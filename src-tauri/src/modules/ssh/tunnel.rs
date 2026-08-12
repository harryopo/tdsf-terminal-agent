//! SSH 隧道与端口转发 (P2 #23 本地转发 / P3 #24 远程转发 + SOCKS5)
//! ============================================================================
//! 三种模式 (对应 OpenSSH -L / -R / -D):
//! - **Local 本地转发** (direct-tcpip): 本地监听端口 → SSH 隧道 → 远程目标。
//!   场景: DBA 通过跳板机连远程数据库 / 访问内网服务, 免 VPN。
//! - **Remote 远程转发** (forward-tcpip): 服务器监听端口 → SSH channel → 客户端
//!   连本地目标。场景: 把本机开发服务暴露给公网跳板机, 供同事/演示访问。
//!   依赖 handler.rs 的 `server_channel_open_forwarded_tcpip` 回调 + 全局
//!   `REMOTE_TUNNEL_REGISTRY` 查表。
//! - **Socks5 动态转发** (SOCKS5 协商 + 动态 direct-tcpip): 本地 SOCKS 代理,
//!   按 CONNECT 请求目标动态开 channel。场景: 浏览器/工具配 127.0.0.1:port
//!   即可访问任意内网目标, 无需逐目标建隧道。
//!
//! ## 工作原理
//! ```text
//! Local:  本地客户端 → localhost:local_port (TcpListener)
//!           → SSH channel_open_direct_tcpip(remote_host:remote_port)
//!           → 远程 SSH 服务器发起 TCP 连接 → remote_host:remote_port
//! Remote: 服务器监听 bind_address:bind_port (tcpip_forward)
//!           → 收到连接 → SSH channel 反推客户端
//!           → Handler 回调 → 客户端连接 local_target_host:local_target_port
//! Socks5: 本地客户端 → localhost:local_port (TcpListener)
//!           → SOCKS5 握手 + CONNECT(目标) → SSH channel_open_direct_tcpip(目标)
//!           → 远程 SSH 服务器连接目标
//! ```
//! 每个入站 TCP 连接开一个独立 direct-tcpip channel, 双向桥接。
//!
//! ## 桥接实现 (为什么不用 make_reader/make_writer)
//! `Channel::make_reader` 是 `&mut self`, `make_writer` 是 `&self` → 二者无法
//! 同时持有 (借用冲突)。russh 官方示例 (client_open_direct_tcpip.rs) 采用
//! 单 channel + tokio::select 双向桥接: stream.read → channel.data(),
//! channel.wait() → stream.write_all()。本模块沿用官方示例模式。
//!
//! ## 生命周期
//! - 创建: `tunnel_start` 命令 (按 kind 校验 + 各自启动流程)
//! - 运行: Local/Socks5 为 accept_loop task 常驻; Remote 无本地 listener,
//!   靠服务器端监听 + Handler 回调驱动
//! - 停止: `tunnel_stop` 命令 / 所属 SSH 会话断开 (ssh_disconnect 自动清理)
//! - Local/Socks5 stop 释放本地端口; Remote stop 向服务器发 cancel_tcpip_forward
//!   并清理注册表

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use russh::ChannelMsg;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;

use super::session::SshSession;

/// 隧道状态 (前端渲染用)
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelState {
    /// 启动中 (listener 绑定中)
    Starting,
    /// 运行中 (listener 已绑定, accept loop 常驻)
    Running,
    /// 停止中 (stop 已请求, 等待 accept loop 退出)
    Stopping,
    /// 已停止
    Stopped,
    /// 启动失败 (端口占用等)
    Failed,
}

/// 隧道类型 (P3 #24)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    /// 本地转发 (direct-tcpip): 本地监听 → 远程目标 (ssh -L)
    Local,
    /// 远程转发 (forward-tcpip): 服务器监听 → 本地目标 (ssh -R)
    Remote,
    /// 动态转发 (SOCKS5): 本地代理 → 按 CONNECT 目标动态直连 (ssh -D)
    Socks5,
}

impl Default for TunnelKind {
    fn default() -> Self {
        // 向后兼容: P2 前端不传 kind → 视为本地转发
        Self::Local
    }
}

/// 隧道定义 (前端 → Rust, tunnel_start 参数)
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    /// 隧道名称 (用户可读)
    pub name: String,
    /// 所属 SSH 会话 id (ssh_connect 返回值)
    pub session_id: u32,
    /// 隧道类型 (默认 Local, 向后兼容 P2)
    #[serde(default)]
    pub kind: TunnelKind,
    /// 本地监听地址 (Local/Socks5 用; 默认 "127.0.0.1"; 填 "0.0.0.0" 可对外暴露, 慎用)
    #[serde(default = "default_local_host")]
    pub local_host: String,
    /// 本地监听端口 (Local/Socks5 用; 0 = 未设置, 命令层按模式校验必填)
    #[serde(default)]
    pub local_port: u16,
    /// 远程目标地址 (仅 Local 用; 空 = 未设置, 命令层按模式校验必填)
    #[serde(default)]
    pub remote_host: String,
    /// 远程目标端口 (仅 Local 用; 0 = 未设置, 命令层按模式校验必填)
    #[serde(default)]
    pub remote_port: u16,
    /// 服务器监听地址 (仅 Remote 用; 默认 "127.0.0.1", 受 sshd GatewayPorts 约束)
    #[serde(default = "default_local_host")]
    pub bind_address: String,
    /// 服务器监听端口 (仅 Remote 用; 0 或 None = 服务器自动分配)
    pub bind_port: Option<u16>,
    /// 本地目标地址 (仅 Remote 用; 相对客户端可达)
    pub local_target_host: Option<String>,
    /// 本地目标端口 (仅 Remote 用)
    pub local_target_port: Option<u16>,
}

fn default_local_host() -> String {
    "127.0.0.1".to_string()
}

/// 隧道信息 (Rust → 前端, tunnel_list 返回值)
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub id: u32,
    pub name: String,
    pub session_id: u32,
    /// 隧道类型 (P3 #24)
    pub kind: TunnelKind,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// 服务器监听地址 (仅 Remote; tcpip_forward 的 address 参数)
    pub bind_address: String,
    /// 服务器实际监听端口 (仅 Remote; tcpip_forward 返回值)
    pub bind_port: Option<u32>,
    /// 本地目标 (仅 Remote)
    pub local_target_host: Option<String>,
    pub local_target_port: Option<u16>,
    pub state: TunnelState,
    /// 已处理连接数 (accept 计数)
    pub connections: u64,
    /// 创建时间戳 (Unix 毫秒)
    pub created_at: i64,
}

/// 桥接缓冲区大小 (官方示例同值, 64KiB)
const BRIDGE_BUF_SIZE: usize = 65536;

/// SSH 隧道
pub struct SshTunnel<R: tauri::Runtime = tauri::Wry> {
    /// 隧道 ID
    pub id: u32,
    /// 隧道定义
    pub spec: TunnelSpec,
    /// 状态
    state: std::sync::RwLock<TunnelState>,
    /// 本地监听器 (Local/Socks5 用; Some = 已绑定; stop/drop 时 take 释放端口; Remote 恒 None)
    listener: Arc<Mutex<Option<TcpListener>>>,
    /// 停止标志 (accept loop 检查)
    stop_flag: Arc<AtomicBool>,
    /// 停止通知 (唤醒 accept loop 的 select)
    stop_notify: Arc<tokio::sync::Notify>,
    /// 已处理连接数
    connections: AtomicU64,
    /// 创建时间戳
    created_at: i64,
    /// 所属 SSH 会话 (开 direct-tcpip channel 用)
    session: Arc<SshSession<R>>,
    /// accept loop task handle (Local/Socks5; stop 时等待退出; Remote 为 None)
    task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Remote 专属: 服务器实际监听端口 (tcpip_forward 返回值; bind_port=0 时由服务器分配)
    remote_port: std::sync::RwLock<Option<u32>>,
}

impl<R: tauri::Runtime> SshTunnel<R> {
    /// 创建隧道 (不启动; 需调用 start)
    pub fn new(id: u32, spec: TunnelSpec, session: Arc<SshSession<R>>) -> Self {
        Self {
            id,
            spec,
            state: std::sync::RwLock::new(TunnelState::Starting),
            listener: Arc::new(Mutex::new(None)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            stop_notify: Arc::new(tokio::sync::Notify::new()),
            connections: AtomicU64::new(0),
            created_at: chrono::Utc::now().timestamp_millis(),
            session,
            task: Arc::new(Mutex::new(None)),
            remote_port: std::sync::RwLock::new(None),
        }
    }

    /// 启动隧道 (按 kind 分支, P3 #24)
    ///
    /// # 错误
    /// - Local/Socks5: 本地端口已被占用 → bind 失败, 状态置 Failed
    /// - Remote: 服务器拒绝监听 (端口占用/无权限) → tcpip_forward 失败, 状态置 Failed
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        match self.spec.kind {
            TunnelKind::Local | TunnelKind::Socks5 => self.start_local_listener().await,
            TunnelKind::Remote => self.start_remote_forward().await,
        }
    }

    /// Local/Socks5: 绑定本地端口 + 启动 accept loop
    async fn start_local_listener(self: &Arc<Self>) -> Result<(), String> {
        let addr = format!("{}:{}", self.spec.local_host, self.spec.local_port);
        let listener = TcpListener::bind(&addr).await.map_err(|e| {
            log::error!(
                "[tunnel] bind failed: id={} addr={} err={}",
                self.id,
                addr,
                e
            );
            *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Failed;
            format!("绑定本地端口 {addr} 失败: {e}")
        })?;
        log::info!(
            "[tunnel] listening: id={} kind={:?} {} → {}:{}",
            self.id,
            self.spec.kind,
            addr,
            self.spec.remote_host,
            self.spec.remote_port
        );
        *self.listener.lock().await = Some(listener);
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Running;

        // 启动 accept loop
        let this = self.clone();
        let task = tokio::spawn(async move {
            this.accept_loop().await;
        });
        *self.task.lock().await = Some(task);
        Ok(())
    }

    /// Remote: 请求服务器开启远程端口转发 (RFC 4254 §7.1 forward-tcpip)
    ///
    /// 流程: tcpip_forward 请求服务器监听 → 注册本地目标到全局 registry
    /// (Handler 回调 `server_channel_open_forwarded_tcpip` 按 (地址, 端口) 查表
    /// 找到本地目标 → 连接 → 桥接)。无本地 listener, 不需要 accept loop。
    async fn start_remote_forward(self: &Arc<Self>) -> Result<(), String> {
        // bind_port None 或 0 → 服务器自动分配端口
        let requested = self.spec.bind_port.unwrap_or(0) as u32;
        let addr = self.spec.bind_address.clone();

        let actual = self.session.tcpip_forward(&addr, requested).await.map_err(|e| {
            log::error!(
                "[tunnel] tcpip_forward failed: id={} addr={}:{} err={}",
                self.id,
                addr,
                requested,
                e
            );
            *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Failed;
            format!("请求服务器监听 {addr}:{requested} 失败: {e}")
        })?;
        log::info!(
            "[tunnel] remote forward active: id={} server {}:{} → local {}:{}",
            self.id,
            addr,
            actual,
            self.spec
                .local_target_host
                .as_deref()
                .unwrap_or("(unset)"),
            self.spec.local_target_port.unwrap_or(0)
        );
        *self.remote_port.write().unwrap_or_else(|e| e.into_inner()) = Some(actual);

        // 注册本地目标到全局 registry (命令层已校验非空, 这里防御性取默认)
        let target = super::handler::RemoteTarget {
            local_target_host: self.spec.local_target_host.clone().unwrap_or_default(),
            local_target_port: self.spec.local_target_port.unwrap_or(0),
        };
        if let Err(e) = super::handler::register_remote_target(addr, actual, target) {
            log::error!("[tunnel] register_remote_target failed: id={} err={}", self.id, e);
            // registry 注册失败 → 回滚服务器转发 (尽力而为)
            let _ = self.session.cancel_tcpip_forward(&self.spec.bind_address, actual).await;
            *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Failed;
            return Err(format!("注册远程转发目标失败: {e}"));
        }

        *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Running;
        Ok(())
    }

    /// accept loop: 接受本地连接 → 开 direct-tcpip channel → spawn 桥接
    ///
    /// 退出条件: stop_flag 置位 / listener 关闭 (stop 时 drop) / accept 出错。
    async fn accept_loop(self: Arc<Self>) {
        let mut guard = self.listener.lock().await;
        let listener = match guard.take() {
            Some(l) => l,
            None => {
                log::warn!("[tunnel] accept_loop: listener already taken, id={}", self.id);
                return;
            }
        };
        drop(guard);

        log::info!("[tunnel] accept loop started: id={}", self.id);
        loop {
            // 停止检查 + accept 的 select
            let accept_res = tokio::select! {
                r = listener.accept() => r,
                _ = self.wait_stop() => {
                    log::info!("[tunnel] accept loop stopped by flag: id={}", self.id);
                    break;
                }
            };

            let (stream, peer) = match accept_res {
                Ok(pair) => pair,
                Err(e) => {
                    // listener 关闭 (stop 时 drop) 会返回错误 → 正常退出
                    log::debug!(
                        "[tunnel] accept error (listener closed?): id={} err={}",
                        self.id,
                        e
                    );
                    break;
                }
            };

            // 已停止但仍接到连接 (竞态) → 直接拒绝
            if self.stop_flag.load(Ordering::Acquire) {
                drop(stream);
                break;
            }

            log::debug!("[tunnel] new connection: id={} peer={}", self.id, peer);

            match self.spec.kind {
                // === Local: 直接开 direct-tcpip channel 到固定远程目标 ===
                TunnelKind::Local => {
                    // 开 direct-tcpip channel (复用 SSH 会话 Handle, 锁只覆盖开 channel 一个 RTT)
                    let channel = match self
                        .session
                        .open_tcpip_channel(
                            &self.spec.remote_host,
                            self.spec.remote_port as u32,
                            &self.spec.local_host,
                            self.spec.local_port as u32,
                        )
                        .await
                    {
                        Ok(ch) => ch,
                        Err(e) => {
                            log::warn!(
                                "[tunnel] open_tcpip_channel failed: id={} err={}",
                                self.id,
                                e
                            );
                            // 开 channel 失败 → 关闭本地连接, 继续 accept
                            drop(stream);
                            continue;
                        }
                    };

                    self.connections.fetch_add(1, Ordering::Relaxed);

                    // spawn 桥接 task (每连接一个, 双向转发直到任一端关闭)
                    tokio::spawn(bridge_connection(stream, channel));
                }
                // === Socks5: SOCKS5 握手 → 解析 CONNECT 目标 → 动态开 channel ===
                TunnelKind::Socks5 => {
                    self.connections.fetch_add(1, Ordering::Relaxed);
                    let session = self.session.clone();
                    let id = self.id;
                    tokio::spawn(async move {
                        if let Err(e) = handle_socks5_connection(stream, session).await {
                            log::debug!("[tunnel] socks5 connection closed: id={} err={}", id, e);
                        }
                    });
                }
                // === Remote: 无本地 listener, 不应进入 accept_loop ===
                TunnelKind::Remote => {
                    log::warn!(
                        "[tunnel] Remote tunnel should not accept connections: id={}",
                        self.id
                    );
                    drop(stream);
                }
            }
        }

        // accept loop 退出 → 状态 Stopped (若未被 stop() 抢先置 Stopped)
        if !self.stop_flag.load(Ordering::Acquire) {
            *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Stopped;
        }
        log::info!("[tunnel] accept loop exited: id={}", self.id);
    }

    /// 等待停止 (stop_flag 已置 或 stop_notify 被通知)
    async fn wait_stop(&self) {
        if self.stop_flag.load(Ordering::Acquire) {
            return;
        }
        self.stop_notify.notified().await;
    }

    /// 停止隧道 (幂等; 按 kind 分支, P3 #24)
    ///
    /// - Local/Socks5: drop listener 释放本地端口 → 通知 accept loop 退出 → 等 task (≤2s)
    /// - Remote: 从全局 registry 移除本地目标 → 请求服务器 cancel_tcpip_forward
    ///   (SSH 会话已断时 cancel 失败, 忽略错误只清注册表, 防泄漏)
    pub async fn stop(&self) {
        if self.stop_flag.swap(true, Ordering::AcqRel) {
            return;
        }
        log::info!("[tunnel] stopping: id={} kind={:?}", self.id, self.spec.kind);
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Stopping;

        match self.spec.kind {
            TunnelKind::Remote => {
                let addr = self.spec.bind_address.clone();
                // 先取实际端口 (锁在取完立即释放, 不跨 await 持锁), 再清注册表 + 请求服务器停止
                let port = self.remote_port.write().unwrap_or_else(|e| e.into_inner()).take();
                if let Some(port) = port {
                    super::handler::unregister_remote_target(&addr, port);
                    if let Err(e) = self.session.cancel_tcpip_forward(&addr, port).await {
                        // SSH 会话断开后 cancel 必然失败 → 只记 debug (registry 已清)
                        log::debug!(
                            "[tunnel] cancel_tcpip_forward failed (session closed?): id={} addr={}:{} err={}",
                            self.id,
                            addr,
                            port,
                            e
                        );
                    }
                }
            }
            TunnelKind::Local | TunnelKind::Socks5 => {
                // 释放端口 (drop listener)
                if let Some(l) = self.listener.lock().await.take() {
                    drop(l);
                }
                // 通知 accept loop (即使已被 accept 分支占用, 循环尾部会再检查 flag)
                self.stop_notify.notify_waiters();

                // 等待 accept loop 退出
                if let Some(task) = self.task.lock().await.take() {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), task).await;
                }
            }
        }
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Stopped;
        log::info!("[tunnel] stopped: id={}", self.id);
    }

    /// 当前状态
    pub fn state(&self) -> TunnelState {
        self.state.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 是否运行中
    pub fn is_running(&self) -> bool {
        self.state() == TunnelState::Running
    }

    /// 生成 TunnelInfo (供 tunnel_list)
    pub fn info(&self) -> TunnelInfo {
        TunnelInfo {
            id: self.id,
            name: self.spec.name.clone(),
            session_id: self.spec.session_id,
            kind: self.spec.kind,
            local_host: self.spec.local_host.clone(),
            local_port: self.spec.local_port,
            remote_host: self.spec.remote_host.clone(),
            remote_port: self.spec.remote_port,
            bind_address: self.spec.bind_address.clone(),
            bind_port: *self.remote_port.read().unwrap_or_else(|e| e.into_inner()),
            local_target_host: self.spec.local_target_host.clone(),
            local_target_port: self.spec.local_target_port,
            state: self.state(),
            connections: self.connections.load(Ordering::Relaxed),
            created_at: self.created_at,
        }
    }
}

/// 双向桥接单个 TCP 连接与 direct-tcpip channel (官方示例模式)
///
/// - 本地客户端 → SSH 服务器: stream.read → channel.data (stream EOF → channel.eof)
/// - SSH 服务器 → 本地客户端: channel.wait → stream.write_all (channel Eof → 关闭)
/// 任一端错误即退出, 结束前 shutdown 本地连接。
///
/// 三种隧道模式 + 远程转发 Handler 回调都复用本函数:
/// stream = 本地 TCP 连接 (Local/Socks5 为入站, Remote 回调为主动 connect),
/// channel = SSH channel。方向无关。
pub(crate) async fn bridge_connection(
    mut stream: TcpStream,
    mut channel: russh::Channel<russh::client::Msg>,
) {
    let peer = match stream.peer_addr() {
        Ok(a) => a.to_string(),
        Err(_) => "unknown".to_string(),
    };
    log::debug!("[tunnel] bridge start: peer={}", peer);

    let mut stream_closed = false;
    let mut buf = vec![0u8; BRIDGE_BUF_SIZE];
    loop {
        tokio::select! {
            // 本地客户端 → SSH 服务器
            r = stream.read(&mut buf), if !stream_closed => {
                match r {
                    Ok(0) => {
                        // 本地客户端关闭写端 → 通知 SSH 服务器 (EOF)
                        stream_closed = true;
                        if let Err(e) = channel.eof().await {
                            log::debug!("[tunnel] eof send failed: {e}");
                            break;
                        }
                    }
                    Ok(n) => {
                        if let Err(e) = channel.data(&buf[..n]).await {
                            log::debug!("[tunnel] channel.data failed: {e}");
                            break;
                        }
                    }
                    Err(e) => {
                        log::debug!("[tunnel] stream read error: {e}");
                        break;
                    }
                }
            }
            // SSH 服务器 → 本地客户端
            Some(msg) = channel.wait() => {
                match msg {
                    ChannelMsg::Data { ref data } => {
                        if let Err(e) = stream.write_all(data).await {
                            log::debug!("[tunnel] stream write error: {e}");
                            break;
                        }
                    }
                    ChannelMsg::Eof => {
                        // 服务器关闭写端 → 回发 EOF 并结束
                        if !stream_closed {
                            if let Err(e) = channel.eof().await {
                                log::debug!("[tunnel] eof send failed (mirror): {e}");
                            }
                        }
                        break;
                    }
                    _ => {} // WindowAdjusted / Failure 等忽略
                }
            }
        }
    }
    // 关闭本地连接 (shutdown 通知对端 FIN)
    let _ = stream.shutdown().await;
    log::debug!("[tunnel] bridge closed: peer={}", peer);
}

// ============================================================================
// SOCKS5 动态转发 (P3 #24, RFC 1928)
// ============================================================================

/// SOCKS5 协议常量 (RFC 1928)
const SOCKS5_VERSION: u8 = 0x05;
/// 无需认证方法
const SOCKS5_AUTH_NONE: u8 = 0x00;
/// CONNECT 命令 (唯一支持; BIND/UDP ASSOCIATE 拒绝)
const SOCKS5_CMD_CONNECT: u8 = 0x01;
/// ATYP: IPv4
const SOCKS5_ATYP_IPV4: u8 = 0x01;
/// ATYP: 域名
const SOCKS5_ATYP_DOMAIN: u8 = 0x03;
/// ATYP: IPv6
const SOCKS5_ATYP_IPV6: u8 = 0x04;

/// SOCKS5 响应 REP 码 (RFC 1928 §6)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Socks5Reply {
    /// 成功
    Succeeded = 0x00,
    /// 常规失败
    GeneralFailure = 0x01,
    /// 目标不可达
    HostUnreachable = 0x04,
    /// 命令不支持 (BIND / UDP ASSOCIATE)
    CommandNotSupported = 0x07,
    /// 地址类型不支持
    AddressTypeNotSupported = 0x08,
}

impl Socks5Reply {
    fn code(self) -> u8 {
        self as u8
    }

    /// 标准 10 字节响应头 (REP 后跟 ATYP=IPv4 + 0.0.0.0:0, BND 地址客户端基本不校验)
    fn to_bytes(self) -> [u8; 10] {
        [SOCKS5_VERSION, self.code(), 0x00, SOCKS5_ATYP_IPV4, 0, 0, 0, 0, 0, 0]
    }
}

/// 解析 SOCKS5 CONNECT 请求完整报文 (ver+cmd+rsv+atyp+addr+port)
///
/// 纯函数, 便于单测。返回 (目标主机, 目标端口)。
/// 失败时返回对应 REP 码 (调用方回给客户端后关闭连接)。
///
/// # 报文格式 (RFC 1928 §4)
/// ```text
/// +----+-----+-------+------+----------+----------+
/// |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
/// +----+-----+-------+------+----------+----------+
/// | 1  |  1  | X'00' |  1   | Variable |    2     |
/// ```
fn socks5_parse_request(buf: &[u8]) -> Result<(String, u16), Socks5Reply> {
    if buf.len() < 4 {
        return Err(Socks5Reply::GeneralFailure);
    }
    if buf[0] != SOCKS5_VERSION {
        return Err(Socks5Reply::GeneralFailure);
    }
    // buf[2] = RSV, 应为 0 (宽松不校验)
    match buf[1] {
        SOCKS5_CMD_CONNECT => {}
        _ => return Err(Socks5Reply::CommandNotSupported),
    }
    match buf[3] {
        SOCKS5_ATYP_IPV4 => {
            if buf.len() < 4 + 4 + 2 {
                return Err(Socks5Reply::GeneralFailure);
            }
            let ip = std::net::Ipv4Addr::new(buf[4], buf[5], buf[6], buf[7]);
            let port = u16::from_be_bytes([buf[8], buf[9]]);
            Ok((ip.to_string(), port))
        }
        SOCKS5_ATYP_DOMAIN => {
            let len = buf[4] as usize;
            if buf.len() < 4 + 1 + len + 2 {
                return Err(Socks5Reply::GeneralFailure);
            }
            let host = String::from_utf8_lossy(&buf[5..5 + len]).to_string();
            let port = u16::from_be_bytes([buf[5 + len], buf[6 + len]]);
            Ok((host, port))
        }
        SOCKS5_ATYP_IPV6 => {
            if buf.len() < 4 + 16 + 2 {
                return Err(Socks5Reply::GeneralFailure);
            }
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&buf[4..20]);
            let ip = std::net::Ipv6Addr::from(octets).to_string();
            let port = u16::from_be_bytes([buf[20], buf[21]]);
            Ok((ip, port))
        }
        _ => Err(Socks5Reply::AddressTypeNotSupported),
    }
}

/// 处理单条 SOCKS5 连接 (accept_loop spawn 的 task):
/// 握手 → CONNECT 请求 → 动态开 direct-tcpip channel → 桥接。
///
/// 任一步失败: 尽力回错误响应 + 关闭连接 (日志 debug)。
async fn handle_socks5_connection<R: tauri::Runtime>(
    mut stream: TcpStream,
    session: Arc<SshSession<R>>,
) -> Result<(), String> {
    // === 1. 握手: 读 [ver, nmethods, methods...] ===
    let mut header = [0u8; 2];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| format!("握手读取失败: {e}"))?;
    if header[0] != SOCKS5_VERSION {
        return Err(format!("非 SOCKS5 客户端 (version={})", header[0]));
    }
    let nmethods = header[1] as usize;
    if nmethods == 0 {
        return Err("客户端未提供认证方法".to_string());
    }
    let mut methods = vec![0u8; nmethods];
    stream
        .read_exact(&mut methods)
        .await
        .map_err(|e| format!("读取认证方法失败: {e}"))?;
    if !methods.contains(&SOCKS5_AUTH_NONE) {
        // 无 NO AUTH → 0xFF 拒绝
        let _ = stream.write_all(&[SOCKS5_VERSION, 0xFF]).await;
        return Err("客户端未提供 NO AUTH 方法".to_string());
    }
    stream
        .write_all(&[SOCKS5_VERSION, SOCKS5_AUTH_NONE])
        .await
        .map_err(|e| format!("握手响应失败: {e}"))?;

    // === 2. 读 CONNECT 请求头 [ver, cmd, rsv, atyp] ===
    let mut req_header = [0u8; 4];
    stream
        .read_exact(&mut req_header)
        .await
        .map_err(|e| format!("请求头读取失败: {e}"))?;

    // === 3. 按 ATYP 读目标地址 + 端口, 拼成完整报文交给纯函数解析 ===
    let mut req = Vec::with_capacity(4 + 16 + 2);
    req.extend_from_slice(&req_header);
    match req_header[3] {
        SOCKS5_ATYP_IPV4 => {
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr).await.map_err(|e| format!("读取 IPv4 失败: {e}"))?;
            req.extend_from_slice(&addr);
        }
        SOCKS5_ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|e| format!("读取域名长度失败: {e}"))?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await.map_err(|e| format!("读取域名失败: {e}"))?;
            req.extend_from_slice(&len);
            req.extend_from_slice(&name);
        }
        SOCKS5_ATYP_IPV6 => {
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr).await.map_err(|e| format!("读取 IPv6 失败: {e}"))?;
            req.extend_from_slice(&addr);
        }
        _ => {
            // 未知 ATYP → 直接回不支持, 不继续读 (长度未知)
            let _ = stream.write_all(&Socks5Reply::AddressTypeNotSupported.to_bytes()).await;
            return Err(format!("不支持的地址类型: {}", req_header[3]));
        }
    }
    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await.map_err(|e| format!("读取端口失败: {e}"))?;
    req.extend_from_slice(&port_buf);

    let (host, port) = match socks5_parse_request(&req) {
        Ok(pair) => pair,
        Err(reply) => {
            let _ = stream.write_all(&reply.to_bytes()).await;
            return Err(format!("SOCKS5 请求被拒绝 (REP={})", reply.code()));
        }
    };

    // === 4. 动态开 direct-tcpip channel 到目标 ===
    // originator 填 "127.0.0.1:0" (仅日志用)
    let channel = match session.open_tcpip_channel(&host, port as u32, "127.0.0.1", 0).await {
        Ok(ch) => ch,
        Err(e) => {
            log::debug!("[tunnel] socks5 connect target failed: {}:{} err={}", host, port, e);
            let _ = stream.write_all(&Socks5Reply::HostUnreachable.to_bytes()).await;
            return Err(format!("连接目标 {}:{} 失败: {e}", host, port));
        }
    };

    // === 5. 回成功响应, 进入桥接 ===
    stream
        .write_all(&Socks5Reply::Succeeded.to_bytes())
        .await
        .map_err(|e| format!("成功响应失败: {e}"))?;
    log::debug!("[tunnel] socks5 connect established: {}:{}", host, port);

    bridge_connection(stream, channel).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tunnel_state_serialization_snake_case() {
        // 验证 TunnelState 序列化为 snake_case (前端 TS 期望)
        assert_eq!(
            serde_json::to_string(&TunnelState::Running).unwrap(),
            "\"running\""
        );
        assert_eq!(
            serde_json::to_string(&TunnelState::Starting).unwrap(),
            "\"starting\""
        );
        assert_eq!(
            serde_json::to_string(&TunnelState::Stopping).unwrap(),
            "\"stopping\""
        );
        assert_eq!(
            serde_json::to_string(&TunnelState::Stopped).unwrap(),
            "\"stopped\""
        );
        assert_eq!(
            serde_json::to_string(&TunnelState::Failed).unwrap(),
            "\"failed\""
        );
    }

    #[test]
    fn test_tunnel_kind_serialization_snake_case() {
        // P3 #24: TunnelKind 序列化为 snake_case (前端 TS 期望)
        assert_eq!(
            serde_json::to_string(&TunnelKind::Local).unwrap(),
            "\"local\""
        );
        assert_eq!(
            serde_json::to_string(&TunnelKind::Remote).unwrap(),
            "\"remote\""
        );
        assert_eq!(
            serde_json::to_string(&TunnelKind::Socks5).unwrap(),
            "\"socks5\""
        );
        // 反序列化 (前端传 kind)
        assert_eq!(
            serde_json::from_str::<TunnelKind>("\"remote\"").unwrap(),
            TunnelKind::Remote
        );
        assert_eq!(
            serde_json::from_str::<TunnelKind>("\"socks5\"").unwrap(),
            TunnelKind::Socks5
        );
    }

    #[test]
    fn test_tunnel_spec_deserialize_camel_case() {
        // 验证 TunnelSpec 反序列化 (前端 camelCase 参数)
        let json = r#"{
            "name": "pg-tunnel",
            "sessionId": 3,
            "localPort": 5432,
            "remoteHost": "db.internal",
            "remotePort": 5432
        }"#;
        let spec: TunnelSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.name, "pg-tunnel");
        assert_eq!(spec.session_id, 3);
        // localHost 未传 → 默认 127.0.0.1
        assert_eq!(spec.local_host, "127.0.0.1");
        assert_eq!(spec.local_port, 5432);
        assert_eq!(spec.remote_host, "db.internal");
        assert_eq!(spec.remote_port, 5432);
        // P3 #24: kind 缺省 → Local (向后兼容 P2)
        assert_eq!(spec.kind, TunnelKind::Local);
        // bindAddress 缺省 → 默认 127.0.0.1
        assert_eq!(spec.bind_address, "127.0.0.1");
    }

    #[test]
    fn test_tunnel_spec_deserialize_remote() {
        // P3 #24: Remote 模式反序列化 (bindPort=0 → None 语义, 服务器自动分配)
        let json = r#"{
            "name": "expose-dev",
            "sessionId": 2,
            "kind": "remote",
            "bindAddress": "127.0.0.1",
            "bindPort": 18080,
            "localTargetHost": "127.0.0.1",
            "localTargetPort": 3000
        }"#;
        let spec: TunnelSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.kind, TunnelKind::Remote);
        assert_eq!(spec.bind_address, "127.0.0.1");
        assert_eq!(spec.bind_port, Some(18080));
        assert_eq!(spec.local_target_host.as_deref(), Some("127.0.0.1"));
        assert_eq!(spec.local_target_port, Some(3000));
    }

    #[test]
    fn test_tunnel_spec_deserialize_socks5() {
        // P3 #24: Socks5 模式反序列化 (只需本地监听; remote 字段忽略)
        let json = r#"{
            "name": "socks-proxy",
            "sessionId": 1,
            "kind": "socks5",
            "localHost": "127.0.0.1",
            "localPort": 1080
        }"#;
        let spec: TunnelSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.kind, TunnelKind::Socks5);
        assert_eq!(spec.local_host, "127.0.0.1");
        assert_eq!(spec.local_port, 1080);
    }

    #[test]
    fn test_tunnel_spec_deserialize_with_local_host() {
        let json = r#"{
            "name": "exposed",
            "sessionId": 1,
            "localHost": "0.0.0.0",
            "localPort": 8080,
            "remoteHost": "127.0.0.1",
            "remotePort": 80
        }"#;
        let spec: TunnelSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.local_host, "0.0.0.0");
        assert_eq!(spec.local_port, 8080);
        assert_eq!(spec.remote_port, 80);
    }

    #[test]
    fn test_tunnel_info_serialization_camel_case() {
        // 验证 TunnelInfo 序列化为 camelCase (前端 TS 期望)
        let info = TunnelInfo {
            id: 7,
            name: "mysql".to_string(),
            session_id: 2,
            kind: TunnelKind::Local,
            local_host: "127.0.0.1".to_string(),
            local_port: 3306,
            remote_host: "db.internal".to_string(),
            remote_port: 3306,
            bind_address: "127.0.0.1".to_string(),
            bind_port: None,
            local_target_host: None,
            local_target_port: None,
            state: TunnelState::Running,
            connections: 42,
            created_at: 1_700_000_000_000,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"id\":7"));
        assert!(json.contains("\"sessionId\":2"));
        assert!(json.contains("\"kind\":\"local\""));
        assert!(json.contains("\"localHost\":\"127.0.0.1\""));
        assert!(json.contains("\"localPort\":3306"));
        assert!(json.contains("\"remoteHost\":\"db.internal\""));
        assert!(json.contains("\"remotePort\":3306"));
        assert!(json.contains("\"state\":\"running\""));
        assert!(json.contains("\"connections\":42"));
        assert!(json.contains("\"createdAt\":1700000000000"));
        // Option 字段序列化为 null (前端可选)
        assert!(json.contains("\"bindPort\":null"));
        assert!(json.contains("\"localTargetHost\":null"));
        assert!(json.contains("\"localTargetPort\":null"));
    }

    #[test]
    fn test_tunnel_info_serialization_remote() {
        // P3 #24: Remote 隧道 info 携带服务器实际端口 + 本地目标
        let info = TunnelInfo {
            id: 8,
            name: "expose-dev".to_string(),
            session_id: 2,
            kind: TunnelKind::Remote,
            local_host: "127.0.0.1".to_string(),
            local_port: 0,
            remote_host: String::new(),
            remote_port: 0,
            bind_address: "127.0.0.1".to_string(),
            bind_port: Some(18080),
            local_target_host: Some("127.0.0.1".to_string()),
            local_target_port: Some(3000),
            state: TunnelState::Running,
            connections: 3,
            created_at: 1_700_000_000_000,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"kind\":\"remote\""));
        assert!(json.contains("\"bindPort\":18080"));
        assert!(json.contains("\"localTargetHost\":\"127.0.0.1\""));
        assert!(json.contains("\"localTargetPort\":3000"));
    }

    #[test]
    fn test_tunnel_spec_clone() {
        // 验证 Clone 派生 (spec 跨 task 传递 / 前端重试用)
        let spec = TunnelSpec {
            name: "t".to_string(),
            session_id: 1,
            kind: TunnelKind::Local,
            local_host: "127.0.0.1".to_string(),
            local_port: 10000,
            remote_host: "r".to_string(),
            remote_port: 20000,
            bind_address: "127.0.0.1".to_string(),
            bind_port: None,
            local_target_host: None,
            local_target_port: None,
        };
        let cloned = spec.clone();
        assert_eq!(cloned.name, spec.name);
        assert_eq!(cloned.session_id, spec.session_id);
        assert_eq!(cloned.kind, spec.kind);
        assert_eq!(cloned.local_port, spec.local_port);
        assert_eq!(cloned.remote_host, spec.remote_host);
    }

    // === SOCKS5 解析测试 (P3 #24) ===

    #[test]
    fn test_socks5_parse_request_ipv4() {
        // IPv4 + 大端端口
        let buf = [0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x1F, 0x90];
        let (host, port) = socks5_parse_request(&buf).unwrap();
        assert_eq!(host, "10.0.0.1");
        assert_eq!(port, 8080);
    }

    #[test]
    fn test_socks5_parse_request_domain() {
        // 域名: db.internal:5432
        let mut buf = vec![0x05, 0x01, 0x00, 0x03, 11];
        buf.extend_from_slice(b"db.internal");
        buf.extend_from_slice(&[0x15, 0x38]); // 5432 big endian
        let (host, port) = socks5_parse_request(&buf).unwrap();
        assert_eq!(host, "db.internal");
        assert_eq!(port, 5432);
    }

    #[test]
    fn test_socks5_parse_request_ipv6() {
        // IPv6: ::1:22
        let mut buf = vec![0x05, 0x01, 0x00, 0x04];
        buf.extend_from_slice(&[0u8; 15]);
        buf.push(1u8); // ::1
        buf.extend_from_slice(&[0x00, 0x16]); // 22
        let (host, port) = socks5_parse_request(&buf).unwrap();
        assert_eq!(host, "::1");
        assert_eq!(port, 22);
    }

    #[test]
    fn test_socks5_parse_request_rejections() {
        // 版本错误 → 常规失败
        assert_eq!(
            socks5_parse_request(&[0x04, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
            Err(Socks5Reply::GeneralFailure)
        );
        // 命令非 CONNECT (BIND=0x02) → 命令不支持
        assert_eq!(
            socks5_parse_request(&[0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]),
            Err(Socks5Reply::CommandNotSupported)
        );
        // 未知 ATYP → 地址类型不支持
        assert_eq!(
            socks5_parse_request(&[0x05, 0x01, 0x00, 0x09, 0, 0, 0, 0, 0, 0]),
            Err(Socks5Reply::AddressTypeNotSupported)
        );
        // 报文过短 (IPv4 缺端口) → 常规失败
        assert_eq!(
            socks5_parse_request(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0]),
            Err(Socks5Reply::GeneralFailure)
        );
    }

    #[test]
    fn test_socks5_reply_bytes() {
        // 成功响应头格式: [0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]
        assert_eq!(
            Socks5Reply::Succeeded.to_bytes(),
            [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(Socks5Reply::CommandNotSupported.code(), 0x07);
        assert_eq!(Socks5Reply::AddressTypeNotSupported.code(), 0x08);
    }
}
