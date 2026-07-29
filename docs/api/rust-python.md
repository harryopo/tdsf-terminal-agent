# Rust ↔ Python Sidecar JSON-RPC 接口切面文档（DEC-V32-05）

> **版本**：v1.0.0
> **最后更新**：2026-07-26
> **对应 spec**：T-P2-12.1 / DEC-V32-05
> **代码基线**：`src-tauri/src/modules/sidecar.rs` + `src-tauri/src/modules/ipc.rs` + `python-sidecar/main.py` + `python-sidecar/jsonrpc.py`
> **协议**：JSON-RPC 2.0 over stdio（每行一条消息，以 `\n` 结尾）

---

## 0. 文档目的

本文档作为 **Rust（Tauri 2 后端）↔ Python Sidecar（Agent 引擎）** 之间的接口切面契约，覆盖以下内容：

- stdio JSON-RPC 2.0 协议格式（请求 / 响应 / 错误 / 通知）
- 启动握手（spawn → ready 通知）
- 心跳健康检查（5s ping，30s 判死锁）
- 进程崩溃自动重启（max_retry=3，DEC-V321-11）
- 错误码体系（JSON-RPC 2.0 标准 + TDSF 扩展）
- Rust 侧 `SidecarManager` API（send_request / send_notification）
- Python 侧 `MethodDispatcher` 注册表（按模块分组）
- Tauri 命令暴露（`ipc_invoke` / `ipc_notify` / `ipc_status`）
- 完整链路时序图（前端 → Rust → Python → Rust → 前端）

**与 frontend-rust.md 的分层**：
- `frontend-rust.md`：前端 ↔ Rust Tauri 命令（47 个 invoke）
- **本文档**：Rust ↔ Python Sidecar（stdio JSON-RPC，约 60 个方法）

---

## 1. 接口总览

### 1.1 通信架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Tauri 主进程（Rust）                            │
│                                                                        │
│  ┌──────────────┐    invoke('ipc_invoke', ...)   ┌──────────────────┐  │
│  │  前端 React   │ ──────────────────────────────►│  ipc.rs          │  │
│  │  TypeScript   │ ◄──────────────────────────────│  IPCClient       │  │
│  └──────────────┘    Tauri event: sidecar:*      └────────┬─────────┘  │
│                                                          │            │
│                                                          ▼            │
│                                              ┌──────────────────────┐  │
│                                              │  sidecar.rs          │  │
│                                              │  SidecarManager      │  │
│                                              │  ──────────────────  │  │
│                                              │  - spawn Python      │  │
│                                              │  - send_request      │  │
│                                              │  - send_notification │  │
│                                              │  - reader_task       │  │
│                                              │  - heartbeat_task    │  │
│                                              └─────┬───────┬────────┘  │
│                                  stdin (write) │       │ (read) stdout │
│                                                  │       │              │
└──────────────────────────────────────────────────┼───────┼──────────────┘
                                                   │       │
                              ┌────────────────────┴───────┴────────────┐
                              │       OS pipe (stdin / stdout)           │
                              └────────────────────┬────────────────────┘
                                                   │
┌──────────────────────────────────────────────────┼────────────────────────┐
│                  Python Sidecar 进程              │                        │
│                                                  ▼                        │
│                                              ┌──────────────┐              │
│                                              │  main.py     │              │
│                                              │  MethodDisp. │              │
│                                              │  ──────────  │              │
│                                              │  - read line │              │
│                                              │  - dispatch  │              │
│                                              │  - response  │              │
│                                              └──────┬───────┘              │
│                                                     │                      │
│                       ┌─────────────────┬───────────┼──────────┬──────────┐ │
│                       ▼                 ▼           ▼          ▼          ▼ │
│                  ┌─────────┐    ┌────────────┐ ┌────────┐ ┌────────┐ ┌──────┐│
│                  │ project │    │  event_bus │ │ graph  │ │ tools  │ │needs ││
│                  │ service │    │            │ │        │ │        │ │ you  ││
│                  └─────────┘    └────────────┘ └────────┘ └────────┘ └──────┘│
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 方法清单（按 Python 模块分组）

| 模块 | 方法数 | 关键方法 |
|------|--------|----------|
| 默认（main.py） | 3 | `ping` / `shutdown` / `status` |
| project_service | ~12 | `project.list` / `session.create` / `session.list` / `lease.acquire` 等 |
| event_bus | 4 | `event.subscribe` / `event.unsubscribe` / `event.publish` / `event.history` |
| needs_you | 15 | `needs_you.request` / `needs_you.request_approval` / `needs_you.respond` / `needs_you.list` 等 |
| tdsf_loader | 5 | `tdsf.status` / `tdsf.reload` / `tdsf.start_watcher` / `tdsf.stop_watcher` / `tdsf.get_prompt_suffix` |
| agents | 4 | `agent.invoke` / `agent.list` / `agent.info` / `agent.configure` |
| graph | ~5 | `graph.invoke` / `graph.stream` / `graph.list_nodes` 等 |
| tools | ~8 | `tool.invoke` / `tool.list` / `tool.metadata` 等 |
| permissions | ~4 | `permission.check` / `permission.list_modes` 等 |
| **合计** | **~60** | — |

### 1.3 命名规则

| 侧 | 命名风格 | 示例 |
|----|----------|------|
| JSON-RPC method | dot.separated | `agent.invoke` / `needs_you.request_approval` |
| Python handler 函数 | snake_case（内部） | `_rpc_agent_invoke` / `_request` |
| params 字段 | snake_case | `{"session_id": "...", "user_input": "..."}` |
| Rust 命令 | snake_case | `ipc_invoke` / `sidecar_status` |
| Tauri 事件 | colon.separated | `sidecar:mood_change` / `sidecar:agent_message` |

---

## 2. 协议格式（JSON-RPC 2.0 over stdio）

### 2.1 三种消息类型

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         JSON-RPC 2.0 消息三态                            │
└─────────────────────────────────────────────────────────────────────────┘

1. Request（请求，有 id，必响应）
   Rust → Python:
   {"jsonrpc": "2.0", "method": "agent.invoke",
    "params": {"name": "coding", "state": {...}}, "id": 42}

2. Response（响应，与请求 id 配对）
   Python → Rust:
   {"jsonrpc": "2.0", "result": {"ok": true, ...}, "id": 42}

   失败时:
   {"jsonrpc": "2.0", "error": {"code": -32601, "message": "...", "data": {...}}, "id": 42}

3. Notification（通知，无 id，无响应）
   Python → Rust (主动推送):
   {"jsonrpc": "2.0", "method": "mood_change", "params": {"mood": "working"}}

   Rust → Python (单向指令):
   {"jsonrpc": "2.0", "method": "shutdown"}
```

### 2.2 消息分隔规则

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       stdin/stdout 消息分帧                              │
└─────────────────────────────────────────────────────────────────────────┘

每条消息 = 1 行 JSON + \n
                                        ▼
   ┌──────────────────────┐   ┌──────────────────────────────────────┐
   │   Rust (writer)      │   │   Python (reader)                    │
   │   write_line(json)   │──►│   for line in stdin:                 │
   │   + b"\n"            │   │       msg = json.loads(line)         │
   └──────────────────────┘   │       handle(msg)                    │
                              └──────────────────────────────────────┘

约束：
- 每条 JSON 必须在单行内（不允许跨行）
- 必须 `flush()` 确保 Python 侧立即读到
- 必须线程安全写入（Python 侧 _write_lock，Rust 侧 Mutex<ChildStdin>）
```

### 2.3 编码与字符集

- JSON 编码：UTF-8（`ensure_ascii=False`，支持中文）
- 换行符：`\n`（LF，不使用 CRLF）
- 数字精度：JSON number（Python `int`/`float`，Rust `i64`/`f64`）

---

## 3. 启动握手（ready 通知）

### 3.1 握手时序图

```
 Rust (SidecarManager)             Python (main.py)
 ─────────────────────             ────────────────
        │                                  │
        │ spawn("python", "main.py")       │
        │ ───────────────────────────────► │
        │                                  │
        │                                  │ import modules
        │                                  │ register methods
        │                                  │ start needs_you scanner
        │                                  │
        │ ◄──────────────────────────────  │ send_notification("ready",
        │                                  │   {version, python, platform,
        │                                  │    methods, startup_time})
        │                                  │
        │ if not received in 10s:          │
        │   return ReadyTimeout            │
        │                                  │
        │ start heartbeat_task             │
        │ start exit_watcher_task          │
        │                                  │
        │ send_request("ping", id=1)       │
        │ ───────────────────────────────► │
        │                                  │ dispatcher.dispatch("ping")
        │                                  │
        │ ◄──────────────────────────────  │ send_response({alive, uptime}, id=1)
        │                                  │
        │ mark as Running                  │
        │                                  │
```

### 3.2 ready 通知参数

```json
{
  "jsonrpc": "2.0",
  "method": "ready",
  "params": {
    "version": "1.0.0",
    "python": "3.13.0",
    "platform": "win32",
    "methods": ["ping", "shutdown", "status", "agent.invoke", "needs_you.request", ...],
    "startup_time": 0.234
  }
}
```

### 3.3 Rust 侧等待逻辑

```rust
// src-tauri/src/modules/sidecar.rs
const READY_TIMEOUT: Duration = Duration::from_secs(10);

async fn wait_for_ready(&self) -> SidecarResult<()> {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if self.is_ready_received() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(SidecarError::ReadyTimeout(READY_TIMEOUT))
}
```

### 3.4 错误处理

| 错误场景 | Rust 行为 |
|---------|----------|
| 10s 内未收到 ready | `SidecarError::ReadyTimeout(10s)`，杀进程后重试 |
| ready JSON 解析失败 | 日志 warning，继续等待 |
| ready 后再次收到 ready | 日志 warning，忽略 |
| Python 进程在 ready 前退出 | `SidecarError::SpawnFailed`，触发 fix-loop |

---

## 4. 心跳健康检查

### 4.1 心跳时序

```
 Rust heartbeat_task (每 5s)         Python (main.py)
 ─────────────────────────           ────────────────
        │                                  │
        │ send_request("ping", id=N)       │
        │ ───────────────────────────────► │
        │                                  │ dispatcher.dispatch("ping")
        │                                  │ return {alive: True, uptime: 12.3}
        │ ◄──────────────────────────────  │ send_response(result, id=N)
        │                                  │
        │ update last_heartbeat = now      │
        │                                  │
        │ if no response in 30s:           │
        │   mark as Crashed                │
        │   trigger fix-loop restart       │
        │                                  │
```

### 4.2 ping 请求 / 响应

```json
// Rust → Python
{"jsonrpc": "2.0", "method": "ping", "id": 7}

// Python → Rust
{"jsonrpc": "2.0", "result": {"alive": true, "uptime": 12.345}, "id": 7}
```

### 4.3 死锁判定

| 阈值 | 含义 |
|------|------|
| `HEARTBEAT_INTERVAL = 5s` | 每 5s 发送一次 ping |
| `HEARTBEAT_TIMEOUT = 30s` | 30s 内未收到任何响应 → 判定死锁 |
| `REQUEST_TIMEOUT = 30s` | 单次请求超时（业务方法） |

```rust
// 死锁判定逻辑
if last_heartbeat.elapsed() > HEARTBEAT_TIMEOUT {
    return Err(SidecarError::HeartbeatLost(HEARTBEAT_TIMEOUT));
}
```

---

## 5. 进程崩溃自动重启（Fix-loop max_retry=3）

### 5.1 重启策略时序

```
 SidecarManager                     Python 进程
 ────────────────                   ────────────
        │                                  │
        │ spawn Python                     │
        │ ───────────────────────────────► │ (运行中)
        │                                  │
        │ ... 心跳正常 ...                  │
        │                                  │
        │                                  │ X 进程崩溃 / 死锁 / stdin 关闭
        │ ◄──────────────────────────────  │ exit code != 0
        │                                  │
        │ retry_count += 1                 │
        │                                  │
        │ if retry_count <= MAX_RETRY(3):  │
        │   status = Restarting            │
        │   wait 1s (backoff)              │
        │   spawn Python again             │
        │   ─────────────────────────────► │ (重启)
        │                                  │
        │ else:                            │
        │   status = Crashed               │
        │   emit "sidecar:crashed" event   │
        │   return MaxRetryExceeded        │
        │                                  │
```

### 5.2 状态机

```
                        spawn()
   ┌──────────────┐ ──────────────► ┌──────────────┐
   │   Stopped    │                  │   Starting   │
   │              │ ◄──────────────  │              │
   └──────────────┘   shutdown()     └──────┬───────┘
         ▲                                  │ ready received
         │                                  ▼
         │                            ┌──────────────┐
         │              shutdown()    │   Running    │ ◄─── heartbeat OK
         │           ┌────────────────│              │
         │           ▼                └──────┬───────┘
         │     ┌──────────────┐              │ crash / heartbeat lost
         │     │   Stopping   │ ◄────────────┤ retry_count++
         │     └──────┬───────┘              │
         │            │ 3s grace             │
         │            │     SIGKILL          │
         │            ▼                      ▼
         │     ┌──────────────┐       ┌──────────────┐
         └─────│   Stopped    │       │  Restarting  │
               └──────────────┘       └──────┬───────┘
                                               │ retry_count > MAX_RETRY
                                               ▼
                                        ┌──────────────┐
                                        │   Crashed    │
                                        └──────────────┘
```

### 5.3 常量定义

```rust
// src-tauri/src/modules/sidecar.rs
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const MAX_RETRY: u32 = 3;  // Fix-loop DEC-V321-11
```

### 5.4 前端事件通知

| 事件名 | 触发时机 | payload |
|--------|----------|---------|
| `sidecar:status` | 状态变化 | `{status, pid, uptime, retry_count, max_retry}` |
| `sidecar:crashed` | 重启次数超限 | `{retry_count, max_retry, last_error}` |
| `sidecar:restarting` | 触发重启 | `{retry_count, backoff_ms}` |

---

## 6. 错误码体系

### 6.1 错误码总表

| 错误码 | 名称 | 含义 | 触发场景 |
|--------|------|------|----------|
| -32700 | Parse error | JSON 解析失败 | 非法 JSON 字符串 |
| -32600 | Invalid Request | 消息格式无效 | 非 dict / 缺 method 字段 |
| -32601 | Method not found | 方法未注册 | 未知 method 名 |
| -32602 | Invalid params | 参数无效 | params 类型错误 / 缺必填字段 |
| -32603 | Internal error | 内部错误 | handler 抛出未捕获异常 |
| -32000 | Server generic | TDSF 通用错误 | 业务逻辑错误 |
| -32001 | Timeout | 请求超时 | 30s 未响应 |
| -32002 | Write lease | 写租约冲突 | project_service 并发写 |

### 6.2 错误响应格式

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32601,
    "message": "Method not found: foo.bar",
    "data": {
      "available": ["ping", "agent.invoke", "needs_you.request"]
    }
  },
  "id": 42
}
```

### 6.3 Rust 侧 IPCError 类型化映射

```rust
// src-tauri/src/modules/ipc.rs
pub enum IPCError {
    NotRunning,                    // → -32000 data.type="not_running"
    Timeout(Duration),             // → -32001
    StdinClosed,                   // → -32000 data.type="stdin_closed"
    ProcessError(String),          // → -32000 data.type="process_error"
    Json(serde_json::Error),       // → -32700
    Io(std::io::Error),            // → -32000 data.type="io_error"
    RemoteError { code, message, data }, // Python 返回的 error
}
```

### 6.4 前端解析示例

```typescript
try {
  const result = await invokeRpc('agent.invoke', { name: 'coding', state: {} });
} catch (e) {
  const err = e as IPCError;
  switch (err.code) {
    case -32001:
      console.log('请求超时，请重试');
      break;
    case -32601:
      console.log('方法不存在，请检查 Python Sidecar 版本');
      break;
    case -32000:
      if (err.data?.type === 'not_running') {
        console.log('Sidecar 未启动，正在重启...');
      }
      break;
  }
}
```

---

## 7. Rust 侧 SidecarManager API

### 7.1 核心方法签名

```rust
// src-tauri/src/modules/sidecar.rs
impl SidecarManager {
    /// 启动 Python Sidecar 进程（spawn + wait_for_ready + heartbeat）
    pub async fn start(&self) -> SidecarResult<()>;

    /// 停止 Python Sidecar（shutdown 方法 → 3s → SIGKILL）
    pub async fn stop(&self) -> SidecarResult<()>;

    /// 重启 Python Sidecar（stop + start）
    pub async fn restart(&self) -> SidecarResult<()>;

    /// 发送请求并等待响应（30s 超时）
    pub async fn send_request(
        &self,
        method: &str,
        params: Value,
    ) -> SidecarResult<Value>;

    /// 发送通知（无 id，无响应）
    pub async fn send_notification(
        &self,
        method: &str,
        params: Value,
    ) -> SidecarResult<()>;

    /// 获取当前状态快照
    pub async fn status(&self) -> SidecarStateSnapshot;
}
```

### 7.2 send_request 链路

```
 ipc_invoke(method, params)
        │
        ▼
 IPCClient::invoke(method, params)
        │
        ▼
 SidecarManager::send_request
        │
        ▼
 ┌──────────────────────────────────────────┐
 │  1. 分配 id (AtomicI64 fetch_add)         │
 │  2. 构造 JSON-RPC request:                │
 │     {jsonrpc, method, params, id}         │
 │  3. 写入 stdin (加锁)                     │
 │  4. 注册 oneshot channel 到 pending 表   │
 │  5. tokio::time::timeout(30s, rx.await)   │
 │  6. reader_task 收到响应 → 查表 → tx.send │
 │  7. 返回 result 或 Timeout 错误           │
 └──────────────────────────────────────────┘
```

### 7.3 reader_task 通知路由

```rust
// reader_task 主循环
loop {
    let line = stdout.read_line().await?;
    let msg: Value = serde_json::from_str(&line)?;

    if let Some(id) = msg.get("id") {
        // 响应：查 pending 表，触发 oneshot
        let tx = pending.remove(&id)?;
        tx.send(msg["result"].clone())?;
    } else if let Some(method) = msg.get("method") {
        // 通知：转发到前端 Tauri event
        app.emit(format!("sidecar:{}", method), msg["params"])?;
    }
}
```

---

## 8. Python 侧 MethodDispatcher

### 8.1 方法注册机制

```python
# python-sidecar/main.py
class MethodDispatcher:
    def register(self, name: str, handler: Callable) -> None:
        """注册方法（同名方法会被覆盖）"""
        self._methods[name] = handler

    def dispatch(self, method: str, params: Any) -> Any:
        """分发方法调用
        params 支持 dict (命名参数) / list (位置参数) / None (无参数)
        """
        handler = self._methods.get(method)
        if handler is None:
            raise JSONRPCError(ERR_METHOD_NOT_FOUND, ...)
        if isinstance(params, dict):
            return handler(**params)
        elif isinstance(params, list):
            return handler(*params)
        elif params is None:
            return handler()
```

### 8.2 注册顺序（main.py 启动时）

```python
# register_business_methods 执行顺序：
1. project_service.register_methods(dispatcher)   # SQLite + 写租约
2. event_bus.register_methods(dispatcher)         # 事件总线
   + event_bus.set_rust_notifier(send_notification)
3. needs_you.register_methods(dispatcher)         # needs-you 协调
   + needs_you.set_event_bus(event_bus.get_global_bus())
   + needs_you.start_global_service()             # 启动超时扫描线程
4. tdsf_loader.register_methods(dispatcher)       # TDSF.md 加载
   + tdsf_loader.initialize_on_startup(start_watcher=True)
5. agents.register_methods(dispatcher)            # Agent 框架
   + agents.configure_agents(event_bus, llm_call=None)
```

### 8.3 默认方法（无需注册）

| 方法 | 参数 | 返回 | 用途 |
|------|------|------|------|
| `ping` | 无 | `{alive: True, uptime: 12.3}` | 心跳 |
| `shutdown` | 无 | `{ok: True}` | 优雅退出 |
| `status` | 无 | `{version, python, platform, uptime, methods, ready}` | 状态查询 |

---

## 9. 完整链路示例：前端调用 Agent

### 9.1 时序图（agent.invoke 完整链路）

```
 前端 React        Rust (Tauri)         Python Sidecar       LangGraph
 ──────────        ────────────         ──────────────       ─────────
      │                  │                    │                  │
      │ invoke('ipc_     │                    │                  │
      │  invoke', {      │                    │                  │
      │   method:'       │                    │                  │
      │   agent.invoke', │                    │                  │
      │   params:{...}}) │                    │                  │
      │ ────────────────►│                    │                  │
      │                  │                    │                  │
      │                  │ IPCClient::invoke  │                  │
      │                  │ send_request(      │                  │
      │                  │  "agent.invoke",   │                  │
      │                  │  params, id=42)    │                  │
      │                  │ ──────────────────►│                  │
      │                  │                    │ dispatcher.      │
      │                  │                    │  dispatch(       │
      │                  │                    │   "agent.invoke")│
      │                  │                    │                  │
      │                  │                    │ agents.invoke_   │
      │                  │                    │  agent(name,     │
      │                  │                    │   state)         │
      │                  │                    │ ─────────────────►│
      │                  │                    │                  │
      │                  │                    │                  │ graph.invoke
      │                  │                    │                  │  (PAOR loop)
      │                  │                    │                  │  plan → act
      │                  │                    │                  │  → observe
      │                  │                    │                  │  → reflect
      │                  │                    │                  │
      │                  │ ◄──────────────────│ send_notification│
      │                  │  "mood_change",    │  (实时事件)       │
      │                  │  {mood:"thinking"} │                  │
      │                  │                    │                  │
      │ ◄────────────────│ emit("sidecar:    │                  │
      │  listen(         │  mood_change")     │                  │
      │  "sidecar:       │                    │                  │
      │  mood_change")   │                    │                  │
      │                  │                    │                  │
      │                  │                    │ ◄────────────────│
      │                  │                    │ return update    │
      │                  │                    │                  │
      │                  │ ◄──────────────────│ send_response(   │
      │                  │  {result:{...},    │  result, id=42)  │
      │                  │   id:42}           │                  │
      │                  │                    │                  │
      │ ◄────────────────│ return result     │                  │
      │  resolve(result) │                    │                  │
      │                  │                    │                  │
```

### 9.2 完整请求示例

```json
// 前端 → Rust (Tauri invoke)
{
  "method": "agent.invoke",
  "params": {
    "name": "coding",
    "state": {
      "input": "修复 nginx 配置错误",
      "session_id": "sess-123",
      "mode": "agent",
      "max_iterations": 10
    }
  }
}

// Rust → Python (JSON-RPC request)
{
  "jsonrpc": "2.0",
  "method": "agent.invoke",
  "params": {
    "name": "coding",
    "state": {"input": "修复 nginx 配置错误", ...}
  },
  "id": 42
}

// Python → Rust (中间通知，无 id)
{"jsonrpc": "2.0", "method": "mood_change",
 "params": {"mood": "thinking", "agent": "coding"}}

{"jsonrpc": "2.0", "method": "agent_message",
 "params": {"content": "调用工具 risk 完成", "type": "tool_call"}}

// Python → Rust (最终响应)
{
  "jsonrpc": "2.0",
  "result": {
    "observation": "工具 risk 执行完成...",
    "next_step": "done",
    "mood": "done",
    "intermediate_results": [...]
  },
  "id": 42
}
```

---

## 10. Rust 暴露的 Tauri 命令（3 个）

### 10.1 `ipc_invoke`

**用途**：前端通过 Rust 中转调用 Python JSON-RPC 方法（等待响应）。

**Rust 签名**：
```rust
#[tauri::command]
pub async fn ipc_invoke(
    state: tauri::State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<Value, String>;
```

**前端调用**：
```typescript
const result = await invoke('ipc_invoke', {
  method: 'agent.invoke',
  params: { name: 'coding', state: {...} }
});
```

**错误**：返回 `IPCError` 序列化字符串，前端 `catch` 后可解析 `.code` 和 `.data.type`。

### 10.2 `ipc_notify`

**用途**：前端通过 Rust 中转向 Python 发送通知（无响应）。

**Rust 签名**：
```rust
#[tauri::command]
pub async fn ipc_notify(
    state: tauri::State<'_, AppState>,
    method: String,
    params: Value,
) -> Result<(), String>;
```

### 10.3 `ipc_status`

**用途**：查询 IPC 层状态（pending 请求数 / 最近错误）。

**返回**：
```json
{
  "sidecar": {"status": "running", "pid": 12345, "uptime": 12.3},
  "pending_requests": 0,
  "last_error": null
}
```

---

## 11. Python 侧关键模块详解

### 11.1 project_service（T-P1-03）

**职责**：SQLite WAL + 5 表 CRUD（projects / sessions / messages / files / leases）+ 写租约机制。

**核心方法**：
| 方法 | 参数 | 返回 |
|------|------|------|
| `project.list` | `{limit?: 100}` | `[{id, name, path, created_at}, ...]` |
| `project.create` | `{name, path}` | `{id, name, path, created_at}` |
| `session.create` | `{project_id, title?}` | `{id, project_id, title, created_at}` |
| `session.list` | `{project_id}` | `[{id, title, ...}]` |
| `lease.acquire` | `{project_id, resource, holder}` | `{lease_id, expires_at}` |
| `lease.release` | `{lease_id}` | `{ok: true}` |

### 11.2 event_bus（T-P1-04）

**职责**：pub-sub 事件总线 + Rust 通知器注入。

**核心方法**：
| 方法 | 参数 | 返回 |
|------|------|------|
| `event.subscribe` | `{event_type}` | `{subscribed: true}` |
| `event.unsubscribe` | `{event_type}` | `{unsubscribed: true}` |
| `event.publish` | `{event_type, payload}` | `{published: true}` |
| `event.history` | `{event_type?, limit?}` | `[{type, payload, timestamp}, ...]` |

**事件类型**：`mood_change` / `agent_message` / `needs_you` / `tool_call` / `tdsf_updated`

### 11.3 needs_you（T-P1-10）

**职责**：4 类型（approval / error / question / handoff）+ 优先级排序 + 30s 超时。

**核心方法**：
| 方法 | 参数 | 返回 |
|------|------|------|
| `needs_you.request` | `{type, title, description, ...}` | `{id, type, status, ...}` |
| `needs_you.respond` | `{req_id, response}` | `{id, status, responded_at}` |
| `needs_you.list` | `{session_id?, type?}` | `[{id, type, title, priority}, ...]` |
| `needs_you.stats` | `{}` | `{total_created, total_responded, ...}` |

### 11.4 agents（T-P1-11）

**职责**：5 个 Agent（main / coding / explore / history / teach）+ PAOR 模板方法。

**核心方法**：
| 方法 | 参数 | 返回 |
|------|------|------|
| `agent.invoke` | `{name, state}` | `{observation, next_step, mood, ...}` |
| `agent.list` | `{}` | `{agents: [...], configured: [...]}` |
| `agent.info` | `{name}` | `{name, role, tools, system_prompt}` |
| `agent.configure` | `{llm_call?}` | `{ok: true, llm_call_set: bool}` |

### 11.5 graph（T-P1-05）

**职责**：LangGraph 7 节点 PAOR 监督循环。

**核心方法**：
| 方法 | 参数 | 返回 |
|------|------|------|
| `graph.invoke` | `{input, session_id, mode}` | `{final_state}` |
| `graph.stream` | `{input, session_id, mode}` | `{events: [...]}` |
| `graph.list_nodes` | `{}` | `{nodes: ["supervisor", "plan", ...]}` |

---

## 12. 通知事件清单（Python → Rust → 前端）

| Python method | Rust 转发事件 | 前端监听 | payload |
|---------------|---------------|----------|---------|
| `ready` | `sidecar:ready` | `listen('sidecar:ready')` | `{version, python, methods}` |
| `mood_change` | `sidecar:mood_change` | `listen('sidecar:mood_change')` | `{mood, agent}` |
| `agent_message` | `sidecar:agent_message` | `listen('sidecar:agent_message')` | `{content, type, agent}` |
| `needs_you` | `sidecar:needs_you` | `listen('sidecar:needs_you')` | `{event, request}` |
| `tool_call` | `sidecar:tool_call` | `listen('sidecar:tool_call')` | `{tool, params, result}` |
| `tdsf_updated` | `sidecar:tdsf_updated` | `listen('sidecar:tdsf_updated')` | `{path, content}` |
| `status` | `sidecar:status` | `listen('sidecar:status')` | `{status, pid, uptime}` |

---

## 13. 边界情况与错误处理

### 13.1 Python 侧异常处理

| 异常 | Python 行为 | Rust 接收 |
|------|-------------|-----------|
| `JSONDecodeError` | 发送 `-32700 Parse error` | reader_task 日志 warning |
| `JSONRPCError` | 发送对应错误码 | IPCError::RemoteError |
| 其他 Exception | 发送 `-32603 Internal error` | IPCError::RemoteError |
| handler 超时 | 不存在超时（同步调用） | Rust 侧 30s REQUEST_TIMEOUT |
| 主循环异常 | log + sleep 0.1s + 继续 | 无感知（心跳维持） |

### 13.2 Rust 侧异常处理

| 异常 | Rust 行为 | 前端接收 |
|------|----------|----------|
| Sidecar 未启动 | `IPCError::NotRunning` | `{code: -32000, data: {type: "not_running"}}` |
| stdin 关闭 | `IPCError::StdinClosed` | `{code: -32000, data: {type: "stdin_closed"}}` |
| 30s 超时 | `IPCError::Timeout(30s)` | `{code: -32001}` |
| Python 返回错误 | `IPCError::RemoteError` | `{code: <原始>, message, data}` |
| 心跳丢失 | 状态置 Crashed + 重启 | emit `sidecar:crashed` |

### 13.3 完整错误恢复链路

```
 前端调用 agent.invoke
        │
        ▼
 Rust send_request
        │
        ├──► 正常响应 → 返回 result
        │
        ├──► Python 返回 error → IPCError::RemoteError → 前端处理
        │
        ├──► 30s 超时 → IPCError::Timeout → 前端重试
        │
        ├──► stdin 关闭 → IPCError::StdinClosed
        │        │
        │        ▼
        │     触发 fix-loop
        │        │
        │        ├── retry 1: 重启 Python → 重新调用 → 成功
        │        ├── retry 2: 重启 Python → 重新调用 → 成功
        │        └── retry 3: 重启 Python → 重新调用 → 失败
        │                                       │
        │                                       ▼
        │                                  SidecarError::MaxRetryExceeded
        │                                       │
        │                                       ▼
        │                                  状态置 Crashed
        │                                  emit "sidecar:crashed"
        │
        └──► 进程崩溃 → 同 stdin 关闭路径
```

---

## 14. 性能与并发

### 14.1 并发模型

| 侧 | 模型 | 并发能力 |
|----|------|----------|
| Rust 主进程 | tokio async | 多请求并发（每请求独立 oneshot） |
| Rust stdin 写入 | `Mutex<ChildStdin>` | 串行化写入（避免消息交错） |
| Rust stdout 读取 | 单 reader_task | 单线程读 + 路由 |
| Python 主循环 | 单线程 + threading.RLock | 串行处理请求 |
| Python needs_you 超时扫描 | daemon thread | 后台 1s 扫描 |

### 14.2 性能基线

| 指标 | 数值 | 备注 |
|------|------|------|
| 单次 IPC 往返延迟 | < 5ms | 本地 stdio pipe |
| ping 响应时间 | < 2ms | 无业务逻辑 |
| agent.invoke 平均耗时 | 100-500ms | 含 LangGraph PAOR 单轮 |
| 心跳 CPU 占用 | < 0.1% | 5s 一次 ping |

### 14.3 背压机制

- Rust `pending` 表无上限（理论上可堆积）
- Python 主循环串行处理（自然背压）
- 30s 超时自动释放 pending（避免内存泄漏）

---

## 15. 版本兼容性

### 15.1 协议版本

| 字段 | 当前值 | 兼容性 |
|------|--------|--------|
| `jsonrpc` | `"2.0"` | JSON-RPC 2.0 标准（永不变） |
| `version` (ready) | `"1.0.0"` | TDSF 协议版本（语义化） |
| `python` | `"3.13.x"` | Python 解释器版本 |

### 15.2 方法兼容性策略

- 已注册方法 **不可移除**（前端可能依赖）
- 新增方法时 **minor 版本 +1**
- 参数变化 **必须向后兼容**（新增参数可选）
- 删除方法 **major 版本 +1** + 前端迁移指南

### 15.3 版本协商

```json
// Rust 启动时主动查询
→ {"method": "status", "id": 1}
← {"result": {"version": "1.0.0", "methods": [...], "ready": true}, "id": 1}

// Rust 检查方法是否存在
if !status.methods.contains(&"agent.invoke".to_string()) {
    return Err(SidecarError::VersionMismatch);
}
```

---

## 16. 安全考量

### 16.1 进程隔离

- Python Sidecar 是独立子进程（非线程）
- 崩溃不影响 Tauri 主进程
- stdin/stdout/stderr 三个 pipe 完全隔离

### 16.2 输入校验

- Python `MethodDispatcher.dispatch` 校验 params 类型
- 各 handler 自行校验业务参数（如 `command` 必填）
- Rust 侧不解析 params（透传 JSON Value）

### 16.3 资源限制

- 单请求 30s 超时（防止 LLM 卡死）
- 心跳 30s 判死锁（防止 Python 假死）
- max_retry=3（防止无限重启循环）

### 16.4 日志隔离

- Python 日志输出到 **stderr**（避免污染 stdout JSON-RPC 流）
- Rust 侧 `tracing` 日志独立配置
- 前端不接收 stderr（仅 Rust 控制台可见）

---

## 17. 调试技巧

### 17.1 启动时方法列表查询

```bash
# Rust 启动后立即查询 Python 已注册方法
→ {"jsonrpc": "2.0", "method": "status", "id": 1}
← {"jsonrpc": "2.0", "result": {
     "version": "1.0.0",
     "methods": ["ping", "agent.invoke", "needs_you.request", ...],
     "ready": true
   }, "id": 1}
```

### 17.2 手动 ping 测试

```bash
# 通过 Tauri 控制台
await window.__TAURI__.core.invoke('ipc_invoke', {
  method: 'ping'
});
// 返回: {alive: true, uptime: 12.345}
```

### 17.3 通知事件监听

```typescript
// 前端监听所有 sidecar 通知
import { listen } from '@tauri-apps/api/event';
const unlisten = await listen('sidecar://', (event) => {
  console.log(`[${event.event}]`, event.payload);
});
```

### 17.4 日志级别调整

```bash
# Python 侧日志级别（环境变量）
TDSF_SIDECAR_LOG=DEBUG python main.py
```

---

## 18. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0.0 | 2026-07-26 | 初始版本：覆盖 stdio JSON-RPC 2.0 + 启动握手 + 心跳 + Fix-loop + 错误码 + 60 个方法清单 |

---

## 19. 参考文档

- `specs/04-api-contract.md`：API 契约规范
- `specs/02-architecture.md`：架构设计
- `python-sidecar/main.py`：Python 入口
- `python-sidecar/jsonrpc.py`：JSON-RPC 服务器封装
- `src-tauri/src/modules/sidecar.rs`：Rust 进程管理
- `src-tauri/src/modules/ipc.rs`：Rust IPC 协议层
- `src/lib/sidecar-bridge.ts`：前端桥接层
- JSON-RPC 2.0 规范：https://www.jsonrpc.org/specification
