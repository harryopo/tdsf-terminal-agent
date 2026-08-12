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

use crate::modules::ssh::client::{SshClient, SshConnectParams};
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

    /// 重连中状态 (P3 #20: KeepaliveTimeout / 网络抖动 / 服务器重启后自动重连)
    pub fn reconnecting(host: &str, port: u16, attempt: u32) -> Self {
        Self {
            state: SshSessionState::Reconnecting,
            host: host.to_string(),
            port,
            user: None,
            error: Some(format!("第 {attempt} 次重连")),
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

/// 自动重连配置 (P3 #20)
///
/// 由 `ssh_connect` 命令在 `open_pty` 成功后调用 `enable_reconnect` 注入。
/// 保存重连所需的全部参数: 连接参数 + PTY 尺寸 + 三个前端 channel。
/// 重连成功后, 新 reader task 推送到**同一批** channel, 前端无需感知。
///
/// Clone 为手动实现 (见下方 impl), 避免 derive 给泛型 R 加不必要的 Clone 约束。
pub struct SshReconnectConfig<R: tauri::Runtime = tauri::Wry> {
    /// Tauri AppHandle (重连时 SshClient::connect 需要, 用于 TOFU 事件)
    ///
    /// 泛型化 Runtime (默认 Wry): 测试用 tauri::test::mock_app() (MockRuntime)
    /// 即可构造, 无需构建真实 Wry App。
    pub app_handle: tauri::AppHandle<R>,
    /// 连接参数 (host/port/user/auth, 含密码/私钥路径)
    pub params: SshConnectParams,
    /// PTY 尺寸 (cols/rows) 与终端类型 (重连后重开 PTY 用)
    pub cols: u16,
    pub rows: u16,
    pub term: String,
    /// 输出推送 channel (与首次 open_pty 传入的同一个)
    pub on_data: Channel<Vec<u8>>,
    /// 状态推送 channel (同上)
    pub on_status: Channel<SshStatusEvent>,
    /// 退出码推送 channel (同上)
    pub on_exit: Channel<i32>,
}

// 手动实现 Clone (不用 derive): derive 会给泛型参数 R 添加 `R: Clone` 约束,
// 而 tauri::Runtime 不要求 Clone, 导致 `SshReconnectConfig<R>: Clone` 不成立。
// 各字段本身无条件 Clone (AppHandle<R>/Channel/参数), 手动 impl 可省去该约束。
impl<R: tauri::Runtime> Clone for SshReconnectConfig<R> {
    fn clone(&self) -> Self {
        Self {
            app_handle: self.app_handle.clone(),
            params: self.params.clone(),
            cols: self.cols,
            rows: self.rows,
            term: self.term.clone(),
            on_data: self.on_data.clone(),
            on_status: self.on_status.clone(),
            on_exit: self.on_exit.clone(),
        }
    }
}

/// 自动重连常量 (P3 #20)
const RECONNECT_MAX_ATTEMPTS: u32 = 6;
const RECONNECT_BACKOFF_INITIAL_SECS: u64 = 1;
const RECONNECT_BACKOFF_CAP_SECS: u64 = 30;

/// 重连退避延迟计算 (纯函数, 可单测)
///
/// 指数退避: 1s → 2s → 4s → 8s → 16s → 30s (封顶 30s)
fn reconnect_backoff_delay(attempt: u32) -> std::time::Duration {
    let secs = RECONNECT_BACKOFF_INITIAL_SECS
        .checked_shl(attempt.saturating_sub(1).min(5))
        .unwrap_or(RECONNECT_BACKOFF_CAP_SECS)
        .min(RECONNECT_BACKOFF_CAP_SECS);
    std::time::Duration::from_secs(secs)
}

/// SSH PTY 会话
///
/// 持有 russh Channel 的写半部 + 状态信息。
/// reader task 在后台独立运行,通过 Channel<Vec<u8>> 推送输出到前端。
pub struct SshSession<R: tauri::Runtime = tauri::Wry> {
    /// russh 客户端 Handle (用于 disconnect)
    ///
    /// 用 Mutex 保护,close 时持有锁避免并发冲突。
    handle: Arc<Mutex<Option<Handle<SshClientHandler<R>>>>>,

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

    /// PTY 断开通知器 (P3 #20)
    ///
    /// reader task 结束时 `notify_waiters`, 自动重连 supervisor 等待唤醒。
    /// 用 `Mutex<Arc<Notify>>` 以便重连成功后替换为新 reader task 的 notify
    /// (新 reader 结束时要能再次唤醒 supervisor)。
    exited_notify: Arc<Mutex<Arc<tokio::sync::Notify>>>,

    /// 自动重连配置 (P3 #20)
    ///
    /// `enable_reconnect` 设置; supervisor 任务读取。None = 不自动重连。
    reconnect: Arc<Mutex<Option<SshReconnectConfig<R>>>>,

    /// 是否收到过 ExitStatus (P3 #20)
    ///
    /// reader task 收到 `ChannelMsg::ExitStatus` 时置 true。supervisor 据此
    /// 区分"shell 正常退出 (exit 命令)" vs "连接异常断开 (Close/None)"。
    /// 用 `Mutex<Arc<AtomicBool>>` 以便重连成功后替换为新 reader 的标志。
    received_exit: Arc<Mutex<Arc<AtomicBool>>>,
}

impl<R: tauri::Runtime> SshSession<R> {
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
        client: SshClient<R>,
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

        // 1.5 方案 A (2026-08-09): 远端 shell 静默注入 OSC 7 (cwd) 钩子。
        //    背景: 此前前端 SshTerminalHost 用"行缓冲 + cd 命令改写"在本地伪造
        //    `cd; printf OSC7`——行缓冲残留 + 元字符黑名单缺 `*`/`?`, 导致用户
        //    `yum install httpd* -y` 被误判为 cd 命令而被整体丢弃改写, 终端"弹出
        //    别的字眼"(用户报告 #18)。现改为行业标准做法 (VS Code / Tabby / Warp):
        //    认证后探测远端 shell 类型 → 写最小注入脚本到 /tmp → PTY exec 启动
        //    注入 shell, 让远端 shell 在命令间隙自动发 OSC 7, 前端输入原样透传。
        //    任何一步失败都降级为 request_shell (仅失去 cwd 同步, 绝不篡改输入)。
        let mut launch_cmd: Option<String> = None;
        match probe_remote_shell(&handle).await {
            Ok(kind) => match write_shell_integration(&handle, kind).await {
                Ok(cmd) => {
                    log::info!("[ssh] shell integration ready: {cmd}");
                    launch_cmd = Some(cmd);
                }
                Err(e) => log::warn!(
                    "[ssh] shell integration write failed, fallback to request_shell: {e}"
                ),
            },
            Err(e) => {
                log::warn!("[ssh] shell probe failed, fallback to request_shell: {e}");
            }
        }

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

        // 5. 启动 shell: 优先 exec 注入 shell (方案 A), 失败降级 request_shell
        //    want_reply=true: 同上, 捕获 shell/exec 请求的 Success/Failure
        match &launch_cmd {
            Some(cmd) => {
                log::info!("[ssh] exec injected shell: {cmd}");
                channel_write.exec(true, cmd.as_str()).await?;
            }
            None => {
                log::info!("[ssh] requesting interactive shell");
                channel_write.request_shell(true).await?;
            }
        }

        // 6. 启动 reader task
        //    reader task 在后台运行,通过 on_data 推送输出
        let exited = Arc::new(AtomicBool::new(false));
        let exited_clone = exited.clone();
        // P3 #20: 记录是否收到 ExitStatus (shell 正常退出 vs 连接异常断开)。
        // supervisor 据此决定是否自动重连: 收到 ExitStatus = 用户 exit / shell
        // 被杀 → 不重连; 连接断开 (Close/None, 无 ExitStatus) → 自动重连。
        let received_exit = Arc::new(Mutex::new(Arc::new(AtomicBool::new(false))));
        let received_exit_clone = received_exit.lock().await.clone();
        let on_data_clone = on_data.clone();
        let on_exit_clone = on_exit.clone();
        let exited_notify = Arc::new(Mutex::new(Arc::new(tokio::sync::Notify::new())));
        let notify_for_reader = exited_notify.lock().await.clone();

        tokio::spawn(async move {
            Self::reader_task(
                channel_read,
                on_data_clone,
                on_exit_clone,
                exited_clone,
                received_exit_clone,
                notify_for_reader,
            )
            .await;
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
            exited_notify,
            reconnect: Arc::new(Mutex::new(None)),
            received_exit,
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
        received_exit: Arc<AtomicBool>,
        exited_notify: Arc<tokio::sync::Notify>,
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
                    // P3 #20: 收到 ExitStatus 说明 shell 进程正常结束 (exit 命令等)。
                    // supervisor 据此不触发自动重连 (用户主动退出, 会话应保持结束态)。
                    received_exit.store(true, Ordering::Release);
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
        // P3 #20: 唤醒自动重连 supervisor (若有)。
        // notify_waiters 不存储 permit: 唤醒当前 waiter 后, 新注册的
        // notified() 需等下一次 notify (重连成功后的新 reader task 结束时会
        // 再次 notify, 因为 open_pty 内部把同一个 Arc<Notify> 传给了新 reader)。
        exited_notify.notify_waiters();
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

    // ========================================================================
    // P3 #20: 自动重连
    // ========================================================================

    /// 启用自动重连 (P3 #20)
    ///
    /// 由 `ssh_connect` 命令在 `open_pty` 成功后调用。注入重连配置。
    /// 后台 supervisor 需另调 `reconnect_supervisor(arc_session)` spawn:
    /// 当 SSH 连接异常断开 (非用户 exit、非主动 close) 时, 按指数退避
    /// 自动重建连接 + PTY, 新 reader task 继续推送到原有三个 channel
    /// (on_data/on_status/on_exit), 前端无需感知。
    ///
    /// 仅在明确配置时才启用; 不调用本方法 = 保持旧行为 (断开即结束)。
    pub async fn enable_reconnect(&self, config: SshReconnectConfig<R>) {
        // 先提取日志字段 (config 随后 move 进 store, 避免 use-after-move)
        let user = config.params.user.clone();
        let host = config.params.host.clone();
        let port = config.params.port;
        *self.reconnect.lock().await = Some(config);
        log::info!(
            "[ssh] auto reconnect enabled: {}@{}:{} (max {} attempts, backoff 1s..30s)",
            user,
            host,
            port,
            RECONNECT_MAX_ATTEMPTS
        );
    }

    /// 获取自动重连配置 (供 Arc 包装的调用方读取)
    async fn reconnect_config(&self) -> Option<SshReconnectConfig<R>> {
        self.reconnect.lock().await.clone()
    }

    /// supervisor 后台循环 (P3 #20)
    ///
    /// 由 `ssh_connect` 命令在 `enable_reconnect` 之后 spawn:
    /// ```text
    /// let session = Arc::new(session);
    /// session.enable_reconnect(config).await;
    /// tokio::spawn(SshSession::reconnect_supervisor(session));
    /// ```
    ///
    /// 流程: 等待 PTY 断开 → 非主动关闭且非正常退出 → 进入重连状态机,
    /// 指数退避重建连接 + PTY, 直到成功或耗尽尝试次数。
    pub async fn reconnect_supervisor(session: Arc<Self>) {
        log::info!("[ssh] reconnect supervisor started");
        loop {
            // 1. 等待 PTY 断开 (notify_waiters 不存储 permit, 无忙轮询)
            let notify = session.exited_notify.lock().await.clone();
            notify.notified().await;

            // 2. 主动关闭 (close / ssh_disconnect) → 退出 supervisor
            if session.connection_closed.load(Ordering::Acquire) {
                log::info!("[ssh] reconnect supervisor: session closed by user, stop");
                return;
            }

            // 3. 未配置重连 → 退出 (防御, 正常不会发生)
            let config = match session.reconnect_config().await {
                Some(c) => c,
                None => {
                    log::debug!("[ssh] reconnect supervisor: no reconnect config, stop");
                    return;
                }
            };

            // 4. shell 正常退出 (收到 ExitStatus = 用户 exit) → 不重连
            if session.received_exit.lock().await.load(Ordering::Acquire) {
                log::info!(
                    "[ssh] pty exited normally (ExitStatus received), skip auto reconnect: {}@{}:{}",
                    config.params.user,
                    config.params.host,
                    config.params.port
                );
                return;
            }

            // 5. 连接异常断开 → 进入重连状态机
            log::warn!(
                "[ssh] connection dropped unexpectedly, starting auto reconnect: {}@{}:{}",
                config.params.user,
                config.params.host,
                config.params.port
            );
            *session.state.write().unwrap_or_else(|e| e.into_inner()) =
                SshSessionState::Reconnecting;
            let _ = config.on_status.send(SshStatusEvent::reconnecting(
                &config.params.host,
                config.params.port,
                1,
            ));

            // 6. 指数退避重连
            let mut ok = false;
            let mut attempt: u32 = 0;
            while attempt < RECONNECT_MAX_ATTEMPTS {
                attempt += 1;
                let delay = reconnect_backoff_delay(attempt);
                log::info!(
                    "[ssh] reconnect attempt {}/{} in {}s",
                    attempt,
                    RECONNECT_MAX_ATTEMPTS,
                    delay.as_secs()
                );
                tokio::time::sleep(delay).await;
                // 退避期间用户主动断开 → 取消重连
                if session.connection_closed.load(Ordering::Acquire) {
                    log::info!("[ssh] reconnect cancelled (user disconnected during backoff)");
                    return;
                }
                if session.perform_reconnect(&config).await.is_ok() {
                    ok = true;
                    break;
                }
            }

            // 7. 结果
            if !ok {
                log::error!(
                    "[ssh] auto reconnect failed after {} attempts: {}@{}:{}",
                    RECONNECT_MAX_ATTEMPTS,
                    config.params.user,
                    config.params.host,
                    config.params.port
                );
                let _ = config.on_status.send(SshStatusEvent::failed(
                    &config.params.host,
                    config.params.port,
                    &format!("自动重连失败 (已重试 {} 次)", RECONNECT_MAX_ATTEMPTS),
                ));
                *session.state.write().unwrap_or_else(|e| e.into_inner()) =
                    SshSessionState::Failed;
                return;
            }
            // 成功 → 继续循环, 等待下一次断开
        }
    }

    /// 单次重连: 重建 SSH 连接 + PTY, 热替换内部资源
    ///
    /// 成功时: 状态 → Connected + 推送状态事件; 失败时返回错误字符串。
    async fn perform_reconnect(&self, config: &SshReconnectConfig<R>) -> Result<(), String> {
        // 1. 重新建立 SSH 连接 (含 TOFU + 认证, 凭据来自 config)
        let client = SshClient::connect(
            config.app_handle.clone(),
            config.params.clone(),
            Some(config.on_status.clone()),
        )
        .await
        .map_err(|e| format!("SSH reconnect connect failed: {e}"))?;

        // 2. 重新开 PTY (含远端 shell 静默注入 + 新 reader task)
        let new_session = SshSession::open_pty(
            client,
            config.cols,
            config.rows,
            config.term.clone(),
            config.on_data.clone(),
            config.on_status.clone(),
            config.on_exit.clone(),
        )
        .await
        .map_err(|e| format!("SSH reconnect open_pty failed: {e}"))?;

        // 3. 热替换内部资源
        // 3.1 关闭旧 channel_write (drop 触发 channel close)
        {
            let mut guard = self.channel_write.lock().await;
            if let Some(old) = guard.take() {
                drop(old);
            }
        }
        // 3.2 关闭旧 handle (主动断开, 释放连接资源)
        {
            let mut guard = self.handle.lock().await;
            if let Some(old) = guard.take() {
                let _ = old
                    .disconnect(Disconnect::ByApplication, "reconnecting", "en")
                    .await;
                drop(old);
            }
        }
        // 3.3 替换为新的 (handle / channel_write / notify / received_exit)
        *self.channel_write.lock().await = new_session.channel_write.lock().await.take();
        *self.handle.lock().await = new_session.handle.lock().await.take();
        *self.exited_notify.lock().await = new_session.exited_notify.lock().await.clone();
        *self.received_exit.lock().await = new_session.received_exit.lock().await.clone();

        // 3.4 重置标志 (新 reader task 已 spawn)
        self.exited.store(false, Ordering::Release);
        self.connection_closed.store(false, Ordering::Release);

        // 3.5 状态 → Connected + 推送状态事件 (前端状态栏恢复 "已连接")
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = SshSessionState::Connected;
        let _ = config.on_status.send(SshStatusEvent::connected(
            &config.params.host,
            config.params.port,
            &config.params.user,
        ));

        log::info!(
            "[ssh] auto reconnect success: {}@{}:{}",
            config.params.user,
            config.params.host,
            config.params.port
        );
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

    /// 打开 direct-tcpip 转发 channel (P2 #23 SSH 隧道)
    ///
    /// 复用现有 SSH Handle 开一个直连 channel (RFC 4254 7.1),
    /// 请求远程 SSH 服务器代连 `host_to_connect:port_to_connect`,
    /// 返回的 Channel 与本地的 TcpStream 双向桥接即构成一条隧道。
    ///
    /// 与 `open_sftp_channel` / `exec_command` 同一模式:
    /// 锁只覆盖开 channel 一个 RTT, 立即释放, 不阻塞同会话其他操作。
    ///
    /// # 参数
    /// - `host_to_connect` / `port_to_connect`: 远程目标 (相对 SSH 服务器可达)
    /// - `originator_address` / `originator_port`: 发起方 (本地地址端口, 仅用于日志)
    ///
    /// # 返回
    /// `Channel<Msg>` — 与本地 TCP 连接桥接用
    pub async fn open_tcpip_channel(
        &self,
        host_to_connect: &str,
        port_to_connect: u32,
        originator_address: &str,
        originator_port: u32,
    ) -> Result<russh::Channel<russh::client::Msg>, SshSessionError> {
        // 与 open_sftp_channel 一致: 只在连接已断时拒绝
        if self.connection_closed.load(Ordering::Acquire) {
            return Err(SshSessionError::Closed);
        }

        // 借用 handle 开 channel (不 take, 保持 SSH 连接; 锁只覆盖开 channel 一个 RTT)
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(SshSessionError::Closed)?;
        let channel = handle
            .channel_open_direct_tcpip(
                host_to_connect,
                port_to_connect,
                originator_address,
                originator_port,
            )
            .await?;
        drop(handle_guard);

        Ok(channel)
    }

    /// 请求服务器开启远程端口转发 (P3 #24, RFC 4254 §7.1 forward-tcpip)
    ///
    /// 让 SSH 服务器监听 `address:port`, 收到连接时经 SSH channel 反推给客户端
    /// (对应 `ssh -R`)。客户端侧在 Handler 的 `server_channel_open_forwarded_tcpip`
    /// 回调里收到 channel, 连接本地目标后桥接。
    ///
    /// # 参数
    /// - `address`: 服务器监听地址 (受 sshd_config GatewayPorts 约束;
    ///   no=仅 127.0.0.1, yes=0.0.0.0, clientspecified=请求地址)
    /// - `port`: 服务器监听端口; **0 = 由服务器自动分配**, 返回值即实际端口
    ///
    /// # 返回
    /// 服务器实际监听端口 (port 非 0 时与入参相同)
    pub async fn tcpip_forward(&self, address: &str, port: u32) -> Result<u32, SshSessionError> {
        // 与 open_tcpip_channel 一致: 只在连接已断时拒绝
        if self.connection_closed.load(Ordering::Acquire) {
            return Err(SshSessionError::Closed);
        }

        // 借用 handle 发起全局请求 (锁只覆盖一个 RTT, 不阻塞同会话其他操作)
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(SshSessionError::Closed)?;
        let actual_port = handle.tcpip_forward(address, port).await?;
        drop(handle_guard);

        Ok(actual_port)
    }

    /// 取消服务器远程端口转发 (RFC 4254 §7.1)
    ///
    /// 与 `tcpip_forward` 对称: 请求服务器停止监听 `address:port`。
    /// SSH 会话断开后调用会失败 (连接已断), 调用方需容错 (只清理本地注册表)。
    pub async fn cancel_tcpip_forward(&self, address: &str, port: u32) -> Result<(), SshSessionError> {
        if self.connection_closed.load(Ordering::Acquire) {
            return Err(SshSessionError::Closed);
        }

        let handle_guard = self.handle.lock().await;
        let handle = handle_guard.as_ref().ok_or(SshSessionError::Closed)?;
        handle.cancel_tcpip_forward(address, port).await?;
        drop(handle_guard);

        Ok(())
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

// ==== 远端 shell 注入 (方案 A, 2026-08-09) ======================================
// 在 open_pty 里探测远端默认登录 shell, 写入最小 OSC 7 注入脚本, 再用
// PTY exec 启动注入 shell, 让远端 shell 在命令间隙自动上报 cwd。
//
// 设计约束 (综合优化, 不破坏既有功能):
//   - 只发 OSC 7 (cwd), 不发 OSC 133 / 不碰 PS1: SSH 终端 blocks=false,
//     前端无 OSC 133 消费方, 且不触碰用户 prompt 样式
//   - 注入脚本先 source 用户原 rc (bashrc/zshrc/zshenv), 保留用户配置
//   - 脚本写入用带引号 heredoc (`<<'TDSF_OSC7'`), 内容原样落盘, 无转义风险
//   - 任何失败显式 log 并降级 request_shell (仅失去 cwd 同步, 绝不篡改输入)

/// 远端 shell 类型 (探测结果)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteShellKind {
    Bash,
    Zsh,
    Fish,
    Other,
}

impl RemoteShellKind {
    fn from_path(path: &str) -> Self {
        match path.trim().rsplit('/').next().unwrap_or("") {
            "bash" => Self::Bash,
            "zsh" => Self::Zsh,
            "fish" => Self::Fish,
            _ => Self::Other,
        }
    }
}

/// 远端 bash 注入脚本: 恢复用户 .bashrc + PROMPT_COMMAND 钩子 (仅 OSC 7)
const BASH_INTEGRATION_SCRIPT: &str = r#"# TDSF SSH cwd integration (bash)
if [ -z "${__TDSF_OSC7_LOADED:-}" ]; then
  __TDSF_OSC7_LOADED=1
  [ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
  _tdsf_osc7_precmd() {
    printf '\033]7;file://localhost%s\007' "$(pwd -P)"
  }
  case ":${PROMPT_COMMAND:-}:" in
    *":_tdsf_osc7_precmd:"*) ;;
    *) PROMPT_COMMAND="_tdsf_osc7_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
  esac
fi
"#;

/// 远端 zsh 注入脚本 (.zshenv): 保留用户原 .zshenv
const ZSH_ZSENV_SCRIPT: &str = r#"# TDSF SSH cwd integration (zsh) - zshenv
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
"#;

/// 远端 zsh 注入脚本 (.zshrc): 恢复用户 .zshrc + precmd 钩子 (仅 OSC 7)
const ZSH_ZSHRC_SCRIPT: &str = r#"# TDSF SSH cwd integration (zsh) - zshrc
if [[ -z "${__TDSF_OSC7_LOADED:-}" ]]; then
  __TDSF_OSC7_LOADED=1
  [[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
  _tdsf_osc7_precmd() {
    printf '\033]7;file://localhost%s\007' "$(pwd -P)"
  }
  autoload -Uz add-zsh-hook 2>/dev/null
  (( $+functions[add-zsh-hook] )) && add-zsh-hook precmd _tdsf_osc7_precmd
fi
"#;

/// 远端 fish 注入脚本: 包装 fish_prompt 发 OSC 7 (fish 自动读 config.fish, -C 最后执行)
const FISH_INTEGRATION_SCRIPT: &str = r#"# TDSF SSH cwd integration (fish)
if not set -q __TDSF_OSC7_LOADED
  set -g __TDSF_OSC7_LOADED 1
  function __tdsf_urlencode_path
    set -l parts (string split '/' -- $argv[1])
    set -l out
    for p in $parts
      if test -n "$p"
        set out $out (string escape --style=url -- $p)
      else
        set out $out ""
      end
    end
    string join '/' $out
  end
  function __tdsf_restore_status
    return $argv[1]
  end
  if not functions -q __tdsf_user_prompt
    functions -c fish_prompt __tdsf_user_prompt 2>/dev/null
  end
  function fish_prompt
    set -l __tdsf_status $status
    printf '\033]7;file://localhost%s\007' (__tdsf_urlencode_path "$PWD")
    __tdsf_restore_status $__tdsf_status
    if functions -q __tdsf_user_prompt
      __tdsf_user_prompt
    end
  end
end
"#;

/// 执行一条单次命令并返回 stdout 文本 (探测/写脚本用, 非 PTY, 10s 超时)
async fn exec_simple<R: tauri::Runtime>(
    handle: &Handle<SshClientHandler<R>>,
    cmd: &str,
) -> Result<String, SshSessionError> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, cmd).await?;

    let mut out: Vec<u8> = Vec::new();
    let collect = async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => out.extend_from_slice(&data),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {} // ExitStatus/Success/Failure/ExtendedData 忽略
            }
        }
    };

    tokio::time::timeout(std::time::Duration::from_secs(10), collect)
        .await
        .map_err(|_| SshSessionError::Other(format!("exec timeout: {cmd}")))?;

    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// 探测远端默认登录 shell
async fn probe_remote_shell<R: tauri::Runtime>(
    handle: &Handle<SshClientHandler<R>>,
) -> Result<RemoteShellKind, SshSessionError> {
    // exec 模式的命令由用户默认 shell 的 -c 执行。优先 $SHELL 环境变量,
    // 兜底 getent passwd (id -u) 第 7 字段 (getent 缺失时输出为空)。
    let probe = "echo \"${SHELL:-$(getent passwd $(id -u) 2>/dev/null | cut -d: -f7)}\"";
    let path = exec_simple(handle, probe).await?;
    let kind = RemoteShellKind::from_path(&path);
    log::info!("[ssh] remote shell probe: path={path:?} kind={kind:?}");
    Ok(kind)
}

/// 按 shell 类型写入注入脚本, 返回 PTY 启动命令
async fn write_shell_integration<R: tauri::Runtime>(
    handle: &Handle<SshClientHandler<R>>,
    kind: RemoteShellKind,
) -> Result<String, SshSessionError> {
    // uuid simple (32 hex 无连字符), 避免并发连接共享同名临时文件
    let id = uuid::Uuid::new_v4().simple().to_string();
    let tmp = format!("/tmp/tdsf-osc7-{id}");

    let (write_cmd, launch_cmd) = match kind {
        RemoteShellKind::Bash => {
            let script = format!(
                "cat > {tmp}.bash <<'TDSF_OSC7'\n{BASH_INTEGRATION_SCRIPT}TDSF_OSC7"
            );
            let launch = format!("exec bash --rcfile {tmp}.bash -i");
            (script, launch)
        }
        RemoteShellKind::Zsh => {
            // zdotdir 方式: ZDOTDIR 替换整个 dotfile 目录, 需要 .zshenv + .zshrc
            let script = format!(
                "mkdir -p {tmp}.zdotdir\n\
                 cat > {tmp}.zdotdir/.zshenv <<'TDSF_OSC7'\n{ZSH_ZSENV_SCRIPT}TDSF_OSC7\n\
                 cat > {tmp}.zdotdir/.zshrc <<'TDSF_OSC7_2'\n{ZSH_ZSHRC_SCRIPT}TDSF_OSC7_2"
            );
            let launch = format!("exec env ZDOTDIR={tmp}.zdotdir zsh -i");
            (script, launch)
        }
        RemoteShellKind::Fish => {
            let script = format!(
                "cat > {tmp}.fish <<'TDSF_OSC7'\n{FISH_INTEGRATION_SCRIPT}TDSF_OSC7"
            );
            let launch = format!("exec fish -C 'source {tmp}.fish' -i");
            (script, launch)
        }
        RemoteShellKind::Other => {
            // 非 bash/zsh/fish (csh/tcsh/ash 等): 不支持注入, 降级 request_shell
            log::info!("[ssh] unsupported remote shell kind, skip integration");
            return Err(SshSessionError::Other(
                "unsupported remote shell for integration".to_string(),
            ));
        }
    };

    // 写脚本 (非 PTY exec, 失败不影响 PTY 建立——降级 request_shell)
    exec_simple(handle, &write_cmd).await?;
    Ok(launch_cmd)
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

impl<R: tauri::Runtime> Drop for SshSession<R> {
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
// make_test_session 为 pub(crate), 供 tunnel.rs / mod.rs 测试复用
pub(crate) mod tests {
    use super::*;
    use crate::modules::ssh::client::SshAuthMethod;

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
    ///
    /// pub(crate): 供 tunnel.rs / mod.rs 的隧道 registry 测试构造假会话。
    pub(crate) fn make_test_session<R: tauri::Runtime>(
        connection_closed: bool,
        exited: bool,
    ) -> SshSession<R> {
        SshSession::<R> {
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
            exited_notify: Arc::new(Mutex::new(Arc::new(tokio::sync::Notify::new()))),
            reconnect: Arc::new(Mutex::new(None)),
            received_exit: Arc::new(Mutex::new(Arc::new(AtomicBool::new(false)))),
        }
    }

    // === P3 #20 自动重连测试 ====================================================

    #[test]
    fn test_reconnect_backoff_delay_progression() {
        // 指数退避: 1s → 2s → 4s → 8s → 16s → 30s (封顶)
        assert_eq!(reconnect_backoff_delay(1).as_secs(), 1);
        assert_eq!(reconnect_backoff_delay(2).as_secs(), 2);
        assert_eq!(reconnect_backoff_delay(3).as_secs(), 4);
        assert_eq!(reconnect_backoff_delay(4).as_secs(), 8);
        assert_eq!(reconnect_backoff_delay(5).as_secs(), 16);
        assert_eq!(reconnect_backoff_delay(6).as_secs(), 30);
        // 超过上限封顶 30s (防止 attempt 溢出 / 无限增大)
        assert_eq!(reconnect_backoff_delay(7).as_secs(), 30);
        assert_eq!(reconnect_backoff_delay(u32::MAX).as_secs(), 30);
    }

    #[tokio::test]
    async fn test_reconnecting_status_event() {
        let event = SshStatusEvent::reconnecting("example.com", 22, 3);
        assert_eq!(event.state, SshSessionState::Reconnecting);
        assert_eq!(event.host, "example.com");
        assert_eq!(event.port, 22);
        assert_eq!(event.error, Some("第 3 次重连".to_string()));
        // snake_case 序列化 (前端期望)
        let json = serde_json::to_string(&event.state).unwrap();
        assert_eq!(json, "\"reconnecting\"");
    }

    #[tokio::test]
    async fn test_enable_reconnect_stores_config() {
        // MockRuntime: tauri::test::mock_app() 返回 App<MockRuntime>,
        // 无需构建真实 Wry App (真实 App 在非主线程构建会触发 tao EventLoop 限制)
        let session = make_test_session::<tauri::test::MockRuntime>(false, false);
        // reconnect 初始为 None
        assert!(session.reconnect.lock().await.is_none());
        // 构造 mock Tauri app 拿 AppHandle
        let app = tauri::test::mock_app();
        // 注入配置
        session.enable_reconnect(SshReconnectConfig {
            app_handle: app.handle().clone(),
            params: SshConnectParams {
                host: "example.com".to_string(),
                port: 22,
                user: "root".to_string(),
                auth: SshAuthMethod::Password {
                    password: "secret".to_string(),
                },
            },
            cols: 80,
            rows: 24,
            term: "xterm-256color".to_string(),
            on_data: Channel::new(|_| Ok(())),
            on_status: Channel::new(|_| Ok(())),
            on_exit: Channel::new(|_| Ok(())),
        })
        .await;
        let stored = session.reconnect.lock().await;
        assert!(stored.is_some());
        let cfg = stored.as_ref().unwrap();
        assert_eq!(cfg.params.host, "example.com");
        assert_eq!(cfg.cols, 80);
        assert_eq!(cfg.rows, 24);
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
        let session = make_test_session::<tauri::Wry>(
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
        let session = make_test_session::<tauri::Wry>(
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
        let session = make_test_session::<tauri::Wry>(true, true);

        let result = session.exec_command("sleep 100", Some(1)).await;
        assert!(matches!(result, Err(SshSessionError::Closed)));
    }

    #[test]
    fn test_is_connection_closed_after_construction() {
        // 验证 make_test_session 的状态标志正确 (测试工具自身的自检)
        let closed = make_test_session::<tauri::Wry>(true, true);
        assert!(closed.is_connection_closed());
        assert!(closed.is_exited()); // exited 也 true (close 同时设两者)

        let open = make_test_session::<tauri::Wry>(false, false);
        assert!(!open.is_connection_closed());
        assert!(!open.is_exited());
    }
}
