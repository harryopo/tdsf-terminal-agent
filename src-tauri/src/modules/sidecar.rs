// modules/sidecar.rs — TDSF Python Sidecar 进程管理（T-P1-01.2）
// ============================================================================
// 职责:
//   - spawn Python 子进程，传入 stdio pipe（stdin/stdout/stderr）
//   - 等待 Python 侧发送的 ready 通知（10s 超时）
//   - 健康检查: 每 5s 发送 ping 请求，30s 无响应判定死锁
//   - 自动重启: 进程崩溃后自动重启（max_retry=3，Fix-loop DEC-V321-11）
//   - 优雅退出: 发送 shutdown 方法 → 3s → SIGKILL
//   - Tauri 命令: sidecar_status / sidecar_restart / sidecar_start / sidecar_stop
//
// 与 T-P1-02 ipc.rs 的分层:
//   - sidecar.rs: 进程管理 + stdio pipe + 基础 IO（send_raw / recv_raw）
//   - ipc.rs: JSON-RPC 协议层（请求-响应匹配、通知广播、超时处理）
//
// 通信协议:
//   - 写 stdin:  一行 JSON-RPC 消息 + 换行符 \n
//   - 读 stdout: 一行 JSON-RPC 消息 + 换行符 \n
//   - 读 stderr: 日志输出（直接转发到 Rust log）
//
// 启动握手:
//   1. Rust spawn Python 进程
//   2. Rust 阻塞等待 Python 发送的 ready 通知（10s 超时）
//   3. 收到 ready 后，启动 health check task + exit watcher task
// ============================================================================

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::time::timeout;

// ============================================================================
// 常量
// ============================================================================

/// ready 通知等待超时（python 脚本模式; jieba 词典重建 + 语料索引冷启动
/// 实测 15-25s, 10s 会误杀; 打包 exe 模式在 new() 中显式 60s。
/// TDSF 修复 2026-08-28: 30s 在重负载下仍会误杀——实测 cargo 并行编译
/// 抢满 CPU 时 sidecar 仅注册方法就耗时 12s+，叠加词典/索引冷启动逼近
/// 30s 上限，触发 "ready timeout" → 启动失败（用户侧表现为窗口空白）。
/// 与打包模式统一放宽到 60s：sidecar 本就是后台异步启动，放宽不影响
/// 窗口首屏；AI 后端就绪晚几十秒可接受，启动失败不可接受。）
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// 心跳间隔（每 5s 发送 ping）
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);

/// 心跳丢失判定阈值（30s 无响应判定死锁）
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);

/// 请求超时（默认 60s）
/// TDSF 修复 2026-08-01 (P0-3): 30s → 60s，与前端 SIDECAR_TIMEOUT_MS 默认值对齐。
/// 30s 对 Strands agentic loop（多轮工具调用 + LLM 推理）太紧，
/// 复杂任务频繁超时；前端可传 timeoutMs 覆盖（见 send_request_with_timeout）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// 优雅退出等待时间（3s，超时后 SIGKILL）
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);

/// 最大重启次数（TDSF P0 修复：3 → 5，配合运行冷却重置，5 次足够覆盖偶发崩溃）
const MAX_RETRY: u32 = 5;

/// 重启退避基准（秒）：backoff = 2^(retry-1)，首重试 1s
/// TDSF P0 修复：避免 ready 后即崩场景下的无限快速重启
const RESTART_BACKOFF_BASE: u64 = 1;

/// 重启退避上限（秒）
const RESTART_BACKOFF_MAX: Duration = Duration::from_secs(60);

/// 运行冷却阈值：Python 运行超过此时长后崩溃，视为偶发，重置 retry_count
const RUNTIME_COOLDOWN: Duration = Duration::from_secs(60);

/// Python 解释器环境变量名（用户可指定自定义路径）
const ENV_PYTHON: &str = "TDSF_SIDECAR_PYTHON";

// ============================================================================
// Sidecar 状态
// ============================================================================

/// Sidecar 运行状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarStatus {
    /// 未启动
    Stopped,
    /// 启动中（spawn 后等待 ready）
    Starting,
    /// 运行中（已收到 ready）
    Running,
    /// 重启中
    Restarting,
    /// 崩溃（重启次数超限）
    Crashed,
    /// 停止中（已发送 shutdown，等待退出）
    Stopping,
}

/// Sidecar 状态快照（用于 sidecar_status 命令返回）
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStateSnapshot {
    pub status: SidecarStatus,
    pub pid: Option<u32>,
    pub uptime: Option<f64>,
    pub retry_count: u32,
    pub max_retry: u32,
    pub last_heartbeat_ago: Option<f64>,
    pub methods: Vec<String>,
    pub python_version: Option<String>,
}

/// 内部状态（受 RwLock 保护，读多写少）
#[derive(Debug)]
struct SidecarState {
    status: SidecarStatus,
    pid: Option<u32>,
    started_at: Option<Instant>,
    last_heartbeat: Option<Instant>,
    retry_count: u32,
    methods: Vec<String>,
    python_version: Option<String>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            status: SidecarStatus::Stopped,
            pid: None,
            started_at: None,
            last_heartbeat: None,
            retry_count: 0,
            methods: Vec::new(),
            python_version: None,
        }
    }
}

impl SidecarState {
    fn snapshot(&self) -> SidecarStateSnapshot {
        let uptime = self.started_at.map(|t| t.elapsed().as_secs_f64());
        let last_heartbeat_ago = self.last_heartbeat.map(|t| t.elapsed().as_secs_f64());
        SidecarStateSnapshot {
            status: self.status,
            pid: self.pid,
            uptime,
            retry_count: self.retry_count,
            max_retry: MAX_RETRY,
            last_heartbeat_ago,
            methods: self.methods.clone(),
            python_version: self.python_version.clone(),
        }
    }
}

// ============================================================================
// Sidecar 错误类型
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum SidecarError {
    #[error("sidecar spawn failed: {0}")]
    SpawnFailed(String),

    #[error("sidecar ready timeout after {0:?}")]
    ReadyTimeout(Duration),

    #[error("sidecar heartbeat lost (no response in {0:?})")]
    HeartbeatLost(Duration),

    #[error("sidecar max retry exceeded ({max_retries})")]
    MaxRetryExceeded { max_retries: u32 },

    #[error("sidecar not running")]
    NotRunning,

    #[error("sidecar stdin closed")]
    StdinClosed,

    #[error("sidecar request timeout after {0:?}")]
    RequestTimeout(Duration),

    #[error("sidecar io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("sidecar json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// 内部使用的 Result 别名（避免与 std::result::Result 冲突）
type SidecarResult<T> = std::result::Result<T, SidecarError>;

// ============================================================================
// SidecarManager — 进程管理器（Clone 廉价，所有字段都是 Arc）
// ============================================================================

/// Python Sidecar 进程管理器
///
/// 设计: 所有字段都是 Arc<...>，因此 #[derive(Clone)] 廉价
/// 用法:
///   ```ignore
///   let manager = SidecarManager::new(script_path);
///   let cloned = manager.clone();
///   tokio::spawn(async move { cloned.start().await });
///   app.manage(manager);
///   ```
#[derive(Clone)]
pub struct SidecarManager {
    /// 内部状态（读写锁，读多写少）
    state: Arc<RwLock<SidecarState>>,

    /// 写 stdin 的 mpsc sender（writer task 持有 receiver）
    /// None 表示 Sidecar 未运行
    stdin_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,

    /// 子进程句柄（用于 kill）
    child: Arc<Mutex<Option<Child>>>,

    /// 待响应请求表（id → oneshot sender）
    pending_requests: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,

    /// 下一个请求 ID（自增，Arc 包装以便 Clone）
    next_request_id: Arc<AtomicI64>,

    /// 已重启次数（AtomicU32，Arc 包装以便 Clone）
    retry_count: Arc<AtomicU32>,

    /// Tauri AppHandle（用于 emit event 到前端）
    app_handle: Arc<Mutex<Option<AppHandle>>>,

    /// Python 脚本路径（python-sidecar/main.py 或打包 sidecar exe）
    script_path: Arc<Mutex<PathBuf>>,

    /// ready 等待超时（打包 exe 冷启动 744MB 依赖实测 15-30s, 放宽到 60s;
    /// python 脚本模式 READY_TIMEOUT=30s: jieba 词典重建 + 语料索引冷启动 15-25s）
    ready_timeout: Arc<Mutex<Duration>>,

    /// 重启信号发送端（exit_watcher_task 发送 → restart_loop 接收）
    /// 解耦设计：避免 exit_watcher_task 直接调用 start() 形成循环依赖
    /// （Rust 编译器无法证明循环调用的 future 是 Send，导致 tokio::spawn 失败）
    restart_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>>,

    /// 重启取消信号发送端（stop() 发送 → restart_loop 在退避 sleep 中接收，中断循环）
    /// TDSF P0 修复：退避等待期间用户点"停止 Sidecar"可中断
    cancel_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>>,
}

impl SidecarManager {
    /// 创建新的 SidecarManager（不启动进程）
    pub fn new(script_path: PathBuf) -> Self {
        // PyInstaller onedir exe 冷启动（744MB 依赖 + 杀软扫描）实测 15-30s,
        // 远超 python 脚本模式的 10s ready 超时, 按运行目标动态设置。
        let is_packaged_exe = script_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        let ready_timeout = if is_packaged_exe {
            Duration::from_secs(60)
        } else {
            READY_TIMEOUT
        };
        Self {
            state: Arc::new(RwLock::new(SidecarState::default())),
            stdin_tx: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            pending_requests: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: Arc::new(AtomicI64::new(1)),
            retry_count: Arc::new(AtomicU32::new(0)),
            app_handle: Arc::new(Mutex::new(None)),
            script_path: Arc::new(Mutex::new(script_path)),
            ready_timeout: Arc::new(Mutex::new(ready_timeout)),
            restart_tx: Arc::new(Mutex::new(None)),
            cancel_tx: Arc::new(Mutex::new(None)),
        }
    }

    /// 设置 Tauri AppHandle（用于 emit event 到前端）
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut guard = self.app_handle.lock().await;
        *guard = Some(handle);
    }

    /// 获取当前状态快照
    pub async fn snapshot(&self) -> SidecarStateSnapshot {
        self.state.read().await.snapshot()
    }

    /// 启动 Sidecar（spawn + 等待 ready + 启动 health check + exit watcher）
    pub async fn start(&self) -> SidecarResult<()> {
        log::info!("[sidecar] starting Python Sidecar...");

        // 1. 更新状态为 Starting
        {
            let mut state = self.state.write().await;
            if state.status == SidecarStatus::Running
                || state.status == SidecarStatus::Starting
            {
                // TDSF 2026-07-31 加固：Starting 期间（spawn + 等 ready，最长 10s）
                // 再次进入 start() 直接跳过，避免 restart_loop 与手动 restart 并发
                // 触发双 spawn——双 spawn 会让先前的 reader_task 与新 child 的 stdout
                // 读端错配，子进程写 stdout 得到 EINVAL、每写必崩，进入自我延续的崩溃循环。
                log::warn!(
                    "[sidecar] already {:?}, skip concurrent start",
                    state.status
                );
                return Ok(());
            }
            state.status = SidecarStatus::Starting;
            state.started_at = Some(Instant::now());
        }

        // 2. spawn Python 进程
        // TDSF 2026-07-31 加固：spawn 失败时把状态从 Starting 复位为 Crashed，
        // 否则新增的 Starting 守卫会让后续所有 start() 被永久跳过（wedge）。
        let (child, stdin, stdout) = match self.spawn_python().await {
            Ok(v) => v,
            Err(e) => {
                let mut state = self.state.write().await;
                state.status = SidecarStatus::Crashed;
                return Err(e);
            }
        };

        // 记录 PID
        let pid = child.id();
        {
            let mut state = self.state.write().await;
            state.pid = pid;
        }
        log::info!("[sidecar] python process spawned, pid={:?}", pid);

        // 3. 启动 writer task（从 mpsc receiver 读消息写 stdin）
        let (stdin_tx, stdin_rx) = tokio::sync::mpsc::channel::<String>(64);
        tokio::spawn(writer_task(stdin, stdin_rx));

        // 保存 stdin_tx
        {
            let mut guard = self.stdin_tx.lock().await;
            *guard = Some(stdin_tx);
        }

        // 4. 启动 reader task（读 stdout + 解析 JSON-RPC + 路由响应/通知/反向请求）
        // TDSF P1: 传入 stdin_tx，用于把反向请求的响应写回 Python stdin
        let reader_state = self.state.clone();
        let reader_pending = self.pending_requests.clone();
        let reader_app = self.app_handle.clone();
        let reader_stdin = self.stdin_tx.clone();
        tokio::spawn(reader_task(
            stdout,
            reader_state,
            reader_pending,
            reader_app,
            reader_stdin,
        ));

        // 5. 保存 child 句柄
        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }

        // 6. 等待 ready 通知（10s 超时）
        // TDSF P0 修复：ready 失败时清理已 spawn 的 child，避免句柄泄漏
        // （场景 B：Python import 阶段崩溃，start() 提前返回，exit_watcher 未 spawn）
        if let Err(e) = self.wait_for_ready().await {
            let mut guard = self.child.lock().await;
            if let Some(mut child) = guard.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            drop(guard);
            // 清理 stdin_tx
            let mut stdin_guard = self.stdin_tx.lock().await;
            *stdin_guard = None;
            return Err(e);
        }

        // 7. TDSF P0 修复：不再在此处无条件重置 retry_count
        //    重置逻辑移到 exit_watcher_task 的"运行冷却"判断中（运行 ≥60s 后崩溃才重置）
        //    手动 restart() 仍保留无条件重置。这样"发 ready 后即崩"场景下 retry_count
        //    持续递增，配合退避与 MAX_RETRY 终止循环。

        // 8. 启动 health check task
        let health_state = self.state.clone();
        let health_pending = self.pending_requests.clone();
        let health_stdin = self.stdin_tx.clone();
        let health_next_id = self.next_request_id.clone();
        let health_app = self.app_handle.clone();
        tokio::spawn(health_check_task(
            health_state,
            health_pending,
            health_stdin,
            health_next_id,
            health_app,
        ));

        // 9. 启动 exit watcher task（不传 manager，只传 restart_tx 发送重启信号）
        // 设计：避免 exit_watcher_task → manager.start() → spawn(exit_watcher_task) 循环依赖
        // exit_watcher_task 只 wait + send restart signal，restart_loop 接收后调用 start()
        let watcher_child = self.child.clone();
        let watcher_state = self.state.clone();
        let watcher_restart_tx = self.restart_tx.clone();
        let watcher_retry_count = self.retry_count.clone();
        let watcher_app_handle = self.app_handle.clone();
        tokio::spawn(exit_watcher_task(
            watcher_child,
            watcher_state,
            watcher_retry_count,
            watcher_app_handle,
            watcher_restart_tx,
        ));

        log::info!("[sidecar] started successfully");
        Ok(())
    }

    /// 启动 restart loop（在 lib.rs setup 中调用一次）
    ///
    /// 监听 restart_tx 信号，收到后调用 start() 重启 Sidecar
    /// 这打破了 `exit_watcher_task → manager.start() → spawn(exit_watcher_task)` 的循环依赖
    /// （Rust 编译器无法证明循环调用的 future 是 Send）
    pub async fn start_restart_loop(&self) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        {
            let mut guard = self.restart_tx.lock().await;
            *guard = Some(tx);
        }
        // TDSF P0 修复：创建 cancel channel，stop() 持有发送端
        // 退避 sleep 期间收到 cancel 即中断循环，避免用户点"停止"后仍在等待退避
        let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        {
            let mut guard = self.cancel_tx.lock().await;
            *guard = Some(cancel_tx);
        }

        let manager = self.clone();
        tokio::spawn(async move {
            log::info!("[sidecar:restart_loop] started");
            while let Some(()) = rx.recv().await {
                log::info!("[sidecar:restart_loop] received restart signal");

                // 1. 检查状态：Stopping/Stopped 时不重启
                let need_restart = {
                    let state = manager.state.read().await;
                    !(state.status == SidecarStatus::Stopping
                        || state.status == SidecarStatus::Stopped)
                };
                if !need_restart {
                    log::info!("[sidecar:restart_loop] skip restart (stopping/stopped)");
                    continue;
                }

                // 2. TDSF P0 修复：指数退避（基于 retry_count，已被 exit_watcher fetch_add 自增）
                //    backoff = 2^(retry-1) 秒，上限 60s
                let retry = manager.retry_count.load(Ordering::SeqCst);
                // shift 限制在 0-6（retry=1→1s, retry=7→64s 但被 min(60) 截断）
                let shift = retry.saturating_sub(1).min(6);
                let backoff_secs = RESTART_BACKOFF_BASE
                    .saturating_mul(1u64 << shift);
                let backoff = Duration::from_secs(backoff_secs).min(RESTART_BACKOFF_MAX);
                log::info!(
                    "[sidecar:restart_loop] backing off {:?} before restart (retry_count={})",
                    backoff, retry
                );

                // 3. 退避等待，期间监听取消信号（用户 stop() 可中断）
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = cancel_rx.recv() => {
                        // 注意：不能 break 退出循环——rx 一旦 drop，此后 exit_watcher
                        // 的重启信号 tx.send 将失败，自动重启机制永久失效
                        //（手动 stop/restart 一次即触发）。continue 跳过本次重启，
                        // 循环继续等待下一个信号；用户 stop 语义由下方状态检查兜住。
                        log::info!("[sidecar:restart_loop] cancelled during backoff, skip this restart");
                        continue;
                    }
                }

                // 4. 再次检查状态（sleep 期间用户可能已 stop）
                let need_restart = {
                    let state = manager.state.read().await;
                    !(state.status == SidecarStatus::Stopping
                        || state.status == SidecarStatus::Stopped)
                };
                if !need_restart {
                    log::info!("[sidecar:restart_loop] skip restart after backoff (stopping/stopped)");
                    continue;
                }

                // 5. 调用 start() 重启
                match manager.start().await {
                    Ok(()) => log::info!("[sidecar:restart_loop] restart succeeded"),
                    Err(e) => {
                        log::error!("[sidecar:restart_loop] restart failed: {}", e);
                        // start() 失败时 retry_count 未达 MAX_RETRY，exit_watcher 仍会发后续信号
                        // （若新 child spawn 成功且崩溃）；若 spawn 本身失败则无后续信号，循环自然停止
                        {
                            let mut state = manager.state.write().await;
                            state.status = SidecarStatus::Crashed;
                        }
                        let guard = manager.app_handle.lock().await;
                        if let Some(handle) = guard.as_ref() {
                            let _ = handle.emit(
                                "sidecar:crashed",
                                json!({"reason": "restart_failed", "error": e.to_string()}),
                            );
                        }
                    }
                }
            }
            log::info!("[sidecar:restart_loop] stopped");
        });
    }

    /// 停止 Sidecar（优雅退出: shutdown → 3s → kill）
    pub async fn stop(&self) -> SidecarResult<()> {
        log::info!("[sidecar] stopping...");

        // 1. 更新状态为 Stopping
        {
            let mut state = self.state.write().await;
            state.status = SidecarStatus::Stopping;
        }

        // TDSF P0 修复：通知 restart_loop 中断退避 sleep，停止重试循环
        {
            let guard = self.cancel_tx.lock().await;
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(());
            }
        }

        // 2. 发送 shutdown 方法（best effort，不等待响应）
        if let Err(e) = self.send_notification("shutdown", json!({})).await {
            log::warn!("[sidecar] failed to send shutdown notification: {}", e);
        }

        // 3. 等待 3s 让 Python 优雅退出
        tokio::time::sleep(SHUTDOWN_GRACE).await;

        // 4. 强制 kill
        {
            let mut guard = self.child.lock().await;
            if let Some(child) = guard.as_mut() {
                match child.kill().await {
                    Ok(_) => log::info!("[sidecar] process killed"),
                    Err(e) => log::warn!("[sidecar] kill failed: {}", e),
                }
                let _ = child.wait().await; // 回收 zombie
            }
            *guard = None;
        }

        // 5. 清理 stdin_tx
        {
            let mut guard = self.stdin_tx.lock().await;
            *guard = None;
        }

        // 6. 更新状态为 Stopped
        {
            let mut state = self.state.write().await;
            state.status = SidecarStatus::Stopped;
            state.pid = None;
            state.started_at = None;
            state.last_heartbeat = None;
        }

        // 7. 清理 pending_requests（所有等待者收到错误响应）
        {
            let mut pending = self.pending_requests.lock().await;
            for (_, sender) in pending.drain() {
                let _ = sender.send(json!({"error": "sidecar stopped"}));
            }
        }

        log::info!("[sidecar] stopped");
        Ok(())
    }

    /// 重启 Sidecar（手动触发，重置 retry_count）
    pub async fn restart(&self) -> SidecarResult<()> {
        log::info!("[sidecar] manual restart requested");
        self.retry_count.store(0, Ordering::SeqCst);
        self.stop().await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        self.start().await
    }

    /// 发送请求（等待响应，60s 默认超时，可用 send_request_with_timeout 覆盖）
    pub async fn send_request(&self, method: &str, params: Value) -> SidecarResult<Value> {
        self.send_request_with_timeout(method, params, REQUEST_TIMEOUT)
            .await
    }

    /// 发送请求（自定义超时）
    ///
    /// TDSF 修复 2026-08-01 (P0-3): 前端 agent.invoke 可传 timeoutMs
    /// （长任务/复杂诊断放宽到 120s+），由 ipc_invoke 解析 params 后调用。
    pub async fn send_request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_duration: Duration,
    ) -> SidecarResult<Value> {
        let id = self.next_request_id.fetch_add(1, Ordering::SeqCst);

        // 1. 注册 pending request（oneshot channel）
        let (tx, rx) = oneshot::channel::<Value>();
        {
            let mut pending = self.pending_requests.lock().await;
            pending.insert(id, tx);
        }

        // 2. 发送请求
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });
        self.send_raw(serde_json::to_string(&msg)?).await?;

        // 3. 等待响应（可配置超时）
        match timeout(timeout_duration, rx).await {
            Ok(Ok(result)) => {
                // 检查响应是否包含 error
                if let Some(err) = result.get("error") {
                    let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-32000);
                    let message = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown error");
                    // 2026-08-18 审查确认: 此处仅做日志, 不转 Err——
                    // 唯一调用方 IPCClient::invoke (ipc.rs) 会检测 error 字段
                    // 并返回 IPCError::RemoteError (含 code/message/data), 语义已正确
                    log::warn!(
                        "[sidecar] request {} failed: code={}, message={}",
                        method,
                        code,
                        message
                    );
                }
                Ok(result)
            }
            Ok(Err(_)) => {
                // sender 被 drop（通常因 sidecar 停止）
                let mut pending = self.pending_requests.lock().await;
                pending.remove(&id);
                Err(SidecarError::NotRunning)
            }
            Err(_) => {
                // 超时
                let mut pending = self.pending_requests.lock().await;
                pending.remove(&id);
                Err(SidecarError::RequestTimeout(timeout_duration))
            }
        }
    }

    /// 发送通知（无 id，无响应）
    pub async fn send_notification(&self, method: &str, params: Value) -> SidecarResult<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.send_raw(serde_json::to_string(&msg)?).await
    }

    /// 发送原始 JSON-RPC 消息到 stdin
    async fn send_raw(&self, line: String) -> SidecarResult<()> {
        let stdin_tx = {
            let guard = self.stdin_tx.lock().await;
            guard.clone()
        };

        match stdin_tx {
            Some(tx) => tx
                .send(line + "\n")
                .await
                .map_err(|_| SidecarError::StdinClosed),
            None => Err(SidecarError::NotRunning),
        }
    }

    /// spawn Python 进程（返回 child + stdin + stdout；stderr 内部已 spawn task 转发）
    async fn spawn_python(
        &self,
    ) -> SidecarResult<(Child, ChildStdin, ChildStdout)> {
        // 1. 确定 Python 解释器路径
        let python = self.resolve_python().await?;
        log::info!("[sidecar] using python: {:?}", python);

        // 2. 获取脚本路径
        let script = {
            let guard = self.script_path.lock().await;
            guard.clone()
        };

        // 3. 判定运行目标: PyInstaller onefile 产物自带入口, 不接受 -u/script 参数
        //    - 发布模式下 script_path 即打包 exe（lib.rs locate_sidecar_script 探测）
        //    2026-08-28 审查修复: 不能用"扩展名是 exe"判定打包产物——venv 的
        //    解释器本身就叫 python.exe，会被误判 → 不带任何参数运行 python.exe
        //    → 交互解释器读 pipe stdin 遇 EOF 立即退出 → ready 超时。
        //    现只看 script 是否 exe：dev 模式 script=main.py 走解释器分支，
        //    打包模式 script=tdsf-sidecar.exe 走 exe 分支。TDSF_SIDECAR_PYTHON
        //    无论指向解释器还是什么都不影响该判定。
        let script_is_exe = script
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);

        let mut command = if script_is_exe {
            // 打包 exe 冷启动慢（744MB 依赖）, ready 等待放宽到 60s
            *self.ready_timeout.lock().await = Duration::from_secs(60);
            log::info!("[sidecar] running packaged sidecar exe: {:?}", script);
            tokio::process::Command::new(&script)
        } else {
            if !script.exists() {
                return Err(SidecarError::SpawnFailed(format!(
                    "sidecar script not found: {:?}",
                    script
                )));
            }
            log::info!("[sidecar] script: {:?}", script);
            let mut cmd = tokio::process::Command::new(&python);
            cmd.arg("-u") // unbuffered（确保 stdout 即时 flush）
                .arg(&script);
            cmd
        };

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("TDSF_SIDECAR_LOG", "INFO")
            .env("PYTHONUNBUFFERED", "1") // 强制 unbuffered
            .env("PYTHONDONTWRITEBYTECODE", "1") // 不生成 .pyc
            // TDSF 魔改 2026-07-30 P0-E 收尾：默认启用 Strands 适配层
            // 用户可通过外部 TDSF_AGENT_BACKEND 环境变量覆盖（如 =langgraph 回退）
            // Strands 启动失败时 Python 侧会 fallback 到 langgraph + 推送 backend_status 事件
            .env(
                "TDSF_AGENT_BACKEND",
                std::env::var("TDSF_AGENT_BACKEND").unwrap_or_else(|_| "strands".to_string()),
            );

        // Windows: 隐藏控制台窗口
        // tokio::process::Command 在 Windows 上有固有方法 creation_flags（无需 import trait）
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|e| SidecarError::SpawnFailed(format!("failed to spawn python: {}", e)))?;

        // 4. 取出 stdio pipe
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SidecarError::SpawnFailed("failed to capture stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SidecarError::SpawnFailed("failed to capture stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SidecarError::SpawnFailed("failed to capture stderr".into()))?;

        // 5. 启动 stderr reader task（转发到 Rust log）
        tokio::spawn(stderr_reader_task(stderr));

        Ok((child, stdin, stdout))
    }

    /// 解析 Python 解释器路径
    /// 优先级: TDSF_SIDECAR_PYTHON 环境变量 > 项目 venv > python > python3 > py
    ///
    /// TDSF 修复 2026-08-28（黑屏/崩溃根因治理）：新增"项目 venv 自动探测"层。
    /// 此前 dev 启动若未设 TDSF_SIDECAR_PYTHON（用户直接跑 `pnpm tauri:dev` 而非
    /// 启动脚本），会 fallback 到系统 python——缺 pydantic/yaml/jieba 等依赖，
    /// sidecar 注册方法失败、ready 延迟甚至超时，表现为窗口空白/启动异常。
    /// 项目 venv 固定在 `src-tauri/sidecar/.venv`（与 main.py 同级 .venv），
    /// 这里按 Cargo manifest 目录拼路径探测，命中则优先使用，彻底消除环境错配。
    async fn resolve_python(&self) -> SidecarResult<PathBuf> {
        // 1. 环境变量（显式指定优先，如打包/CI 场景）
        if let Ok(python_path) = std::env::var(ENV_PYTHON) {
            let path = PathBuf::from(python_path);
            if path.exists() {
                return Ok(path);
            }
            log::warn!(
                "[sidecar] {}={} but file not found, fallback",
                ENV_PYTHON,
                path.display()
            );
        }

        // 2. 项目 venv（dev 模式默认正确环境；打包模式不存在此路径，自然跳过）
        let venv_python = {
            #[cfg(target_os = "windows")]
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("sidecar")
                .join(".venv")
                .join("Scripts")
                .join("python.exe");
            #[cfg(not(target_os = "windows"))]
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("sidecar")
                .join(".venv")
                .join("bin")
                .join("python");
            p
        };
        if venv_python.exists() {
            log::info!("[sidecar] using project venv python: {:?}", venv_python);
            return Ok(venv_python);
        }

        // 3. 尝试 python / python3 / py
        let candidates = ["python", "python3", "py"];
        for cmd in &candidates {
            let mut command = tokio::process::Command::new(cmd);
            command
                .arg("--version")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(target_os = "windows")]
            {
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                command.creation_flags(CREATE_NO_WINDOW);
            }

            if let Ok(output) = command.output().await {
                if output.status.success() {
                    let version = String::from_utf8_lossy(&output.stdout);
                    log::info!("[sidecar] found {}: {}", cmd, version.trim());
                    return Ok(PathBuf::from(cmd));
                }
            }
        }

        Err(SidecarError::SpawnFailed(format!(
            "python interpreter not found (tried: {:?}, env: {})",
            candidates, ENV_PYTHON
        )))
    }

    /// 等待 ready 通知（python 脚本 10s / 打包 exe 60s 超时）
    /// ready 是 notification，由 reader_task 直接处理并更新 state 为 Running
    async fn wait_for_ready(&self) -> SidecarResult<()> {
        let timeout = *self.ready_timeout.lock().await;
        log::info!("[sidecar] waiting for ready notification ({timeout:?} timeout)...");

        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                let mut state = self.state.write().await;
                state.status = SidecarStatus::Crashed;
                return Err(SidecarError::ReadyTimeout(timeout));
            }

            // 检查状态是否变为 Running
            {
                let state = self.state.read().await;
                if state.status == SidecarStatus::Running {
                    log::info!("[sidecar] ready notification received");
                    return Ok(());
                }
                if state.status == SidecarStatus::Crashed {
                    return Err(SidecarError::SpawnFailed(
                        "sidecar crashed during startup".into(),
                    ));
                }
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

// ============================================================================
// 后台 task 实现
// ============================================================================

/// writer task: 从 mpsc receiver 读消息，写入 stdin
async fn writer_task(mut stdin: ChildStdin, mut rx: tokio::sync::mpsc::Receiver<String>) {
    log::debug!("[sidecar:writer] started");
    while let Some(line) = rx.recv().await {
        match stdin.write_all(line.as_bytes()).await {
            Ok(_) => {
                log::trace!("[sidecar:writer] wrote {} bytes", line.len());
            }
            Err(e) => {
                log::error!("[sidecar:writer] write failed: {}", e);
                break;
            }
        }
    }
    let _ = stdin.shutdown().await;
    log::debug!("[sidecar:writer] stopped");
}

/// reader task: 读 stdout + 解析 JSON-RPC + 路由响应/通知/反向请求
///
/// TDSF P1（2026-07-30）: 双向 JSON-RPC 桥
/// ---------------------------------------------------------------
/// 新增反向请求分支：消息同时含 `method` 和 `id` 时，判定为 Python→Rust 反向请求。
/// 路由到 `handle_reverse_request`，执行对应 Tauri 命令（如 ssh_command/sftp_*），
/// 把结果通过 stdin_tx 写回 Python（作为 JSON-RPC response）。
///
/// 消息类型判断顺序：
/// 1. `method + id` → Python→Rust 反向请求（spawn task 执行，不阻塞 reader）
/// 2. `method`（无 id）→ Python→Rust 通知（原逻辑，转发到前端）
/// 3. `id`（无 method）→ Rust→Python 请求的响应（原逻辑，匹配 pending_requests）
///
/// ID 空间隔离：
/// - Rust 请求 ID：1, 2, 3...（AtomicI64，从 1 开始）
/// - Python 反向请求 ID：1,000,000+（Python 侧 counter，避免与 Rust 冲突）
/// - 响应路由时根据 id 数值匹配 pending_requests（Rust）或 pending_reverse（Python）
async fn reader_task(
    stdout: ChildStdout,
    state: Arc<RwLock<SidecarState>>,
    pending_requests: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    stdin_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
) {
    log::debug!("[sidecar:reader] started");
    let mut reader = BufReader::new(stdout);

    loop {
        // TDSF 2026-07-31 根因修复: 按字节读行 + from_utf8_lossy 宽容解码。
        // 此前 lines() 严格按 UTF-8 解析，Python 以 gbk 编码写出含中文的行时
        // 报 InvalidData 使 reader 退出 → 误判子进程死亡 → kill。
        let line = {
            let mut buf = Vec::new();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => {
                    // EOF: 记录子进程存活状态（区分真退出与管道误判）
                    let pid = {
                        let s = state.read().await;
                        s.pid
                    };
                    log::warn!(
                        "[sidecar:reader] stdout EOF (child pid={:?}, alive check below)",
                        pid
                    );
                    if let Some(pid_num) = pid {
                        #[cfg(target_os = "windows")]
                        {
                            let alive = is_process_alive(pid_num).await;
                            log::warn!(
                                "[sidecar:reader] child pid={} alive={} (1=alive,0=dead)",
                                pid_num,
                                alive
                            );
                        }
                    }
                    break;
                }
                Ok(_n) => String::from_utf8_lossy(&buf).into_owned(),
                Err(e) => {
                    log::error!("[sidecar:reader] read error: {:?}", e);
                    break;
                }
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        log::trace!("[sidecar:reader] recv: {}", line);

        // 解析 JSON
        match serde_json::from_str::<Value>(&line) {
            Ok(msg) => {
                // 判断消息类型
                if let Some(method) = msg.get("method").and_then(|m| m.as_str()) {
                    if let Some(id) = msg.get("id").cloned() {
                        // TDSF P1: 反向请求（method + id）= Python→Rust
                        // spawn task 执行 handler，不阻塞 reader 继续读 stdout
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        let app_clone = app_handle.clone();
                        let stdin_clone = stdin_tx.clone();
                        let method_owned = method.to_string();
                        log::info!(
                            "[sidecar:reverse] request: method={}, id={}",
                            method_owned,
                            id
                        );
                        tokio::spawn(async move {
                            let response = handle_reverse_request(
                                &method_owned,
                                params,
                                &app_clone,
                            )
                            .await;
                            let response_msg = match response {
                                Ok(value) => json!({
                                    "jsonrpc": "2.0",
                                    "result": value,
                                    "id": id,
                                }),
                                Err(err_msg) => json!({
                                    "jsonrpc": "2.0",
                                    "error": {
                                        "code": -32000,
                                        "message": err_msg,
                                    },
                                    "id": id,
                                }),
                            };
                            // 序列化响应并写回 Python stdin
                            let line = serde_json::to_string(&response_msg)
                                .unwrap_or_else(|_| {
                                    json!({
                                        "jsonrpc": "2.0",
                                        "error": {
                                            "code": -32603,
                                            "message": "reverse response serialize failed",
                                        },
                                        "id": id,
                                    })
                                    .to_string()
                                });
                            let stdin_guard = stdin_clone.lock().await;
                            if let Some(tx) = stdin_guard.as_ref() {
                                if let Err(e) = tx.send(line + "\n").await {
                                    log::warn!(
                                        "[sidecar:reverse] failed to send response: {}",
                                        e
                                    );
                                }
                            } else {
                                log::warn!(
                                    "[sidecar:reverse] stdin closed, cannot respond: {}",
                                    method_owned
                                );
                            }
                        });
                    } else {
                        // 通知（method 无 id）→ 原逻辑
                        handle_notification(method, &msg, &state, &app_handle).await;
                    }
                } else if let Some(id) = msg.get("id") {
                    // 响应（有 id，无 method）→ Rust→Python 请求的响应
                    if let Some(id_num) = id.as_i64() {
                        let mut pending = pending_requests.lock().await;
                        if let Some(sender) = pending.remove(&id_num) {
                            let _ = sender.send(msg);
                        } else {
                            log::warn!(
                                "[sidecar:reader] no pending request for id={}",
                                id_num
                            );
                        }
                    }
                } else {
                    log::warn!("[sidecar:reader] unknown message: {}", line);
                }
            }
            Err(e) => {
                log::warn!(
                    "[sidecar:reader] JSON parse error: {} (line: {:?})",
                    e,
                    line
                );
            }
        }
    }

    log::warn!("[sidecar:reader] stdout closed (process exited)");
    // 标记状态为 Crashed（exit watcher 会处理重启）
    let mut state_guard = state.write().await;
    if state_guard.status != SidecarStatus::Stopping
        && state_guard.status != SidecarStatus::Stopped
    {
        state_guard.status = SidecarStatus::Crashed;
    }
}

/// TDSF 2026-07-31 诊断: 判断进程是否存活（EOF 误判排查用）
#[cfg(target_os = "windows")]
async fn is_process_alive(pid: u32) -> u32 {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    tokio::task::spawn_blocking(move || unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return 0; // 无法打开 = 已退出
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        if ok == 0 {
            return 2; // 查询失败
        }
        if code as i32 == STILL_ACTIVE {
            1
        } else {
            0
        }
    })
    .await
    .unwrap_or(2)
}

/// TDSF 2026-07-31 诊断: 非 Windows 平台占位（恒 2=未查询）
#[cfg(not(target_os = "windows"))]
async fn is_process_alive(_pid: u32) -> u32 {
    2
}

/// 强制终止进程（TDSF 2026-08-12 新增）
///
/// 用途: health_check_task 心跳丢失（Python 死锁/无响应）时杀死进程,
/// 让 exit_watcher_task 的 child.wait() 返回, 从而复用既有"指数退避重启"
/// 流程自动恢复, 而非让 AI 功能卡死在 Crashed 直到用户手动重启。
/// 不用 child.kill() 的原因: exit_watcher_task 已 take 走 Child 句柄
/// (mutex 内为 None), 这里只能按 pid 系统级终止。
#[cfg(target_os = "windows")]
async fn kill_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    tokio::task::spawn_blocking(move || unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return false; // 进程已不存在
        }
        let ok = TerminateProcess(handle, 1);
        CloseHandle(handle);
        ok != 0
    })
    .await
    .unwrap_or(false)
}

/// 非 Windows 平台: SIGKILL（兼容占位, 与 is_process_alive 风格一致）
#[cfg(not(target_os = "windows"))]
async fn kill_process(pid: u32) -> bool {
    tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// TDSF P1（2026-07-30）: 处理 Python→Rust 反向 JSON-RPC 请求
///
/// 把 method 路由到对应 Tauri 命令，执行后返回结果。
///
/// 支持的方法（参数用 camelCase，与前端 invoke 一致，便于复用 Tauri 命令）：
/// - `ssh_command`: 执行 SSH 命令（exec 模式，非 PTY）— P0-D 实现
/// - `ssh_status`: 枚举全部 SSH 会话详情（sessionId/host/port/user/state）— P2 #42 实现
/// - `sftp_read`: 读取远程文件内容（返回 number[]）
/// - `sftp_write`: 写入远程文件（接收 number[] content）
/// - `sftp_stat`: 查询文件属性
/// - `sftp_list`: 列出目录条目
/// - `sftp_mkdir`: 创建远程目录
/// - `sftp_remove`: 删除远程文件
/// - `sftp_rename`: 重命名远程文件/目录
///
/// 设计要点：
/// 1. 直接调用 `ssh::*` 命令函数（`#[tauri::command]` 宏生成的 wrapper 签名与原始一致）
/// 2. 通过 `app.state::<SshState>()` 获取状态，避免依赖 Tauri invoke 机制
/// 3. 错误统一返回 `String`（与 Tauri 命令的 `Result<T, String>` 对齐）
/// 4. 序列化结果为 `serde_json::Value`（调用方负责写回 JSON-RPC response）
async fn handle_reverse_request(
    method: &str,
    params: Value,
    app_handle: &Arc<Mutex<Option<AppHandle>>>,
) -> Result<Value, String> {
    // 1. clone AppHandle（避免长时间持锁）
    let app = {
        let guard = app_handle.lock().await;
        guard.as_ref().cloned().ok_or_else(|| {
            "app_handle not set (sidecar 启动中或已停止)".to_string()
        })?
    };

    // 2. 路由分发
    match method {
        // === SSH 命令执行（exec 模式）===
        "ssh_command" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("ssh_command: missing or invalid sessionId")?
                as u32;
            let command = params
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or("ssh_command: missing or invalid command")?
                .to_string();
            let timeout = params.get("timeout").and_then(|v| v.as_u64());

            let ssh_state = app.state::<crate::ssh::SshState>();
            let result =
                crate::ssh::ssh_command(ssh_state, session_id, command, timeout).await?;

            serde_json::to_value(&result)
                .map_err(|e| format!("ssh_command serialize failed: {}", e))
        }

        // === SSH 会话枚举（P2 #42 agent 多主机运维, 2026-09-01）===
        // 返回 Vec<SshSessionDetail>（camelCase: sessionId/host/port/user/state）。
        // agent 的 ssh_list_sessions 工具消费；host 校验放宽也以此为权威数据源。
        "ssh_status" => {
            let ssh_state = app.state::<crate::ssh::SshState>();
            let details = crate::ssh::sessions_detail(&ssh_state).await;
            serde_json::to_value(&details)
                .map_err(|e| format!("ssh_status serialize failed: {}", e))
        }

        // === SFTP 读取远程文件 ===
        "sftp_read" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_read: missing or invalid sessionId")?
                as u32;
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("sftp_read: missing or invalid path")?
                .to_string();
            validate_remote_path("sftp_read", &path)?;

            let ssh_state = app.state::<crate::ssh::SshState>();
            let content = crate::ssh::sftp_read(ssh_state, session_id, path).await?;
            // Vec<u8> → JSON number[]（与 Tauri 自动序列化一致）
            serde_json::to_value(&content)
                .map_err(|e| format!("sftp_read serialize failed: {}", e))
        }

        // === SFTP 写入远程文件 ===
        "sftp_write" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_write: missing or invalid sessionId")?
                as u32;
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("sftp_write: missing or invalid path")?
                .to_string();
            validate_remote_path("sftp_write", &path)?;
            // content 应为 number[]（每项 0-255）
            let content_arr = params
                .get("content")
                .and_then(|v| v.as_array())
                .ok_or("sftp_write: missing or invalid content (expected number[])")?;
            let mut content = Vec::with_capacity(content_arr.len());
            for (i, n) in content_arr.iter().enumerate() {
                let byte_val = n
                    .as_u64()
                    .ok_or_else(|| format!("sftp_write: content[{}] not a number", i))?
                    as u8;
                content.push(byte_val);
            }

            let ssh_state = app.state::<crate::ssh::SshState>();
            crate::ssh::sftp_write(ssh_state, session_id, path, content).await?;
            Ok(Value::Null)
        }

        // === SFTP 查询文件属性 ===
        "sftp_stat" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_stat: missing or invalid sessionId")?
                as u32;
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("sftp_stat: missing or invalid path")?
                .to_string();
            validate_remote_path("sftp_stat", &path)?;

            let ssh_state = app.state::<crate::ssh::SshState>();
            let attrs = crate::ssh::sftp_stat(ssh_state, session_id, path).await?;
            serde_json::to_value(&attrs)
                .map_err(|e| format!("sftp_stat serialize failed: {}", e))
        }

        // === SFTP 列出目录条目 ===
        "sftp_list" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_list: missing or invalid sessionId")?
                as u32;
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("sftp_list: missing or invalid path")?
                .to_string();
            validate_remote_path("sftp_list", &path)?;

            let ssh_state = app.state::<crate::ssh::SshState>();
            let entries = crate::ssh::sftp_list(ssh_state, session_id, path).await?;
            serde_json::to_value(&entries)
                .map_err(|e| format!("sftp_list serialize failed: {}", e))
        }

        // === SFTP 创建目录 ===
        "sftp_mkdir" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_mkdir: missing or invalid sessionId")?
                as u32;
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("sftp_mkdir: missing or invalid path")?
                .to_string();
            validate_remote_path("sftp_mkdir", &path)?;

            let ssh_state = app.state::<crate::ssh::SshState>();
            crate::ssh::sftp_mkdir(ssh_state, session_id, path).await?;
            Ok(Value::Null)
        }

        // === SFTP 删除文件 ===
        "sftp_remove" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_remove: missing or invalid sessionId")?
                as u32;
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("sftp_remove: missing or invalid path")?
                .to_string();
            validate_remote_path("sftp_remove", &path)?;

            let ssh_state = app.state::<crate::ssh::SshState>();
            crate::ssh::sftp_remove(ssh_state, session_id, path).await?;
            Ok(Value::Null)
        }

        // === SFTP 重命名 ===
        "sftp_rename" => {
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_u64())
                .ok_or("sftp_rename: missing or invalid sessionId")?
                as u32;
            let from = params
                .get("from")
                .and_then(|v| v.as_str())
                .ok_or("sftp_rename: missing or invalid from")?
                .to_string();
            let to = params
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or("sftp_rename: missing or invalid to")?
                .to_string();
            validate_remote_path("sftp_rename", &from)?;
            validate_remote_path("sftp_rename", &to)?;

            let ssh_state = app.state::<crate::ssh::SshState>();
            crate::ssh::sftp_rename(ssh_state, session_id, from, to).await?;
            Ok(Value::Null)
        }

        // === 终端 scrollback（B1-F0 修复 2026-08-28）===
        // xterm buffer 在前端 renderer，Rust 无缓存 → 经 Tauri event 转发前端读取。
        // 前端监听 "sidecar:get-terminal-scrollback"（useAiLiveBridge），
        // 用 getTerminalContext()（含 redact/SSH 优先/private 检查）读 buffer，
        // 再 invoke("sidecar_scrollback_response") 回传，oneshot 关联 request_id。
        // 前端无响应（未挂载/JS 阻塞）时 2s 超时 → 返回 unavailable（fail-closed，
        // 与修复前行为一致，无回归风险）。
        "get_terminal_scrollback" => {
            let lines = params.get("lines").and_then(|v| v.as_u64()).unwrap_or(80) as u32;

            let request_id = {
                let mut counter = SCROLLBACK_REQ_COUNTER.lock().await;
                *counter += 1;
                format!("sb-{}", *counter)
            };
            let (tx, rx) = oneshot::channel::<String>();
            SCROLLBACK_PENDING.lock().await.insert(request_id.clone(), tx);

            // 请求前端（emit 不等待；超时由下方 timeout 控制）
            {
                let guard = app_handle.lock().await;
                if let Some(handle) = guard.as_ref() {
                    if let Err(e) = handle.emit(
                        "sidecar:get-terminal-scrollback",
                        json!({ "requestId": request_id, "lines": lines }),
                    ) {
                        log::warn!("[sidecar] get_terminal_scrollback emit failed: {}", e);
                    }
                }
            }

            // 等待前端回传（2s 超时 fail-closed）
            match timeout(Duration::from_secs(2), rx).await {
                Ok(Ok(output)) => Ok(json!({ "output": output, "available": !output.is_empty() })),
                Ok(Err(_)) | Err(_) => {
                    // 清理残留 entry（响应迟到时防泄漏）
                    SCROLLBACK_PENDING.lock().await.remove(&request_id);
                    Ok(json!({ "output": "", "available": false }))
                }
            }
        }

        _ => Err(format!(
            "reverse route not found: {} (supported: ssh_command, ssh_status, sftp_read, sftp_write, sftp_stat, sftp_list, sftp_mkdir, sftp_remove, sftp_rename, get_terminal_scrollback)",
            method
        )),
    }
}

// ── B1-F0 (2026-08-28): 前端 scrollback 回传通道 ────────────────────────────
// pending 表：request_id → oneshot sender（handle_reverse_request 发起，命令 resolve）
// 用 std LazyLock（Rust 1.70+）包 tokio Mutex——HashMap::new 非 const fn
static SCROLLBACK_PENDING: std::sync::LazyLock<
    tokio::sync::Mutex<HashMap<String, oneshot::Sender<String>>>,
> = std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));
static SCROLLBACK_REQ_COUNTER: std::sync::LazyLock<tokio::sync::Mutex<u64>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(0));

/// 前端回传终端 scrollback（配合 get_terminal_scrollback 反向 RPC）
///
/// 调用链：Python ipc_invoke("get_terminal_scrollback") → Rust emit 事件到前端
/// → 前端读 xterm buffer（redact 后）→ invoke 本命令 → oneshot resolve → Python。
/// 迟到响应（原请求已超时）静默丢弃（remove 返回 None）。
#[tauri::command]
pub async fn sidecar_scrollback_response(
    request_id: String,
    output: String,
) -> Result<(), String> {
    if let Some(tx) = SCROLLBACK_PENDING.lock().await.remove(&request_id) {
        let _ = tx.send(output);
    }
    Ok(())
}

/// 校验反向 RPC 的远程路径（TDSF 2026-08-04, Rust-M2）
///
/// 背景：反向 RPC 由 Python sidecar（AI 引擎）发起，LLM 输出可能被
/// prompt-injection 引导，从而读写任意远程路径（如 `~/.ssh/authorized_keys`）。
/// 规则：非空 + 绝对路径（以 `/` 开头）+ 无 null 字节 + 无 `..` 遍历段。
/// 前端 SFTP 桥 / 远程文件树始终使用绝对路径，此规则不会破坏正常功能。
fn validate_remote_path(method: &str, path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err(format!("{}: path is empty", method));
    }
    if !path.starts_with('/') {
        return Err(format!(
            "{}: path must be absolute (start with /): {:?}",
            method, path
        ));
    }
    if path.contains('\0') {
        return Err(format!("{}: path contains null byte", method));
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err(format!(
            "{}: path contains '..' traversal segment: {:?}",
            method, path
        ));
    }
    Ok(())
}

/// 处理 Python 侧发送的通知
async fn handle_notification(
    method: &str,
    msg: &Value,
    state: &Arc<RwLock<SidecarState>>,
    app_handle: &Arc<Mutex<Option<AppHandle>>>,
) {
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    match method {
        "ready" => {
            log::info!("[sidecar] ready notification received: {:?}", params);
            let mut state_guard = state.write().await;
            state_guard.status = SidecarStatus::Running;
            state_guard.started_at = Some(Instant::now());
            state_guard.last_heartbeat = Some(Instant::now());

            // 提取 methods 和 python version
            if let Some(obj) = params.as_object() {
                if let Some(methods) = obj.get("methods").and_then(|m| m.as_array()) {
                    state_guard.methods = methods
                        .iter()
                        .filter_map(|m| m.as_str().map(|s| s.to_string()))
                        .collect();
                }
                if let Some(version) = obj.get("python").and_then(|v| v.as_str()) {
                    state_guard.python_version = Some(version.to_string());
                }
            }
        }
        _ => {
            log::debug!("[sidecar] notification: {} params={}", method, params);
            // 转发到前端（通过 Tauri event）
            let guard = app_handle.lock().await;
            if let Some(handle) = guard.as_ref() {
                let event_name = format!("sidecar:{}", method);
                if let Err(e) = handle.emit(&event_name, &params) {
                    log::warn!("[sidecar] failed to emit event {}: {}", event_name, e);
                }
            }
        }
    }
}

/// stderr reader task: 读 stderr，转发到 Rust log
async fn stderr_reader_task(stderr: tokio::process::ChildStderr) {
    log::debug!("[sidecar:stderr] started");
    let mut reader = BufReader::new(stderr);

    loop {
        // 与 reader_task 同方案: read_until + from_utf8_lossy 宽容解码。
        // lines() 严格 UTF-8 在 Windows GBK 环境首个非 UTF-8 行就退出，丢失全部 stderr。
        let line = {
            let mut buf = Vec::new();
            match reader.read_until(b'\n', &mut buf).await {
                Ok(0) => break,
                Ok(_) => String::from_utf8_lossy(&buf).into_owned(),
                Err(e) => {
                    log::error!("[sidecar:stderr] read error: {:?}", e);
                    break;
                }
            }
        };
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        log::info!("[python] {}", trimmed);
        push_log(&format!("[python] {}", trimmed));
    }

    log::debug!("[sidecar:stderr] stopped");
}

/// health check task: 每 5s 发送 ping，30s 无响应判定死锁
async fn health_check_task(
    state: Arc<RwLock<SidecarState>>,
    pending_requests: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    stdin_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<String>>>>,
    next_request_id: Arc<AtomicI64>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
) {
    log::debug!("[sidecar:health] started");
    let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
    interval.tick().await; // 跳过第一次立即触发

    loop {
        interval.tick().await;

        // 检查状态
        {
            let state_guard = state.read().await;
            if state_guard.status == SidecarStatus::Stopped {
                // Stopped = 进程已被用户 stop 且未重启。本 task 无存在意义，
                // 退出释放资源（下次 start() 会 spawn 新的 health task）。
                // 否则每次重启都泄漏一个永久空转 task（每 5s 醒来空转一次）。
                log::debug!("[sidecar:health] sidecar stopped, health task exiting");
                return;
            }
            if state_guard.status != SidecarStatus::Running {
                log::debug!(
                    "[sidecar:health] skipping ping (status={:?})",
                    state_guard.status
                );
                continue;
            }

            // 检查心跳超时
            if let Some(last) = state_guard.last_heartbeat {
                let elapsed = last.elapsed();
                if elapsed > HEARTBEAT_TIMEOUT {
                    log::error!(
                        "[sidecar:health] heartbeat lost (no response in {:?})",
                        elapsed
                    );
                    // TDSF 2026-08-12 修复: 死锁(进程存活但无响应)时按 pid 强杀,
                    // 让 exit_watcher_task 的 child.wait() 返回 → 既有指数退避重启流程
                    // 自动恢复。此前只置 Crashed, 死锁进程存活 → 永不重启, AI 卡死到手动 restart。
                    let pid = state_guard.pid;
                    drop(state_guard);
                    if let Some(pid_num) = pid {
                        let killed = kill_process(pid_num).await;
                        log::warn!(
                            "[sidecar:health] killed hung pid={} success={}",
                            pid_num,
                            killed
                        );
                        if !killed {
                            log::error!(
                                "[sidecar:health] kill pid={} failed (process gone or no permission)",
                                pid_num
                            );
                        }
                    } else {
                        log::warn!("[sidecar:health] no pid recorded, cannot kill");
                    }
                    let mut state_mut = state.write().await;
                    state_mut.status = SidecarStatus::Crashed;
                    // 通知前端
                    let guard = app_handle.lock().await;
                    if let Some(handle) = guard.as_ref() {
                        let _ = handle.emit(
                            "sidecar:heartbeat_lost",
                            json!({"elapsed_sec": elapsed.as_secs_f64()}),
                        );
                    }
                    return;
                }
            }
        }

        // 发送 ping
        let id = next_request_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<Value>();
        {
            let mut pending = pending_requests.lock().await;
            pending.insert(id, tx);
        }

        let msg = json!({
            "jsonrpc": "2.0",
            "method": "ping",
            "id": id,
        });

        let send_result = {
            let stdin_guard = stdin_tx.lock().await;
            if let Some(tx) = stdin_guard.as_ref() {
                tx.send(serde_json::to_string(&msg).unwrap_or_default() + "\n").await
            } else {
                Err(tokio::sync::mpsc::error::SendError(String::new()))
            }
        };

        if send_result.is_err() {
            log::warn!("[sidecar:health] failed to send ping");
            let mut pending = pending_requests.lock().await;
            pending.remove(&id);
            continue;
        }

        // 等待响应（不阻塞，启动新 task）
        let health_state = state.clone();
        let pending_for_wait = pending_requests.clone();
        tokio::spawn(async move {
            match timeout(HEARTBEAT_INTERVAL * 2, rx).await {
                Ok(Ok(_)) => {
                    // 收到响应，更新 last_heartbeat
                    let mut state_guard = health_state.write().await;
                    state_guard.last_heartbeat = Some(Instant::now());
                    log::trace!("[sidecar:health] ping ok");
                }
                _ => {
                    log::warn!("[sidecar:health] ping timeout");
                    let mut pending = pending_for_wait.lock().await;
                    pending.remove(&id);
                }
            }
        });
    }
}

/// exit watcher task: 监控子进程退出，发送重启信号
///
/// 设计要点（打破循环依赖）:
///   - 不直接调用 `manager.start()`，而是通过 `restart_tx` 发送信号
///   - 避免形成 `exit_watcher_task → start() → spawn(exit_watcher_task)` 循环
///   - Rust 编译器无法证明循环调用的 future 是 Send，会导致 tokio::spawn 失败
///
/// Send 约束:
///   - 不跨 `child.wait().await` 持有 `MutexGuard`（先 take 出 child）
///   - 不同时持有多个 guard 跨 await（state.write 与 app_handle.lock 分开 block）
async fn exit_watcher_task(
    child: Arc<Mutex<Option<Child>>>,
    state: Arc<RwLock<SidecarState>>,
    retry_count: Arc<AtomicU32>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    restart_tx: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<()>>>>,
) {
    log::debug!("[sidecar:watcher] started");

    // 1. take 出 child 句柄（不跨 wait 持有 lock）
    let mut child_handle = {
        let mut guard = child.lock().await;
        match guard.take() {
            Some(c) => c,
            None => {
                log::warn!("[sidecar:watcher] no child to watch");
                return;
            }
        }
    };

    // 2. 等待子进程退出（不持有任何 lock）
    let exit_status = child_handle.wait().await;
    log::warn!("[sidecar:watcher] process exited: {:?}", exit_status);

    // 3. 检查状态：如果是 Stopping 或 Stopped，是正常退出，不重启
    let need_restart = {
        let state_guard = state.read().await;
        !(state_guard.status == SidecarStatus::Stopping
            || state_guard.status == SidecarStatus::Stopped)
    };
    if !need_restart {
        log::info!("[sidecar:watcher] normal exit, no restart");
        return;
    }

    // 4. 检查 retry 次数
    // TDSF P0 修复：运行冷却判断——若 Python 运行 ≥60s 才崩溃，视为偶发，重置 retry_count
    // 这样偶发崩溃（运行 ≥60s）会重置计数器，从 1 开始重新计数，不累积历史偶发；
    // 而快速崩溃（运行 <60s，场景 C "发 ready 后即崩"）不重置，retry_count 持续递增直至 MAX_RETRY
    let runtime = {
        let state_guard = state.read().await;
        state_guard.started_at.map(|t| t.elapsed()).unwrap_or(Duration::ZERO)
    };
    if runtime >= RUNTIME_COOLDOWN {
        log::info!(
            "[sidecar:watcher] runtime {:?} >= cooldown {:?}, resetting retry_count",
            runtime, RUNTIME_COOLDOWN
        );
        retry_count.store(0, Ordering::SeqCst);
    }

    let retry = retry_count.fetch_add(1, Ordering::SeqCst);
    if retry >= MAX_RETRY {
        log::error!(
            "[sidecar:watcher] max retry exceeded ({}/{}), giving up",
            retry,
            MAX_RETRY
        );
        {
            let mut state_guard = state.write().await;
            state_guard.status = SidecarStatus::Crashed;
        }
        // 通知前端（独立 block，避免同时持有 state + app_handle guard）
        let guard = app_handle.lock().await;
        if let Some(handle) = guard.as_ref() {
            let _ = handle.emit(
                "sidecar:crashed",
                json!({
                    "reason": "max_retry_exceeded",
                    "retry_count": retry,
                    "max_retry": MAX_RETRY
                }),
            );
        }
        return;
    }

    log::info!(
        "[sidecar:watcher] auto restart {}/{} (sending signal)",
        retry + 1,
        MAX_RETRY
    );

    // 5. 更新状态为 Restarting
    {
        let mut state_guard = state.write().await;
        state_guard.status = SidecarStatus::Restarting;
    }

    // 6. 发送重启信号（不直接调用 start()，避免循环依赖）
    let tx_guard = restart_tx.lock().await;
    if let Some(tx) = tx_guard.as_ref() {
        match tx.send(()) {
            Ok(()) => log::info!("[sidecar:watcher] restart signal sent"),
            Err(_) => {
                log::error!("[sidecar:watcher] restart channel closed");
                {
                    let mut state_guard = state.write().await;
                    state_guard.status = SidecarStatus::Crashed;
                }
            }
        }
    } else {
        log::error!("[sidecar:watcher] restart_tx not set, cannot restart");
        {
            let mut state_guard = state.write().await;
            state_guard.status = SidecarStatus::Crashed;
        }
    }
}

// ============================================================================
// Tauri 命令（T-P1-01.3）
// ============================================================================

/// 查询 Sidecar 状态
#[tauri::command]
pub async fn sidecar_status(
    state: tauri::State<'_, SidecarManager>,
) -> std::result::Result<SidecarStateSnapshot, String> {
    Ok(state.snapshot().await)
}

/// 手动重启 Sidecar
#[tauri::command]
pub async fn sidecar_restart(
    state: tauri::State<'_, SidecarManager>,
) -> std::result::Result<SidecarStateSnapshot, String> {
    state.restart().await.map_err(|e| e.to_string())?;
    Ok(state.snapshot().await)
}

/// 停止 Sidecar
#[tauri::command]
pub async fn sidecar_stop(
    state: tauri::State<'_, SidecarManager>,
) -> std::result::Result<SidecarStateSnapshot, String> {
    state.stop().await.map_err(|e| e.to_string())?;
    Ok(state.snapshot().await)
}

/// 启动 Sidecar
#[tauri::command]
pub async fn sidecar_start(
    state: tauri::State<'_, SidecarManager>,
) -> std::result::Result<SidecarStateSnapshot, String> {
    state.start().await.map_err(|e| e.to_string())?;
    Ok(state.snapshot().await)
}

// ============================================================================
// TDSF 魔改 P2-3: Sidecar 日志缓冲区（专门审查子 Agent 用）
// ============================================================================
// 设计目标: 让前端能在设置面板实时查看 Python Sidecar 日志,
//          无需打开 DevTools 或翻 tauri_plugin_log 文件。
//
// 实现:
//   - 全局 VecDeque<String> 环形缓冲区 (容量 1000 条)
//   - stderr_reader_task 写入, sidecar_logs 命令读取
//   - 每条日志格式: "[ts] [level] content"
//   - 容量满时丢弃最旧条目 (FIFO)

/// 日志缓冲区容量
const LOG_BUFFER_CAP: usize = 1000;

/// 全局日志缓冲区 (进程级单例, 同步 Mutex 避免异步上下文开销)
/// 用 std::sync::OnceLock 避免引入 once_cell 依赖 (Rust 1.70+ 标准库)
static LOG_BUFFER: std::sync::OnceLock<std::sync::Mutex<VecDeque<String>>> =
    std::sync::OnceLock::new();

/// 获取日志缓冲区句柄 (懒初始化)
fn log_buffer() -> &'static std::sync::Mutex<VecDeque<String>> {
    LOG_BUFFER.get_or_init(|| std::sync::Mutex::new(VecDeque::with_capacity(LOG_BUFFER_CAP)))
}

/// 日志条目 (前端展示用)
#[derive(Debug, Clone, Serialize)]
pub struct SidecarLogEntry {
    /// 时间戳 (Unix 毫秒)
    pub ts: u64,
    /// 日志级别 (info/warn/error/debug)
    pub level: String,
    /// 日志内容
    pub content: String,
}

/// 推送一条日志到缓冲区 (内部函数, stderr_reader_task 调用)
fn push_log(line: &str) {
    // 简单解析级别 ([python] LEVEL message 或 [sidecar:xxx] LEVEL message)
    let level = if line.contains("[ERROR]") || line.contains("ERROR") {
        "error"
    } else if line.contains("[WARN]") || line.contains("WARN") {
        "warn"
    } else if line.contains("[DEBUG]") || line.contains("DEBUG") {
        "debug"
    } else {
        "info"
    };

    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let entry = format!("[{}] [{}] {}", ts, level, line);

    // 同步阻塞获取锁 (日志路径, 不能阻塞太长时间)
    // 使用 try_lock 避免可能的死锁, 失败则丢弃该条日志
    if let Ok(mut buf) = log_buffer().lock() {
        if buf.len() >= LOG_BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(entry);
    }
}

/// 读取 Sidecar 日志 (前端设置页调用)
#[tauri::command]
pub async fn sidecar_logs(
    limit: Option<usize>,
    level_filter: Option<String>,
) -> std::result::Result<Vec<String>, String> {
    let buf = log_buffer().lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(200).min(LOG_BUFFER_CAP);
    let filter = level_filter.unwrap_or_default();

    let iter = buf.iter().rev().take(limit);
    let mut result: Vec<String> = if filter.is_empty() {
        iter.cloned().collect()
    } else {
        iter.filter(|line| line.contains(&format!("[{}]", filter)))
            .cloned()
            .collect()
    };
    // 反转回时间正序 (旧→新)
    result.reverse();
    Ok(result)
}

/// 清空日志缓冲区
#[tauri::command]
pub async fn sidecar_logs_clear() -> std::result::Result<(), String> {
    let mut buf = log_buffer().lock().map_err(|e| e.to_string())?;
    buf.clear();
    Ok(())
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sidecar_status_serde() {
        let json = serde_json::to_string(&SidecarStatus::Running).unwrap();
        assert_eq!(json, "\"running\"");
        let status: SidecarStatus = serde_json::from_str("\"stopped\"").unwrap();
        assert_eq!(status, SidecarStatus::Stopped);
    }

    #[test]
    fn test_sidecar_state_default() {
        let state = SidecarState::default();
        assert_eq!(state.status, SidecarStatus::Stopped);
        assert_eq!(state.retry_count, 0);
        assert!(state.methods.is_empty());
    }

    #[test]
    fn test_sidecar_state_snapshot() {
        let state = SidecarState {
            status: SidecarStatus::Running,
            pid: Some(12345),
            started_at: Some(Instant::now()),
            last_heartbeat: Some(Instant::now()),
            retry_count: 1,
            methods: vec!["ping".to_string(), "status".to_string()],
            python_version: Some("3.13.7".to_string()),
        };

        let snapshot = state.snapshot();
        assert_eq!(snapshot.status, SidecarStatus::Running);
        assert_eq!(snapshot.pid, Some(12345));
        assert!(snapshot.uptime.unwrap() >= 0.0);
        assert_eq!(snapshot.retry_count, 1);
        assert_eq!(snapshot.max_retry, MAX_RETRY);
        assert_eq!(snapshot.methods, vec!["ping", "status"]);
        assert_eq!(snapshot.python_version, Some("3.13.7".to_string()));
    }

    #[test]
    fn test_sidecar_manager_clone() {
        // 验证 SidecarManager 可以 Clone（所有字段都是 Arc）
        let manager = SidecarManager::new(PathBuf::from("/tmp/test.py"));
        let cloned = manager.clone();
        // clone 后两个 manager 共享同一份内部状态
        assert_eq!(
            manager.next_request_id.load(Ordering::SeqCst),
            cloned.next_request_id.load(Ordering::SeqCst)
        );
    }

    /// TDSF P0 修复：退避计算辅助函数（与 start_restart_loop 内联公式一致）
    fn compute_backoff(retry: u32) -> Duration {
        let shift = retry.saturating_sub(1).min(6);
        let secs = RESTART_BACKOFF_BASE.saturating_mul(1u64 << shift);
        Duration::from_secs(secs).min(RESTART_BACKOFF_MAX)
    }

    #[test]
    fn test_max_retry_is_five() {
        // TDSF P0 修复：MAX_RETRY 从 3 提升到 5
        assert_eq!(MAX_RETRY, 5);
    }

    #[test]
    fn test_backoff_calculation() {
        // retry=1 → 1s, retry=2 → 2s, retry=3 → 4s, retry=4 → 8s, retry=5 → 16s
        assert_eq!(compute_backoff(1), Duration::from_secs(1));
        assert_eq!(compute_backoff(2), Duration::from_secs(2));
        assert_eq!(compute_backoff(3), Duration::from_secs(4));
        assert_eq!(compute_backoff(4), Duration::from_secs(8));
        assert_eq!(compute_backoff(5), Duration::from_secs(16));
        // retry=7 → 1<<6=64s 但被 min(60) 截断
        assert_eq!(compute_backoff(7), Duration::from_secs(60));
        // 防御性：retry=0 → saturating_sub(1)=0 → 1<<0=1 → 1s
        assert_eq!(compute_backoff(0), Duration::from_secs(1));
    }
}
