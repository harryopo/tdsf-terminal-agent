//! SSH 隧道与端口转发 (P2 #23)
//! ============================================================================
//! 本地端口转发 (direct-tcpip): 本地监听端口 → SSH 隧道 → 远程目标。
//! 最常用场景: DBA 通过跳板机连远程数据库 / 访问内网服务, 免 VPN。
//!
//! ## 工作原理
//! ```text
//! 本地客户端 → localhost:local_port (TcpListener)
//!   → SSH channel_open_direct_tcpip(remote_host:remote_port)
//!     → 远程 SSH 服务器发起 TCP 连接 → remote_host:remote_port
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
//! - 创建: `tunnel_start` 命令 (校验 SSH 会话存活 + 本地端口未占用)
//! - 运行: accept_loop task 常驻, 每个入站连接 spawn 一个 bridge task
//! - 停止: `tunnel_stop` 命令 / 所属 SSH 会话断开 (ssh_disconnect 自动清理)
//! - stop 释放本地端口 (drop listener), 已建立的桥接连接自然结束 (与
//!   `ssh -L` Ctrl+C 行为一致)

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

/// 隧道定义 (前端 → Rust, tunnel_start 参数)
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    /// 隧道名称 (用户可读)
    pub name: String,
    /// 所属 SSH 会话 id (ssh_connect 返回值)
    pub session_id: u32,
    /// 本地监听地址 (默认 "127.0.0.1"; 填 "0.0.0.0" 可对外暴露, 慎用)
    #[serde(default = "default_local_host")]
    pub local_host: String,
    /// 本地监听端口
    pub local_port: u16,
    /// 远程目标地址 (相对 SSH 服务器可达)
    pub remote_host: String,
    /// 远程目标端口
    pub remote_port: u16,
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
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
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
    /// 本地监听器 (Some = 已绑定; stop/drop 时 take 释放端口)
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
    /// accept loop task handle (stop 时等待退出)
    task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
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
        }
    }

    /// 绑定本地端口 + 启动 accept loop
    ///
    /// # 错误
    /// - 端口已被占用 (本项目其他隧道或其他进程): bind 失败, 状态置 Failed
    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
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
            "[tunnel] listening: id={} {} → {}:{}",
            self.id,
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

    /// 停止隧道 (幂等)
    ///
    /// 1. 置停止标志 + 状态 Stopping
    /// 2. drop listener (立即释放端口)
    /// 3. 通知 accept loop 退出
    /// 4. 等待 accept loop task 结束 (最多 2s, 防御性)
    /// 5. 状态 Stopped
    pub async fn stop(&self) {
        if self.stop_flag.swap(true, Ordering::AcqRel) {
            return;
        }
        log::info!("[tunnel] stopping: id={}", self.id);
        *self.state.write().unwrap_or_else(|e| e.into_inner()) = TunnelState::Stopping;

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
            local_host: self.spec.local_host.clone(),
            local_port: self.spec.local_port,
            remote_host: self.spec.remote_host.clone(),
            remote_port: self.spec.remote_port,
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
async fn bridge_connection(
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
            local_host: "127.0.0.1".to_string(),
            local_port: 3306,
            remote_host: "db.internal".to_string(),
            remote_port: 3306,
            state: TunnelState::Running,
            connections: 42,
            created_at: 1_700_000_000_000,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"id\":7"));
        assert!(json.contains("\"sessionId\":2"));
        assert!(json.contains("\"localHost\":\"127.0.0.1\""));
        assert!(json.contains("\"localPort\":3306"));
        assert!(json.contains("\"remoteHost\":\"db.internal\""));
        assert!(json.contains("\"remotePort\":3306"));
        assert!(json.contains("\"state\":\"running\""));
        assert!(json.contains("\"connections\":42"));
        assert!(json.contains("\"createdAt\":1700000000000"));
    }

    #[test]
    fn test_tunnel_spec_clone() {
        // 验证 Clone 派生 (spec 跨 task 传递 / 前端重试用)
        let spec = TunnelSpec {
            name: "t".to_string(),
            session_id: 1,
            local_host: "127.0.0.1".to_string(),
            local_port: 10000,
            remote_host: "r".to_string(),
            remote_port: 20000,
        };
        let cloned = spec.clone();
        assert_eq!(cloned.name, spec.name);
        assert_eq!(cloned.session_id, spec.session_id);
        assert_eq!(cloned.local_port, spec.local_port);
        assert_eq!(cloned.remote_host, spec.remote_host);
    }
}
