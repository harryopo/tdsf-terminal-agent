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
            let mut state = self.state.write().unwrap();
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
        self.state.read().unwrap().clone()
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

        // 借用 handle (不 take,保持 SSH 连接)
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(SshSessionError::Closed)?;

        // 开新 channel (与 PTY channel 并发)
        let channel = handle.channel_open_session().await?;

        // 请求 sftp 子系统 (RFC 4254 6.5)
        // want_reply=true: 等待服务器确认子系统启动
        channel.request_subsystem(true, "sftp").await?;

        // 转为 stream (russh-sftp 期望 AsyncRead+AsyncWrite)
        Ok(channel.into_stream())
    }
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
}
