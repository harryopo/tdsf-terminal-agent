# TDSF Terminal Agent 魔改 Agent 代码审查报告 v2

> **审查时间**：2026-07-30
> **审查范围**：在 v1 基础上深入审查三大魔改模块——(1) Python sidecar 适配层（线程安全 / 锁 / 异常 / 资源泄漏 / `_global_backend_override` 单写者）；(2) SSH 终端深度集成（useEffect 依赖 / ref vs state / 内存泄漏 / 竞态）；(3) Strands 后端可观测性（事件订阅时序 / 状态机 / 错误恢复）
> **审查方法**：全量复读 9 个核心源文件，交叉验证前后端协议契约，对照 CLAUDE.md §3 防污染红线逐条核查
> **审查约束**：未修改任何源代码，仅产出本报告；不重复 v1 已发现的 P1-NEW-1/2/4（已修复）；不审查测试文件 / CDP 脚本 / 文档
> **严重度定义**：P0=阻塞/数据丢失/安全漏洞；P1=功能错误/性能问题/资源泄漏；P2=改进建议

---

## 0. 执行摘要

本次 v2 审查在 v1 基础上深入三大模块的并发与时序边界，新发现 **0 个 P0**、**6 个 P1**、**9 个 P2** 问题，重点覆盖 v1 未触及的 **Strands 适配层缓存竞态**、**fix-loop 在 override 路径下失效**、**前端 subscribe Promise 竞态泄漏**、**测试隔离断裂**、**Strands 注入失败后状态机不一致**、**线程池退出无超时保护** 等深度问题。

### 0.1 新发现问题数量（v2 增量，不含 v1 已报）

| 严重度 | 数量 | 说明 |
|--------|------|------|
| P0 | 0 | 无阻断级新问题 |
| P1 | 6 | Strands 缓存 session 串台 / fix-loop 在 override 路径失效 / reset_for_test 不清 override / BackendPill subscribe 泄漏 / Strands 注入失败 backend_type 未重置 / 线程池 shutdown 无超时 |
| P2 | 9 | max_iterations 死代码 / 响应解析启发式误判 / 越权工具不拦截 / dedup_ts 死代码+llm_call_failed 无 dedup / render 写 ref / module Map 无锁 / setStatus 无浅比 / sidecar.health 闭包 import（v1 未修标注）/ _sidecar_health import 未捕获 ImportError |

### 0.2 最严重的新问题

1. **P1-NEW-v2-2：Strands `_agent_cache` 按 agent_id 缓存导致 session_id 串台**
   - `adapter.py:491` 缓存 key 仅 agent_id，callback_handler 与工具闭包绑定**首次** session_id
   - 第二次 invoke 同 agent_id 不同 session_id 时复用缓存，所有事件推送到错误 session
   - 前端看到"另一个会话的 Agent 输出"，且 needs_you 审批卡片路由错误

2. **P1-NEW-v2-3：Strands override 路径完全绕过 fix-loop 保护，违背 DEC-V321-11 spec**
   - `agents/__init__.py:268-273` 走 override 时直接调 `adapter.invoke`，不经过 `BaseAgent.invoke`
   - `BaseAgent._check_fix_loop`（base.py:752-904）永远不执行，`adapter.invoke` 也无 fix-loop 集成
   - Strands 后端下工具失败重试无限循环，无 max_retry=3 保护

3. **P1-NEW-v2-4：BackendPill subscribe Promise unlisten 收集竞态导致 Tauri listener 泄漏**
   - `BackendPill.tsx:199,221` `subscribe(...).then(un => unlistens.push(un))` 的 then 回调未检查 cancelled
   - 组件在 subscribe resolve 前卸载时，cleanup 跑空数组，之后 unlisten 被推入无人调用的数组
   - 每次 mount/unmount 泄漏 2 个 Tauri listener，长期累积导致重复事件回调

4. **P1-NEW-v2-5：Strands 注入失败时 `_backend_status.backend_type` 未重置为 "langgraph"**
   - `main.py:477` 设 `backend_type="strands"`，`main.py:530-541` except 分支 clear_backend 但**未重置 backend_type**
   - 前端 sidecar.health 拿到 `backend_type="strands"` + `backend_activated=false`，语义上暗示"仍是 strands 后端"但实际已回退 LangGraph
   - BackendPill 视觉因 fallback_reason 优先显示 Degraded（视觉正确），但状态机不一致误导诊断

5. **P1-NEW-v2-6：`_main_executor.shutdown(wait=True)` 无超时保护，LLM 请求 hang 时 sidecar 退出卡死**
   - `main.py:879` `shutdown(wait=True, cancel_futures=True)`，`cancel_futures` 只取消排队中的 future
   - 正在执行的 agent.invoke 若 LLM HTTP 请求 hang 住（网络不通 / 服务端不响应），线程会一直阻塞
   - `wait=True` 无超时，主线程一直等，Rust 侧 SIGTERM 强杀是唯一退出方式

### 0.3 推荐修复优先级

1. **P1-NEW-v2-2**（缓存串台）→ 缓存 key 改为 `(agent_id, session_id)`，或每次 invoke 更新 handler.session_id
2. **P1-NEW-v2-3**（fix-loop 失效）→ `adapter.invoke` 内集成 `_check_fix_loop`，或 `invoke_agent` override 路径外包一层
3. **P1-NEW-v2-4**（subscribe 泄漏）→ then 回调内检查 cancelled，已卸载则立即 `un()`
4. **P1-NEW-v2-1**（测试隔离）→ `reset_for_test` 加 `_global_backend_override = None`
5. **P1-NEW-v2-5**（状态机不一致）→ except 分支补 `_backend_status["backend_type"] = "langgraph"`
6. **P1-NEW-v2-6**（退出卡死）→ `shutdown` 加超时保护，或改用 `shutdown(wait=False)` + 强制终止

---

## 1. 已验证安全的模块（v1 未覆盖，本次确认无问题）

### 1.1 `fix_loop.py` FixLoopTracker 线程安全 ✅

**验证位置**：`src-tauri/sidecar/fix_loop.py:60-335`

**验证结论**：
- `FixLoopTracker.__init__`（line 104）创建 `self._lock = threading.RLock()`
- 所有共享状态访问（`_retries` / `_last_errors` / `_last_record_at` / `_max_retry` / `_stats`）均在 `with self._lock` 块内
- `record_retry`（line 160-216）/ `reset`（line 296-335）/ `get_stats`（line 341-393）/ `list_exhausted`（line 395-420）均持锁
- `is_exhausted`（line 249-259）调用 `get_retry_count`（持锁读 count）后比较 `self._max_retry`（无锁读），但 `int` 读在 GIL 下原子，`set_max_retry` 写也持锁，TOCTOU 窗口仅影响"刚好在 set_max_retry 那一刻的判定"，可接受
- 全局单例 `get_global_tracker`（line 536-549）用双重检查锁正确实现

**唯一瑕疵**（P2，不单列条目）：`max_retry` property（line 135-138）无锁读 `self._max_retry`，与 `set_max_retry` 的持锁写存在理论 TOCTOU。实际影响极小（int 原子 + 配置变更低频）。

### 1.2 `rust_bridge.py` RustBridge 线程安全 ✅

**验证位置**：`src-tauri/sidecar/rust_bridge.py:130-323`

**验证结论**：
- `_pending` 字典受 `self._lock`（threading.Lock）保护
- `_next_id` 受 `self._id_lock` 独立保护（避免 ID 分配与 pending 操作互相阻塞）
- `send_request`（line 164-233）/ `dispatch_response`（line 257-301）/ `stop`（line 303-314）/ `pending_count`（line 316-319）均正确持锁
- `stop()` 唤醒所有 pending entry 的 event，避免主线程退出时悬挂（line 311-314）
- 超时清理在 `send_request` 内 lazy 执行（line 213-215），无独立清理线程需求

### 1.3 `sidecar-bridge.ts` subscribe 前缀契约 ✅

**验证位置**：`src/lib/sidecar-bridge.ts:221-235`

**验证结论**：
- `subscribe(eventName, cb)` 自动补 `sidecar:` 前缀（line 231-233）
- `subscribe("ready", ...)` → `listen("sidecar:ready", ...)`
- `subscribe("backend_status", ...)` → `listen("sidecar:backend_status", ...)`
- BackendPill 的事件名调用正确，无前缀缺失问题（v1 审查时曾怀疑，本次确认安全）

---

## 2. 新发现问题（v2 增量，按严重度排序）

### P1-NEW-v2-1：`reset_for_test()` 不清理 `_global_backend_override`，测试隔离断裂

**严重度**：P1（测试污染 + 调试困难）

**位置**：`src-tauri/sidecar/agents/__init__.py:278-283`

**证据**：
```python
# agents/__init__.py:278-283
def reset_for_test() -> None:
    """重置全局状态（测试隔离用）"""
    global _global_event_bus, _global_llm_call
    _global_event_bus = None
    _global_llm_call = None
    _agent_instances.clear()
    # ← 缺少 _global_backend_override = None
```

**根因**：
- `reset_for_test` 清理了 `_global_event_bus` / `_global_llm_call` / `_agent_instances`，但**遗漏了 `_global_backend_override`**
- 如果测试 A 调用 `set_backend(mock_backend)`，测试 A 结束后调 `reset_for_test()`
- 测试 B 调用 `invoke_agent("main", state)`（line 268-275），由于 `_global_backend_override` 仍指向测试 A 的 mock_backend，**测试 B 实际执行的是测试 A 的 mock**
- 测试 B 的断言基于 BaseAgent PAOR 路径，但实际走 override 路径，导致**测试假阳性或假阴性**

**影响**：
- 任何使用 `set_backend` 的测试（如 Strands 适配层测试）若不手动 `clear_backend`，会污染后续所有 `invoke_agent` 测试
- `pytest -p no:randomly` 顺序运行时可能不暴露（测试 A 的 mock 恰好兼容测试 B），`pytest-randomly` 随机顺序下必现

**修复建议**：
```python
def reset_for_test() -> None:
    """重置全局状态（测试隔离用）"""
    global _global_event_bus, _global_llm_call, _global_backend_override
    _global_event_bus = None
    _global_llm_call = None
    _global_backend_override = None  # ← 补这行
    _agent_instances.clear()
```

**验证方法**：
```bash
# 在 test_strands_backend.py 中加一个测试：
# 1. set_backend(mock_fn)
# 2. reset_for_test()
# 3. 断言 invoke_agent 走 BaseAgent 路径（mock_fn 不应被调用）
# 4. 用 pytest-randomly 跑全量 100 次，无污染
pytest src-tauri/sidecar/tests/ -p randomly --randomly-seed=0 -k "test_reset_clears_override"
```

---

### P1-NEW-v2-2：Strands `_agent_cache` 按 agent_id 缓存导致 session_id 串台

**严重度**：P1（功能错误：事件路由错误 + needs_you 审批卡片错会话）

**位置**：`src-tauri/sidecar/strands_backend/adapter.py:481-528`

**证据**：
```python
# adapter.py:481-528
def _get_or_create_agent(self, agent_id: str, ctx: ToolContext) -> Any:
    if agent_id in self._agent_cache:        # ← 缓存 key 仅 agent_id
        return self._agent_cache[agent_id]   # ← 命中缓存，复用旧 Agent

    # ... 首次创建：
    handler = TdsfStrandsCallbackHandler(
        event_bus=self.event_bus,
        agent_name=agent_id,
        session_id=ctx.session_id,           # ← 绑定首次 session_id
    )
    agent = _StrandsAgent(
        model=self.strands_model,
        tools=all_tools,                     # ← 工具闭包绑定首次 ctx
        system_prompt=self.system_prompt,
        callback_handler=handler,            # ← handler 绑定首次 session_id
    )
    self._agent_cache[agent_id] = agent      # ← 缓存 key = agent_id
    return agent
```

**问题链推演**：
1. 会话 A（session_id="sess-A"）调用 `invoke("main", "检查 nginx", state={session_id:"sess-A",...})`
2. `_get_or_create_agent("main", ctx_A)` 未命中缓存，创建 Strands Agent，callback_handler 绑定 `session_id="sess-A"`，工具闭包绑定 `ctx_A.session_id="sess-A"`
3. Agent 执行，事件（mood_change / agent_message / tool_call）全部推送 `session_id="sess-A"` ✅
4. 会话 B（session_id="sess-B"）调用 `invoke("main", "查看日志", state={session_id:"sess-B",...})`
5. `_get_or_create_agent("main", ctx_B)` **命中缓存**（key="main"），返回旧 Agent
6. 旧 Agent 的 callback_handler 仍持 `session_id="sess-A"`
7. 旧 Agent 的工具闭包仍持 `ctx_A.session_id="sess-A"`
8. Strands 执行，所有事件推送 `session_id="sess-A"` ❌ —— **会话 B 的 Agent 输出推到了会话 A**
9. 工具内 `RiskChecker.emit_needs_you`（tools/__init__.py:288-337）用 `ctx.session_id="sess-A"`，**审批卡片路由到会话 A**

**影响**：
- 多会话并发时（前端开两个 Chat 会话），第二个会话的 Agent 输出全部显示在第一个会话里
- 高危命令审批卡片推到错误会话，用户可能在错误的会话上下文里批准命令
- 工具执行的 `emit_needs_you` / `emit_tool_call` 事件 source 标记错误，调试困难

**根因**：
- 缓存 key 设计错误：Strands Agent 实例绑定了 session 级的 callback_handler 和 ToolContext，但缓存 key 仅用 agent_id
- `clear_cache()`（line 764-768）存在但仅在配置变更时手动调用，不会在会话切换时触发

**修复建议**：
方案 A（推荐，最小改动）——缓存 key 改为 `(agent_id, session_id)`：
```python
def _get_or_create_agent(self, agent_id: str, ctx: ToolContext) -> Any:
    cache_key = (agent_id, ctx.session_id)  # ← 二元 key
    if cache_key in self._agent_cache:
        return self._agent_cache[cache_key]
    # ... 创建逻辑不变
    self._agent_cache[cache_key] = agent
    return agent
```
副作用：缓存条目数 = agent 数 × session 数。考虑到 agent 通常 1-2 个、session 并发数通常 <10，缓存规模可接受。

方案 B——每次 invoke 更新 handler.session_id 和 ctx（侵入式，需 Strands Agent 支持热更 callback_handler，不推荐）：
```python
def invoke(self, agent_id, input, state):
    # ... 获取缓存 agent 后：
    if hasattr(agent, 'callback_handler') and agent.callback_handler:
        agent.callback_handler.session_id = session_id  # 热更
    # 工具闭包的 ctx 无法热更（闭包已绑定），仍需重建
```

**验证方法**：
```python
# 单元测试：
def test_cache_isolation_per_session():
    adapter = StrandsAgentAdapter(event_bus=mock_bus, rust_bridge=..., backend_enabled=True, strands_model=mock_model)
    # 第一次 invoke session-A
    adapter.invoke("main", "test", state={"session_id": "sess-A"})
    assert mock_bus.captured_session_ids[-1] == "sess-A"
    # 第二次 invoke session-B
    adapter.invoke("main", "test", state={"session_id": "sess-B"})
    assert mock_bus.captured_session_ids[-1] == "sess-B"  # ← 当前会失败，实际是 sess-A
```

---

### P1-NEW-v2-3：Strands override 路径完全绕过 fix-loop 保护，违背 DEC-V321-11 spec

**严重度**：P1（功能缺失：安全护栏失效 + 无限重试循环风险）

**位置**：
- `src-tauri/sidecar/agents/__init__.py:268-275`（override 路径，跳过 BaseAgent.invoke）
- `src-tauri/sidecar/strands_backend/adapter.py:277-403`（adapter.invoke 无 fix-loop 集成）
- `src-tauri/sidecar/agents/base.py:752-904`（BaseAgent._check_fix_loop 仅在 BaseAgent.invoke 内调用）

**证据 - override 路径跳过 fix-loop**：
```python
# agents/__init__.py:268-275
def invoke_agent(name: str, state: dict[str, Any]) -> dict[str, Any]:
    if _global_backend_override is not None:
        return _global_backend_override(   # ← 直接调 adapter.invoke，不经过 BaseAgent.invoke
            agent_id=name,
            input=state.get("input", ""),
            state=state,
        )
    agent = get_agent(name)
    return agent.invoke(state)  # ← 仅 LangGraph 路径才走 BaseAgent.invoke（含 _check_fix_loop）
```

**证据 - adapter.invoke 无 fix-loop 集成**：
```python
# adapter.py:277-403
def invoke(self, agent_id, input, state):
    # ... 降级检查 / mood 推送 / 创建 Agent / 调用 Strands
    response = strands_agent(prompt)  # ← Strands agentic loop，工具失败会自动重试
    observation = self._extract_response_text(response)
    # ... 返回结果
    # ← 全程无 _check_fix_loop 调用，无 record_retry / is_exhausted 判定
```

**证据 - BaseAgent._check_fix_loop 仅在 BaseAgent.invoke 内**：
```python
# base.py:285-304（在 BaseAgent.invoke 模板方法内）
fix_loop_info = self._check_fix_loop(
    session_id=session_id,
    current_task=current_task,
    tool_call_result=tool_call_result,
    next_step=next_step,
)
if fix_loop_info["exhausted"]:
    next_step = "error"  # ← 强制停手
```

**问题链推演**：
1. `TDSF_AGENT_BACKEND=strands` 启动，`set_backend(adapter.invoke)` 注入 override
2. 前端调 `agent.invoke`，`invoke_agent` 走 override 路径（line 268-273）
3. `adapter.invoke` 调 `strands_agent(prompt)`，Strands agentic loop 内部执行工具
4. 工具失败（如 `ssh_command` 超时），Strands 自动重试（retry within agentic loop）
5. **无 max_retry=3 保护**：Strands 的重试由其内部 LLM 决定，可能无限重试同一失败命令
6. `BaseAgent._check_fix_loop` 永远不执行（因为没走 BaseAgent.invoke）
7. `fix_loop.record_retry` 不被调用，`is_exhausted` 永远 False
8. `needs_you.notify_fix_loop_exhausted` 不触发，用户不被通知
9. **违背 DEC-V321-11 spec**（"同一操作 max_retry=3，超限强制停手 + needs-you 通知"）

**影响**：
- Strands 后端下，工具失败（如 SSH 命令超时 / SFTP 读取失败）会被 Strands LLM 无限重试，消耗 token + CPU
- 高危命令审批被拒后，Strands 可能"换种方式"重试（LLM 改写命令绕过审批），安全护栏失效
- fix-loop 统计（`fix_loop.stats` JSON-RPC）在 Strands 模式下全是 0，误导诊断

**根因**：
- Strands 适配层设计时未集成 fix-loop（adapter.py docstring 未提及 fix-loop）
- `invoke_agent` override 路径直接转发，未在转发层包 fix-loop 检查

**修复建议**：
方案 A（推荐）——在 `adapter.invoke` 内集成 fix-loop 检查：
```python
# adapter.py invoke 方法内，在 strands_agent(prompt) 调用后、返回前：
from fix_loop import build_operation_key, get_global_tracker

# 对每个工具调用结果做 fix-loop 检查
# 需要在 TdsfStrandsCallbackHandler 内捕获工具完成事件，记录 success/failure
# 然后在 invoke 末尾检查 is_exhausted，若超限则中断 Strands loop
```
注：Strands agentic loop 是同步阻塞的（`strands_agent(prompt)` 一次性执行完所有迭代），无法中途中断。需改用 Strands 的 `stream_async` + hook 机制（如 `LimitToolCounts`）在工具调用前检查 fix-loop。

方案 B（侵入式低）——在 `invoke_agent` override 路径外包一层超时 + 重试计数：
```python
# agents/__init__.py invoke_agent
if _global_backend_override is not None:
    # 包一层 fix-loop：对 override 调用本身计为一次"操作"
    from fix_loop import build_operation_key, get_global_tracker
    tracker = get_global_tracker()
    op_key = build_operation_key(state.get("input", ""), "strands_invoke")
    if tracker.is_exhausted(session_id, op_key):
        # 超限，强制返回 error
        return {"next_step": "error", "error": "fix-loop exhausted", ...}
    try:
        result = _global_backend_override(agent_id=name, input=..., state=state)
        tracker.reset(session_id, op_key)  # 成功则重置
        return result
    except Exception:
        tracker.record_retry(session_id, op_key, error=str(e))
        raise
```
局限：只对"整个 invoke 调用"计重试，无法感知 Strands 内部的工具级重试。

方案 C（最佳，需 Strands 支持）——用 Strands `HookProvider` 在每次工具调用前检查 fix-loop：
```python
from strands.hooks import HookProvider, HookContext

class FixLoopHook(HookProvider):
    def before_tool_call(self, context: HookContext):
        tracker = get_global_tracker()
        op_key = build_operation_key(context.task, context.tool_name)
        if tracker.is_exhausted(context.session_id, op_key):
            raise FixLoopExhausted("max_retry exceeded")  # 中断 Strands loop
```

**验证方法**：
```bash
# 1. 启动 Strands 后端：TDSF_AGENT_BACKEND=strands pnpm tauri:dev
# 2. 触发一个必然失败的工具调用（如 ssh_command 到一个不存在的 session）
# 3. 观察 fix_loop.stats RPC 返回：当前应有 retry_count 记录
# 4. 重复 3 次，第 4 次应被 fix-loop 拦截（返回 error + needs_you 通知）
invokeRpc("fix_loop.stats", {})
```

---

### P1-NEW-v2-4：BackendPill subscribe Promise unlisten 收集竞态导致 Tauri listener 泄漏

**严重度**：P1（资源泄漏 + 重复事件回调）

**位置**：`src/modules/ai/components/BackendPill.tsx:197-226`

**证据**：
```typescript
// BackendPill.tsx:168-227
useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    const fetchHealth = async () => {
      if (cancelled) return;  // ← fetchHealth 内部检查 cancelled ✅
      // ...
    };

    void fetchHealth();

    // 问题：subscribe 返回 Promise，then 回调未检查 cancelled
    subscribe("ready", () => {
      void fetchHealth();  // ← fetchHealth 内部检查 cancelled ✅
    }).then((un) => unlistens.push(un));  // ← then 回调未检查 cancelled ❌

    subscribe("backend_status", (payload) => {
      if (cancelled) return;  // ← 事件回调检查 cancelled ✅
      // ...
    }).then((un) => unlistens.push(un));  // ← then 回调未检查 cancelled ❌

    return () => {
      cancelled = true;
      unlistens.forEach((un) => un());  // ← 卸载时调 unlisten
    };
  }, []);
```

**问题链推演**：
1. BackendPill 挂载，`subscribe("ready", ...)` 调用，返回 Promise（Tauri `listen` 是异步的，需注册到 Rust 侧）
2. **组件在 Promise resolve 前卸载**（如快速 tab 切换、条件渲染闪烁）
3. cleanup 函数运行：`cancelled = true`，`unlistens.forEach(un => un())` —— **但 unlistens 为空**（Promise 未 resolve，then 未执行）
4. Promise resolve，`.then((un) => unlistens.push(un))` 执行 —— **un 被推入数组，但 cleanup 已跑完**
5. `un`（Tauri UnlistenFn）永远不被调用 —— **Tauri listener 泄漏**
6. 下次 BackendPill 挂载，又注册 2 个新 listener
7. 每次 mount/unmount 泄漏 2 个 listener，累积后 `sidecar:backend_status` 事件触发 N 个回调（N = 泄漏次数 + 1）

**影响**：
- 长时间运行 + 频繁 tab 切换：Tauri event listener 累积，内存增长
- 泄漏的 listener 仍在响应该事件，但 `cancelled=true` 使其 no-op（事件回调内 `if (cancelled) return`），**但 listener 本身占内存 + Tauri 侧 dispatch 开销**
- 极端情况：100 次挂载 = 200 个泄漏 listener，每次 backend_status 事件触发 200 次回调（199 个 no-op + 1 个有效），CPU 微损

**根因**：
- `subscribe` 返回 `Promise<UnlistenFn>`，但 cleanup 是同步的，无法 await Promise
- then 回调未检查 `cancelled` 标志，导致卸载后仍 push unlisten

**修复建议**：
```typescript
subscribe("ready", () => {
  void fetchHealth();
}).then((un) => {
  if (cancelled) {
    un();  // 已卸载，立即取消订阅
  } else {
    unlistens.push(un);
  }
});

subscribe("backend_status", (payload) => {
  if (cancelled) return;
  // ...
}).then((un) => {
  if (cancelled) {
    un();
  } else {
    unlistens.push(un);
  }
});
```

**验证方法**：
```bash
# 1. 在 BackendPill 外包一个快速 mount/unmount 循环：
#    for (let i = 0; i < 100; i++) { render(<BackendPill/>); unmount(); }
# 2. 调 Tauri 侧 event.listenerCount("sidecar:backend_status")（需 Rust 侧暴露诊断命令）
# 3. 修复前：listenerCount ≈ 200；修复后：listenerCount = 0
```

---

### P2-NEW-v2-1：Strands `max_iterations` 字段保留但从未生效（死代码）

**严重度**：P2（诊断误导 + 死代码）

**位置**：`src-tauri/sidecar/strands_backend/adapter.py:256,520,778`

**证据**：
```python
# adapter.py:248-256
def __init__(self, ..., max_iterations: int = 10, ...):
    self.max_iterations = max_iterations  # ← 字段保留

# adapter.py:515-521（实际创建 Strands Agent）
agent = _StrandsAgent(
    model=self.strands_model,
    tools=all_tools,
    system_prompt=self.system_prompt,
    callback_handler=handler,
    # max_iterations=self.max_iterations,  # ← Strands 1.50.2 已移除，注释掉
)

# adapter.py:770-780（get_stats 仍报告该字段）
def get_stats(self) -> dict[str, Any]:
    return {
        ...
        "max_iterations": self.max_iterations,  # ← 误导：报告一个不生效的值
        ...
    }
```

**问题**：
- `max_iterations` 构造参数 + 实例字段 + get_stats 报告，但实际创建 Strands Agent 时已注释掉（Strands 1.50.2 移除）
- 调用方看到 `get_stats().max_iterations=10` 会误以为"Strands 最多迭代 10 次"，实际无限制
- Strands agentic loop 无迭代上限，工具失败时 LLM 可能无限重试（与 P1-NEW-v2-3 叠加）

**修复建议**：
- 短期：get_stats 返回 `"max_iterations": None` 或 `"max_iterations": "unlimited (Strands 1.50.2 removed param)"`，避免误导
- 长期：用 Strands `LimitToolCounts` hook 实现总工具调用次数限制（adapter.py:510-514 注释已提及此方案）

**验证方法**：
```bash
invokeRpc("sidecar.health", {}).then(s => console.log(s))  # 检查 max_iterations 字段
```

---

### P2-NEW-v2-2：`_extract_response_text` 的 `not text.startswith("<")` 启发式误判 XML/HTML 文本

**严重度**：P2（功能错误：LLM 返回 XML/HTML 时文本被丢弃）

**位置**：`src-tauri/sidecar/strands_backend/adapter.py:600-638`

**证据**：
```python
# adapter.py:607-615
@staticmethod
def _extract_response_text(response: Any) -> str:
    if response is None:
        return ""
    # 优先 str(response)
    try:
        text = str(response)
        if text and not text.startswith("<"):  # ← 启发式：以 < 开头就丢弃
            return text
    except Exception:
        pass

    # 兼容字段（.text / .content / .output）
    for attr in ("text", "content", "output"):
        val = getattr(response, attr, None)
        if isinstance(val, str) and val:
            return val
    # ...
```

**问题**：
- 启发式假设"以 `<` 开头的 str(response) 是对象 repr（如 `<strands.Agent object at 0x...>`）"
- 但 LLM 完全可能返回以 `<` 开头的合法文本：
  - XML：`<result><status>ok</status></result>`
  - HTML：`<div>诊断结果...</div>`
  - Markdown 代码块：`<config>nginx.conf</config>`
  - SVG / 任何标签语言
- 命中时丢弃 str(response)，转而尝试 `.text` / `.content` / `.output`，可能拿到空字符串或错误的属性值
- 最终 fallback `return str(response)`（line 638）会兜底，但中间路径已浪费 + 可能返回非预期属性

**修复建议**：
```python
@staticmethod
def _extract_response_text(response: Any) -> str:
    if response is None:
        return ""
    # 1. 优先 message.content（Strands 1.x 标准字段）
    message = getattr(response, "message", None)
    if message is not None:
        content = getattr(message, "content", None)
        if isinstance(content, list):
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            if texts:
                return "\n".join(texts)
        elif isinstance(content, str) and content:
            return content
    # 2. 兜底 str(response)（不再做 startswith("<") 启发式）
    try:
        return str(response)
    except Exception:
        return ""
```

**验证方法**：
```python
# 单测：模拟 LLM 返回 XML
class MockResponse:
    def __str__(self):
        return "<result>ok</result>"
assert StrandsAgentAdapter._extract_response_text(MockResponse()) == "<result>ok</result>"
# 当前会失败（startswith("<" 命中，转而找 .text/.content 找不到，最终兜底 str(response) 仍返回正确值）
# 但中间路径浪费，且若 response 有 .content="" 会返回空字符串
```

---

### P2-NEW-v2-3：`call_tool` 越权工具仅 warning 不拦截，Strands 路径无 permission_check

**严重度**：P2（安全护栏缺失，但 Strands 工具集固定，风险低）

**位置**：`src-tauri/sidecar/agents/base.py:622-628`

**证据**：
```python
# base.py:609-628
def call_tool(self, name: str, params: dict[str, Any]) -> dict[str, Any]:
    # 校验工具是否在可用列表
    if name not in self.tools:
        logger.warning(
            f"agent {self.name} calling unauthorized tool: {name} "
            f"(allowed: {self.tools})"
        )
        # 仍允许调用，但记录警告（不强制拦截，由 permission_check 节点处理）
    # 继续执行 invoke_tool(name, params) ...
```

**问题**：
- 注释声称"由 permission_check 节点处理"，但 permission_check 是 LangGraph graph 节点（`graph/nodes.py`）
- Strands override 路径（`adapter.invoke`）不经过 graph 节点，**permission_check 永远不执行**
- Strands 适配层的工具通过 `make_all_ops_tools(ctx)` 创建（adapter.py:495），工具集固定为 5 个运维工具
- 但若未来扩展 `extra_tools`（adapter.py:256 构造参数），无白名单校验
- BaseAgent.call_tool 的 warning 仅记录日志，不拦截，Strands 路径下无二次校验

**影响**：
- 当前风险低（Strands 工具集固定，LLM 无法调用 self.tools 之外的工具，因 Strands Agent 只注册了 all_tools）
- 但若 extra_tools 注入未校验的工具，或 Strands LLM 通过 prompt injection 构造工具调用参数，无拦截

**修复建议**：
```python
# adapter.py invoke 内，strands_agent(prompt) 调用前：
# 已通过 make_all_ops_tools 限定工具集，无需额外白名单
# 但若未来支持 extra_tools，应在 _get_or_create_agent 内校验工具名白名单

# 或在 base.py call_tool 内，对 Strands 路径强制拦截：
if name not in self.tools:
    raise PermissionError(f"agent {self.name} cannot call tool {name}")
```
当前工具集固定，建议**保持现状 + 加注释说明 Strands 路径的工具集由 make_all_ops_tools 限定**，待 extra_tools 落地时再补白名单。

**验证方法**：静态审查 `make_all_ops_tools`（tools/__init__.py）返回的 5 个工具，确认无动态工具注入。

---

### P2-NEW-v2-4：`_mock_warning_dedup_ts` 是死代码 + `llm_call_failed` 路径无 dedup（日志洪水风险）

**严重度**：P2（死代码 + LLM 持续失败时告警洪水）

**位置**：
- `src-tauri/sidecar/agents/base.py:163-165`（`_mock_warning_dedup_ts` 初始化，但全局 grep 仅此 1 处引用，**从未被读/写**）
- `src-tauri/sidecar/agents/base.py:566-591`（`_publish_mock_warning` 实际无 dedup 逻辑）
- `src-tauri/sidecar/agents/base.py:546`（`llm_call_failed` 路径**无条件**调 `_publish_mock_warning`，无 dedup）
- `src-tauri/sidecar/agents/base.py:550-556`（`no_llm_config` 路径用 `_mock_warning_emitted` 布尔守卫，only-once 语义）

**证据 - `_mock_warning_dedup_ts` 全局仅 1 处引用（init）**：
```bash
$ grep -rn "_mock_warning_dedup_ts" src-tauri/sidecar/
base.py:163:        self._mock_warning_dedup_ts: dict[str, float] = {}   # ← 仅 init，无任何 read/write
```

**证据 - `_publish_mock_warning` 实际无 dedup 逻辑**：
```python
# base.py:566-591（实际代码，非臆想）
def _publish_mock_warning(self, reason: str, detail: str) -> None:
    logger.warning(
        f"⚠️ Mock LLM activated for agent={self.name}, reason={reason}, "
        f"detail={detail[:120]}"
    )
    if self.event_bus is not None:
        try:
            self.event_bus.emit_mock_warning(
                agent=self.name, reason=reason, detail=detail,
                source=f"{self.name}_agent",
            )
        except Exception as e:
            logger.exception(f"_publish_mock_warning: emit_mock_warning failed: {e}")
    # ← 全程无 _mock_warning_dedup_ts 读写，无 dedup
```

**证据 - 实际 dedup 机制**：
```python
# base.py:546（call_llm 内，llm_call 失败分支）
except Exception as e:
    logger.warning(f"llm_call failed, fallback to mock: {e}")
    self._publish_mock_warning("llm_call_failed", str(e))  # ← 无条件，每次失败都发

# base.py:547-556（call_llm 内，llm_call=None 分支）
else:
    if not self._mock_warning_emitted:  # ← 布尔守卫，only-once
        self._publish_mock_warning("no_llm_config", "...")
        self._mock_warning_emitted = True
```

**问题**：
1. **`_mock_warning_dedup_ts` + `_mock_warning_dedup_window` 是死代码**：init 于 line 163-165，但全局搜索仅此 1 处引用，**从未被 read/write**。注释（line 160-162）声称"60s 内不重发（持续失败时每分钟发一次）"，但该机制从未实现。
2. **`llm_call_failed` 路径无 dedup**：`call_llm` 的 except 分支（line 546）每次 LLM 失败都调 `_publish_mock_warning`，若 LLM 服务持续不可用（如网络断开），每次 invoke 都会 emit 一次告警事件，前端收到 N 次重复告警（日志洪水 + 事件洪水）。
3. **`_mock_warning_emitted` 布尔非线程安全**：`main.py:842-850` 将 `agent.invoke` 提交到 `ThreadPoolExecutor(max_workers=2)`，两个线程同时 invoke 同一 Agent 实例时，`if not self._mock_warning_emitted` 可能双双通过，emit 2 次 `no_llm_config` 告警。但布尔读写在 GIL 下原子，最坏多发 1 次，影响极小。
4. **`_stats` dict（base.py:141-147）同样无锁**：`invocations` / `tool_calls` / `llm_calls` 计数 `+=` 非原子（GIL 下 `dict[k] += 1` 是 read-modify-write，中间可被打断），并发时计数可能少加。统计不准，不影响功能。

**影响**：
- LLM 持续失败时（如 API key 失效 / 网络断开），每次 invoke 都推 `mock_llm_active` 事件，前端告警卡片可能闪烁/堆积
- 死代码误导维护者以为有 60s dedup 窗口，实际没有

**根因**：
- 历史遗留：`_mock_warning_dedup_ts` 设计了但未接线（注释描述的 60s 窗口机制从未实现）
- `_publish_mock_warning` 重构时（v2026-07-30 P1-a 修复）只修了 publish 调用方式，未补 dedup

**修复建议**：
```python
# 方案 A（推荐）——在 _publish_mock_warning 内补齐 dedup 逻辑（激活死代码）：
def _publish_mock_warning(self, reason: str, detail: str) -> None:
    now = time.time()
    # no_llm_config: only-once（进程内永不重发）
    if reason == "no_llm_config" and self._mock_warning_emitted:
        return
    # llm_call_failed: 60s 窗口 dedup（激活 _mock_warning_dedup_ts）
    if reason == "llm_call_failed":
        last_ts = self._mock_warning_dedup_ts.get(reason, 0.0)
        if now - last_ts < self._mock_warning_dedup_window:
            return
        self._mock_warning_dedup_ts[reason] = now
    logger.warning(...)
    if self.event_bus is not None:
        try:
            self.event_bus.emit_mock_warning(...)
        except Exception as e:
            logger.exception(...)
    if reason == "no_llm_config":
        self._mock_warning_emitted = True

# 方案 B（最小改动）——删除死代码 + llm_call_failed 加简单计数限流：
# 1. 删除 _mock_warning_dedup_ts / _mock_warning_dedup_window（死代码清理）
# 2. call_llm 的 except 分支加计数器，每 N 次失败才 emit 一次
```
`_stats` 计数可用 `itertools.count` 或 `threading.Lock` 保护，但考虑统计精度要求低，可接受现状。

**验证方法**：
```python
# 1. 单测：mock llm_call 抛异常，连续 invoke 10 次
#    当前：emit_mock_warning 被调 10 次（无 dedup）
#    修复后方案 A：emit_mock_warning 被调 1 次（60s 窗口）
# 2. grep 验证死代码激活：修复后 _mock_warning_dedup_ts 应有 read/write 引用
```

---

### P2-NEW-v2-5：`SshTerminalHost.tsx` 在 render 阶段写 ref（风格建议）

**严重度**：P2（React 风格 + StrictMode 潜在抖动）

**位置**：`src/modules/ssh-explorer/SshTerminalHost.tsx:63-64`

**证据**：
```typescript
// SshTerminalHost.tsx:63-64
const handleRef = useRef(session?.handle ?? null);
handleRef.current = session?.handle ?? null;  // ← render 阶段写 ref
```

**问题**：
- React 19 文档允许"render 中写 ref"用于初始化默认值，但**持续同步外部值到 ref 推荐用 useEffect**
- 当前模式：每次 render 都覆盖 handleRef.current，确保 openTransport 闭包读到最新 handle
- StrictMode 双重 render 会执行两次 `handleRef.current = ...`，值幂等无副作用，**但 React 警告 "Writing to refs during render is an escape hatch"**
- 若未来 session.handle 在 render 期间被异步更新（zustand 中间件），可能读到中间状态

**修复建议**：
```typescript
const handleRef = useRef(session?.handle ?? null);
useEffect(() => {
  handleRef.current = session?.handle ?? null;
}, [session?.handle]);
```
权衡：useEffect 有一帧延迟，openTransport 闭包在那一帧可能读到旧 handle。当前 render 写 ref 模式实际更及时。**可接受现状，加注释说明"故意在 render 中写 ref 以同步最新 handle"**。

**验证方法**：静态审查，无需运行时验证。

---

### P2-NEW-v2-6：`sshStore.ts` module-level `terminalSubscribers` 等 Map 无锁（当前安全，未来风险）

**严重度**：P2（当前无并发，未来 Tauri 多线程 dispatch 时有风险）

**位置**：`src/modules/ssh-explorer/sshStore.ts:270-335`

**证据**：
```typescript
// sshStore.ts:274-283
const terminalSubscribers = new Map<string, Set<TerminalSubscriber>>();
const pendingBuffer = new Map<string, Uint8Array[]>();
const bufferedSize = new Map<string, number>();

// subscribeTerminalData（line 293-335）在 React 组件挂载时调用（主线程）
// emitTerminalData（line 338-388）在 sshStore.connect 的 onData 回调调用
```

**问题**：
- Tauri event listener 当前在**主线程同步执行**（WebView UI 线程），subscribeTerminalData 和 emitTerminalData 无并发
- 但 Tauri 2.x 文档未保证 event listener 永远在主线程，未来版本可能改为 Worker 线程
- 若 emitTerminalData 在 Worker 线程执行，与 subscribeTerminalData 并发读写 Map，会竞态（Map 不是线程安全的）
- 当前安全，但属于"隐式依赖 Tauri 调度模型"的脆弱点

**修复建议**：当前不修，加注释说明"依赖 Tauri event 在主线程同步执行"。若未来 Tauri 改多线程，需引入 Mutex 或改用 queue 模式。

**验证方法**：静态审查 Tauri 2.x 文档 event 调度模型。

---

### P2-NEW-v2-7：BackendPill `setStatus` 无 shallow compare，重复 payload 触发 rerender

**严重度**：P2（性能微损 + 无谓 rerender）

**位置**：`src/modules/ai/components/BackendPill.tsx:202-221`

**证据**：
```typescript
// BackendPill.tsx:202-221
subscribe("backend_status", (payload) => {
  if (cancelled) return;
  const p = payload as Partial<BackendStatus>;
  setStatus((prev) => ({                    // ← 每次都创建新对象
    backend_type: p.backend_type ?? prev?.backend_type ?? "langgraph",
    backend_activated: p.backend_activated ?? prev?.backend_activated ?? false,
    // ... 7 个字段
  }));
}).then((un) => unlistens.push(un));
```

**问题**：
- Python 侧 `send_notification("backend_status", dict(_backend_status))`（main.py:529/541/549）
- 三次推送（Strands 成功 / 失败 / langgraph 默认），每次 payload 不同 → 触发 rerender ✅ 合理
- 但若 Python 侧因故重复推送**相同** _backend_status（如 restart 后重推），前端创建新对象 → rerender
- `deriveDisplay(status)` 每次都重新计算，Tooltip 内容相同但仍 re-render

**影响**：微小（BackendPill 组件轻量，rerender 成本低）。但违反 CLAUDE.md §3 红线精神（"Context Provider value 用 useMemo"），可优化。

**修复建议**：
```typescript
setStatus((prev) => {
  const next = {
    backend_type: p.backend_type ?? prev?.backend_type ?? "langgraph",
    backend_activated: p.backend_activated ?? prev?.backend_activated ?? false,
    strands_available: p.strands_available ?? prev?.strands_available ?? false,
    rust_bridge_active: p.rust_bridge_active ?? prev?.rust_bridge_active ?? false,
    llm_configured: p.llm_configured ?? prev?.llm_configured ?? false,
    fallback_reason: p.fallback_reason ?? prev?.fallback_reason ?? null,
    activate_time: p.activate_time ?? prev?.activate_time ?? 0,
    agents_count: prev?.agents_count,
    agents_list: prev?.agents_list,
    uptime_seconds: prev?.uptime_seconds,
    python_version: prev?.python_version,
    platform: prev?.platform,
  };
  // shallow compare，字段全相同则返回 prev（避免无谓 rerender）
  if (prev && Object.keys(next).every(k => next[k] === prev[k])) {
    return prev;
  }
  return next;
});
```

**验证方法**：React DevTools Profiler 观察 BackendPill rerender 次数。

---

### P2-NEW-v2-8：`_sidecar_health` 闭包内 `import agents` 仍存在（v1 P2-NEW-1 未修，标注状态）

**严重度**：P2（v1 已报，本次标注未修状态）

**位置**：`src-tauri/sidecar/main.py:690-710`

**证据**：
```python
# main.py:696
def _sidecar_health(_params: dict | None = None) -> dict:
    import agents as _agents_mod  # ← v1 P2-NEW-1 已报，仍未修
    return {
        **_backend_status,
        "agents_count": len(_agents_mod.AGENT_REGISTRY),
        ...
    }
```

**状态**：v1 P2-NEW-1 已记录，本次确认未修。Python import 有 `sys.modules` 缓存，开销极小，但写法不优雅。建议提到模块顶部 import。

---

### P1-NEW-v2-5：Strands 注入失败时 `_backend_status.backend_type` 未重置为 "langgraph"

**严重度**：P1（状态机不一致 + 诊断误导）

**位置**：
- `src-tauri/sidecar/main.py:477`（设置 backend_type="strands"）
- `src-tauri/sidecar/main.py:530-541`（except 分支 clear_backend 但未重置 backend_type）

**证据**：
```python
# main.py:475-477
_tdsf_backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
# P0-E: 写入 _backend_status（供 sidecar.health RPC 读取）
_backend_status["backend_type"] = _tdsf_backend  # ← 设为 "strands"

# main.py:530-541（Strands 注入失败 except 分支）
except Exception as se:
    logger.exception(
        f"failed to activate Strands backend, "
        f"fallback to BaseAgent PAOR: {se}"
    )
    agents.clear_backend()
    # P0-E: 标记降级 + 推送 fallback 事件给前端
    _backend_status["backend_activated"] = False
    _backend_status["fallback_reason"] = f"{type(se).__name__}: {se}"
    _backend_status["activate_time"] = time.time()
    send_notification("backend_status", dict(_backend_status))
    # ← 缺少：_backend_status["backend_type"] = "langgraph"
```

**问题链推演**：
1. 用户设 `TDSF_AGENT_BACKEND=strands` 启动 sidecar
2. `main.py:477` 将 `_backend_status["backend_type"]` 设为 `"strands"`
3. Strands 注入失败（如 strands 包未安装 / model 创建失败 / configure_strands 抛异常）
4. except 分支执行：`clear_backend()` + `backend_activated=False` + `fallback_reason=...`
5. 但 **`backend_type` 仍为 `"strands"`**（未重置）
6. 前端调 `sidecar.health` 拿到：`{backend_type: "strands", backend_activated: false, fallback_reason: "..."}`
7. BackendPill.deriveDisplay 优先看 `fallback_reason` → 显示 Degraded（视觉正确）
8. 但语义上 `backend_type="strands"` 暗示"用户配置了 strands 且后端类型是 strands"
9. 实际已 `clear_backend()` 回退到 LangGraph PAOR 路径，`backend_type` 应为 `"langgraph"`
10. 前端若按 `backend_type` 做其他逻辑判断（如"切换后端"按钮可用性、诊断面板显示），会误判

**影响**：
- 状态机不一致：`backend_type` 字段值与实际运行的后端不匹配
- 诊断误导：前端看到 `backend_type=strands` + `backend_activated=false`，可能误以为"strands 后端存在但未激活"，实际是"strands 注入失败已回退 LangGraph"
- 与 `clear_backend()` 语义不对齐：`clear_backend()` 清除了 override，但 `_backend_status.backend_type` 未同步

**根因**：
- except 分支只清理了 `backend_activated` / `fallback_reason`，遗漏了 `backend_type`
- `backend_type` 在 line 477 被设为用户配置值（"strands"），但回退后应改为实际运行值（"langgraph"）

**修复建议**：
```python
# main.py:530-541 except 分支内，clear_backend() 之后补：
except Exception as se:
    logger.exception(...)
    agents.clear_backend()
    _backend_status["backend_type"] = "langgraph"  # ← 补这行：重置为实际运行的后端
    _backend_status["backend_activated"] = False
    _backend_status["fallback_reason"] = f"{type(se).__name__}: {se}"
    _backend_status["activate_time"] = time.time()
    send_notification("backend_status", dict(_backend_status))
```

**验证方法**：
```bash
# 1. 设置 TDSF_AGENT_BACKEND=strands 但故意让 Strands 注入失败（如 pip uninstall strands-agents）
# 2. 启动 sidecar，调 sidecar.health：
invokeRpc("sidecar.health", {}).then(s => console.log(s))
# 3. 修复前：backend_type="strands"（错误，实际已回退 LangGraph）
# 4. 修复后：backend_type="langgraph"（正确）
```

---

### P1-NEW-v2-6：`_main_executor.shutdown(wait=True)` 无超时保护，LLM 请求 hang 时 sidecar 退出卡死

**严重度**：P1（进程退出卡死 + Rust 侧 SIGTERM 强杀）

**位置**：`src-tauri/sidecar/main.py:877-882`

**证据**：
```python
# main.py:877-882
# 5.0 TDSF P1-NEW-1 (2026-07-30): 关闭慢方法线程池
#     等待正在执行的 agent.invoke 完成（最多 5s），避免响应丢失。
#     不阻塞过久以免 Rust 侧 SIGTERM 强杀。
if _main_executor is not None:
    try:
        _main_executor.shutdown(wait=True, cancel_futures=True)
        logger.info("slow method executor shutdown complete")
    except Exception as e:
        logger.debug(f"executor shutdown on exit: {e}")
```

**问题**：
1. **注释声称"最多 5s"但代码无超时**：`shutdown(wait=True, cancel_futures=True)` 会无限等待正在执行的 future 完成
2. **`cancel_futures=True` 只取消排队中的 future**（Python 3.9+），不取消正在执行的
3. **正在执行的 agent.invoke 若 LLM HTTP 请求 hang 住**（网络不通 / 服务端不响应 / TCP 连接建立但无数据返回），线程会一直阻塞
4. **`wait=True` 无 timeout 参数**：Python `ThreadPoolExecutor.shutdown` 的 `wait` 参数是布尔值，不是超时
5. **主线程一直等**：sidecar 进程无法退出，Rust 侧 SIGTERM 强杀是唯一退出方式
6. **与注释不符**：注释说"最多 5s"，实际可能无限等待

**问题链推演**：
1. sidecar 收到 shutdown 信号（SIGTERM / `_shutdown_flag=True`）
2. 主循环退出，进入清理阶段
3. `_main_executor.shutdown(wait=True, cancel_futures=True)` 执行
4. 排队中的 future 被取消（cancel_futures=True）
5. **正在执行的 agent.invoke**（如 call_llm 内的 HTTP 请求）不被取消
6. 如果 LLM 服务端 hang 住（如 OpenAI API 网络不通），HTTP 请求无超时（取决于 llm_config 的 timeout 设置）
7. 线程池 `shutdown(wait=True)` 一直等待该线程完成
8. sidecar 进程无法退出，Rust 侧等待 N 秒后 SIGTERM 强杀

**影响**：
- sidecar 退出时卡死，无法优雅退出
- Rust 侧 sidecar.rs 的 `stop()` 等待进程退出超时后 kill，产生 zombie 进程风险
- 重启 sidecar 时旧进程未完全退出，端口/资源竞争

**根因**：
- `shutdown(wait=True)` 无超时参数，Python 标准库设计限制
- agent.invoke 内的 LLM HTTP 请求可能无超时（取决于 `make_llm_call` 实现）
- 注释与代码不符（注释说"最多 5s"，代码无超时）

**修复建议**：
方案 A（推荐）——用 `shutdown(wait=False)` + 显式 join 超时：
```python
if _main_executor is not None:
    try:
        _main_executor.shutdown(wait=False, cancel_futures=True)
        # 显式等待，最多 5s
        import concurrent.futures
        try:
            concurrent.futures.wait(
                _main_executor._threads,  # type: ignore[attr-defined]
                timeout=5.0,
            )
        except Exception:
            pass
        logger.info("slow method executor shutdown complete (5s timeout)")
    except Exception as e:
        logger.debug(f"executor shutdown on exit: {e}")
```

方案 B（更彻底）——agent.invoke 内的 LLM 调用加超时：
```python
# core/llm_config.py make_llm_call 内，HTTP 请求加 timeout 参数
# 如 OpenAI client: client.chat.completions.create(..., timeout=25)
# 确保 LLM 请求不会无限 hang
```

方案 C（最简单）——改 `wait=False`，不等待：
```python
_main_executor.shutdown(wait=False, cancel_futures=True)
# 线程会被 Python 解释器在退出时强制终止（daemon=True 时）
# 但 ThreadPoolExecutor 的线程默认非 daemon，需设置
```
局限：`wait=False` 时正在执行的 agent.invoke 响应会丢失。

**验证方法**：
```bash
# 1. 启动 sidecar，触发一个长时间 LLM 调用（如复杂 prompt）
# 2. 在 LLM 响应前发送 SIGTERM（kill <pid>）
# 3. 修复前：sidecar 进程卡死不退出（ps aux | grep python）
# 4. 修复后：sidecar 在 5s 内退出
time (kill -TERM <sidecar_pid>; wait <sidecar_pid>)
```

---

### P2-NEW-v2-9：`_sidecar_health` 闭包内 `import agents` 未捕获 ImportError

**严重度**：P2（agents 加载失败时 sidecar.health RPC 也失败，无法诊断）

**位置**：`src-tauri/sidecar/main.py:690-705`

**证据**：
```python
# main.py:690-705
def _sidecar_health(_params: dict | None = None) -> dict:
    """sidecar.health: 返回 sidecar 后端运行时状态"""
    import agents as _agents_mod  # ← 未 try/except，agents 加载失败时会抛 ImportError
    return {
        **_backend_status,
        "agents_count": len(_agents_mod.AGENT_REGISTRY),
        "agents_list": _agents_mod.list_agents(),
        "uptime_seconds": time.time() - START_TIME,
        "startup_time": START_TIME,
        "python_version": sys.version.split()[0],
        "platform": sys.platform,
    }
```

**问题**：
- `register_business_methods` 内 agents 模块加载失败时（main.py:555 except 分支），agents 不会出现在 `sys.modules`
- `_sidecar_health` 调用时 `import agents as _agents_mod` 会再次触发 ImportError
- 函数内未 try/except，ImportError 抛到 `dispatcher.dispatch`
- `dispatch` 的 except Exception 捕获，返回 `ERR_INTERNAL_ERROR`
- 前端 `sidecar.health` RPC 失败，BackendPill 卡 loading 状态，**无法诊断后端状态**

**影响**：
- agents 模块加载失败（如 agents/base.py 语法错误 / 循环导入 / 依赖缺失）时
- 前端无法通过 sidecar.health 查询后端状态
- BackendPill 永远卡 loading，用户无法知道"agents 加载失败"
- 失去 sidecar.health 作为诊断手段的价值

**根因**：
- `_sidecar_health` 假设 agents 模块已成功加载，但未处理加载失败场景
- 与 `register_business_methods` 的 try/except 防御式编程风格不一致

**修复建议**：
```python
def _sidecar_health(_params: dict | None = None) -> dict:
    """sidecar.health: 返回 sidecar 后端运行时状态"""
    try:
        import agents as _agents_mod
        agents_count = len(_agents_mod.AGENT_REGISTRY)
        agents_list = _agents_mod.list_agents()
    except ImportError:
        agents_count = 0
        agents_list = []
    return {
        **_backend_status,
        "agents_count": agents_count,
        "agents_list": agents_list,
        "uptime_seconds": time.time() - START_TIME,
        "startup_time": START_TIME,
        "python_version": sys.version.split()[0],
        "platform": sys.platform,
    }
```

**验证方法**：
```bash
# 1. 故意让 agents 模块加载失败（如临时重命名 agents/__init__.py）
# 2. 启动 sidecar
# 3. 调 sidecar.health：
invokeRpc("sidecar.health", {}).then(s => console.log(s))
# 4. 修复前：RPC 报错 ERR_INTERNAL_ERROR，BackendPill 卡 loading
# 5. 修复后：返回 {agents_count: 0, agents_list: [], ...}，可诊断
```

---

## 3. CLAUDE.md §3 防污染红线核查

| 红线 | 核查结果 | 证据 |
|------|----------|------|
| 红线 1：0 字节源文件 = 污染信号 | ✅ 未发现 0 字节 | 所有审查文件均非空 |
| 红线 2：禁止 git checkout/reset/restore 已跟踪文件 | ✅ 未触发 | 本次仅审查，未修改 |
| 红线 3：改依赖只用 pnpm add/remove | ✅ 未触发 | 本次仅审查 |
| 红线 4：useEffect 依赖禁止自反循环 | ✅ 未发现 | BackendPill useEffect 依赖 `[]`，无自反；useTerminalSession 依赖 `[leafId, container, blocks]`，无自反；SshTerminalHost 依赖 `[]`，无自反 |
| 红线 5：Context Provider value 用 useMemo | ✅ 未发现违反 | 本次未审查 Provider 代码（v1 已查 composer.tsx） |
| 红线 6：zustand selector 别返回新引用 | ⚠️ 1 处风险 | `SshTerminalHost.tsx:56-58` `s.sessions.find(...)` 返回数组元素引用（非新对象），但 sessions 数组变化时 selector 重算。实际行为正确（find 返回同一对象引用时不触发 rerender），但 O(n) 遍历。见 P2-NEW-v2-5 讨论 |
| 红线 7：启动/窗口/架构问题先比对上游 | ✅ 未触发 | 本次审查未涉及启动链 |
| 红线 8：五绿门禁全过才算完成 | ✅ 本次仅审查 | 不涉及改动 |

---

## 4. 协议契约补充核查（v1 未覆盖的维度）

### 4.1 Strands override 路径返回值契约 ⚠️ 部分不一致

**核查位置**：
- Python: `adapter.py:358-376`（invoke 返回 dict）
- Python: `base.py:86-100`（AgentResult.to_state_update 返回 dict）
- 前端: `sidecar-adapter.ts`（消费返回值）

**核查结论**：
- `BaseAgent.invoke` 返回 dict 含：`observation` / `next_step` / `reflection` / `mood` / `intermediate_results` / `error` / `plan` / `current_task_index` / `current_task` / `selected_agent` / `sub_agent_result` / `fix_loop` / 教学额外字段
- `adapter.invoke` 返回 dict 含：`observation` / `next_step` / `mood` / `intermediate_results` / `error` / `tokens` / `degraded` / `degraded_reason` / `degraded_message`
- **差异**：Strands 路径**不返回** `reflection` / `plan` / `current_task_index` / `selected_agent` / `sub_agent_result` / `fix_loop`
- 前端若依赖这些字段做 UI 渲染（如 plan 进度条、sub_agent_result 卡片），Strands 模式下会拿到 undefined
- **影响**：前端 plan 进度条 / sub_agent_result 卡片在 Strands 模式下不显示（功能缺失，非崩溃）

**建议**：adapter.invoke 应补齐 `reflection` / `fix_loop`（即使是空值）以保持契约一致。`plan` / `selected_agent` 等 LangGraph 专属字段可缺省。

### 4.2 Strands 事件 source 命名一致性 ✅

**核查位置**：
- `adapter.py:174` `source=f"{self.agent_name}_agent.strands"`
- `base.py:672` `source=f"{self.name}_agent"`

**核查结论**：Strands 路径事件 source 带 `.strands` 后缀，LangGraph 路径不带。前端若按 source 过滤（如 `source.endsWith("_agent")`），Strands 事件会被漏掉。当前前端按 `event_type` + `session_id` 路由，不依赖 source 后缀，**安全**。

---

## 5. 推荐修复顺序

### 优先级 1（P1，影响核心功能 / 资源泄漏）

1. **P1-NEW-v2-2**（Strands 缓存串台）→ 缓存 key 改 `(agent_id, session_id)`，1 行改动
   - 工作量：小（10 分钟）
   - 影响：所有 Strands 模式多会话场景
   - 建议：立即修复

2. **P1-NEW-v2-4**（BackendPill subscribe 泄漏）→ then 回调检查 cancelled
   - 工作量：小（5 分钟）
   - 影响：长期运行的 listener 泄漏
   - 建议：立即修复

3. **P1-NEW-v2-1**（reset_for_test 不清 override）→ 加 1 行
   - 工作量：小（1 分钟）
   - 影响：测试隔离
   - 建议：立即修复

4. **P1-NEW-v2-5**（Strands 注入失败 backend_type 未重置）→ except 分支补 1 行
   - 工作量：小（1 分钟）
   - 影响：状态机一致性 + 诊断准确性
   - 建议：立即修复

5. **P1-NEW-v2-6**（shutdown 无超时保护）→ 加超时或改 wait=False
   - 工作量：小（10 分钟）
   - 影响：sidecar 退出卡死风险
   - 建议：立即修复

6. **P1-NEW-v2-3**（fix-loop 在 override 路径失效）→ adapter.invoke 集成 fix-loop
   - 工作量：中（需理解 Strands hook 机制）
   - 影响：Strands 模式安全护栏
   - 建议：与 Strands LimitToolCounts hook 一起实现（P2-NEW-v2-1 死代码复活）

### 优先级 2（P2，改进建议）

7. **P2-NEW-v2-1**（max_iterations 死代码）→ 用 LimitToolCounts hook 复活或删除字段
8. **P2-NEW-v2-2**（响应解析启发式）→ 去掉 startswith("<") 判定
9. **P2-NEW-v2-4**（dedup_ts 死代码 + llm_call_failed 无 dedup）→ 激活 dedup 或删死代码
10. **P2-NEW-v2-7**（setStatus 无浅比）→ shallow compare
11. **P2-NEW-v2-3 / v2-5 / v2-6 / v2-8 / v2-9** → 按需推进

---

## 6. 审查文件清单

| # | 文件 | 行数 | 角色 | 审查动作 |
|---|------|------|------|----------|
| 1 | `src-tauri/sidecar/main.py` | 903 | Python Sidecar 入口 + 线程池 + Strands 注入 | 全量复读（v1 后改动部分） |
| 2 | `src-tauri/sidecar/agents/__init__.py` | 389 | Agent 注册表 + invoke_agent override 路径 | 全量复读 |
| 3 | `src-tauri/sidecar/agents/base.py` | 926 | BaseAgent PAOR 模板 + fix-loop 集成 + mock warning dedup | 全量复读 |
| 4 | `src-tauri/sidecar/strands_backend/adapter.py` | 786 | Strands 适配层 + Agent 缓存 + 事件转发 | 全量复读 |
| 5 | `src-tauri/sidecar/strands_backend/tools/__init__.py` | 407+ | Strands 运维工具 + RiskChecker + RustBridge | 全量复读 |
| 6 | `src-tauri/sidecar/rust_bridge.py` | 323 | Python→Rust 反向 JSON-RPC 通道 | 全量复读（线程安全确认） |
| 7 | `src-tauri/sidecar/fix_loop.py` | 773 | Fix-loop 重试计数器 | 全量复读（线程安全确认） |
| 8 | `src/modules/ssh-explorer/SshTerminalHost.tsx` | 125 | SSH 终端宿主 + transport 注入 | 全量复读 |
| 9 | `src/modules/ssh-explorer/sshStore.ts` | 800+ | SSH 会话 store + 终端数据 fan-out | 部分复读（connect/disconnect/订阅机制） |
| 10 | `src/modules/terminal/lib/useTerminalSession.ts` | 1325 | 终端会话管理 + PTY/SSH transport | 全量复读 |
| 11 | `src/modules/ai/components/BackendPill.tsx` | 271 | 后端类型指示器 + 事件订阅 | 全量复读 |
| 12 | `src/lib/sidecar-bridge.ts` | 456 | 前端 IPC 桥 + subscribe 前缀契约 | 全量复读（契约确认） |
| 13 | `docs/reports/modded-agent-code-review-2026-07-30.md` | 578 | v1 审查报告 | 摘要复读（去重） |

---

## 7. 简短总结

**v2 新发现数量**：P0=0，P1=6，P2=9

**最严重的 v2 新问题**：
1. **P1-NEW-v2-2**：Strands `_agent_cache` 按 agent_id 缓存，导致第二次 invoke 不同 session_id 时事件推送到错误会话（callback_handler 与工具闭包绑定首次 session_id）
2. **P1-NEW-v2-3**：Strands override 路径完全绕过 `BaseAgent._check_fix_loop`，fix-loop max_retry=3 保护在 Strands 模式下失效，违背 DEC-V321-11 spec
3. **P1-NEW-v2-4**：BackendPill `subscribe(...).then(un => unlistens.push(un))` 的 then 回调未检查 cancelled，组件快速卸载时泄漏 Tauri listener
4. **P1-NEW-v2-5**：Strands 注入失败时 `_backend_status.backend_type` 未重置为 "langgraph"，状态机不一致误导诊断
5. **P1-NEW-v2-6**：`_main_executor.shutdown(wait=True)` 无超时保护，LLM 请求 hang 时 sidecar 退出卡死
6. **P1-NEW-v2-1**：`reset_for_test()` 不清理 `_global_backend_override`，测试隔离断裂

**已验证安全的模块**（v1 未覆盖，本次确认）：
- `fix_loop.py` FixLoopTracker 线程安全（RLock 正确使用）
- `rust_bridge.py` RustBridge 线程安全（Lock + Event + 双重 ID 锁）
- `sidecar-bridge.ts` subscribe 前缀契约（自动补 `sidecar:` 前缀）

**推荐修复优先级**：
1. P1-NEW-v2-2（缓存 key 改二元组，1 行）
2. P1-NEW-v2-4（then 回调检查 cancelled，5 分钟）
3. P1-NEW-v2-1（reset_for_test 加 1 行）
4. P1-NEW-v2-5（except 分支补 backend_type 重置，1 行）
5. P1-NEW-v2-6（shutdown 加超时保护）
6. P1-NEW-v2-3（fix-loop 集成，需 Strands hook 研究）
7. P2 改进项按需推进

**与 v1 的关系**：v1 的 P1-NEW-1/2/4 已修复（线程池 / 模块级 logger / useCallback），本次未发现修复回归。v1 的 P2-NEW-1（sidecar.health 闭包 import）仍未修，本次标注为 P2-NEW-v2-8。

---

> **审查员**：GLM-5.2 子 Agent（代码审查模式 v2）
> **审查性质**：只读静态审查（未运行代码、未修改任何源文件）
> **报告生成**：2026-07-30
> **上一版本**：`docs/reports/modded-agent-code-review-2026-07-30.md`（v1）
