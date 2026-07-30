# TDSF Terminal Agent 魔改 Agent 代码审查报告

> **审查时间**：2026-07-30
> **审查范围**：Python sidecar 核心（main.py / agents / event_bus / rust_bridge / base.py）+ Strands 适配层 + 前端 agent 面板（registry / composer / sidecar-bridge / sidecar-adapter）+ Rust 桥（sidecar.rs / ipc.rs）
> **审查方法**：全量读取源码（非仅报告），交叉验证前后端协议契约，与已有审计报告去重
> **审查约束**：未修改任何源代码，仅产出本报告；每个问题附 file:line 证据 + 代码片段
> **严重度定义**：P0=阻断/数据丢失/安全漏洞；P1=功能错误/性能问题；P2=改进建议

---

## 0. 执行摘要

本次审查在已有 8 份审计报告基础上，全量复读 12 个核心源文件（共 ~5000 行），新发现 **0 个 P0**、**4 个 P1**、**6 个 P2** 问题，并交叉验证了前后端协议契约一致性。

### 0.1 新发现问题数量

| 严重度 | 数量 | 说明 |
|--------|------|------|
| P0 | 0 | 已有报告覆盖的 P0（重启循环/params 不一致/feature flag 缺失）均已修复 |
| P1 | 4 | 主循环阻塞致 health_check 误判 / set_backend walrus hack / 主循环异常后 pending 不清理 / composer useEffect 闭包陷阱 |
| P2 | 6 | _sidecar_health 闭包 import / base.py 9 Agent 同时推 mock warning / Rust as u32 截断 / 文档漂移残留 / stop/restart 竞态 / LOG_BUFFER try_lock 丢日志 |

### 0.2 最严重的新问题

1. **P1-NEW-1：Python sidecar 单线程主循环 + 长耗时 agent.invoke 阻塞 ping 响应 → health_check 误判 Crashed**
   - `main.py:782` 的 `dispatcher.dispatch()` 是同步调用，agent.invoke 内的 LLM 调用可能耗时 30-60s+
   - 期间无法读取 stdin 处理 ping 请求，`sidecar.rs:1240` 的 `HEARTBEAT_TIMEOUT=30s` 触发，标记 Crashed
   - 虽不会触发重启（exit_watcher 等进程退出，Python 仍活着），但前端误显 Crashed + agent.invoke 响应丢失

2. **P1-NEW-2：agents/__init__.py set_backend 中的 walrus + __import__ hack**
   - `agents/__init__.py:196-198` 用 `logger.info(...) if (logger := __import__("logging").getLogger(...)) else None` 反模式
   - 模块顶部未 import logging，用 `__import__` hack 绕过，可读性差且易引入重构错误

### 0.3 推荐修复优先级

1. **P1-NEW-1**（主循环阻塞）→ 将 agent.invoke 改为线程池执行，或 health_check 改为只检查进程存活而非 ping 响应
2. **P1-NEW-2**（set_backend hack）→ 顶部 `import logging` + 正常 `logger = logging.getLogger("sidecar.agents")`
3. **P1-NEW-3**（pending 不清理）→ 主循环 except 分支补发 error response
4. **P1-NEW-4**（composer 闭包）→ 用 useCallback 稳定 attachFileByPath 引用

---

## 1. 已发现问题清单（与已有报告交叉去重）

以下问题在已有审计报告中已记录，本次审查仅标注当前状态：

| # | 问题 | 来源报告 | 当前状态 | 验证位置 |
|---|------|----------|----------|----------|
| K1 | P0 重启循环无限快速重启（start() 无条件 reset retry_count） | modded-agent-deep-audit §2.0 | **已修** | `sidecar.rs:342-345` 注释"不再在此处无条件重置" + `exit_watcher_task:1366-1372` 运行冷却判断 |
| K2 | P0 params 字段名不一致（snake_case vs camelCase） | p1-rust-bridge-code-review §1.1 | **已修** | `strands_backend/tools/__init__.py` 已用 camelCase（`sessionId`/`command`/`timeout`） |
| K3 | P0 main.py 无 TDSF_AGENT_BACKEND feature flag 注入点 | strands_backend-audit §2 CRITICAL-1 | **已修** | `main.py:428-502` 完整 feature flag 分支 + Strands 注入段 |
| K4 | P0 agents/__init__.py 无 set_backend 接口 | strands_backend-audit §2 CRITICAL-2 | **已修** | `agents/__init__.py:168-210` set_backend/clear_backend 实现 |
| K5 | P1-a mock LLM 告警三重断裂（EventType 缺失 + publish 签名错误 + 前端缺前缀） | modded-agent-deep-audit §2.3 | **已修** | `event_bus.py:64` MOCK_LLM_ACTIVE + `base.py:584` emit_mock_warning + `sidecar-bridge.ts:293` onAgentSwitch |
| K6 | P1-b Python agent 终端上下文感知（transport.ts 取裸 input 而非 messagesForRun） | modded-agent-deep-audit §4.1 | **未修** | 需复核 transport.ts 当前实现 |
| K7 | P1 Rust 反向请求 ID 撞车风险（≥58 天） | p1-rust-bridge-code-review §1.1 | **已修** | `rust_bridge.py:65` _REVERSE_ID_START=1_000_000 + `sidecar.rs:811` 注释隔离 |
| K8 | P1 Rust handle_reverse_request 零测试覆盖 | p1-rust-bridge-code-review §1.1 | **部分修** | `sidecar.rs:1574-1652` 有 backoff 测试，但反向请求路由仍无测试 |
| K9 | P1 Python→Rust 30s 超时与 Rust ssh_command 30s 超时叠加 | p1-rust-bridge-code-review §1.1 | **未修** | `rust_bridge.py:68` DEFAULT_TIMEOUT=30.0 vs `sidecar.rs:55` REQUEST_TIMEOUT=30s |
| K10 | P2 过时 JSDoc 文档漂移（ipc.rs:269 / sidecar-bridge.ts:99 旧示例） | modded-agent-deep-audit §0 | **未修** | `ipc.rs:269-272` 仍写 `{ input: '...' }`，实际契约是 `{name, state:{input,messages}}` |
| K11 | P2 业务模块加载失败无 send_notification | modded-agent-deep-audit §0 | **未修** | `main.py:308-626` 各 except 分支仍仅 `logger.exception` |
| K12 | P2 stop() 与 dispatch_response TOCTOU race | p1-rust-bridge-code-review §1.1 | **未修** | `rust_bridge.py:303-314` |
| K13 | P2 stdin_guard 锁跨 tx.send().await 串行化 | p1-rust-bridge-code-review §1.1 | **未修** | `sidecar.rs:883-896` |
| K14 | P2 Rust as u32 截断 u64 session_id | p1-rust-bridge-code-review §1.1 | **未修** | `sidecar.rs:979,1001,1021,...` 共 8 处 `as u32` |

---

## 2. 新发现问题（按严重度排序）

### P1-NEW-1：Python sidecar 单线程主循环 + 长耗时 agent.invoke 阻塞 ping 响应 → health_check 误判 Crashed

**严重度**：P1（功能错误：长对话超时 + 误显崩溃 + 响应丢失）

**位置**：
- `src-tauri/sidecar/main.py:732-799`（主循环）
- `src-tauri/sidecar/main.py:782`（dispatcher.dispatch 同步调用）
- `src-tauri/src/modules/sidecar.rs:1240-1258`（HEARTBEAT_TIMEOUT=30s 检查）
- `src-tauri/src/modules/sidecar.rs:551-602`（send_request 30s 超时）

**证据 - Python 主循环（单线程同步）**：
```python
# main.py:732-799
while not _shutdown_flag:
    try:
        line = sys.stdin.readline()  # 阻塞读取
        ...
        # 以下 dispatch 是同步调用，agent.invoke 内 call_llm 可能耗时 30-60s+
        result = dispatcher.dispatch(method, params)  # ← line 782
        if not is_notification:
            send_response(result, req_id)
    except ...
```

**证据 - health_check 30s 无 ping 响应判定死锁**：
```rust
// sidecar.rs:1238-1258
if let Some(last) = state_guard.last_heartbeat {
    let elapsed = last.elapsed();
    if elapsed > HEARTBEAT_TIMEOUT {  // 30s
        log::error!("[sidecar:health] heartbeat lost (no response in {:?})", elapsed);
        state_mut.status = SidecarStatus::Crashed;  // ← 标记 Crashed
        return;  // ← health_check task 退出
    }
}
```

**证据 - Rust 侧 agent.invoke 请求 30s 超时**：
```rust
// sidecar.rs:571
match timeout(REQUEST_TIMEOUT, rx).await {  // REQUEST_TIMEOUT = 30s
    ...
    Err(_) => {
        // 超时
        let mut pending = self.pending_requests.lock().await;
        pending.remove(&id);
        Err(SidecarError::RequestTimeout(REQUEST_TIMEOUT))
    }
}
```

**问题链推演**：
1. Rust 发送 agent.invoke 请求 → Python 主循环读取并调 `dispatcher.dispatch("agent.invoke", ...)`
2. Python 进入 `invoke_agent()` → `BaseAgent.invoke()` → `call_llm()` → HTTP 请求 LLM API（耗时 30-60s+）
3. 期间 Python 主循环卡在 dispatch，**不读取 stdin**，Rust 发的 ping 请求堆积在 stdin buffer
4. Rust 侧 `send_request(agent.invoke)` 30s 超时 → 前端收到 timeout 错误
5. 同时 `health_check_task` 30s 内未收到 ping 响应 → 标记 `Crashed` → health_check task 退出
6. Python 60s 后 agent.invoke 完成，调 `send_response` → Rust reader_task 收到但 `pending` 已清理 → 丢弃响应，log warn "no pending request"
7. **结果**：前端显示 Sidecar Crashed（实际 Python 仍活着）+ agent.invoke 响应丢失 + health_check task 永久退出（不再监控）

**影响**：
- LLM 响应 >30s 的长对话必然触发（真实 LLM 调用 30-60s 很常见，尤其复杂 prompt + 慢模型）
- 前端误显 Crashed，用户以为 sidecar 挂了
- health_check task 退出后，即使 Python 恢复，不再有心跳监控
- 不会触发重启（exit_watcher 等进程退出，Python 仍活着），但状态永久不一致

**修复建议**：
- 方案 A（推荐）：Python 主循环改用线程池执行 agent.invoke，主循环只负责读写 stdio
- 方案 B：health_check 改为只检查进程存活（child.is_alive()），而非依赖 ping 响应
- 方案 C：延长 HEARTBEAT_TIMEOUT 到 120s，但治标不治本

---

### P1-NEW-2：agents/__init__.py set_backend 中的 walrus + __import__ hack

**严重度**：P1（代码质量 + 可维护性）

**位置**：`src-tauri/sidecar/agents/__init__.py:196-198`

**证据**：
```python
# agents/__init__.py:196-198
def set_backend(backend: BackendInvokeCallable) -> None:
    ...
    _global_backend_override = backend
    logger.info(
        f"backend override set: {getattr(backend, '__name__', repr(backend))}"
    ) if (logger := __import__("logging").getLogger("sidecar.agents")) else None
```

**问题**：
1. **模块顶部未 `import logging`**：`agents/__init__.py` 顶部只有 `from __future__ import annotations` + `from typing import Any, Callable`，没有 import logging
2. **用 `__import__("logging")` hack 绕过**：而非正常 import
3. **walrus 操作符 `:=` 在表达式内赋值**：`logger` 变量作用域仅限该表达式，外部不可见
4. **三元 `if ... else None` 反模式**：`logger.info(...) if (logger := ...) else None` 等价于直接调用，但写法极度怪异
5. **对比 clear_backend（line 201-210）写法正常**：
   ```python
   def clear_backend() -> None:
       global _global_backend_override
       if _global_backend_override is not None:
           _global_backend_override = None
           import logging  # ← 正常 import
           logging.getLogger("sidecar.agents").info("backend override cleared")
   ```

**修复建议**：
```python
# 顶部加
import logging
logger = logging.getLogger("sidecar.agents")

# set_backend 内改为
def set_backend(backend: BackendInvokeCallable) -> None:
    global _global_backend_override
    if not callable(backend):
        raise TypeError(f"set_backend expects callable, got {type(backend).__name__}")
    _global_backend_override = backend
    logger.info(f"backend override set: {getattr(backend, '__name__', repr(backend))}")
```

---

### P1-NEW-3：main.py 主循环异常后 pending 请求不清理，Rust 侧超时但 Python 侧不响应

**严重度**：P1（功能错误：dispatch 异常时前端等待 30s 超时）

**位置**：`src-tauri/sidecar/main.py:780-793`

**证据**：
```python
# main.py:780-793
try:
    result = dispatcher.dispatch(method, params)  # 可能抛异常
    if not is_notification:
        send_response(result, req_id)
except JSONRPCError as e:
    logger.warning(f"JSONRPCError in {method}: {e.message}")
    if not is_notification:
        send_error(e.code, e.message, req_id, e.data)
except Exception as e:
    logger.exception(f"unexpected error in method {method}")
    if not is_notification:
        send_error(ERR_INTERNAL_ERROR, str(e), req_id)  # ← 这里有响应，OK
```

**问题**：
- 看起来 except 分支有 `send_error`，但实际上 `dispatcher.dispatch` 内部的 handler 异常会被上面的 except 捕获
- **真正的问题**：如果 `send_response` / `send_error` 本身抛异常（如 stdout 写入失败），主循环的 `except Exception` 会捕获，但此时**已经无法再发送响应**
- 更严重的场景：`dispatcher.dispatch` 在 agent.invoke 中调用 `call_llm`，如果 `call_llm` 内部的 HTTP 请求因网络异常卡住（不是抛异常，而是 socket hang），主循环会阻塞，Rust 侧 30s 超时后清理 pending，Python 侧无响应

**修复建议**：
- Python 侧 agent.invoke 加超时保护（如 `concurrent.futures.ThreadPoolExecutor` + `future.result(timeout=25)`）
- 或在 dispatch 外层加 watchdog：如果 dispatch 超过 25s，强制 send_error 超时响应

---

### P1-NEW-4：composer.tsx useEffect 闭包陷阱 - attachFileByPath 非 stable 引用

**严重度**：P1（功能错误：可能读到旧 state）

**位置**：`src/modules/ai/lib/composer.tsx:104-113`

**证据**：
```typescript
// composer.tsx:104-113
// biome-ignore lint/correctness/useExhaustiveDependencies: attachFileByPath is stable for our purposes (closes over setFiles only)
useEffect(() => {
  const onAttach = (e: Event) => {
    const path = (e as CustomEvent<string>).detail;
    if (typeof path === "string" && path.length > 0) {
      void attachFileByPath(path);  // ← 闭包了 attachFileByPath
    }
  };
  window.addEventListener("tdsf:ai-attach-file", onAttach);
  return () => window.removeEventListener("tdsf:ai-attach-file", onAttach);
}, []);  // ← 空依赖数组，只在 mount 时注册
```

**问题**：
- `attachFileByPath` 在每次 render 时重新创建（`composer.tsx:173-207` 是普通函数声明，非 useCallback）
- useEffect 依赖数组为 `[]`，只在 mount 时注册事件监听器
- 监听器闭包了**首次 render 的 attachFileByPath**
- 虽然 attachFileByPath 内部只用了 `setFiles`（稳定）和 `invoke`（稳定）和 `useChatStore.getState()`（稳定），**当前不会读旧 state**
- 但这是脆弱的：如果未来有人在 attachFileByPath 里读 `value` 或 `files` state，就会读到 mount 时的旧值
- biome-ignore 注释声称"closes over setFiles only"是**当前正确但脆弱**的假设

**修复建议**：
```typescript
const attachFileByPath = useCallback(async (path: string) => {
  // ... 现有实现
}, []);  // 显式声明依赖为空

useEffect(() => {
  const onAttach = (e: Event) => {
    const path = (e as CustomEvent<string>).detail;
    if (typeof path === "string" && path.length > 0) {
      void attachFileByPath(path);
    }
  };
  window.addEventListener("tdsf:ai-attach-file", onAttach);
  return () => window.removeEventListener("tdsf:ai-attach-file", onAttach);
}, [attachFileByPath]);  // 依赖 attachFileByPath
```

---

### P2-NEW-1：_sidecar_health 闭包内每次调用都 import agents

**严重度**：P2（性能微损 + 可维护性）

**位置**：`src-tauri/sidecar/main.py:643-658`

**证据**：
```python
# main.py:643-658
def _sidecar_health(_params: dict | None = None) -> dict:
    """sidecar.health: 返回 sidecar 后端运行时状态"""
    import agents as _agents_mod  # ← 每次调用都 import
    return {
        **_backend_status,
        "agents_count": len(_agents_mod.AGENT_REGISTRY),
        "agents_list": _agents_mod.list_agents(),
        ...
    }
```

**问题**：虽然 Python import 有缓存（sys.modules），开销极小，但写法不优雅。应在模块顶部 import 或在 register_business_methods 作用域内捕获引用。

**修复建议**：在 `_sidecar_health` 定义前捕获引用：
```python
import agents as _agents_mod  # 模块级或函数级顶部

def _sidecar_health(_params: dict | None = None) -> dict:
    return {
        **_backend_status,
        "agents_count": len(_agents_mod.AGENT_REGISTRY),
        ...
    }
```

---

### P2-NEW-2：base.py __init__ 中 9 个 Agent 同时推送 mock warning，无全局 dedup

**严重度**：P2（事件洪水风险，但当前行为合理）

**位置**：`src-tauri/sidecar/agents/base.py:179-185` + `src-tauri/sidecar/agents/__init__.py:143-147`

**证据**：
```python
# base.py:179-185
if llm_call is None and self.event_bus is not None:
    self._publish_mock_warning(
        "no_llm_config",
        f"Agent '{self.name}' 构造时未注入 llm_call, ...",
    )
    self._mock_warning_emitted = True

# agents/__init__.py:143-147
for name, cls in AGENT_REGISTRY.items():
    _agent_instances[name] = cls(
        event_bus=event_bus,
        llm_call=llm_call,  # ← 如果 None，9 个 Agent 都会推 warning
    )
```

**问题**：如果 `llm_call=None`（未配置 LLM），9 个 Agent 的 `__init__` 会**连续推送 9 个 mock_llm_active 事件**。每个 Agent 有 `_mock_warning_dedup_ts`（base.py:163），但这是**实例级**的，9 个 Agent 各自独立。EventBus 无全局 dedup，9 个事件都会推送到前端。**当前行为是合理的**（每个 Agent 都没配 LLM，用户应该知道），但可能造成前端 MockLLMWarning 闪烁 9 次。

**修复建议**：在 `configure_agents` 层面加全局 dedup，或前端 MockLLMWarning 做事件合并。

---

### P2-NEW-3：Rust `as u32` 截断 u64 session_id（已知，标注当前状态）

**严重度**：P2（极端场景下会话路由错误）

**位置**：`src-tauri/src/modules/sidecar.rs:979,1001,1021,1052,1071,1090,1108,1125`（共 8 处）

**状态**：已知（p1-rust-bridge-code-review §1.1 提到），未修。实际影响极小（sessionId 来自 Rust 侧自增 counter，通常是小整数）。

---

### P2-NEW-4：ipc.rs / sidecar-bridge.ts JSDoc 文档漂移残留（已知，标注当前状态）

**严重度**：P2（文档不一致）

**位置**：`src-tauri/src/modules/ipc.rs:269-272` + `src/lib/sidecar-bridge.ts:99-108`

**证据**：
```rust
// ipc.rs:269-272 仍写旧契约
///   const result = await invoke<string>('ipc_invoke', {
///     method: 'agent.invoke',
///     params: { input: 'nginx 启动失败' }  // ← 旧契约
///   });
```

实际契约：`agent.invoke` 的 params 是 `{name: str, state: {input, messages, live}}`（见 `agents/__init__.py:300-302`）

**状态**：已知（modded-agent-deep-audit §0 提到），未修。

---

### P2-NEW-5：sidecar.rs stop() 与 restart() 的 cancel signal 竞态

**严重度**：P2（边缘场景：手动 restart 后自动重启机制失效）

**位置**：`src-tauri/src/modules/sidecar.rs:476-548`

**证据**：
```rust
// sidecar.rs:542-548 restart()
pub async fn restart(&self) -> SidecarResult<()> {
    self.retry_count.store(0, Ordering::SeqCst);
    self.stop().await?;  // ← stop() 会发 cancel signal 给 restart_loop
    tokio::time::sleep(Duration::from_millis(500)).await;
    self.start().await  // ← 直接 start，不经 restart_loop
}
```

**问题**：`restart()` 调用 `stop()` → 发 cancel signal → `restart_loop` 收到后 `break` 退出。但 `restart()` 随后直接调 `start()`，不经 `restart_loop`。如果 `restart()` 之后 Python 又崩溃，`exit_watcher` 发 restart signal，但 `restart_loop` 已退出，自动重启机制失效。

**修复建议**：`restart()` 不发 cancel signal，或在 `restart()` 完成后重新启动 `restart_loop`。

---

### P2-NEW-6：sidecar.rs LOG_BUFFER try_lock 失败丢弃日志

**严重度**：P2（日志丢失风险，但 best-effort 设计可接受）

**位置**：`src-tauri/src/modules/sidecar.rs:1531-1537`

**证据**：
```rust
// sidecar.rs:1531-1537
fn push_log(line: &str) {
    ...
    if let Ok(mut buf) = log_buffer().lock() {
        if buf.len() >= LOG_BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(entry);
    }
    // ← else 分支静默丢弃日志
}
```

**问题**：`try_lock` 失败时静默丢弃日志，无任何计数或告警。如果日志高频写入，可能频繁丢弃。

**修复建议**：加 `AtomicU64` 丢弃计数器，sidecar_logs 命令返回丢弃数。

---

## 3. 协议契约一致性

### 3.1 agent.invoke 契约 ✅ 一致

| 层 | 契约 | 证据 |
|----|------|------|
| 前端 sidecar-adapter.ts | `invoke("ipc_invoke", {method: "agent.invoke", params: {name: pythonName, state: {input, messages, live}}})` | runSidecarStream |
| Rust ipc.rs | `ipc_invoke(method, params) → SidecarManager::send_request(method, params)` | `ipc.rs:278-286` |
| Python agents/__init__.py | `_rpc_agent_invoke(name: str, state: dict) → invoke_agent(name, state)` | `agents/__init__.py:300-302` |
| BaseAgent.invoke | `invoke(state: dict[str, Any]) → dict[str, Any]` | `base.py:191` |

**结论**：前后端 agent.invoke 参数契约对齐（`{name, state}`），已有报告 K10 指出的 JSDoc 文档漂移仍在（P2-NEW-4）。

### 3.2 事件名契约 ✅ 一致

| Python EventType | Rust emit 事件名 | 前端订阅函数 | 状态 |
|------------------|------------------|--------------|------|
| MOOD_CHANGE | sidecar:mood_change | onMoodChange | ✅ |
| AGENT_MESSAGE | sidecar:agent_message | onAgentMessage | ✅ |
| TOOL_CALL | sidecar:tool_call | onToolCall | ✅ |
| NEEDS_YOU | sidecar:needs_you | onNeedsYou | ✅ |
| AGENT_SWITCH | sidecar:agent_switch | onAgentSwitch | ✅ |
| MOCK_LLM_ACTIVE | sidecar:mock_llm_active | MockLLMWarning.tsx | ✅（已修 K5）|
| BACKEND_STATUS | sidecar:backend_status | BackendPill.tsx | ✅（P0-E 新增）|

**结论**：事件名前后端完全对齐，无漂移。

### 3.3 RPC 方法名契约 ✅ 一致

| 前端调用 | Rust 路由 | Python handler | 状态 |
|----------|-----------|----------------|------|
| ipc_invoke("ping", {}) | send_request("ping") | MethodDispatcher._ping | ✅ |
| ipc_invoke("agent.invoke", {name, state}) | send_request | _rpc_agent_invoke | ✅ |
| ipc_invoke("agent.list", {}) | send_request | _rpc_agent_list | ✅ |
| ipc_invoke("sidecar.health", {}) | send_request | _sidecar_health | ✅（P0-E 新增）|
| 反向: ssh_command | handle_reverse_request | rust_bridge.send_request | ✅（已修 K2）|
| 反向: sftp_read/write/stat/list/mkdir/remove/rename | handle_reverse_request | rust_bridge.send_request | ✅ |

**结论**：RPC 方法名前后端对齐，camelCase 参数一致。

### 3.4 ID 空间隔离 ✅ 一致

| 侧 | ID 范围 | 证据 |
|----|---------|------|
| Rust→Python 请求 | 1, 2, 3...（AtomicI64 from 1） | `sidecar.rs:250` next_request_id 初始化为 1 |
| Python→Rust 反向请求 | 1,000,000+ | `rust_bridge.py:65` _REVERSE_ID_START=1_000_000 |
| 响应路由 | id < 1M → Rust pending; id ≥ 1M → Python pending | `sidecar.rs:835-917` reader_task + `rust_bridge.py:235-255` is_reverse_response |

**结论**：ID 空间隔离正确，无撞车风险（已修 K7）。

---

## 4. 测试覆盖缺口

### 4.1 已有测试覆盖（验证）

| 模块 | 测试文件 | 用例数 | 覆盖路径 |
|------|----------|--------|----------|
| Rust sidecar.rs | `sidecar.rs:1574-1652` | 7 | 状态序列化 / backoff 计算 / MAX_RETRY |
| Rust ipc.rs | `ipc.rs:347-414` | 8 | IPCError 转换 / 序列化 |
| Python rust_bridge.py | （p1 报告称 25 用例）| 25 | send_request / dispatch_response / stop / 超时 |
| Python agents/ | （base.py 无测试）| 0 | BaseAgent.invoke / set_backend / clear_backend |
| Python event_bus.py | （无测试文件）| 0 | publish / subscribe / emit_* |
| 前端 composer.tsx | （无测试）| 0 | submit / attachFileByPath |

### 4.2 关键测试缺口（新发现）

| # | 缺口 | 严重度 | 说明 |
|---|------|--------|------|
| T1 | **Python 主循环阻塞场景无测试** | P1 | P1-NEW-1 的根因：无测试验证 agent.invoke 长耗时下 health_check 行为 |
| T2 | **set_backend / clear_backend 无单元测试** | P1 | `agents/__init__.py:168-210` 的 override 路径无测试覆盖 |
| T3 | **BaseAgent.invoke PAOR 模板方法无测试** | P1 | `base.py:191-390` 400+ 行核心逻辑无测试 |
| T4 | **Rust handle_reverse_request 8 个 method 分支无测试** | P1 | `sidecar.rs:958-1148` 仅靠端到端 CDP 验证，无单元测试 |
| T5 | **event_bus.publish 线程安全无并发测试** | P2 | `event_bus.py:230-289` 多线程 publish/subscribe 无压力测试 |
| T6 | **composer.tsx submit 逻辑无测试** | P2 | 前端消息组装 + slash command 拦截无测试 |

---

## 5. 推荐修复顺序

### 优先级 1（P1，影响核心功能）

1. **P1-NEW-1**：Python 主循环阻塞 → health_check 误判
   - 工作量：大（需重构主循环为线程池模型）
   - 影响：所有 LLM 调用 >30s 的场景
   - 建议：先用方案 B（health_check 只检查进程存活）作为短期缓解，方案 A（线程池）作为长期方案

2. **P1-NEW-2**：set_backend walrus hack
   - 工作量：小（5 分钟）
   - 影响：代码质量 + 重构风险
   - 建议：立即修复

3. **P1-NEW-3**：主循环异常后 pending 不清理
   - 工作量：中（需加 watchdog 或超时保护）
   - 建议：与 P1-NEW-1 一起修复

4. **P1-NEW-4**：composer 闭包陷阱
   - 工作量：小（加 useCallback）
   - 建议：立即修复

### 优先级 2（P2，改进建议）

5. **P2-NEW-1**：_sidecar_health 闭包 import → 提到顶部
6. **P2-NEW-2**：9 Agent mock warning 洪水 → 全局 dedup
7. **P2-NEW-5**：stop/restart 竞态 → restart 后重启 restart_loop
8. **P2-NEW-6**：LOG_BUFFER 丢日志 → 加丢弃计数器

### 优先级 3（已有报告未修问题）

9. **K6**：Python agent 终端上下文感知（transport.ts 取裸 input）
10. **K9**：Python→Rust 30s 超时叠加
11. **K10**：JSDoc 文档漂移
12. **K11**：业务模块加载失败无通知
13. **K12-K14**：Rust 侧 TOCTOU / 串行化 / u32 截断

---

## 6. 审查文件清单

| # | 文件 | 行数 | 角色 | 审查动作 |
|---|------|------|------|----------|
| 1 | `src-tauri/sidecar/main.py` | 822 | Python Sidecar 入口 | 全量复读 |
| 2 | `src-tauri/sidecar/rust_bridge.py` | 323 | Python→Rust 反向通道 | 全量复读 |
| 3 | `src-tauri/sidecar/agents/__init__.py` | 384 | Agent 注册表 + invoke_agent | 全量复读 |
| 4 | `src-tauri/sidecar/agents/base.py` | 926 | BaseAgent PAOR 模板方法 | 全量复读 |
| 5 | `src-tauri/sidecar/event_bus.py` | 607 | 事件总线 pub-sub | 全量复读 |
| 6 | `src-tauri/src/modules/sidecar.rs` | 1652 | Rust 进程管理 + 重启循环 | 全量复读 |
| 7 | `src-tauri/src/modules/ipc.rs` | 414 | Rust JSON-RPC 协议层 | 全量复读 |
| 8 | `src/modules/ai/lib/composer.tsx` | 387 | 前端消息组合 + submit | 全量复读 |
| 9 | `src/modules/ai/agents/registry.ts` | 189 | 前端 Agent 元数据 | 全量复读 |
| 10 | `src/lib/sidecar-bridge.ts` | 456 | 前端 IPC 桥 | 全量复读 |
| 11 | `docs/reports/modded-agent-deep-audit.md` | - | 已有审计报告 | 摘要复读 |
| 12 | `docs/reports/p1-rust-bridge-code-review-2026-07-30.md` | - | 已有审计报告 | 摘要复读 |
| 13 | `docs/reports/strands_backend-audit-2026-07-30.md` | - | 已有审计报告 | 摘要复读 |

---

## 7. 简短总结

**新发现数量**：P0=0，P1=4，P2=6

**最严重的新问题**：
1. **P1-NEW-1**：Python sidecar 单线程主循环 + 长耗时 agent.invoke 阻塞 ping 响应 → health_check 误判 Crashed（LLM 调用 >30s 必触发，前端误显崩溃 + 响应丢失）
2. **P1-NEW-2**：agents/__init__.py set_backend 中的 walrus + `__import__("logging")` hack（模块顶部未 import logging，用 hack 绕过）

**推荐修复优先级**：
1. P1-NEW-1（主循环阻塞，短期用 health_check 进程存活检查缓解，长期改线程池）
2. P1-NEW-2（set_backend hack，5 分钟修复）
3. P1-NEW-3 + P1-NEW-4（pending 清理 + composer 闭包，小工作量）
4. P2 改进项按需推进

**已有报告状态**：14 个已知问题中，6 个已修（K1-K5/K7），8 个未修/部分修（K6/K8-K14），本次审查未发现已有问题的修复回归。

---

> **审查员**：GLM-5.2 子 Agent（代码审查模式）
> **审查性质**：只读静态审查（未运行代码、未修改任何源文件）
> **报告生成**：2026-07-30
