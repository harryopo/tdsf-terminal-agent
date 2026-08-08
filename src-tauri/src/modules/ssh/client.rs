//! SSH 客户端核心 (P2-B T-P2-03)
//! ============================================================================
//! 封装 russh::client 的连接 + 认证流程,提供高层 API:
//! - `SshClient::connect`: 建立连接 (含 TOFU) + 认证 (password/publickey)
//! - 配置原生 keepalive (15s) + keepalive_max (3) + inactivity_timeout (30s)
//! - 返回 russh::client::Handle 供 SshSession 使用
//!
//! ## 认证方法
//! - **Password**: 直接 password 认证 (最简单,适合教学场景)
//! - **PublicKey**: 私钥文件 + 可选 passphrase,支持 RSA/Ed25519/ECDSA
//!
//! ## keepalive 配置 (russh 原生)
//! ```rust
//! use std::time::Duration;
//! use russh::client;
//!
//! let config = client::Config {
//!     keepalive_interval: Some(Duration::from_secs(15)),  // 15s 发一次 keepalive
//!     keepalive_max: 3,                                    // 3 次无响应则断开
//!     inactivity_timeout: Some(Duration::from_secs(30)),  // 30s 无数据则超时
//!     ..<_>::default()
//! };
//! ```
//! russh 主循环自动调度,无需应用层定时器。

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle};
use tauri::ipc::Channel;

use crate::modules::ssh::handler::SshClientHandler;
use crate::modules::ssh::known_hosts::KnownHostsManager;
use crate::modules::ssh::session::SshStatusEvent;

/// TCP + SSH 握手超时: 服务器不可达/端口未开放时快速失败
/// (Windows TCP connect 默认 ~21s, 无显式超时会卡住用户等待)
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// SSH 认证方法
///
/// 前端通过 JSON 传递,Rust 端 serde 反序列化。
/// 使用 `#[serde(tag = "type", rename_all = "lowercase")]` 实现枚举多态。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SshAuthMethod {
    /// 密码认证 (最简单,适合教学场景)
    Password {
        password: String,
    },
    /// 公钥认证 (推荐,生产环境用)
    PublicKey {
        /// 私钥文件路径 (支持 RSA/Ed25519/ECDSA,OpenSSH/PKCS8 格式)
        private_key_path: String,
        /// 私钥 passphrase (可选,加密的私钥需要)
        #[serde(default)]
        passphrase: Option<String>,
    },
}

/// SSH 连接参数
#[derive(Debug, Clone)]
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuthMethod,
}

/// SSH 客户端
///
/// 封装 russh::client::Handle,提供高层 API。
/// connect 成功后,通过 `handle()` 获取 russh Handle 用于开 channel。
pub struct SshClient {
    /// russh 客户端 Handle (用于 channel_open_session 等)
    handle: Handle<SshClientHandler>,
}

/// SSH 客户端错误
#[derive(Debug, thiserror::Error)]
pub enum SshClientError {
    /// russh 错误 (连接/认证/协议)
    #[error("russh error: {0}")]
    Russh(#[from] russh::Error),

    /// TCP + SSH 握手超时 (服务器不可达/端口未开放)
    #[error("SSH 连接超时({secs}s): 服务器不可达或端口未开放")]
    HandshakeTimeout { secs: u64 },

    /// russh keys 错误 (私钥加载/解析)
    #[error("russh keys error: {0}")]
    RusshKeys(#[from] russh::keys::Error),

    /// 认证失败
    #[error("authentication failed for user {user}: {reason}")]
    AuthFailed { user: String, reason: String },

    /// 私钥文件读取失败
    #[error("failed to read private key {path}: {source}")]
    PrivateKeyRead {
        path: String,
        #[source]
        source: std::io::Error,
    },

    /// 其他错误
    #[error("{0}")]
    Other(String),
}

impl SshClient {
    /// 建立 SSH 连接 (含 TOFU + 认证)
    ///
    /// 流程:
    /// 1. 创建 russh::client::Config (配置 keepalive)
    /// 2. 创建 SshClientHandler (含 host/port/app_handle/known_hosts)
    /// 3. 调用 client::connect 建立 TCP + SSH 握手 (含 check_server_key 回调)
    /// 4. 根据认证方法执行认证 (password/publickey)
    /// 5. 认证成功后返回 SshClient (持有 Handle)
    ///
    /// # 参数
    /// - `app_handle`: Tauri AppHandle (用于 emit HostVerify 事件)
    /// - `params`: 连接参数 (host/port/user/auth)
    /// - `on_status`: 状态推送 channel (可选; ssh_connect 传 Some, ssh_test 传 None)
    pub async fn connect(
        app_handle: tauri::AppHandle,
        params: SshConnectParams,
        on_status: Option<Channel<SshStatusEvent>>,
    ) -> Result<Self, SshClientError> {
        let host = params.host.clone();
        let port = params.port;
        let user = params.user.clone();

        log::info!(
            "[ssh] connecting to {}@{}:{}",
            user,
            host,
            port
        );

        // 1. 推送 Connecting 状态
        if let Some(ref ch) = on_status {
            let _ = ch.send(SshStatusEvent::connecting(&host, port));
        }

        // 2. 创建 Config (keepalive + inactivity_timeout)
        let config = client::Config {
            // 15s 发一次 keepalive (russh 主循环自动调度)
            keepalive_interval: Some(Duration::from_secs(15)),
            // 3 次无响应则断开 (返回 Error::KeepaliveTimeout)
            keepalive_max: 3,
            // 30s 无任何数据则超时 (返回 Error::InactivityTimeout)
            // 注意: 这个比较严格,但适合教学场景 (及时发现问题)
            inactivity_timeout: Some(Duration::from_secs(30)),
            ..<_>::default()
        };

        // 3. 创建 Handler (含 known_hosts 管理器)
        let handler = SshClientHandler {
            host: host.clone(),
            port,
            app_handle: app_handle.clone(),
            known_hosts: KnownHostsManager::new(),
        };

        // 4. 推送 Handshaking 状态
        if let Some(ref ch) = on_status {
            let _ = ch.send(SshStatusEvent::handshaking(&host, port));
        }

        // 5. 建立 TCP + SSH 握手
        //    client::connect 内部:
        //    a. TcpStream::connect((host, port))
        //    b. SSH 协议握手 (version exchange + kex)
        //    c. 调用 handler.check_server_key (TOFU)
        //    TDSF 2026-08-08: 显式 15s 超时, 服务器不可达/端口关闭时快速失败
        //    (TCP connect 系统默认 ~21s, 用户等待无反馈, 教学场景应快速提示)
        let mut handle = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            client::connect(Arc::new(config), (host.as_str(), port), handler),
        )
        .await
        .map_err(|_| SshClientError::HandshakeTimeout {
            secs: HANDSHAKE_TIMEOUT.as_secs(),
        })??;

        log::info!("[ssh] TCP+SSH handshake done, starting authentication");

        // 6. 推送 Authenticating 状态
        if let Some(ref ch) = on_status {
            let _ = ch.send(SshStatusEvent::authenticating(&host, port, &user));
        }

        // 7. 执行认证
        let auth_result = match &params.auth {
            SshAuthMethod::Password { password } => {
                log::debug!("[ssh] authenticating with password");
                handle
                    .authenticate_password(&user, password.clone())
                    .await?
            }
            SshAuthMethod::PublicKey {
                private_key_path,
                passphrase,
            } => {
                log::debug!(
                    "[ssh] authenticating with publickey: path={}",
                    private_key_path
                );
                self::authenticate_publickey(&mut handle, &user, private_key_path, passphrase.as_deref())
                    .await?
            }
        };

        // 8. 检查认证结果
        match auth_result {
            russh::client::AuthResult::Success => {
                log::info!("[ssh] authentication successful: user={}", user);
                if let Some(ref ch) = on_status {
                    let _ = ch.send(SshStatusEvent::authenticated(&host, port, &user));
                }
                Ok(Self { handle })
            }
            other => {
                let reason = format!("{:?}", other);
                log::warn!("[ssh] authentication failed: user={} reason={}", user, reason);
                if let Some(ref ch) = on_status {
                    let _ = ch.send(SshStatusEvent::failed(&host, port, &reason));
                }
                Err(SshClientError::AuthFailed {
                    user: user.clone(),
                    reason,
                })
            }
        }
    }

    /// 获取 russh Handle (供 SshSession 开 channel)
    ///
    /// 注意: Handle 内部是 Sender<Msg> + tokio mpsc,可多次 clone。
    /// 多 tab 共享 Handle 时,每个 tab 持有自己的 clone。
    pub fn handle(self) -> Handle<SshClientHandler> {
        self.handle
    }

    /// 获取 Handle 引用 (用于 SshSession::open_pty 借用而非消费)
    pub fn handle_ref(&self) -> &Handle<SshClientHandler> {
        &self.handle
    }
}

/// 公钥认证辅助函数
///
/// 流程:
/// 1. 加载私钥文件 (russh::keys::load_secret_key)
/// 2. 协商 RSA hash 算法 (best_supported_rsa_hash)
/// 3. 调用 handle.authenticate_publickey
///
/// 注意: russh 0.61 的 PrivateKeyWithHashAlg::new 签名为
///       `new(key: Arc<PrivateKey>, hash_alg: Option<HashAlg>) -> Self`
///       (直接返回 Self,非 Result;key 需用 Arc 包装)
async fn authenticate_publickey(
    handle: &mut Handle<SshClientHandler>,
    user: &str,
    private_key_path: &str,
    passphrase: Option<&str>,
) -> Result<russh::client::AuthResult, SshClientError> {
    // 1. 加载私钥 (russh::keys::load_secret_key 自动识别格式 + 解密)
    let private_key = russh::keys::load_secret_key(private_key_path, passphrase)
        .map_err(SshClientError::RusshKeys)?;

    // 2. 协商 RSA hash 算法
    //    服务器可能支持 rsa-sha2-256 / rsa-sha2-512 / ssh-rsa (已废弃)
    //    best_supported_rsa_hash 返回 Option<Option<HashAlg>>:
    //    - None: 服务器不支持 server-sig-algs 扩展,用默认
    //    - Some(None): 服务器明确不支持 rsa-sha2-*
    //    - Some(Some(hash)): 推荐的 hash 算法
    let key_with_hash_alg = if matches!(
        private_key.algorithm(),
        russh::keys::Algorithm::Rsa { .. }
    ) {
        let best_hash = handle.best_supported_rsa_hash().await?;
        match best_hash {
            None => russh::keys::PrivateKeyWithHashAlg::new(
                std::sync::Arc::new(private_key.clone()),
                None,
            ),
            Some(None) => {
                return Err(SshClientError::AuthFailed {
                    user: user.to_string(),
                    reason: "server does not support rsa-sha2-* algorithms".to_string(),
                });
            }
            Some(Some(hash)) => russh::keys::PrivateKeyWithHashAlg::new(
                std::sync::Arc::new(private_key.clone()),
                Some(hash),
            ),
        }
    } else {
        // Ed25519/ECDSA 不需要 hash 算法协商
        russh::keys::PrivateKeyWithHashAlg::new(std::sync::Arc::new(private_key.clone()), None)
    };

    // 3. 执行公钥认证
    let result = handle.authenticate_publickey(user, key_with_hash_alg).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_auth_method_password_deserialize() {
        let json = r#"{"type":"password","password":"secret"}"#;
        let auth: SshAuthMethod = serde_json::from_str(json).unwrap();
        match auth {
            SshAuthMethod::Password { password } => {
                assert_eq!(password, "secret");
            }
            _ => panic!("expected Password variant"),
        }
    }

    #[test]
    fn test_ssh_auth_method_publickey_deserialize() {
        let json = r#"{"type":"publickey","private_key_path":"/home/user/.ssh/id_rsa","passphrase":"mypass"}"#;
        let auth: SshAuthMethod = serde_json::from_str(json).unwrap();
        match auth {
            SshAuthMethod::PublicKey {
                private_key_path,
                passphrase,
            } => {
                assert_eq!(private_key_path, "/home/user/.ssh/id_rsa");
                assert_eq!(passphrase, Some("mypass".to_string()));
            }
            _ => panic!("expected PublicKey variant"),
        }
    }

    #[test]
    fn test_ssh_auth_method_publickey_no_passphrase() {
        let json = r#"{"type":"publickey","private_key_path":"/home/user/.ssh/id_ed25519"}"#;
        let auth: SshAuthMethod = serde_json::from_str(json).unwrap();
        match auth {
            SshAuthMethod::PublicKey {
                private_key_path,
                passphrase,
            } => {
                assert_eq!(private_key_path, "/home/user/.ssh/id_ed25519");
                assert_eq!(passphrase, None);
            }
            _ => panic!("expected PublicKey variant"),
        }
    }

    #[test]
    fn test_ssh_connect_params_construction() {
        let params = SshConnectParams {
            host: "example.com".to_string(),
            port: 2222,
            user: "testuser".to_string(),
            auth: SshAuthMethod::Password {
                password: "pwd".to_string(),
            },
        };
        assert_eq!(params.host, "example.com");
        assert_eq!(params.port, 2222);
        assert_eq!(params.user, "testuser");
    }
}
