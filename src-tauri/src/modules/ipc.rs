// modules/ipc.rs — TDSF stdio JSON-RPC 协议层（T-P1-02.2）
// ============================================================================
// 职责（与 sidecar.rs 的分层）:
//   - sidecar.rs: 进程管理 + stdio pipe + 基础 IO（send_request / send_notification）
//   - ipc.rs:     JSON-RPC 协议层（类型化错误 + 高层 invoke + Tauri 命令 + 通知路由）
//
// 提供接口:
//   - IPCClient: 包装 SidecarManager，提供高层 invoke / notify 方法
//   - IPCError:  类型化错误（NotRunning / Timeout / ProtocolError / RemoteError）
//   - Tauri 命令: ipc_invoke / ipc_notify / ipc_status（前端通过 invoke 调用 Python Sidecar）
//   - 通知路由: sidecar:* event 转发到前端（已在 sidecar.rs reader_task 实现）
//
// 通信协议（与 Python 侧 main.py 对齐）:
//   - 请求:  {"jsonrpc": "2.0", "method": "...", "params": {...}, "id": N}
//   - 响应:  {"jsonrpc": "2.0", "result": {...}, "id": N}
//   - 错误:  {"jsonrpc": "2.0", "error": {"code": -32000, "message": "..."}, "id": N}
//   - 通知:  {"jsonrpc": "2.0", "method": "...", "params": {...}}（无 id，无响应）
//
// 错误码（JSON-RPC 2.0 标准 + TDSF 扩展）:
//   -32700 Parse error         解析错误
//   -32600 Invalid Request     无效请求
//   -32601 Method not found    方法未找到
//   -32602 Invalid params      无效参数
//   -32603 Internal error      内部错误
//   -32000 Server generic      TDSF 通用服务器错误
//   -32001 Timeout             TDSF 超时（请求 30s）
//   -32002 Write lease         TDSF 写租约冲突（Project Service 并发写）
// ============================================================================

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use super::sidecar::{SidecarError, SidecarManager, SidecarStateSnapshot};

// ============================================================================
// 常量
// ============================================================================

/// 默认请求超时（300s，与 sidecar.rs REQUEST_TIMEOUT 对齐）
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

// ============================================================================
// IPC 错误类型（类型化，前端可精确处理）
// ============================================================================

/// IPC 调用错误
///
/// 设计：从 SidecarError 转换而来，提供更细粒度的错误类型
/// 前端通过 `ipc_invoke` 的 Result<T, String> 接收，可解析 error code
#[derive(Debug, thiserror::Error)]
pub enum IPCError {
    /// Sidecar 未运行（spawn 失败或已停止）
    #[error("sidecar not running")]
    NotRunning,

    /// 请求超时（30s 无响应）
    #[error("request timeout after {0:?}")]
    Timeout(Duration),

    /// stdin 已关闭（Sidecar 进程退出中）
    #[error("sidecar stdin closed")]
    StdinClosed,

    /// 进程错误（spawn 失败等）
    #[error("sidecar process error: {0}")]
    ProcessError(String),

    /// JSON 序列化/反序列化错误
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    /// IO 错误
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// 方法不在白名单（#67 纵深防御：webview 被注入后也不能自行调任意 RPC）
    #[error("method not allowed: {0}")]
    MethodNotAllowed(String),

    /// Python 侧返回的 JSON-RPC 错误（包含 error code + message + data）
    #[error("remote error {code}: {message}")]
    RemoteError {
        code: i64,
        message: String,
        data: Option<Value>,
    },
}

impl From<SidecarError> for IPCError {
    fn from(e: SidecarError) -> Self {
        match e {
            SidecarError::NotRunning => IPCError::NotRunning,
            SidecarError::StdinClosed => IPCError::StdinClosed,
            SidecarError::RequestTimeout(d) => IPCError::Timeout(d),
            SidecarError::SpawnFailed(msg) => IPCError::ProcessError(msg),
            SidecarError::Io(e) => IPCError::Io(e),
            SidecarError::Json(e) => IPCError::Json(e),
            // 其他错误归为 ProcessError
            other => IPCError::ProcessError(other.to_string()),
        }
    }
}

/// 序列化为前端可解析的字符串（保持 error code 信息）
///
/// 前端通过 `invoke<string>('ipc_invoke', ...)` 接收，解析 JSON 拿到 code/message/data
impl Serialize for IPCError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let (code, message, data) = match self {
            IPCError::NotRunning => (
                -32000,
                "sidecar not running".to_string(),
                Some(json!({"type": "not_running"})),
            ),
            IPCError::Timeout(d) => (
                -32001,
                format!("request timeout after {:?}", d),
                Some(json!({"type": "timeout", "secs": d.as_secs()})),
            ),
            IPCError::StdinClosed => (
                -32000,
                "sidecar stdin closed".to_string(),
                Some(json!({"type": "stdin_closed"})),
            ),
            IPCError::ProcessError(msg) => (
                -32000,
                msg.clone(),
                Some(json!({"type": "process_error"})),
            ),
            IPCError::Json(e) => (
                -32700,
                format!("json parse error: {}", e),
                Some(json!({"type": "json_error"})),
            ),
            IPCError::Io(e) => (
                -32000,
                format!("io error: {}", e),
                Some(json!({"type": "io_error"})),
            ),
            // -32601 = JSON-RPC 标准的 "Method not found"：白名单命中时对外
            // 表现得与"该方法不存在"一致，不给探测者区分"不存在"和"被拒"的信息
            IPCError::MethodNotAllowed(m) => (
                -32601,
                format!("method not allowed: {m}"),
                Some(json!({"type": "method_not_allowed", "method": m})),
            ),
            IPCError::RemoteError {
                code,
                message,
                data,
            } => (*code, message.clone(), data.clone()),
        };

        // 序列化为 JSON 字符串（前端 JSON.parse 即可拿到结构化错误）
        let err_obj = json!({
            "code": code,
            "message": message,
            "data": data,
        });
        serializer.serialize_str(&err_obj.to_string())
    }
}

// ============================================================================
// IPCClient — 高层封装（包装 SidecarManager）
// ============================================================================

/// IPC 客户端：包装 SidecarManager，提供高层 invoke / notify 接口
///
/// 设计：
///   - 不持有独立状态，所有调用委托给 SidecarManager
///   - 提供 invoke_with_timeout（可自定义超时）和 invoke（默认 30s）
///   - 自动解析 JSON-RPC error 响应，转换为 IPCError::RemoteError
///
/// 用法：
///   ```ignore
///   let client = IPCClient::new(sidecar_manager);
///   let result = client.invoke("agent.invoke", json!({"input": "..."})).await?;
///   ```
#[derive(Clone)]
pub struct IPCClient {
    manager: SidecarManager,
}

impl IPCClient {
    /// 创建 IPCClient（接收 SidecarManager 的 Clone，内部都是 Arc，廉价）
    pub fn new(manager: SidecarManager) -> Self {
        Self { manager }
    }

    /// 发送 JSON-RPC 请求（默认 60s 超时）
    ///
    /// 流程:
    ///   1. 调用 SidecarManager::send_request
    ///   2. 解析响应: 检查是否包含 error 字段
    ///   3. 有 error → 返回 IPCError::RemoteError
    ///   4. 有 result → 返回 Ok(result)
    ///
    /// 错误:
    ///   - NotRunning: Sidecar 未运行
    ///   - Timeout: 60s 无响应
    ///   - RemoteError: Python 侧返回 JSON-RPC error
    pub async fn invoke(&self, method: &str, params: Value) -> Result<Value, IPCError> {
        self.invoke_with_timeout(method, params, DEFAULT_REQUEST_TIMEOUT)
            .await
    }

    /// 发送 JSON-RPC 请求（自定义超时）
    ///
    /// TDSF 修复 2026-08-01 (P0-3): 让自定义超时真正生效——
    /// 原来 SidecarManager::send_request 内部固定 30s，invoke_with_timeout
    /// 的 timeout 参数被忽略；现转发到 send_request_with_timeout。
    pub async fn invoke_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, IPCError> {
        let response = self
            .manager
            .send_request_with_timeout(method, params, timeout)
            .await?;

        // 解析响应
        if let Some(err) = response.get("error") {
            let code = err
                .get("code")
                .and_then(|c| c.as_i64())
                .unwrap_or(-32000);
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error")
                .to_string();
            let data = err.get("data").cloned();
            return Err(IPCError::RemoteError {
                code,
                message,
                data,
            });
        }

        // 返回 result 字段（若无 result 字段，返回整个响应）
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// 发送 JSON-RPC 通知（无 id，无响应）
    ///
    /// 用法: 通知 Python 侧执行某个动作（如取消任务、更新配置）
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), IPCError> {
        self.manager
            .send_notification(method, params)
            .await
            .map_err(IPCError::from)
    }

    /// 获取 Sidecar 状态快照
    pub async fn status(&self) -> SidecarStateSnapshot {
        self.manager.snapshot().await
    }

    /// 检查 Sidecar 是否运行中（status == Running）
    pub async fn is_running(&self) -> bool {
        self.manager.snapshot().await.status == super::sidecar::SidecarStatus::Running
    }
}

// ============================================================================
// Tauri 命令（前端通过 invoke 调用 Python Sidecar）
// ============================================================================

/// #67 未就绪期兜底核心集：只放健康检查。
///
/// 白名单的**唯一真源是 sidecar `ready` 快照里的 `methods`**（`jsonrpc.py`
/// 的注册表 → Rust `SidecarState.methods`）。快照为空说明还没 ready，
/// 此时任何业务请求本来都会 `NotRunning` —— 所以核心集小不是功能妥协，
/// 而是把"未就绪期能调什么"钉到最小面：新增 RPC 一律不需要改这里。
pub(crate) const CORE_IPC_METHODS: &[&str] = &["sidecar.health"];

/// 快照非空 → 快照说了算；快照为空 → fail-closed 到核心集。
///
/// 为什么不做成"两份名单取并集"：并集意味着 sidecar 删了某个方法后 Rust 还在放行，
/// 而放行面只会随时间单调变大 —— 那正是这次要收掉的东西。
fn method_allowed(known: &[String], core: &[&str], method: &str) -> bool {
    match known.first() {
        None => core.contains(&method),
        Some(_) => known.iter().any(|m| m == method),
    }
}

/// ipc_invoke: 前端调用 Python Sidecar 的 JSON-RPC 方法
///
/// 用法（前端 TypeScript）:
///   ```typescript
///   const result = await invoke<string>('ipc_invoke', {
///     method: 'agent.invoke',
///     params: { input: 'nginx 启动失败' },
///     timeoutMs: 120_000, // 可选：覆盖默认 60s 超时（P0-3）
///   });
///   const data = JSON.parse(result); // { thinking: '...', output: '...' }
///   ```
///
/// 错误处理:
///   - 返回 Err(String)，内容是 JSON 序列化的 { code, message, data }
///   - 前端 JSON.parse 后可拿到 error code（-32000/-32001/-32700/-32601 等）
///   - `-32601` = 方法不在白名单（#67）
#[tauri::command]
pub async fn ipc_invoke(
    sidecar: tauri::State<'_, SidecarManager>,
    method: String,
    params: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, IPCError> {
    let client = IPCClient::new(sidecar.inner().clone());

    // #67 纵深防御：webview 一旦被注入（R1 修前门槛极低），也不能自行调任意 RPC
    // —— 例如 `needs_you.approve` 自批、改白名单、`skill.invoke` 落盘、关停应用。
    let snap = client.status().await;
    if !method_allowed(&snap.methods, CORE_IPC_METHODS, &method) {
        log::warn!("[ipc] rejected not-allowlisted method={}", method);
        return Err(IPCError::MethodNotAllowed(method));
    }

    let params = params.unwrap_or(json!({}));
    match timeout_ms {
        // P0-3: 前端显式传 timeoutMs 时覆盖默认（夹取 10s-10min，防误配）
        Some(ms) => {
            let secs = ms.clamp(10_000, 600_000) / 1000;
            client
                .invoke_with_timeout(&method, params, Duration::from_secs(secs))
                .await
        }
        None => client.invoke(&method, params).await,
    }
}

/// ipc_notify: 前端向 Python Sidecar 发送通知（无响应）
///
/// 用法:
///   ```typescript
///   await invoke('ipc_notify', {
///     method: 'task.cancel',
///     params: { task_id: 'xxx' }
///   });
///   ```
#[tauri::command]
pub async fn ipc_notify(
    sidecar: tauri::State<'_, SidecarManager>,
    method: String,
    params: Option<Value>,
) -> Result<(), IPCError> {
    let client = IPCClient::new(sidecar.inner().clone());
    let params = params.unwrap_or(json!({}));
    client.notify(&method, params).await
}

/// ipc_status: 查询 Sidecar 状态（与 sidecar_status 相同，提供别名便于前端记忆）
///
/// 返回 SidecarStateSnapshot（status / pid / uptime / retry_count / methods 等）
#[tauri::command]
pub async fn ipc_status(
    sidecar: tauri::State<'_, SidecarManager>,
) -> Result<SidecarStateSnapshot, String> {
    Ok(sidecar.snapshot().await)
}

// ============================================================================
// 通知广播（已由 sidecar.rs reader_task 实现）
// ============================================================================
//
// Python 侧发送的通知会经过 sidecar.rs reader_task 的 handle_notification 函数:
//   1. "ready" 通知: 内部消费，更新 state 为 Running
//   2. 其他通知: 通过 Tauri event emit 到前端，事件名格式 `sidecar:<method>`
//
// 前端订阅示例:
//   ```typescript
//   import { listen } from '@tauri-apps/api/event';
//   const unlisten = await listen('sidecar:agent_message', (e) => {
//     console.log('agent message:', e.payload);
//   });
//   ```
//
// 常见通知事件名（由 Python 侧决定，T-P1-04 事件总线会扩展）:
//   - sidecar:ready              Sidecar 启动完成
//   - sidecar:agent_message      Agent 输出消息
//   - sidecar:tool_call          工具调用事件
//   - sidecar:needs_you          needs-you 协调请求
//   - sidecar:mood_change        Agent 心情变化
//   - sidecar:heartbeat_lost     心跳丢失（Sidecar 死锁）
//   - sidecar:crashed            Sidecar 崩溃

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_ipc_error_from_sidecar_not_running() {
        let err = IPCError::from(SidecarError::NotRunning);
        assert!(matches!(err, IPCError::NotRunning));
    }

    #[test]
    fn test_ipc_error_from_sidecar_timeout() {
        let err = IPCError::from(SidecarError::RequestTimeout(Duration::from_secs(30)));
        assert!(matches!(err, IPCError::Timeout(_)));
    }

    #[test]
    fn test_ipc_error_from_sidecar_stdin_closed() {
        let err = IPCError::from(SidecarError::StdinClosed);
        assert!(matches!(err, IPCError::StdinClosed));
    }

    #[test]
    fn test_ipc_error_from_sidecar_spawn_failed() {
        let err = IPCError::from(SidecarError::SpawnFailed("test".to_string()));
        assert!(matches!(err, IPCError::ProcessError(_)));
    }

    #[test]
    fn test_ipc_error_serialize_not_running() {
        let err = IPCError::NotRunning;
        let json_str = serde_json::to_string(&err).unwrap();
        // 序列化为 JSON 字符串（包含 code/message/data）
        assert!(json_str.contains("-32000"));
        assert!(json_str.contains("not_running"));
    }

    #[test]
    fn test_ipc_error_serialize_timeout() {
        let err = IPCError::Timeout(Duration::from_secs(30));
        let json_str = serde_json::to_string(&err).unwrap();
        assert!(json_str.contains("-32001"));
        assert!(json_str.contains("timeout"));
        assert!(json_str.contains("30"));
    }

    #[test]
    fn test_ipc_error_serialize_remote_error() {
        let err = IPCError::RemoteError {
            code: -32601,
            message: "Method not found".to_string(),
            data: Some(json!({"available": ["ping", "status"]})),
        };
        let json_str = serde_json::to_string(&err).unwrap();
        assert!(json_str.contains("-32601"));
        assert!(json_str.contains("Method not found"));
        assert!(json_str.contains("available"));
    }

    #[test]
    fn test_ipc_client_clone() {
        // 验证 IPCClient 可以 Clone（SidecarManager 内部都是 Arc）
        let manager = SidecarManager::new(PathBuf::from("/tmp/test.py"));
        let client = IPCClient::new(manager);
        let _cloned = client.clone();
    }

    // ============================================================
    // #67 方法白名单
    // ============================================================

    #[test]
    fn allowlist_uses_ready_snapshot_as_single_source() {
        // knowledge.rebuild 不在核心集里，但快照里有 → 放行（证明真源确实是 sidecar，
        // Rust 不再另持一张会过期的表）；快照里没有的一律拒，哪怕它听起来人畜无害。
        let known = [
            "agent.invoke".to_string(),
            "risk.evaluate".to_string(),
            "knowledge.rebuild".to_string(),
        ];
        assert!(method_allowed(&known, CORE_IPC_METHODS, "agent.invoke"));
        assert!(method_allowed(&known, CORE_IPC_METHODS, "knowledge.rebuild"));
        assert!(!method_allowed(&known, CORE_IPC_METHODS, "needs_you.approve"));
    }

    #[test]
    fn allowlist_fails_closed_to_core_set_when_snapshot_empty() {
        // 空快照 = sidecar 还没 ready。此时任何请求本来都会 NotRunning，
        // 所以只放行健康检查不是妥协，而是把"未就绪期能调什么"钉到最小面。
        assert!(method_allowed(&[], CORE_IPC_METHODS, "sidecar.health"));
        assert!(!method_allowed(&[], CORE_IPC_METHODS, "agent.invoke"));
        assert!(!method_allowed(&[], CORE_IPC_METHODS, "shutdown"));
    }

    #[test]
    fn method_not_allowed_serializes_jsonrpc_method_not_found() {
        let err = IPCError::MethodNotAllowed("python.exec".to_string());
        let json_str = serde_json::to_string(&err).unwrap();
        assert!(json_str.contains("-32601"), "{json_str}");
        assert!(json_str.contains("python.exec"), "{json_str}");
        assert!(json_str.contains("method_not_allowed"), "{json_str}");
    }
}
