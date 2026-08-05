//! SSH 客户端模块 (P2-B T-P2-03)
//! ============================================================================
//! 基于 russh 0.61 纯 Rust 异步 SSH 客户端,与 Tauri 2 tokio 运行时完美契合
//!
//! ## 模块结构
//! - `handler`: SshClientHandler 实现 russh::client::Handler trait
//!   - check_server_key 回调 → TOFU + 用户确认 (通过 Tauri 事件)
//! - `client`: SshClient 核心客户端
//!   - connect + authenticate (password/publickey)
//!   - keepalive/inactivity_timeout 原生配置
//! - `known_hosts`: 已知主机 TOFU 管理
//!   - check_known_hosts / learn_known_hosts
//!   - 支持 hashed host (|1|salt|hash)
//!   - mismatch 时大字警告 + 用户确认
//! - `session`: SSH Session (PTY 交互 + 多路复用)
//!   - request_pty + request_shell
//!   - channel.wait() 异步读取输出
//!   - window_change 调整窗口大小
//!   - open_sftp_channel() (T-P2-05 扩展) 复用 Handle 开 SFTP channel
//! - `sftp`: SFTP 文件传输 (T-P2-05 新增)
//!   - SftpSession 封装 russh-sftp 2.1
//!   - list_dir / stat / read_file / write_file / mkdir / remove / rename
//!
//! ## 关键特性
//! - **原生 keepalive**: Config.keepalive_interval=15s + keepalive_max=3
//! - **TOFU**: 首次连接推送 HostVerify 事件到前端,用户确认后 learn_known_hosts
//! - **多路复用**: 同 host 多 tab 共享 russh::client::Handle (P3 实现)
//! - **状态推送**: 通过 Tauri emit "ssh:status" 事件实时推送连接状态
//! - **SFTP 复用**: T-P2-05 SFTP 操作复用 SSH Handle 开新 channel (Tauri State 缓存)

pub mod client;
pub mod credentials;
pub mod handler;
pub mod known_hosts;
pub mod session;
pub mod sftp;

// 重导出核心类型,供 lib.rs 注册 Tauri 命令使用
pub use client::{SshAuthMethod, SshClient, SshConnectParams};
pub use known_hosts::KnownHostsManager;
pub use session::{SshCommandOutput, SshSession, SshSessionState, SshStatusEvent};
pub use sftp::{SftpAttrs, SftpEntry, SftpSession};

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};

use tauri::ipc::Channel;

/// SSH 会话注册表 (全局,通过 Tauri State 注入)
///
/// 每个 SSH 连接对应一个 session_id,前端通过 session_id 操作会话。
/// session_id 从 1 开始单调递增,与 PTY 的 id 空间独立。
///
/// 同时维护 SFTP 会话缓存 (T-P2-05 新增):
/// key = session_id (与 SSH session 共用 ID),value = SftpSession。
/// 首次 SFTP 操作时创建,SSH 断开时清理。
pub struct SshState {
    sessions: RwLock<HashMap<u32, Arc<SshSession>>>,
    /// SFTP 会话缓存 (T-P2-05)
    /// 与 sessions 共享 session_id,首次 SFTP 操作时通过 SshSession::open_sftp_channel 创建。
    sftp_sessions: RwLock<HashMap<u32, Arc<SftpSession>>>,
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            sftp_sessions: RwLock::new(HashMap::new()),
            // 从 1 开始,避免前端把 0 误判为 "未设置"
            next_id: AtomicU32::new(1),
        }
    }
}

impl SshState {
    /// 分配新 session_id
    pub fn allocate_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// 插入新会话
    pub fn insert(&self, id: u32, session: Arc<SshSession>) {
        self.sessions.write().unwrap_or_else(|e| e.into_inner()).insert(id, session);
    }

    /// 取出会话 (移除)
    /// 同时移除对应的 SFTP 会话 (T-P2-05)
    pub fn take(&self, id: u32) -> Option<Arc<SshSession>> {
        // 同步清理 SFTP 会话缓存
        if let Some(sftp) = self.sftp_sessions.write().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            // 异步关闭 SFTP 会话 (不阻塞 SSH 断开流程)
            let sftp_clone = sftp.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sftp_clone.close().await {
                    log::warn!("[ssh] SFTP close on disconnect failed: {}", e);
                }
            });
        }
        self.sessions.write().unwrap_or_else(|e| e.into_inner()).remove(&id)
    }

    /// 获取会话引用 (不移除)
    pub fn get(&self, id: u32) -> Option<Arc<SshSession>> {
        self.sessions.read().unwrap_or_else(|e| e.into_inner()).get(&id).cloned()
    }

    /// 列出所有会话 ID (用于 ssh_status 命令)
    pub fn list_ids(&self) -> Vec<u32> {
        self.sessions.read().unwrap_or_else(|e| e.into_inner()).keys().copied().collect()
    }

    // === SFTP 会话缓存管理 (T-P2-05 新增) ===

    /// 获取或创建 SFTP 会话
    ///
    /// 首次调用时: 通过 SshSession::open_sftp_channel() 开 channel,创建 SftpSession。
    /// 后续调用: 直接返回缓存的 SftpSession。
    ///
    /// # 参数
    /// - `session_id`: SSH 会话 ID
    pub async fn get_or_create_sftp(
        &self,
        session_id: u32,
    ) -> Result<Arc<SftpSession>, String> {
        // 2026-08-04 修复 TOCTOU 竞态: double-check 模式（不持锁跨 await）。
        // 此前并发请求各自创建 SFTP channel 后无条件 insert，后者覆盖前者导致孤儿泄漏。
        // 修复：创建后在 write 锁内再次检查，已有则用现有的、丢弃新建的。

        // 1. 快速路径: read 锁检查
        if let Some(sftp) = self.sftp_sessions.read().unwrap_or_else(|e| e.into_inner()).get(&session_id) {
            return Ok(sftp.clone());
        }

        // 2. 缓存未命中，创建新 SFTP 会话（不持锁，避免 std::sync Guard 跨 await）
        let session = self
            .get(session_id)
            .ok_or_else(|| format!("SSH session not found: id={session_id}"))?;

        log::info!("[sftp] creating new SFTP session for ssh_id={}", session_id);
        let stream = session
            .open_sftp_channel()
            .await
            .map_err(|e| format!("open SFTP channel failed: {e}"))?;
        let sftp = Arc::new(SftpSession::new(stream).await?);

        // 3. write 锁 double-check: 防止并发请求重复创建
        let mut sftp_map = self.sftp_sessions.write().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = sftp_map.get(&session_id) {
            // 另一个并发请求已创建，用它的（新建的会随 Arc drop 被回收）
            log::debug!("[sftp] race resolved: session {} already created by another request", session_id);
            return Ok(existing.clone());
        }
        sftp_map.insert(session_id, sftp.clone());

        Ok(sftp)
    }

    /// 移除 SFTP 会话 (用于主动关闭 SFTP)
    #[allow(dead_code)]
    pub fn remove_sftp(&self, session_id: u32) -> Option<Arc<SftpSession>> {
        self.sftp_sessions.write().unwrap_or_else(|e| e.into_inner()).remove(&session_id)
    }
}

// ============================================================================
// Tauri 命令定义 (lib.rs 中通过 invoke_handler 注册)
// ============================================================================

/// SSH 连接参数 (前端 → Rust)
///
/// 前端调用示例:
/// ```ts
/// await invoke('ssh_connect', {
///   params: {
///     host: '192.168.1.100',
///     port: 22,
///     user: 'root',
///     auth: { type: 'password', password: '***' },
///     // 或 { type: 'publickey', private_key_path: '/path/to/id_rsa', passphrase: '***' }
///     cols: 80,
///     rows: 24,
///     term: 'xterm-256color',
///   },
///   on_data: channel,  // Tauri Channel<Response>
///   on_status: channel, // Tauri Channel<SshStatusEvent>
///   on_exit: channel,   // Tauri Channel<i32>
/// });
/// ```
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectCommand {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    pub auth: SshAuthMethod,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_term")]
    pub term: String,
}

fn default_port() -> u16 {
    22
}
fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}
fn default_term() -> String {
    "xterm-256color".to_string()
}

/// ssh_connect 命令: 建立 SSH 连接并打开 PTY 会话
///
/// 流程:
/// 1. 解析参数,分配 session_id
/// 2. 通过 SshClient::connect 建立连接 (含 TOFU + 认证)
/// 3. 通过 SshSession::open_pty 请求 PTY + shell
/// 4. 启动 reader task 推送输出到 on_data channel
/// 5. 推送 SshStatusEvent 到 on_status channel
/// 6. 返回 session_id 给前端
#[tauri::command]
pub async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, SshState>,
    params: SshConnectCommand,
    on_data: Channel<Vec<u8>>,
    on_status: Channel<SshStatusEvent>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let session_id = state.allocate_id();
    log::info!(
        "[ssh] connect start: id={} host={} port={} user={}",
        session_id,
        params.host,
        params.port,
        params.user
    );

    // 1. 建立连接 (含 TOFU + 认证)
    let connect_params = SshConnectParams {
        host: params.host.clone(),
        port: params.port,
        user: params.user.clone(),
        auth: params.auth.clone(),
    };

    let app_handle_for_connect = app.clone();
    let client = SshClient::connect(app_handle_for_connect, connect_params, Some(on_status.clone()))
        .await
        .map_err(|e| {
            let msg = format!("SSH connect failed: {e}");
            log::error!("[ssh] connect failed: id={} err={}", session_id, e);
            msg
        })?;

    // 2. 打开 PTY 会话
    let session = SshSession::open_pty(
        client,
        params.cols,
        params.rows,
        params.term.clone(),
        on_data,
        on_status,
        on_exit,
    )
    .await
    .map_err(|e| {
        let msg = format!("SSH open PTY failed: {e}");
        log::error!("[ssh] open pty failed: id={} err={}", session_id, e);
        msg
    })?;

    // 3. 注册到全局 state
    state.insert(session_id, Arc::new(session));

    log::info!("[ssh] connect success: id={}", session_id);
    Ok(session_id)
}

/// ssh_write 命令: 向 SSH 会话写入数据 (前端按键)
///
/// 与本地 PTY 的 pty_write 不同,SSH 走 russh 异步 channel.data_bytes,
/// 不需要 spawn_blocking。
#[tauri::command]
pub async fn ssh_write(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = state
        .get(session_id)
        .ok_or_else(|| format!("SSH session not found: id={session_id}"))?;

    session.write_data(&data).await.map_err(|e| {
        log::error!("[ssh] write failed: id={} err={}", session_id, e);
        e.to_string()
    })
}

/// ssh_resize 命令: 调整 SSH PTY 窗口大小
#[tauri::command]
pub async fn ssh_resize(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .get(session_id)
        .ok_or_else(|| format!("SSH session not found: id={session_id}"))?;

    session.resize(cols, rows).await.map_err(|e| {
        log::error!("[ssh] resize failed: id={} err={}", session_id, e);
        e.to_string()
    })
}

/// ssh_disconnect 命令: 主动断开 SSH 连接
///
/// 关闭 channel + disconnect,会话从 state 移除。
#[tauri::command]
pub async fn ssh_disconnect(
    state: tauri::State<'_, SshState>,
    session_id: u32,
) -> Result<(), String> {
    let session = state
        .take(session_id)
        .ok_or_else(|| format!("SSH session not found: id={session_id}"))?;

    log::info!("[ssh] disconnect: id={}", session_id);
    session.close().await.map_err(|e| {
        log::error!("[ssh] disconnect failed: id={} err={}", session_id, e);
        e.to_string()
    })
}

/// ssh_status 命令: 查询所有 SSH 会话状态
///
/// 返回 HashMap<session_id, SshSessionState>,前端用于渲染状态栏。
#[tauri::command]
pub async fn ssh_status(
    state: tauri::State<'_, SshState>,
) -> Result<Vec<(u32, SshSessionState)>, String> {
    let sessions = state.sessions.read().unwrap_or_else(|e| e.into_inner());
    let mut result = Vec::with_capacity(sessions.len());
    for (id, session) in sessions.iter() {
        result.push((*id, session.state()));
    }
    Ok(result)
}

/// ssh_approve_host 命令: 用户确认信任未知主机 (TOFU)
///
/// 当 check_server_key 回调推送 HostVerify 事件到前端后,
/// 前端弹窗询问用户,用户点击"信任"后调用此命令。
/// 命令通过 oneshot channel 通知挂起的 check_server_key future 继续。
#[tauri::command]
pub async fn ssh_approve_host(
    approval_id: String,
    approved: bool,
) -> Result<(), String> {
    log::info!(
        "[ssh] host approval: id={} approved={}",
        approval_id,
        approved
    );
    // 通过全局 approval registry 查找挂起的 future 并通知
    handler::resolve_host_approval(&approval_id, approved)
        .map_err(|e| format!("resolve host approval failed: {e}"))
}

// ============================================================================
// SFTP Tauri 命令 (T-P2-05 新增)
// ============================================================================
// 前端通过 invoke('sftp_*', { sessionId, path, ... }) 调用。
// 所有命令复用 SshState 中缓存的 SFTP 会话 (首次调用自动创建)。
// 错误统一为 String,前端用 toast/error boundary 显示。

/// sftp_list 命令: 列出远程目录内容
///
/// 返回 SftpEntry 数组 (已排序: 目录优先 + 字母序)。
#[tauri::command]
pub async fn sftp_list(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    log::info!("[sftp] list: id={} path={}", session_id, path);
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.list_dir(&path).await.map_err(|e| {
        log::error!("[sftp] list failed: id={} path={} err={}", session_id, path, e);
        e
    })
}

/// sftp_stat 命令: 查询文件属性
#[tauri::command]
pub async fn sftp_stat(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    path: String,
) -> Result<SftpAttrs, String> {
    log::info!("[sftp] stat: id={} path={}", session_id, path);
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.stat(&path).await.map_err(|e| {
        log::error!("[sftp] stat failed: id={} path={} err={}", session_id, path, e);
        e
    })
}

/// sftp_read 命令: 读取远程文件内容
///
/// 返回 Vec<u8>,Tauri 自动序列化为 number[] 给前端 (大文件场景注意 IPC 开销)。
#[tauri::command]
pub async fn sftp_read(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    path: String,
) -> Result<Vec<u8>, String> {
    log::info!("[sftp] read: id={} path={}", session_id, path);
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.read_file(&path).await.map_err(|e| {
        log::error!("[sftp] read failed: id={} path={} err={}", session_id, path, e);
        e
    })
}

/// sftp_write 命令: 写入远程文件 (覆盖)
#[tauri::command]
pub async fn sftp_write(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    path: String,
    content: Vec<u8>,
) -> Result<(), String> {
    log::info!(
        "[sftp] write: id={} path={} bytes={}",
        session_id,
        path,
        content.len()
    );
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.write_file(&path, &content).await.map_err(|e| {
        log::error!("[sftp] write failed: id={} path={} err={}", session_id, path, e);
        e
    })
}

/// sftp_mkdir 命令: 创建远程目录
#[tauri::command]
pub async fn sftp_mkdir(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    path: String,
) -> Result<(), String> {
    log::info!("[sftp] mkdir: id={} path={}", session_id, path);
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.mkdir(&path).await.map_err(|e| {
        log::error!("[sftp] mkdir failed: id={} path={} err={}", session_id, path, e);
        e
    })
}

/// sftp_remove 命令: 删除远程文件
///
/// 仅删除文件,不递归删除目录 (与 rm 一致)。
#[tauri::command]
pub async fn sftp_remove(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    path: String,
) -> Result<(), String> {
    log::info!("[sftp] remove: id={} path={}", session_id, path);
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.remove_file(&path).await.map_err(|e| {
        log::error!("[sftp] remove failed: id={} path={} err={}", session_id, path, e);
        e
    })
}

/// sftp_rename 命令: 重命名远程文件/目录
#[tauri::command]
pub async fn sftp_rename(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    from: String,
    to: String,
) -> Result<(), String> {
    log::info!("[sftp] rename: id={} from={} to={}", session_id, from, to);
    let sftp = state.get_or_create_sftp(session_id).await?;
    sftp.rename(&from, &to).await.map_err(|e| {
        log::error!(
            "[sftp] rename failed: id={} from={} to={} err={}",
            session_id,
            from,
            to,
            e
        );
        e
    })
}

// ============================================================================
// SSH 测试连接 (TDSF 魔改: 永久保存密钥 + 自动登录)
// ============================================================================
// 前端在 SshConnectDialog 点击"测试连接"按钮时调用,验证凭据可用后立即断开。
// 不打开 PTY 会话,不注册到 SshState,不推送状态事件 (轻量级 ping)。
// TOFU 主机确认仍通过 app_handle.emit("ssh:approve-host") 推送 (复用现有流程)。

/// ssh_test 命令返回值
///
/// 前端通过 `const result = await invoke('ssh_test', { params })` 接收:
/// - `{ ok: true, message: "..." }`: 连接 + 认证成功
/// - `{ ok: false, message: "..." }`: 连接或认证失败 (含错误信息)
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub ok: bool,
    pub message: String,
}

/// ssh_test 命令: 测试 SSH 连接 (不保留会话)
///
/// 流程:
/// 1. 解析连接参数 (复用 SshConnectCommand)
/// 2. 调用 SshClient::connect(app, params, None) — on_status=None 不推送状态事件
/// 3. 成功: drop SshClient → russh Handle 自动 disconnect → 返回 ok=true
/// 4. 失败: 返回 ok=false + 错误信息
///
/// TOFU 主机确认: SshClientHandler::check_server_key 仍会通过 app_handle.emit
/// 推送 "ssh:approve-host" 事件,前端弹窗询问用户 (与 ssh_connect 一致)。
#[tauri::command]
pub async fn ssh_test(
    app: tauri::AppHandle,
    params: SshConnectCommand,
) -> Result<SshTestResult, String> {
    log::info!(
        "[ssh] test connection: host={} port={} user={}",
        params.host,
        params.port,
        params.user
    );

    let connect_params = SshConnectParams {
        host: params.host.clone(),
        port: params.port,
        user: params.user.clone(),
        auth: params.auth.clone(),
    };

    // 调用 connect (on_status=None), 成功后立即 drop 断开
    match SshClient::connect(app, connect_params, None).await {
        Ok(_client) => {
            // drop _client → russh Handle 自动发送 disconnect
            log::info!("[ssh] test connection success: host={}", params.host);
            drop(_client);
            Ok(SshTestResult {
                ok: true,
                message: format!(
                    "连接成功: {}@{}:{}",
                    params.user, params.host, params.port
                ),
            })
        }
        Err(e) => {
            let msg = format!("{e}");
            log::warn!(
                "[ssh] test connection failed: host={} err={}",
                params.host,
                msg
            );
            Ok(SshTestResult {
                ok: false,
                message: msg,
            })
        }
    }
}

// ============================================================================
// SSH exec 命令执行 (TDSF 魔改 P0-D, 2026-07-30)
// ============================================================================
// 为运维 Agent 提供"执行单条命令并拿回输出"能力,与 PTY 交互解耦。
// 复用现有 SSH Handle 开新 channel,用 channel.exec() (RFC 4254 6.4)
// 而非 request_pty + request_shell,适合一次性命令
// (uptime / systemctl status nginx / df -h 等)。
//
// 调用方:
// 1. 前端直接 invoke('ssh_command', { sessionId, command, timeout })
//    (用于 CDP 测试 / 调试 / 未来 UI 集成)
// 2. Python sidecar 通过 rust_bridge.ipc_invoke("ssh_command", {...})
//    (P1 双向 JSON-RPC 桥接通后,Strands 运维工具实际调用路径)
//
// 返回值结构对齐 Python 端 execute_via_ssh 期望:
//   { ok, output, exit_code, duration, stderr? }
// 见 strands_backend/tools/__init__.py:execute_via_ssh 注释。

/// ssh_command 命令返回值
///
/// 前端/Python 通过 `invoke('ssh_command', {...})` 接收:
/// - `{ ok: true, output: "...", exit_code: 0, duration: 0.123, stderr: "..." }`: 执行完成
///   (exit_code 可能为非 0, ok=true 仅表示命令执行链路正常)
/// - `{ ok: false, output: "", exit_code: -1, duration: ..., stderr: "..." }`: 执行失败
///   (连接断开 / 开 channel 失败 / exec 被拒)
///
/// 字段说明:
/// - `ok`: 命令执行链路是否正常 (true=完成, false=异常)
/// - `output`: stdout 文本 (UTF-8 解码, 失败时可能为空)
/// - `stderr`: stderr 文本 (UTF-8 解码, 超时含说明)
/// - `exit_code`: 退出码 (0=成功, 1-255=Unix 标准, -1=超时/未收到 ExitStatus)
/// - `duration`: 执行耗时 (秒, f64, 便于前端展示)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandResult {
    /// 命令执行链路是否正常 (true=完成, false=异常)
    pub ok: bool,
    /// stdout 文本 (UTF-8 解码, lossy)
    pub output: String,
    /// stderr 文本 (UTF-8 解码, lossy; 超时含说明)
    #[serde(default)]
    pub stderr: String,
    /// 退出码 (0=成功, 1-255=Unix 标准, -1=超时/未收到 ExitStatus)
    pub exit_code: i32,
    /// 执行耗时 (秒, f64)
    pub duration: f64,
}

/// ssh_command 命令: 执行单条 SSH 命令并返回结构化结果 (exec 模式, 非 PTY)
///
/// TDSF 魔改 P0-D (2026-07-30): 为运维 Agent 提供"执行命令并拿回输出"能力。
/// 复用现有 SSH 会话的 Handle 开新 channel (与 PTY / SFTP 并发),
/// 用 channel.exec() 请求执行,循环 wait() 收集 stdout/stderr/exit_code。
///
/// # 参数
/// - `session_id`: SSH 会话 ID (ssh_connect 返回值)
/// - `command`: 要执行的命令 (如 `uptime`, `systemctl status nginx`)
///   远端走 `/bin/sh -c <command>`,支持管道 / 重定向 / 链式
/// - `timeout`: 超时秒数 (None 默认 30s)
///
/// # 返回
/// `SshCommandResult { ok, output, stderr, exit_code, duration }`
///
/// # 错误处理
/// - SSH 会话不存在: 返回 Err (前端显示错误)
/// - SSH 连接已断 / exec 调用失败: 返回 `{ ok: false, ... }` (不抛 Err)
/// - 命令超时: 返回 `{ ok: true, exit_code: -1, stderr: "..." }` (ok=true 表示链路正常)
///
/// # 与 Python 端契约
/// `strands_backend/tools/__init__.py:execute_via_ssh` 期望返回值:
/// ```python
/// result = ctx.rust_bridge.ipc_invoke("ssh_command", {
///     "session_id": session_id,
///     "command": command,
///     "timeout": timeout,
/// })
/// # result 应为 {"ok": true, "output": "...", "exit_code": 0, "duration": 0.123}
/// ```
#[tauri::command]
pub async fn ssh_command(
    state: tauri::State<'_, SshState>,
    session_id: u32,
    command: String,
    timeout: Option<u64>,
) -> Result<SshCommandResult, String> {
    let start = std::time::Instant::now();
    log::info!(
        "[ssh] exec command: id={} cmd={:?} timeout={:?}s",
        session_id,
        command,
        timeout.unwrap_or(30)
    );

    // 1. 获取 SSH 会话
    let session = state
        .get(session_id)
        .ok_or_else(|| format!("SSH session not found: id={session_id}"))?;

    // 2. 调用 exec_command (复用 Handle + channel.exec + wait 循环)
    let result = session.exec_command(&command, timeout).await;

    let duration = start.elapsed().as_secs_f64();

    match result {
        Ok(out) => {
            // UTF-8 解码 (lossy, 命令输出可能含非 UTF-8 字节,如二进制文件 cat)
            let stdout_str = String::from_utf8_lossy(&out.stdout).into_owned();
            let stderr_str = String::from_utf8_lossy(&out.stderr).into_owned();
            log::info!(
                "[ssh] exec command done: id={} exit={} stdout={}B stderr={}B duration={:.3}s",
                session_id,
                out.exit_code,
                out.stdout.len(),
                out.stderr.len(),
                duration
            );
            Ok(SshCommandResult {
                ok: true,
                output: stdout_str,
                stderr: stderr_str,
                exit_code: out.exit_code,
                duration,
            })
        }
        Err(e) => {
            // exec_command 失败 (连接断开 / 开 channel 失败 / exec 被拒)
            // 返回 ok=false 而非 Err,让 Python 端走 "error" 状态分支
            let err_msg = format!("{e}");
            log::error!(
                "[ssh] exec command failed: id={} cmd={:?} err={} duration={:.3}s",
                session_id,
                command,
                err_msg,
                duration
            );
            Ok(SshCommandResult {
                ok: false,
                output: String::new(),
                stderr: err_msg,
                exit_code: -1,
                duration,
            })
        }
    }
}

// ============================================================================
// 单元测试 (P0-D 新增, 2026-07-30)
// ============================================================================
//
// 覆盖范围:
// - SshCommandResult 序列化 (camelCase 字段名 + #[serde(default)] stderr)
// - SshState 基础行为 (allocate_id 单调递增 / get 不存在 / take 移除)
//
// 不覆盖 (需真实 SSH 连接, 留给 tauri:dev + CDP 9222 实测):
// - ssh_command 命令完整链路 (tauri::State 无法在普通 #[test] 构造)
// - exec_command 真实执行 (依赖 russh Handle, 见 session.rs tests 注释)

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_command_result_serialization_camel_case() {
        // 验证 SshCommandResult 序列化为 camelCase (前端 TS 期望)
        let result = SshCommandResult {
            ok: true,
            output: "uptime output".to_string(),
            stderr: "warn line".to_string(),
            exit_code: 0,
            duration: 0.123,
        };
        let json = serde_json::to_string(&result).unwrap();
        // camelCase 字段名验证
        assert!(json.contains("\"exitCode\""), "exit_code → exitCode");
        assert!(!json.contains("\"exit_code\""), "snake_case 不应出现");
        assert!(json.contains("\"ok\":true"));
        assert!(json.contains("\"output\":\"uptime output\""));
        assert!(json.contains("\"stderr\":\"warn line\""));
        assert!(json.contains("\"duration\":0.123"));
    }

    #[test]
    fn test_ssh_command_result_serialization_empty_stderr() {
        // 验证 stderr=空字符串时序列化仍输出 "stderr":"" 字段
        // (前端 TS 期望 stderr 字段始终存在, 不依赖默认值)
        let result = SshCommandResult {
            ok: true,
            output: "x".to_string(),
            stderr: String::new(),
            exit_code: 0,
            duration: 0.1,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"stderr\":\"\""));
        assert!(json.contains("\"output\":\"x\""));
        assert!(json.contains("\"ok\":true"));
    }

    #[test]
    fn test_ssh_command_result_serialization_failure_payload() {
        // 验证 ok=false 失败路径的序列化 (Python 端消费此格式)
        let result = SshCommandResult {
            ok: false,
            output: String::new(),
            stderr: "SSH session not found: id=999".to_string(),
            exit_code: -1,
            duration: 0.001,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"ok\":false"));
        assert!(json.contains("\"output\":\"\""));
        assert!(json.contains("\"exitCode\":-1"));
        // stderr 含中英文混合错误信息时应正确序列化 (UTF-8)
        assert!(json.contains("SSH session not found"));
    }

    #[test]
    fn test_ssh_command_result_clone_and_debug() {
        // 验证 Clone + Debug 派生 (日志 / 跨 task 传递用)
        let result = SshCommandResult {
            ok: true,
            output: "data".to_string(),
            stderr: String::new(),
            exit_code: 42,
            duration: 1.5,
        };
        let cloned = result.clone();
        assert_eq!(cloned.ok, result.ok);
        assert_eq!(cloned.output, result.output);
        assert_eq!(cloned.exit_code, result.exit_code);

        let debug_str = format!("{:?}", result);
        assert!(debug_str.contains("SshCommandResult"));
        assert!(debug_str.contains("42"));
    }

    #[test]
    fn test_ssh_state_default_is_empty() {
        // 验证 SshState 初始无会话 (ssh_command 在此状态下应返回 "session not found")
        let state = SshState::default();
        assert!(state.list_ids().is_empty());
        // 用 is_none() 而非 assert_eq!(..., None), 避免 SshSession 需实现 PartialEq/Debug
        assert!(state.get(1).is_none());
        assert!(state.take(1).is_none());
    }

    #[test]
    fn test_ssh_state_allocate_id_monotonic() {
        // 验证 session_id 从 1 开始单调递增 (与 PTY 的 id 空间独立)
        let state = SshState::default();
        assert_eq!(state.allocate_id(), 1);
        assert_eq!(state.allocate_id(), 2);
        assert_eq!(state.allocate_id(), 3);
    }

    #[test]
    fn test_ssh_state_get_returns_none_for_unknown_id() {
        // ssh_command 第 1 步: state.get(session_id) 返回 None → ok_or_else → Err
        // 这里验证 get 在未插入时确实返回 None (ssh_command 错误路径前置条件)
        let state = SshState::default();
        let _id = state.allocate_id(); // id=1, 但未 insert
        assert!(state.get(1).is_none());
    }
}
