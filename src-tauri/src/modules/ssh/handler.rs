//! SSH Handler 实现 (P2-B T-P2-03)
//! ============================================================================
//! 实现 russh::client::Handler trait,核心是 check_server_key 回调:
//! - 已知主机 + key 匹配 → 直接通过
//! - 未知主机 → 推送 HostVerify 事件到前端,异步等待用户确认 (TOFU)
//! - 已知主机 + key 不匹配 → 推送 HostKeyMismatch 事件,大字警告
//!
//! 用户确认通过全局 approval registry 实现:
//! - check_server_key 创建 approval_id,注册 oneshot sender,挂起等待
//! - 前端弹窗后调用 ssh_approve_host 命令,通过 approval_id 找到 sender 并发送结果
//! - check_server_key 收到结果后,若 approved 则 learn_known_hosts,返回 Ok(true)

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, OnceLock};

use russh::client::Handler;
use russh::keys::PublicKey;
use tauri::Emitter;
use tokio::sync::{oneshot, Notify};
// P1-NEW-v3-3 修复 (2026-07-30): 引入 timeout + Duration,
// 给主机审批 rx.await 加 5min 超时, 防止用户关闭弹窗不点按钮时
// SSH 连接 tokio task 永久阻塞 + registry 内存泄漏。
use tokio::time::{timeout, Duration};

use crate::modules::ssh::known_hosts::KnownHostsManager;

/// 主机审批超时时间 (5 分钟)
///
/// 用户在 5 分钟内未点击"信任"/"拒绝"按钮时, 视为超时拒绝:
/// - 关闭弹窗 / 切换窗口 / 离开电脑 → 5 分钟后自动拒绝连接
/// - 防止 SSH 连接 tokio task 永久挂起 + approval_id 永留 registry
///
/// 超时时间选取依据:
/// - 太短 (1-2min): 用户可能还在阅读指纹, 误判为拒绝
/// - 太长 (30min): 连接卡死时间过久, 资源浪费
/// - 5min: 平衡可用性 (用户有足够时间读指纹) + 资源回收
const HOST_APPROVAL_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// 将字符串错误转换为 russh::Error
///
/// russh 0.61 的 Error 枚举没有 Inner 变体,我们使用 IO 变体包装字符串错误。
/// (russh::Error::IO(std::io::Error::new(Other, msg)))
fn rust_error(msg: impl Into<String>) -> russh::Error {
    russh::Error::IO(std::io::Error::new(std::io::ErrorKind::Other, msg.into()))
}

/// 全局主机审批注册表
///
/// key: approval_id (UUID 字符串)
/// value: oneshot::Sender<bool> (用户是否信任)
///
/// 使用 LazyLock + Mutex 保证线程安全。
/// approval_id 由 check_server_key 生成 (UUID v4),保证唯一性。
static HOST_APPROVAL_REGISTRY: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 全局通知器: 当有新 approval 注册时唤醒 (用于前端事件订阅,目前预留)
#[allow(dead_code)]
static HOST_APPROVAL_NOTIFY: OnceLock<Notify> = OnceLock::new();

/// 解析主机审批结果 (供 ssh_approve_host 命令调用)
///
/// 根据 approval_id 查找挂起的 check_server_key future,
/// 通过 oneshot channel 发送用户决策 (true=信任, false=拒绝)。
///
/// # Errors
/// - `approval_id not found`: approval_id 不存在或已被消费 (重复调用)
pub fn resolve_host_approval(approval_id: &str, approved: bool) -> Result<(), String> {
    let mut registry = HOST_APPROVAL_REGISTRY.lock().map_err(|e| e.to_string())?;
    match registry.remove(approval_id) {
        Some(sender) => {
            sender
                .send(approved)
                .map_err(|_| "approval receiver already dropped".to_string())?;
            Ok(())
        }
        None => Err(format!("approval_id not found: {approval_id}")),
    }
}

/// SSH 客户端 Handler 实现
///
/// 每个 SSH 连接对应一个 SshClientHandler 实例,持有:
/// - host/port: 用于 known_hosts 检查
/// - app_handle: 用于推送 Tauri 事件到前端
/// - known_hosts_manager: 用于 check/learn known_hosts
pub struct SshClientHandler {
    /// 远程主机名 (用于 known_hosts 检查)
    pub host: String,
    /// 远程端口 (用于 known_hosts 检查)
    pub port: u16,
    /// Tauri AppHandle (用于 emit 事件到前端)
    pub app_handle: tauri::AppHandle,
    /// known_hosts 管理器 (TOFU + 持久化)
    pub known_hosts: KnownHostsManager,
}

impl Handler for SshClientHandler {
    type Error = russh::Error;

    /// check_server_key 回调: TOFU 策略入口
    ///
    /// russh 在 KEX (Key Exchange) 完成后调用此方法,让客户端决定是否信任服务器公钥。
    /// 返回 Ok(true) → 信任,继续认证;Ok(false) → 拒绝,russh 断开连接。
    ///
    /// ## 策略 (借鉴 OpenSSH + wezterm-ssh)
    /// 1. **已知主机 + key 匹配**: 返回 Ok(true)
    /// 2. **未知主机** (TOFU): 推送 HostVerify 事件到前端,等待用户确认
    ///    - 用户确认 → learn_known_hosts 写入文件,返回 Ok(true)
    ///    - 用户拒绝 → 返回 Ok(false)
    /// 3. **已知主机 + key 不匹配**: 推送 HostKeyMismatch 事件 (中间人攻击警告)
    ///    - 用户必须明确"删除旧 key 并继续" → learn_known_hosts 覆盖,返回 Ok(true)
    ///    - 否则返回 Ok(false)
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        log::info!(
            "[ssh] check_server_key: host={} port={}",
            self.host,
            self.port
        );

        // 计算指纹 (SHA256 base64 no-pad,OpenSSH 现代格式)
        // russh 0.61: PublicKey::fingerprint(ssh_key::HashAlg::Sha256) -> Fingerprint
        // Fingerprint 实现 Display,格式为 "SHA256:base64string"
        // ssh_key 通过 russh::keys::ssh_key 重导出
        let fingerprint = format!(
            "{}",
            server_public_key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        );
        log::info!("[ssh] server key fingerprint: {}", fingerprint);

        // 1. 检查 known_hosts
        match self.known_hosts.check(&self.host, self.port, server_public_key) {
            Ok(true) => {
                // 已知主机 + key 匹配
                log::info!("[ssh] host key matches known_hosts: {}", self.host);
                Ok(true)
            }
            Ok(false) => {
                // 未知主机 → TOFU 询问用户
                log::info!("[ssh] unknown host, asking user: {}", self.host);
                self.ask_user_to_trust_host(server_public_key, &fingerprint, false)
                    .await
            }
            Err(e) => {
                // key 不匹配 → 大字警告询问用户
                log::warn!(
                    "[ssh] host key mismatch! host={} err={}",
                    self.host,
                    e
                );
                self.ask_user_to_trust_host(server_public_key, &fingerprint, true)
                    .await
            }
        }
    }

    /// disconnected 回调: russh 会话主循环退出时调用 (TDSF 诊断新增)
    ///
    /// 默认实现只在 debug 级别打印,导致 shell 黑屏根因 (连接为何在
    /// 认证+开 channel 后立刻断) 被吞掉。这里提升到 info/warn 级别,
    /// 打印确切原因:
    /// - `ReceivedDisconnect`: 服务器主动发 SSH_MSG_DISCONNECT (含 reason_code)
    /// - `Error`: 传输层错误 (TCP EOF、IO、KeepaliveTimeout、InactivityTimeout 等)
    ///
    /// 保持默认语义: ReceivedDisconnect → Ok(()),Error → Err(e)。
    async fn disconnected(
        &mut self,
        reason: russh::client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        match reason {
            russh::client::DisconnectReason::ReceivedDisconnect(info) => {
                log::warn!(
                    "[ssh] disconnected: server sent DISCONNECT reason_code={:?} message={:?}",
                    info.reason_code,
                    info.message
                );
                Ok(())
            }
            russh::client::DisconnectReason::Error(e) => {
                log::warn!("[ssh] disconnected with transport error: {:?}", e);
                Err(e)
            }
        }
    }
}

impl SshClientHandler {
    /// 询问用户是否信任主机
    ///
    /// 通过 Tauri emit 推送事件到前端,前端弹窗询问用户。
    /// 同时注册 oneshot channel 到全局 approval registry,异步等待用户响应。
    ///
    /// # 参数
    /// - `server_public_key`: 服务器公钥 (用于 learn_known_hosts)
    /// - `fingerprint`: 公钥指纹 (用于前端显示)
    /// - `is_mismatch`: true=key 不匹配 (大字警告), false=未知主机 (TOFU)
    async fn ask_user_to_trust_host(
        &self,
        server_public_key: &PublicKey,
        fingerprint: &str,
        is_mismatch: bool,
    ) -> Result<bool, russh::Error> {
        // 1. 生成 approval_id (UUID v4)
        let approval_id = uuid::Uuid::new_v4().to_string();

        // 2. 创建 oneshot channel 等待用户响应
        let (tx, rx) = oneshot::channel::<bool>();

        // 3. 注册到全局 approval registry
        {
            let mut registry = HOST_APPROVAL_REGISTRY
                .lock()
                .map_err(|e| rust_error(format!("approval registry lock failed: {e}")))?;
            registry.insert(approval_id.clone(), tx);
        }

        // 4. 推送事件到前端 (HostVerify 或 HostKeyMismatch)
        let event_payload = serde_json::json!({
            "approval_id": approval_id,
            "host": self.host,
            "port": self.port,
            "fingerprint": fingerprint,
            "is_mismatch": is_mismatch,
            "key_type": format!("{:?}", server_public_key.algorithm()),
            "message": if is_mismatch {
                format!(
                    "⚠️ 主机密钥不匹配!\n\n主机: {}:{}\n这可能意味着中间人攻击或服务器重装。\n\n指纹: {}",
                    self.host, self.port, fingerprint
                )
            } else {
                format!(
                    "未知主机,是否信任?\n\n主机: {}:{}\n指纹: {}",
                    self.host, self.port, fingerprint
                )
            },
        });

        let event_name = if is_mismatch {
            "ssh:host_key_mismatch"
        } else {
            "ssh:host_verify"
        };

        log::info!(
            "[ssh] emitting event: {} approval_id={}",
            event_name,
            approval_id
        );

        if let Err(e) = self.app_handle.emit(event_name, event_payload) {
            log::error!("[ssh] emit event failed: {}", e);
            // emit 失败时清理 registry,返回拒绝
            let mut registry = HOST_APPROVAL_REGISTRY
                .lock()
                .map_err(|e| rust_error(format!("approval registry lock failed: {e}")))?;
            registry.remove(&approval_id);
            return Ok(false);
        }

        // 5. 异步等待用户响应 (P1-NEW-v3-3 修复: 加 5min 超时)
        //    前端应提供"信任"/"拒绝"按钮,调用 ssh_approve_host 命令
        //
        //    P1-NEW-v3-3 修复 (2026-07-30):
        //    - 原版 `rx.await.unwrap_or(false)` 无超时, 用户关闭弹窗
        //      不点按钮时 SSH 连接 tokio task 永久阻塞 + approval_id
        //      永留 registry (多次触发累积内存泄漏)
        //    - 修复: 用 tokio::time::timeout 包裹, 5min 超时后
        //      视为拒绝, 同时主动清理 registry (虽然 oneshot rx 已
        //      drop, sender 端的 registry.remove 由超时分支也清理)
        //    - 超时场景: 用户关弹窗 / 切换窗口 / 离开电脑 / 前端崩溃
        //    - 正常路径: 用户点"信任"/"拒绝" → resolve_host_approval
        //      通过 oneshot tx 发送结果 → rx 立即返回
        let approved = match timeout(HOST_APPROVAL_TIMEOUT, rx).await {
            Ok(result) => result.unwrap_or(false),
            Err(_) => {
                log::warn!(
                    "[ssh] host approval timeout (5min) id={} host={}:{}, treating as rejected",
                    approval_id,
                    self.host,
                    self.port
                );
                // 超时后清理 registry (虽然 oneshot rx 已 drop,
                // 但 sender 仍在 registry 中, 不清会泄漏)
                if let Ok(mut registry) = HOST_APPROVAL_REGISTRY.lock() {
                    registry.remove(&approval_id);
                }
                false
            }
        };

        log::info!(
            "[ssh] host approval result: id={} approved={}",
            approval_id,
            approved
        );

        // 6. 用户确认信任 → learn_known_hosts 写入文件
        if approved {
            if let Err(e) = self
                .known_hosts
                .learn(&self.host, self.port, server_public_key)
            {
                log::warn!("[ssh] learn_known_hosts failed: {}", e);
                // learn 失败不阻断连接 (内存中已信任),只是文件未持久化
            }
        }

        Ok(approved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_approval_registry_resolve_nonexistent() {
        // 不存在的 approval_id 应返回错误
        let result = resolve_host_approval("nonexistent-id", true);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("approval_id not found: nonexistent-id"));
    }

    #[tokio::test]
    async fn test_approval_registry_register_and_resolve() {
        let approval_id = "test-approval-001";
        let (tx, rx) = oneshot::channel::<bool>();

        // 注册
        {
            let mut registry = HOST_APPROVAL_REGISTRY.lock().unwrap();
            registry.insert(approval_id.to_string(), tx);
        }

        // 解析 (approved=true)
        let result = resolve_host_approval(approval_id, true);
        assert!(result.is_ok());

        // receiver 应收到 true
        let approved = rx.await.unwrap();
        assert!(approved);

        // 再次解析应失败 (已被消费)
        let result = resolve_host_approval(approval_id, true);
        assert!(result.is_err());
    }
}
