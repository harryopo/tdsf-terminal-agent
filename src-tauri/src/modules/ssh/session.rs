//! SSH PTY 会话 (P2-B T-P2-03)
//! ============================================================================
//! 封装 russh::Channel 的 PTY 交互,提供与本地 PTY 一致的接口:
//! - `open_pty`: 请求 PTY + shell,启动 reader task 推送输出
//! - `write_data`: 写入数据 (前端按键)
//! - `resize`: 调整窗口大小 (window_change)
//! - `close`: 关闭 channel + disconnect
//!
//! ## 状态机
//! ```text
//! [Idle] --open_pty--> [Connecting] --channel opened--> [Connected]
//! [Connected] --ExitStatus--> [Closing] --channel close--> [Closed]
//! [Connected] --KeepaliveTimeout--> [Failed] --close--> [Closed]
//! ```
//!
//! ## reader task
//! 替代本地 PTY 的 reader 线程,使用 tokio::spawn 跑 `channel.wait()` 循环:
//! - `ChannelMsg::Data { data }` → 推送到 on_data channel
//! - `ChannelMsg::ExitStatus { exit_status }` → 推送到 on_exit channel,标记 exited
//! - `ChannelMsg::Eof` / `Close` → 标记 exited
//!
//! 复用本地 PTY 的背压机制 (MAX_PENDING = 4 MiB + OVERFLOW_NOTICE) 由 Tauri Channel 自身处理。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh::client::Handle;
use russh::{ChannelMsg, Disconnect};
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::modules::ssh::client::SshClient;
use crate::modules::ssh::handler::SshClientHandler;

/// SSH 会话状态 (用于状态栏显示)
///
/// 对应 SSH 连接生命周期各阶段,前端根据状态渲染不同 UI。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshSessionState {
    /// 空闲 (尚未连接)
    Idle,
    /// 正在建立 TCP 连接
    Connecting,
    /// SSH 握手中 (version exchange + kex)
    Handshaking,
    /// 主机验证中 (TOFU 询问用户)
    HostVerifying,
    /// 认证中 (password/publickey)
    Authenticating,
    /// 已认证 (准备开 channel)
    Authenticated,
    /// 已连接 (PTY 会话已建立)
    Connected,
    /// 重连中 (KeepaliveTimeout 后自动重连,P3 实现)
    Reconnecting,
    /// 失败 (连接/认证/超时错误)
    Failed,
    /// 已关闭 (主动断开或服务器断开)
    Closed,
}

impl Default for SshSessionState {
    fn default() -> Self {
        Self::Idle
    }
}

/// SSH 状态事件 (推送到前端 on_status channel)
///
/// 前端通过监听此事件实时更新状态栏。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshStatusEvent {
    /// 当前状态
    pub state: SshSessionState,
    /// 主机名
    pub host: String,
    /// 端口
    pub port: u16,
    /// 用户名 (认证阶段后填充)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// 错误信息 (Failed 状态时填充)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 时间戳 (Unix 毫秒)
    pub timestamp: i64,
}

impl SshStatusEvent {
    fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    pub fn connecting(host: &str, port: u16) -> Self {
        Self {
            state: SshSessionState::Connecting,
            host: host.to_string(),
            port,
            user: None,
            error: None,
            timestamp: Self::now(),
        }
    }

    pub fn handshaking(host: &str, port: u16) -> Self {
        Self {
            state: SshSessionState::Handshaking,
            host: host.to_string(),
            port,
            user: None,
            error: None,
            timestamp: Self::now(),
        }
    }

    pub fn authenticating(host: &str, port: u16, user: &str) -> Self {
        Self {
            state: SshSessionState::Authenticating,
            host: host.to_string(),
            port,
            user: Some(user.to_string()),
            error: None,
            timestamp: Self::now(),
        }
    }

    pub fn authenticated(host: &str, port: u16, user: &str) -> Self {
        Self {
            state: SshSessionState::Authenticated,
            host: host.to_string(),
            port,
            user: Some(user.to_string()),
            error: None,
            timestamp: Self::now(),
        }
    }

    pub fn connected(host: &str, port: u16, user: &str) -> Self {
        Self {
            state: SshSessionState::Connected,
            host: host.to_string(),
            port,
            user: Some(user.to_string()),
            error: None,
            timestamp: Self::now(),
        }
    }

    pub fn failed(host: &str, port: u16, error: &str) -> Self {
        Self {
            state: SshSessionState::Failed,
            host: host.to_string(),
            port,
            user: None,
            error: Some(error.to_string()),
            timestamp: Self::now(),
        }
    }

    pub fn closed(host: &str, port: u16) -> Self {
        Self {
            state: SshSessionState::Closed,
            host: host.to_string(),
            port,
            user: None,
            error: None,
            timestamp: Self::now(),
        }
    }
}

/// SSH 会话错误
#[derive(Debug, thiserror::Error)]
pub enum SshSessionError {
    /// russh 错误
    #[error("russh error: {0}")]
    Russh(#[from] russh::Error),

    /// 会话已关闭
    #[error("session already closed")]
    Closed,

    /// 其他错误
    #[error("{0}")]
    Other(String),
}

/// SSH PTY 会话
///
/// 持有 russh Channel 的写半部 + 状态信息。
/// reader task 在后台独立运行,通过 Channel<Vec<u8>> 推送输出到前端。
pub struct SshSession {
    /// russh 客户端 Handle (用于 disconnect)
    ///
    /// 用 Mutex 保护,close 时持有锁避免并发冲突。
    handle: Arc<Mutex<Option<Handle<SshClientHandler>>>>,

    /// russh Channel 写半部
    ///
    /// 用 Mutex 保护,write_data 时持有锁。
    /// 实际上 russh Channel 内部是 Send + Sync,但 API 要求 &self,
    /// 用 Mutex 简化生命周期管理。
    channel_write: Arc<Mutex<Option<russh::ChannelWriteHalf<russh::client::Msg>>>>,

    /// 当前状态 (原子读,无需锁)
    state: Arc<std::sync::RwLock<SshSessionState>>,

    /// PTY channel 是否已退出 (原子标志,reader task 设置)
    ///
    /// 仅表示 PTY 通道生命周期: reader task 拿到 ExitStatus/Eof/Close/None
    /// 时设置。PTY 死亡不一定意味着 SSH 连接断开 (例如用户在远端敲 `exit`
    /// 退出 shell,但 SFTP 仍可继续用)。
    exited: Arc<AtomicBool>,

    /// SSH 连接是否已关闭 (原子标志,close()/Drop 设置)
    ///
    /// TDSF (#20): 解耦 PTY 与 SFTP。PTY reader 死亡不应连坐 SFTP,
    /// 只有 close() / Drop / 服务器主动 disconnect 才设置此标志。
    /// open_sftp_channel 只检查此标志 (不再检查 `exited`)。
    connection_closed: Arc<AtomicBool>,

    /// 主机信息 (用于状态事件 + P2-04 多标签会话标识)
    /// 注: 当前仅在日志/host 字段使用,port/user 预留给 P2-04 SSH 多标签
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    #[allow(dead_code)]
    user: String,
}

impl SshSession {
    /// 打开 PTY 会话
    ///
    /// 流程:
    /// 1. 从 SshClient 获取 Handle
    /// 2. channel_open_session 开 channel
    /// 3. channel.split() 拆分读写半部
    /// 4. request_pty 请求 PTY
    /// 5. request_shell 请求 shell
    /// 6. 启动 reader task (channel.wait() 循环 → on_data)
    /// 7. 推送 Connected 状态到 on_status
    pub async fn open_pty(
        client: SshClient,
        cols: u16,
        rows: u16,
        term: String,
        on_data: Channel<Vec<u8>>,
        on_status: Channel<SshStatusEvent>,
        on_exit: Channel<i32>,
    ) -> Result<Self, SshSessionError> {
        // 1. 获取 Handle
        let handle = client.handle();

        // 从 handler 提取 host/port/user (用于状态事件)
        // 注意: Handle 内部的 handler 不可直接访问,我们通过参数传递
        // 这里假设 SshClient::connect 已经设置了正确的 host/port/user
        // 通过 on_status 最后一次推送 Connected 事件

        // 2. 开 channel
        log::debug!("[ssh] opening session channel");
        let channel = handle.channel_open_session().await?;

        // 3. 拆分读写半部
        let (channel_read, channel_write) = channel.split();

        // 4. 请求 PTY
        //    参数: want_reply=false, term, cols, rows, pix_width=0, pix_height=0, terminal_modes=[]
        //    terminal_modes 留空,使用服务器默认设置
        log::debug!(
            "[ssh] requesting PTY: cols={} rows={} term={}",
            cols,
            rows,
            term
        );
        channel_write
            .request_pty(
                // want_reply=true: 让服务器回 CHANNEL_SUCCESS/FAILURE,
                // 与 SFTP request_subsystem(true) 一致,便于在 reader task
                // 里明确看到 PTY 是否被服务器接受 (诊断 shell 黑屏根因)
                true,
                &term,
                cols as u32,
                rows as u32,
                0,
                0,
                // terminal_modes 用标准空 slice（russh 官方示例做法）。
                // 之前用 `&[(TTY_OP_END, 0)]` 是畸形：TTY_OP_END(0) 是终止符却又带了
                // 4 字节值，疑似导致 OpenSSH 收到 pty-req 后直接硬关 TCP（early eof）。
                &[],
            )
            .await?;

        // 5. 请求 shell
        log::info!("[ssh] requesting interactive shell");
        // want_reply=true: 同上,捕获 shell 请求的 Success/Failure
        channel_write.request_shell(true).await?;

        // 6. 启动 reader task
        //    reader task 在后台运行,通过 on_data 推送输出
        let exited = Arc::new(AtomicBool::new(false));
        let exited_clone = exited.clone();
        let on_data_clone = on_data.clone();
        let on_exit_clone = on_exit.clone();

        tokio::spawn(async move {
            Self::reader_task(channel_read, on_data_clone, on_exit_clone, exited_clone).await;
        });

        // 7. 推送 Connected 状态
        //    (host/port/user 从 handler 字段获取,这里简化为占位)
        //    实际生产中应从 handle 中提取,但 russh 0.61 API 不直接暴露 handler
        //    解决方案: SshClient::connect 时记录 host/port/user,通过返回值传递
        //    此处用空字符串,前端通过 connect 时的参数补全
        let host = String::new(); // 占位,SshClient 应传递
        let port: u16 = 22;
        let user = String::new();
        let _ = on_status.send(SshStatusEvent::connected(&host, port, &user));

        Ok(Self {
            handle: Arc::new(Mutex::new(Some(handle))),
            channel_write: Arc::new(Mutex::new(Some(channel_write))),
            state: Arc::new(std::sync::RwLock::new(SshSessionState::Connected)),
            exited,
            // TDSF (#20): 连接刚建立,未关闭
            connection_closed: Arc::new(AtomicBool::new(false)),
            host,
            port,
            user,
        })
    }

    /// reader task: 异步读取 channel 输出并推送到前端
    ///
    /// 替代本地 PTY 的 reader 线程,使用 tokio::spawn 跑异步循环。
    async fn reader_task(
        mut channel_read: russh::ChannelReadHalf,
        on_data: Channel<Vec<u8>>,
        on_exit: Channel<i32>,
        exited: Arc<AtomicBool>,
    ) {
        log::info!("[ssh] reader task started");
        let mut exit_code: Option<i32> = None;
        let mut first_data = true;

        loop {
            match channel_read.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    // 推送输出到前端
                    if first_data {
                        log::info!("[ssh] reader first data: {} bytes", data.len());
                        first_data = false;
                    }
                    let bytes: Vec<u8> = data.to_vec();
                    if let Err(e) = on_data.send(bytes) {
                        log::warn!("[ssh] on_data send failed: {}", e);
                        break;
                    }
                }
                Some(ChannelMsg::ExtendedData { ext, data }) => {
                    // stderr (ext=1) 也推送到 on_data,前端区分需依赖终端转义序列
                    // 与本地 PTY 行为一致 (本地 PTY 不区分 stdout/stderr)
                    log::debug!("[ssh] extended data (ext={}): {} bytes", ext, data.len());
                    let bytes: Vec<u8> = data.to_vec();
                    if let Err(e) = on_data.send(bytes) {
                        log::warn!("[ssh] on_data send failed (ext): {}", e);
                        break;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    log::info!("[ssh] remote exit status: {}", exit_status);
                    exit_code = Some(exit_status as i32);
                    // 不立即 break,继续读取剩余输出直到 EOF/Close
                }
                Some(ChannelMsg::Eof) => {
                    log::info!("[ssh] channel EOF");
                    // 服务器关闭写端,继续等 ExitStatus (如果还没收到)
                }
                Some(ChannelMsg::Close) => {
                    log::info!("[ssh] channel closed by peer");
                    break;
                }
                Some(ChannelMsg::Success) => {
                    // want_reply=true 时,服务器接受 PTY/shell 请求的确认
                    log::info!("[ssh] channel request Success (pty/shell accepted, data should follow)");
                }
                Some(ChannelMsg::Failure) => {
                    // 服务器拒绝 PTY/shell 请求 → shell 黑屏的根因
                    log::warn!("[ssh] channel request Failure (pty/shell REJECTED by server)");
                }
                Some(msg) => {
                    log::info!("[ssh] other channel msg: {:?}", msg);
                }
                None => {
                    // channel 已关闭
                    log::info!("[ssh] channel.wait() returned None (channel gone)");
                    break;
                }
            }
        }

        // 推送 exit code
        let code = exit_code.unwrap_or(-1);
        if let Err(e) = on_exit.send(code) {
            log::warn!("[ssh] on_exit send failed: {}", e);
        }

        // 标记已退出
        exited.store(true, Ordering::Release);
        log::info!("[ssh] reader task done, exit_code={}", code);
    }

    /// 写入数据 (前端按键)
    pub async fn write_data(&self, data: &[u8]) -> Result<(), SshSessionError> {
        // TDSF (#20): PTY 死亡或连接断开都不能写 PTY
        if self.exited.load(Ordering::Acquire)
            || self.connection_closed.load(Ordering::Acquire)
        {
            return Err(SshSessionError::Closed);
        }

        let mut guard = self.channel_write.lock().await;
        let channel_write = guard
            .as_mut()
            .ok_or(SshSessionError::Closed)?;

        // 使用 data_bytes 直接发送 Bytes,避免 AsyncRead 桥接
        channel_write
            .data_bytes(bytes::Bytes::copy_from_slice(data))
            .await?;
        Ok(())
    }

    /// 调整窗口大小 (window_change)
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), SshSessionError> {
        // TDSF (#20): PTY 死亡或连接断开都不能 resize
        if self.exited.load(Ordering::Acquire)
            || self.connection_closed.load(Ordering::Acquire)
        {
            return Err(SshSessionError::Closed);
        }

        let mut guard = self.channel_write.lock().await;
        let channel_write = guard
            .as_mut()
            .ok_or(SshSessionError::Closed)?;

        log::debug!("[ssh] window_change: cols={} rows={}", cols, rows);
        channel_write
            .window_change(cols as u32, rows as u32, 0, 0)
            .await?;
        Ok(())
    }

    /// 关闭会话
    ///
    /// 1. 关闭 channel (channel.eof + channel.close)
    /// 2. 断开 SSH 连接 (handle.disconnect)
    /// 3. 清空 handle/channel_write (drop 释放资源)
    /// 4. 更新状态为 Closed
    pub async fn close(&self) -> Result<(), SshSessionError> {
        log::info!("[ssh] closing session: host={}", self.host);

        // 1. 关闭 channel 写半部
        {
            let mut guard = self.channel_write.lock().await;
            if let Some(channel_write) = guard.take() {
                // drop channel_write 会触发 channel close
                // russh 内部会发送 EOF + close 消息
                drop(channel_write);
            }
        }

        // 2. 断开 SSH 连接
        {
            let mut guard = self.handle.lock().await;
            if let Some(handle) = guard.take() {
                // Disconnect::ByApplication 表示客户端主动断开
                // TDSF (#20): disconnect 失败降到 debug 级 (close 本就是要关,
                // 失败的 send/recv 都是预期内的, 不值得 warn 刷屏)。
                if let Err(e) = handle
                    .disconnect(Disconnect::ByApplication, "user closed", "en")
                    .await
                {
                    log::debug!("[ssh] disconnect failed (expected during close): {}", e);
                    // 即使 disconnect 失败,drop handle 也会清理资源
                }
                drop(handle);
            }
        }

        // 3. 更新状态
        {
            let mut state = self.state.write().unwrap_or_else(|e| e.into_inner());
            *state = SshSessionState::Closed;
        }

        // TDSF (#20): close 同时设两个标志 — 整个连接都关了,
        // PTY 也跟着死 (write_data/resize 会因 connection_closed 直接返回 Closed)。
        self.exited.store(true, Ordering::Release);
        self.connection_closed.store(true, Ordering::Release);
        log::info!("[ssh] session closed: host={}", self.host);
        Ok(())
    }

    /// 获取当前状态
    pub fn state(&self) -> SshSessionState {
        self.state.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 是否已退出 (PTY 通道退出 或 SSH 连接关闭)
    ///
    /// 保留旧接口契约: 任何一边死了都返回 true。
    /// 调用方若要区分 PTY 死 vs 连接死, 用 `is_pty_exited` / `is_connection_closed`。
    pub fn is_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
            || self.connection_closed.load(Ordering::Acquire)
    }

    /// PTY 通道是否已退出 (reader task 拿到 ExitStatus/Eof/Close/None)
    pub fn is_pty_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    /// SSH 连接是否已关闭 (close()/Drop/服务器主动 disconnect)
    pub fn is_connection_closed(&self) -> bool {
        self.connection_closed.load(Ordering::Acquire)
    }

    /// 打开 SFTP channel (T-P2-05 新增,扩展接口)
    ///
    /// 复用现有 SSH Handle 开一个新 channel,请求 sftp 子系统,返回 channel stream。
    /// 上层 SftpSession::new(stream) 用此 stream 初始化 SFTP 协议握手。
    ///
    /// 注意: 不影响 PTY 主通道,独立 channel 与 PTY 并发工作。
    ///       限 channel.subsystem(true, "sftp") 用法 (RFC 4254 6.5)。
    ///
    /// TDSF (#20): **解耦 PTY 与 SFTP** — 只检查 `connection_closed`,
    /// 不再检查 `exited`。PTY reader 死亡 (用户敲 `exit` 退出 shell) 后,
    /// SFTP 仍能继续用, 因为 SSH 连接本身还在。
    ///
    /// # 返回
    /// `Channel<Msg>::into_stream()` 结果,即 AsyncRead+AsyncWrite 流。
    pub async fn open_sftp_channel(
        &self,
    ) -> Result<russh::ChannelStream<russh::client::Msg>, SshSessionError> {
        // TDSF (#20): 只在连接已断时拒绝 SFTP, PTY 死亡不影响
        if self.connection_closed.load(Ordering::Acquire) {
            return Err(SshSessionError::Closed);
        }

        // 借用 handle 开 channel (不 take,保持 SSH 连接)
        // TDSF 2026-08-04 (Rust-C2): 与 exec_command 一致, channel 建立后立即释放锁,
        // 避免持锁阻塞同会话并发操作
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(SshSessionError::Closed)?;
        let channel = handle.channel_open_session().await?;
        drop(handle_guard);

        // 请求 sftp 子系统 (RFC 4254 6.5)
        // want_reply=true: 等待服务器确认子系统启动
        channel.request_subsystem(true, "sftp").await?;

        // 转为 stream (russh-sftp 期望 AsyncRead+AsyncWrite)
        Ok(channel.into_stream())
    }

    /// 执行单条 SSH 命令并返回结构化结果（exec 模式，非 PTY）
    ///
    /// TDSF 魔改 P0-D（2026-07-30）：为运维 Agent 提供"执行命令并拿回输出"能力，
    /// 与 PTY 交互（`write_data`）解耦。复用现有 SSH Handle 开新 channel，
    /// 用 `channel.exec()` 而非 `request_pty + request_shell`，适合一次性命令
    /// （`uptime` / `systemctl status nginx` / `df -h` 等）。
    ///
    /// # 与 PTY 模式的区别
    /// - **PTY**：常驻 shell，前端按键 → ssh_write → 服务器 shell 回显 + 输出
    /// - **exec**：单条命令，stdin 关闭，命令结束 → channel EOF + ExitStatus
    /// - 两者并行不冲突：各自独立 channel，与 SFTP channel 一样复用 Handle
    ///
    /// # 流程
    /// 1. 借用 Handle（不 take，保持 SSH 连接）
    /// 2. `handle.channel_open_session()` 开新 channel
    /// 3. `channel.exec(true, command)` 请求执行（want_reply=true 等服务器确认）
    /// 4. 循环 `channel.wait()` 收集输出：
    ///    - `ChannelMsg::Data` → stdout
    ///    - `ChannelMsg::ExtendedData { ext: 1 }` → stderr
    ///    - `ChannelMsg::ExitStatus` → 退出码（继续读到 EOF/Close）
    ///    - `ChannelMsg::Eof` / `Close` / `None` → 跳出
    /// 5. 用 `tokio::time::timeout` 包装整体避免命令卡死（默认 30s）
    /// 6. channel.drop() 触发底层关闭
    ///
    /// # 参数
    /// - `command`: 要执行的命令（如 `uptime` / `systemctl status nginx`）
    ///   注意：远端走 `/bin/sh -c <command>`，支持管道 / 重定向 / 链式
    /// - `timeout_secs`: 超时秒数（None 时用默认 30s）
    ///
    /// # 返回
    /// `SshCommandOutput { stdout, stderr, exit_code }`
    /// - 超时：`exit_code = -1`，stderr 含超时说明
    /// - 命令未发 ExitStatus（被信号杀死）：`exit_code = -1`
    ///
    /// # 错误
    /// - `Closed`：SSH 连接已断（`connection_closed=true`）
    /// - `Russh`：开 channel / exec 调用失败
    ///
    /// # 与 Python 端的契约
    /// `strands_backend/tools/__init__.py:execute_via_ssh` 期望返回值：
    /// ```json
    /// { "ok": true, "output": "...", "exit_code": 0, "duration": 0.123 }
    /// ```
    /// 上层 `ssh_command` Tauri command 负责包装成此格式，本方法只返回原始数据。
    pub async fn exec_command(
        &self,
        command: &str,
        timeout_secs: Option<u64>,
    ) -> Result<SshCommandOutput, SshSessionError> {
        // 1. 连接检查（与 open_sftp_channel 一致，PTY 死亡不影响 exec）
        if self.connection_closed.load(Ordering::Acquire) {
            return Err(SshSessionError::Closed);
        }

        // 2. 借用 handle 开 channel（锁只覆盖 channel 创建这一个 RTT）
        //    TDSF 2026-08-04 (Rust-C2): 注意 russh 0.61 的 Handle **不实现 Clone**
        //    (审查报告"Handle 实现 Clone"有误)。channel 一旦建立即独立于 handle,
        //    因此立刻释放锁——后续 exec / 收集输出在锁外执行。
        //    效果: 同一会话的 close()/其他 exec/open_sftp_channel 最多阻塞一个 RTT,
        //    而非整个命令执行期(最长 30s)。
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(SshSessionError::Closed)?;
        let mut channel = handle.channel_open_session().await?;
        drop(handle_guard);

        log::info!(
            "[ssh] exec_command start: cmd={:?}, timeout={:?}s",
            command,
            timeout_secs.unwrap_or(30)
        );

        // 4. 请求 exec（RFC 4254 6.4，want_reply=true 等服务器确认 exec 启动）
        //    russh 0.61 签名：exec(&self, want_reply: bool, command: &str) -> Result<()>
        channel.exec(true, command).await?;

        // 5. 收集输出（带超时保护）
        let timeout_dur =
            std::time::Duration::from_secs(timeout_secs.unwrap_or(30));
        let collect_fut = Self::collect_exec_output(&mut channel, command);

        let (stdout, stderr, exit_code) = match tokio::time::timeout(
            timeout_dur,
            collect_fut,
        )
        .await
        {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                log::error!(
                    "[ssh] exec_command channel error: cmd={:?} err={}",
                    command,
                    e
                );
                return Err(SshSessionError::Russh(e));
            }
            Err(_elapsed) => {
                // 超时：返回部分输出 + exit_code=-1（与 JSch/AgentSSH 约定一致）
                log::warn!(
                    "[ssh] exec_command timeout after {}s: cmd={:?}",
                    timeout_secs.unwrap_or(30),
                    command
                );
                let stderr_msg = format!(
                    "\n[tdsf-exec-timeout] command timed out after {}s\n",
                    timeout_secs.unwrap_or(30)
                );
                // channel drop 会触发底层关闭
                return Ok(SshCommandOutput {
                    stdout: Vec::new(),
                    stderr: stderr_msg.into_bytes(),
                    exit_code: -1,
                });
            }
        };

        log::info!(
            "[ssh] exec_command done: cmd={:?} exit={} stdout={}B stderr={}B",
            command,
            exit_code,
            stdout.len(),
            stderr.len()
        );

        Ok(SshCommandOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    /// exec 模式输出收集器（reader_task 的简化版，无 Channel<T> 推送）
    ///
    /// 与 reader_task 的区别：
    /// - 不推送前端，只本地收集
    /// - 持续读到 ExitStatus + EOF/Close，而不是常驻循环
    /// - 不区分 first_data 标志（exec 输出量通常较少）
    async fn collect_exec_output(
        channel: &mut russh::Channel<russh::client::Msg>,
        command: &str,
    ) -> Result<(Vec<u8>, Vec<u8>, i32), russh::Error> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code: i32 = -1; // 默认 -1，收到 ExitStatus 才更新

        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    stdout.extend_from_slice(&data);
                }
                Some(ChannelMsg::ExtendedData { ext, data }) => {
                    // ext=1 是 stderr（RFC 4254 5.2）
                    // ext=2 是 "ExitStatus 之外的扩展数据"（罕见，合并到 stderr）
                    if ext == 1 || ext == 2 {
                        stderr.extend_from_slice(&data);
                    } else {
                        log::debug!(
                            "[ssh] exec unknown ext={}: {} bytes",
                            ext,
                            data.len()
                        );
                        stderr.extend_from_slice(&data);
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = exit_status as i32;
                    log::debug!(
                        "[ssh] exec exit_status={} cmd={:?}",
                        exit_code,
                        command
                    );
                    // 不立即 break，继续读剩余输出直到 EOF/Close
                }
                Some(ChannelMsg::Eof) => {
                    log::debug!("[ssh] exec EOF");
                    // 服务器关闭写端，可能还有 ExitStatus 后到，继续等
                }
                Some(ChannelMsg::Close) => {
                    log::debug!("[ssh] exec channel closed by peer");
                    break;
                }
                Some(ChannelMsg::Success) => {
                    // want_reply=true 的 exec 请求被服务器接受
                    log::debug!("[ssh] exec request Success");
                }
                Some(ChannelMsg::Failure) => {
                    // 服务器拒绝 exec 请求（罕见，权限/策略禁止）
                    log::warn!(
                        "[ssh] exec request Failure (REJECTED by server) cmd={:?}",
                        command
                    );
                    // TDSF 修复 2026-08-01 (P1-NEW-v2-7): 服务器拒绝 exec 后
                    // 不会再发 ExitStatus/数据，继续等会挂到超时（默认 30s）
                    // 白白浪费时间。立即 break，并把拒绝标记写入 stderr，
                    // 让上层能区分"被拒"与"超时"（两者 exit_code 均为 -1）。
                    stderr.extend_from_slice(
                        b"\n[tdsf-exec-rejected] exec request rejected by server\n",
                    );
                    break;
                }
                Some(msg) => {
                    log::debug!("[ssh] exec other channel msg: {:?}", msg);
                }
                None => {
                    log::debug!("[ssh] exec channel.wait() returned None");
                    break;
                }
            }
        }

        Ok((stdout, stderr, exit_code))
    }
}

/// SSH exec 命令执行结果（exec 模式，非 PTY）
///
/// TDSF 魔改 P0-D（2026-07-30）：为运维 Agent 提供结构化输出，
/// 上层 `ssh_command` Tauri command 包装为 `{ok, output, exit_code, duration}` JSON。
#[derive(Debug, Clone)]
pub struct SshCommandOutput {
    /// stdout（标准输出，UTF-8 字节）
    pub stdout: Vec<u8>,
    /// stderr（标准错误，UTF-8 字节）
    pub stderr: Vec<u8>,
    /// 退出码（0=成功，1-255=Unix 标准，-1=超时/未收到 ExitStatus）
    pub exit_code: i32,
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // drop 时设置 connection_closed (即使 reader task 还在跑, handle drop
        // 会触发底层 disconnect, 后续 open_sftp_channel 会因 connection_closed
        // 立即拒绝, 避免 "Channel send error" 之类下游 panic)。
        // PTY exited 也设上 (整连接都死了, PTY 自然也死)。
        if !self.exited.load(Ordering::Acquire) {
            self.exited.store(true, Ordering::Release);
        }
        self.connection_closed.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_session_state_default() {
        let state = SshSessionState::default();
        assert_eq!(state, SshSessionState::Idle);
    }

    #[test]
    fn test_ssh_status_event_connecting() {
        let event = SshStatusEvent::connecting("example.com", 22);
        assert_eq!(event.state, SshSessionState::Connecting);
        assert_eq!(event.host, "example.com");
        assert_eq!(event.port, 22);
        assert!(event.user.is_none());
        assert!(event.error.is_none());
    }

    #[test]
    fn test_ssh_status_event_failed() {
        let event = SshStatusEvent::failed("example.com", 22, "auth failed");
        assert_eq!(event.state, SshSessionState::Failed);
        assert_eq!(event.error, Some("auth failed".to_string()));
    }

    #[test]
    fn test_ssh_status_event_serialization() {
        let event = SshStatusEvent::connected("host", 22, "user");
        let json = serde_json::to_string(&event).unwrap();
        // 验证 camelCase 序列化
        assert!(json.contains("\"state\":\"connected\""));
        assert!(json.contains("\"host\":\"host\""));
        assert!(json.contains("\"port\":22"));
        assert!(json.contains("\"user\":\"user\""));
    }

    #[test]
    fn test_ssh_session_state_snake_case() {
        // 验证 snake_case 序列化 (前端 TS 期望 snake_case)
        let json = serde_json::to_string(&SshSessionState::Connected).unwrap();
        assert_eq!(json, "\"connected\"");

        let json = serde_json::to_string(&SshSessionState::HostVerifying).unwrap();
        assert_eq!(json, "\"host_verifying\"");
    }

    // === TDSF P0-D (2026-07-30) 新增测试 ============================================
    //
    // exec_command 是异步方法,依赖真实 russh Handle + 远端 SSH 服务器,
    // 难以做端到端单元测试。这里覆盖可离线验证的两类:
    // 1. SshCommandOutput 结构体: 字段构造 / Debug 输出 / 默认 exit_code 语义
    // 2. exec_command 错误路径: connection_closed=true / handle=None 时
    //    必须立即返回 Err(Closed),不发起任何 channel_open_session / exec 调用
    //
    // 真实链路验证靠 tauri:dev + CDP 9222 实测 (见 docs/dev-state.md §P0-D)。

    /// 构造测试用 SshSession,所有字段为 None / 默认值
    ///
    /// 同模块可访问私有字段,绕过 open_pty 的真实连接依赖。
    /// `connection_closed` / `exited` 由参数控制,覆盖不同状态分支。
    ///
    /// 注: handle 一律构造为 None (模拟 close() 后 handle 被 take 走的场景)。
    /// 真实 Handle 需 russh 连接,无法离线构造。当前测试用例通过
    /// `connection_closed=true` 让 exec_command 在第 1 步就提前返回 Closed,
    /// 不会触达 handle 借用;`connection_closed=false` 时让 handle 借用
    /// 走 `as_ref() → None` 路径,同样返回 Closed (防御性分支覆盖)。
    fn make_test_session(connection_closed: bool, exited: bool) -> SshSession {
        SshSession {
            handle: Arc::new(Mutex::new(None)),
            channel_write: Arc::new(Mutex::new(None)),
            state: Arc::new(std::sync::RwLock::new(if connection_closed {
                SshSessionState::Closed
            } else {
                SshSessionState::Connected
            })),
            exited: Arc::new(AtomicBool::new(exited)),
            connection_closed: Arc::new(AtomicBool::new(connection_closed)),
            host: String::new(),
            port: 0,
            user: String::new(),
        }
    }

    #[test]
    fn test_ssh_command_output_construction() {
        // 验证 SshCommandOutput 字段构造 (P0-D 返回类型)
        let out = SshCommandOutput {
            stdout: b"hello\n".to_vec(),
            stderr: Vec::new(),
            exit_code: 0,
        };
        assert_eq!(out.stdout, b"hello\n");
        assert!(out.stderr.is_empty());
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn test_ssh_command_output_default_exit_code() {
        // 验证默认 exit_code 语义: -1 表示"未收到 ExitStatus / 超时 / 异常"
        // (与 collect_exec_output 的 exit_code: i32 = -1 默认值一致)
        let out = SshCommandOutput {
            stdout: Vec::new(),
            stderr: b"timeout".to_vec(),
            exit_code: -1,
        };
        assert_eq!(out.exit_code, -1);
        assert!(out.stdout.is_empty());
        assert_eq!(out.stderr, b"timeout");
    }

    #[test]
    fn test_ssh_command_output_debug_format() {
        // 验证 Debug 派生 (日志里会打印 SshCommandOutput)
        let out = SshCommandOutput {
            stdout: b"ok".to_vec(),
            stderr: b"warn".to_vec(),
            exit_code: 42,
        };
        let debug_str = format!("{:?}", out);
        assert!(debug_str.contains("SshCommandOutput"));
        assert!(debug_str.contains("stdout"));
        assert!(debug_str.contains("stderr"));
        assert!(debug_str.contains("exit_code"));
        assert!(debug_str.contains("42"));
    }

    #[test]
    fn test_ssh_command_output_clone() {
        // 验证 Clone 派生 (跨 task 传递时常用 .clone())
        let original = SshCommandOutput {
            stdout: b"data".to_vec(),
            stderr: b"err".to_vec(),
            exit_code: 1,
        };
        let cloned = original.clone();
        assert_eq!(cloned.stdout, original.stdout);
        assert_eq!(cloned.stderr, original.stderr);
        assert_eq!(cloned.exit_code, original.exit_code);
    }

    #[tokio::test]
    async fn test_exec_command_returns_closed_when_connection_closed() {
        // 验证 exec_command 在 connection_closed=true 时立即返回 Err(Closed),
        // 不会触达 handle 借用 / channel_open_session (避免对已断连接的二次操作)
        let session = make_test_session(
            /* connection_closed */ true,
            /* exited */ true,
        );

        let result = session.exec_command("uptime", None).await;
        assert!(
            matches!(result, Err(SshSessionError::Closed)),
            "expected Err(Closed) when connection_closed=true, got {:?}",
            result
        );
    }

    #[tokio::test]
    async fn test_exec_command_returns_closed_when_handle_none() {
        // 验证 exec_command 在 handle=None (close() 后 take 走) 时返回 Err(Closed)。
        // 此场景 connection_closed=false (模拟连接未断但 handle 已被 take 的边界),
        // 但 handle.as_ref() 返回 None → 返回 Closed。
        // 注意:此场景在生产中不应发生 (close() 同时设 connection_closed=true),
        // 这里覆盖防御性分支 (collect_exec_output 的 handle 借用路径)。
        let session = make_test_session(
            /* connection_closed */ false,
            /* exited */ false,
        );

        let result = session.exec_command("ls /tmp", Some(5)).await;
        assert!(
            matches!(result, Err(SshSessionError::Closed)),
            "expected Err(Closed) when handle=None, got {:?}",
            result
        );
    }

    #[tokio::test]
    async fn test_exec_command_returns_closed_with_custom_timeout() {
        // 验证 timeout 参数不影响错误路径的提前返回
        // (timeout 仅在 collect_exec_output 阶段生效,connection_closed 在 1. 步拦截)
        let session = make_test_session(true, true);

        let result = session.exec_command("sleep 100", Some(1)).await;
        assert!(matches!(result, Err(SshSessionError::Closed)));
    }

    #[test]
    fn test_is_connection_closed_after_construction() {
        // 验证 make_test_session 的状态标志正确 (测试工具自身的自检)
        let closed = make_test_session(true, true);
        assert!(closed.is_connection_closed());
        assert!(closed.is_exited()); // exited 也 true (close 同时设两者)

        let open = make_test_session(false, false);
        assert!(!open.is_connection_closed());
        assert!(!open.is_exited());
    }
}
