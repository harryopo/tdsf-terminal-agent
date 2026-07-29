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
pub use session::{SshSession, SshSessionState, SshStatusEvent};
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
        self.sessions.write().unwrap().insert(id, session);
    }

    /// 取出会话 (移除)
    /// 同时移除对应的 SFTP 会话 (T-P2-05)
    pub fn take(&self, id: u32) -> Option<Arc<SshSession>> {
        // 同步清理 SFTP 会话缓存
        if let Some(sftp) = self.sftp_sessions.write().unwrap().remove(&id) {
            // 异步关闭 SFTP 会话 (不阻塞 SSH 断开流程)
            let sftp_clone = sftp.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = sftp_clone.close().await {
                    log::warn!("[ssh] SFTP close on disconnect failed: {}", e);
                }
            });
        }
        self.sessions.write().unwrap().remove(&id)
    }

    /// 获取会话引用 (不移除)
    pub fn get(&self, id: u32) -> Option<Arc<SshSession>> {
        self.sessions.read().unwrap().get(&id).cloned()
    }

    /// 列出所有会话 ID (用于 ssh_status 命令)
    pub fn list_ids(&self) -> Vec<u32> {
        self.sessions.read().unwrap().keys().copied().collect()
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
        // 1. 检查缓存
        if let Some(sftp) = self.sftp_sessions.read().unwrap().get(&session_id) {
            return Ok(sftp.clone());
        }

        // 2. 缓存未命中,创建新 SFTP 会话
        let session = self
            .get(session_id)
            .ok_or_else(|| format!("SSH session not found: id={session_id}"))?;

        log::info!("[sftp] creating new SFTP session for ssh_id={}", session_id);
        let stream = session
            .open_sftp_channel()
            .await
            .map_err(|e| format!("open SFTP channel failed: {e}"))?;
        let sftp = Arc::new(SftpSession::new(stream).await?);

        // 3. 写入缓存
        self.sftp_sessions
            .write()
            .unwrap()
            .insert(session_id, sftp.clone());

        Ok(sftp)
    }

    /// 移除 SFTP 会话 (用于主动关闭 SFTP)
    #[allow(dead_code)]
    pub fn remove_sftp(&self, session_id: u32) -> Option<Arc<SftpSession>> {
        self.sftp_sessions.write().unwrap().remove(&session_id)
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
    let sessions = state.sessions.read().unwrap();
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
