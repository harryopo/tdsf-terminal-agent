# TDSF Terminal Agent 魔改 Agent 代码审查报告 v3

> **审查时间**：2026-07-30
> **审查范围**：在 v2 基础上深入审查四大魔改模块——(1) Strands 适配层与 LangGraph 路径的配置/调用契约一致性；(2) sidecar 流协议在 Strands 并发工具调用下的 toolCallId 配对正确性；(3) Rust SSH 后端主机审批 registry 的资源生命周期；(4) sidecar 退出阶段线程池的实际阻塞行为
> **审查方法**：全量复读 11 个核心源文件，验证 v2 已修复问题状态，对照 v2 报告逐条核查未修复项，交叉验证 Python/TypeScript/Rust 三端协议契约
> **审查约束**：未修改任何源代码，仅产出本报告；不重复 v1/v2 已发现问题（除非状态变更）；不审查测试文件 / CDP 脚本 / 文档
> **严重度定义**：P0=阻塞/数据丢失/安全漏洞；P1=功能错误/性能问题/资源泄漏；P2=改进建议

---

## 0. 执行摘要

本次 v3 审查在 v2 基础上聚焦"配置热更新路径完整性"、"Strands 并发工具调用流协议正确性"、"SSH 主机审批资源生命周期"、"线程池退出语义"四个维度，新发现 **0 个 P0**、**4 个 P1**、**4 个 P2** 问题，同时确认 v2 报告的 6 个 P1 中有 5 个已正确修复、1 个未修（P1-NEW-v2-3 fix-loop 失效），v2 的 9 个 P2 中 0 个已修。

### 0.1 新发现问题数量（v3 增量，不含 v1/v2 已报）

| 严重度 | 数量 | 说明 |
|--------|------|------|
| P0 | 0 | 无阻断级新问题 |
| P1 | 4 | agent.configure 在 Strands 模式静默失效 / Strands 并发同名工具 toolCallId 配对错乱 / SSH 主机审批无超时导致连接线程永久挂起 / ThreadPoolExecutor 线程非 daemon 导致 sidecar 退出仍卡死 |
| P2 | 4 | sidecar timeout timer 未清理 / abortSignal 监听器未移除 / SSH onExit 未触发 transport.close / emitTerminalData 缓冲区溢出逻辑复杂 |

### 0.2 v2 修复状态确认

| v2 问题 | 状态 | 证据 |
|---------|------|------|
| P1-NEW-v2-1（reset_for_test 不清 override） | ✅ 已修 | gents/__init__.py:283-286 补 _global_backend_override = None |
| P1-NEW-v2-2（缓存按 agent_id 串台） | ✅ 已修 | dapter.py:263-266,494 缓存 key 改为 (agent_id, session_id) |
| P1-NEW-v2-3（fix-loop 在 override 路径失效） | ❌ 未修 | dapter.py 无 fix-loop 集成，	ools/__init__.py grep 0 处 fix_loop 引用 |
| P1-NEW-v2-4（BackendPill subscribe 泄漏） | ✅ 已修 | BackendPill.tsx:204-210,232-238 then 回调内检查 cancelled |
| P1-NEW-v2-5（backend_type 未重置） | ✅ 已修 | main.py:541 补 _backend_status["backend_type"] = "langgraph" |
| P1-NEW-v2-6（shutdown 无超时） | ⚠️ 部分修 | main.py:888 改 wait=False，但仍可能阻塞（见 P1-NEW-v3-4） |

### 0.3 最严重的 v3 新问题

1. **P1-NEW-v3-1：gent.configure JSON-RPC 在 Strands 模式下静默失效**
   - gents/__init__.py:360-376 仅更新 _global_llm_call 和 BaseAgent 实例的 llm_call
   - Strands 后端通过 _strands_adapter.strands_model 调 LLM，不读 _global_llm_call
   - 用户在 Strands 模式下重新配置 LLM 后，前端收到 ok:true 以为成功，实际 Strands 仍用旧 model
   - 缓存的 Strands Agent 实例（_agent_cache）也不会失效，即使 model 更新仍用旧实例

2. **P1-NEW-v3-2：sidecar 流协议按 tool_name 配对在 Strands 并发同名工具调用时错乱**
   - sidecar-adapter.ts:377-403 用 Map<tool_name, toolCallId> 配对 started/completed
   - 注释假设"sidecar PAOR 串行执行"，但 Strands agentic loop 可并发/连续调用同名工具
   - 第二次同名工具 started 覆盖 Map 中的 toolCallId，第一次的 completed 错配到第二次的 id

3. **P1-NEW-v3-3：SSH 主机审批无超时，用户关闭弹窗导致连接线程永久挂起**
   - handler.rs:247-249 注释明说"无超时，用户必须显式决策"
   - 用户关闭弹窗不点任何按钮 → x.await 永久挂起 → SSH 连接 tokio task 永久阻塞
   - approval_id 永留 registry，多次触发累积内存泄漏

4. **P1-NEW-v3-4：_main_executor.shutdown(wait=False) 仍可能阻塞 sidecar 退出**
   - main.py:886-891 P1-NEW-v2-6 修复改为 wait=False，注释称"由 OS 回收"
   - 但 Python concurrent.futures.thread._python_exit 在 atexit 时 join 所有非 daemon 线程
   - ThreadPoolExecutor 创建的线程默认 daemon=False，主线程退出后解释器仍会等待
   - LLM HTTP 请求 hang 住时，sidecar 进程仍卡死，与 v2 修复预期不符

### 0.4 推荐修复优先级

1. **P1-NEW-v3-1**（agent.configure Strands 失效）→ StrandsAgentAdapter 加 update_model + clear_cache，agent.configure override 路径调用
2. **P1-NEW-v3-3**（SSH 审批无超时）→ rx.await 加 5min 超时 + 超时后清理 registry
3. **P1-NEW-v3-2**（toolCallId 配对错乱）→ 改用 FIFO 队列按 tool_name 配对，或让 Python 端发 tool_call_id
4. **P1-NEW-v3-4**（线程池退出卡死）→ 设线程为 daemon 或 os._exit(0) 强制退出

---

## 1. 数据流与控制流总览

### 1.1 Strands 后端配置热更新路径（P1-NEW-v3-1 根因）

`mermaid
flowchart LR
    A[前端 agent.configure RPC] --> B[agents.__init__._rpc_agent_configure]
    B --> C{override 已注入?}
    C -->|否 LangGraph| D[更新 _global_llm_call]
    D --> E[更新 BaseAgent.llm_call]
    E --> F[返回 ok:true]
    C -->|是 Strands| G[更新 _global_llm_call]
    G --> H[更新 BaseAgent.llm_call]
    H --> I[Strands adapter.strands_model 未更新]
    I --> J[缓存 Agent 实例仍用旧 model]
    J --> K[返回 ok:true 误报成功]
    style I fill:#ffcdd2,color:#b71c1c
    style J fill:#ffcdd2,color:#b71c1c
    style K fill:#ffcdd2,color:#b71c1c
`

### 1.2 Strands 并发同名工具调用流协议错乱（P1-NEW-v3-2 根因）

`mermaid
sequenceDiagram
    participant Py as Python Strands
    participant Bus as event_bus
    participant Ts as sidecar-adapter.ts
    participant UI as AiChat 工具行
    Py->>Bus: tool_call ssh_command #1 started
    Bus->>Ts: {name:ssh_command, status:started}
    Ts->>Ts: toolIdByName.set(ssh_command, tool-1)
    Py->>Bus: tool_call ssh_command #2 started
    Bus->>Ts: {name:ssh_command, status:started}
    Ts->>Ts: toolIdByName.set(ssh_command, tool-2) 覆盖!
    Py->>Bus: tool_call ssh_command #1 completed
    Bus->>Ts: {name:ssh_command, status:completed}
    Ts->>Ts: toolIdByName.get(ssh_command) = tool-2 错配!
    Ts->>UI: tool-2 output (tool-1 永无 output)
    Py->>Bus: tool_call ssh_command #2 completed
    Bus->>Ts: {name:ssh_command, status:completed}
    Ts->>Ts: toolIdByName.get(ssh_command) = undefined 生成 tool-3
    Ts->>UI: tool-3 output (tool-2 已被消费)
`

---

## 2. 新发现问题（v3 增量，按严重度排序）

### P1-NEW-v3-1：gent.configure JSON-RPC 在 Strands 模式下静默失效

**严重度**：P1（功能错误：配置热更新静默失败 + 用户误以为成功）

**位置**：
- src-tauri/sidecar/agents/__init__.py:337-393（_rpc_agent_configure 实现）
- src-tauri/sidecar/strands_backend/adapter.py:240-274（StrandsAgentAdapter 无 update_model 方法）
- src-tauri/sidecar/strands_backend/__init__.py:60-139（configure_strands 一次性创建，无重配置入口）

**证据 - _rpc_agent_configure 仅更新 LangGraph 路径**：
`python
# agents/__init__.py:360-376
def _rpc_agent_configure(config: dict[str, Any] | None = None) -> dict[str, Any]:
    global _global_llm_call
    if config:
        try:
            from core.llm_config import LLMConfig, reconfigure
            llm_config = LLMConfig(...)
            new_llm_call = reconfigure(llm_config)
            if new_llm_call is not None:
                _global_llm_call = new_llm_call          # ← 仅 LangGraph 路径
                for agent in _agent_instances.values():
                    agent.llm_call = new_llm_call        # ← 仅 BaseAgent 实例
                return {"ok": True, "llm_call_set": True, ...}  # ← 误报成功
`

**证据 - StrandsAgentAdapter 无 update_model 方法**：
`python
# adapter.py:240-274（构造函数，strands_model 一次性注入）
def __init__(self, ..., strands_model: Any = None, ...):
    self.strands_model = strands_model  # ← 构造后无更新入口
    # _agent_cache 缓存的 Agent 实例也绑定旧 model

# grep "update_model|reconfigure" strands_backend/ → 0 命中
`

**问题链推演**：
1. sidecar 启动时 TDSF_AGENT_BACKEND=strands，configure_strands(llm_config=old_config) 创建 adapter
2. _strands_adapter.strands_model = create_strands_model(old_config)（如 OpenAIModel with old api_key）
3. 用户在前端设置面板更新 API Key / model name
4. 前端调 gent.configure({provider, api_key, model, ...}) JSON-RPC
5. _rpc_agent_configure 更新 _global_llm_call + BaseAgent 实例的 llm_call
6. **但 _strands_adapter.strands_model 仍是旧 model**
7. **_strands_adapter._agent_cache 中的 Strands Agent 实例仍绑定旧 model**
8. 返回 {"ok": true, "llm_call_set": true, "message": "LLM 配置已更新"} —— 误报成功
9. 用户继续对话，Strands 后端仍用旧 API Key 调用旧 model
10. 旧 API Key 已失效 → LLM 调用失败 → 用户困惑"明明配置了新 Key 为什么还失败"

**影响**：
- Strands 模式下 agent.configure 完全无效，用户重新配置 LLM 后仍用旧配置
- 前端误报成功，用户无法通过错误反馈发现问题
- 与 LangGraph 路径行为不一致（LangGraph 路径配置热更新正常工作）
- 用户可能误以为 Strands 后端有 bug，实际是配置未生效

**根因**：
- _rpc_agent_configure 设计时未考虑 Strands override 路径
- StrandsAgentAdapter 未提供 update_model / econfigure 方法
- 即使 adapter.strands_model 更新，_agent_cache 中的 Strands Agent 实例仍绑定旧 model（需 clear_cache）

**修复建议**：
`python
# 1. StrandsAgentAdapter 加 update_model 方法（adapter.py）
def update_model(self, new_model: Any) -> None:
    """更新 Strands Model 并清空 Agent 缓存（配置热更新时调用）"""
    self.strands_model = new_model
    self._model_available = new_model is not None
    self.clear_cache()  # 强制下次 invoke 重建 Agent，绑定新 model
    logger.info(f"Strands model updated, cache cleared")

# 2. agents/__init__.py 暴露 reconfigure_backend 入口
def reconfigure_backend(llm_config: Any) -> None:
    """Strands 后端配置热更新（由 _rpc_agent_configure 调用）"""
    global _global_backend_override
    if _global_backend_override is None:
        return  # 非 Strands 模式，无需处理
    # 需要持有 adapter 引用，或在 set_backend 时注册 reconfigure 回调
    # 方案：set_backend 增加可选 reconfigure_fn 参数

# 3. _rpc_agent_configure override 路径调用
def _rpc_agent_configure(config):
    if config:
        new_llm_call = reconfigure(llm_config)
        if new_llm_call is not None:
            _global_llm_call = new_llm_call
            for agent in _agent_instances.values():
                agent.llm_call = new_llm_call
            # P1-NEW-v3-1 修复：Strands 后端同步更新
            if _global_backend_override is not None:
                from strands_backend.model_adapter import create_strands_model
                new_model = create_strands_model(llm_config)
                _reconfigure_strands_backend(new_model)  # 需要持有 adapter 引用
            return {"ok": True, "llm_call_set": True, ...}
`

**验证方法**：
`ash
# 1. 启动 Strands 后端：TDSF_AGENT_BACKEND=strands pnpm tauri:dev
# 2. 用错误 API Key 配置，确认 LLM 调用失败
# 3. 前端调 agent.configure 更新为正确 API Key
# 4. 修复前：继续对话仍失败（用旧 Key）
# 5. 修复后：继续对话成功（用新 Key）
invokeRpc("agent.configure", {config: {provider:"openai", api_key:"new-key", model:"gpt-4o-mini"}})
  .then(r => console.log(r))  # ok:true
invokeRpc("agent.invoke", {name:"main", state:{input:"ping"}})
  .then(r => console.log(r))  # 应成功
`

---

### P1-NEW-v3-2：sidecar 流协议按 tool_name 配对在 Strands 并发同名工具调用时错乱

**严重度**：P1（功能错误：工具行渲染错乱 + 工具输出错配）

**位置**：src/modules/ai/lib/sidecar-adapter.ts:376-403

**证据**：
`	ypescript
// sidecar-adapter.ts:376-403
const collectedTools: SidecarStreamPart[] = [];
const toolIdByName = new Map<string, string>();  // ← key 是 tool_name
let toolSeq = 0;
const onToolCall = (p: ToolCallPayload) => {
  const name = p.tool_name;
  if (!name) return;
  if (p.status === "started") {
    const toolCallId = ${streamId}-tool-;
    toolIdByName.set(name, toolCallId);  // ← 同名工具覆盖
    collectedTools.push({ type: "tool-input", toolCallId, toolName: name, input: p.params ?? {} });
  } else if (p.status === "completed" || p.status === "error") {
    const toolCallId = toolIdByName.get(name) ?? ${streamId}-tool-;  // ← 取最新，非配对
    toolIdByName.delete(name);
    collectedTools.push({ type: "tool-output", toolCallId, toolName: name, output: p.result ?? null, isError: p.status === "error" });
  }
};
`

**注释假设**：
`	ypescript
// sidecar-adapter.ts:374-375
// toolIdByName 把同一工具的 started/completed 两个事件配对到同一 toolCallId
// （sidecar PAOR 串行执行，按 tool_name 配对即可）
`

**问题链推演**：
1. Strands agentic loop 调用 ssh_command 第 1 次（started → toolIdByName["ssh_command"]="tool-1"）
2. Strands 在第 1 次完成前**连续**调用 ssh_command 第 2 次（started → toolIdByName["ssh_command"]="tool-2"，覆盖 tool-1）
3. 第 1 次 ssh_command completed → 	oolIdByName.get("ssh_command") = "tool-2"（错配！应该是 tool-1）
4. 	oolIdByName.delete("ssh_command")
5. 第 2 次 ssh_command completed → 	oolIdByName.get("ssh_command") = undefined → 生成新 "tool-3"
6. **结果**：
   - tool-1（第 1 次调用）有 input 无 output（永远 pending）
   - tool-2（第 2 次调用）有 input 有 output（但 output 是第 1 次的结果）
   - tool-3（孤儿）只有 output 无 input
7. 前端 AiChat 渲染：第 1 次工具行永远转圈，第 2 次工具行显示第 1 次的结果

**影响**：
- Strands 后端下，LLM 连续调用同名工具（如多次 ssh_command 查不同主机）时工具行渲染错乱
- 工具输出与输入错配，用户看到错误的命令结果
- tool-1 永远 pending 导致 UI 卡在"工具调用中"状态
- LangGraph PAOR 路径串行执行不触发此问题（注释假设成立），仅 Strands 路径受影响

**根因**：
- 注释假设"PAOR 串行执行"在 LangGraph 路径成立，但 Strands agentic loop 可并发/连续调用同名工具
- 	oolIdByName 用 tool_name 作 key，无法区分同名工具的多次调用
- Python event_bus.emit_tool_call 不携带唯一 tool_call_id（仅传 tool_name + params + status）

**修复建议**：
方案 A（推荐，前端改）——用 FIFO 队列按 tool_name 配对：
`	ypescript
const pendingToolCalls = new Map<string, string[]>();  // name → toolCallId 队列
const onToolCall = (p: ToolCallPayload) => {
  const name = p.tool_name;
  if (!name) return;
  if (p.status === "started") {
    const toolCallId = ${streamId}-tool-;
    const queue = pendingToolCalls.get(name) ?? [];
    queue.push(toolCallId);
    pendingToolCalls.set(name, queue);
    collectedTools.push({ type: "tool-input", toolCallId, toolName: name, input: p.params ?? {} });
  } else if (p.status === "completed" || p.status === "error") {
    const queue = pendingToolCalls.get(name);
    const toolCallId = queue?.shift() ?? ${streamId}-tool-;
    if (queue && queue.length === 0) pendingToolCalls.delete(name);
    collectedTools.push({ type: "tool-output", toolCallId, toolName: name, output: p.result ?? null, isError: p.status === "error" });
  }
};
`
局限：仍假设 started/completed 严格 FIFO（Strands 工具串行完成时成立，并发完成时不成立）。

方案 B（最佳，Python 端发 tool_call_id）——event_bus.emit_tool_call 增加 tool_call_id 字段：
`python
# event_bus.py emit_tool_call 增加可选 tool_call_id 参数
def emit_tool_call(self, tool_name, params, status, session_id=None, source=None, tool_call_id=None):
    # tool_call_id 由调用方生成（如 uuid4），前端按 id 配对，不再按 name
`
Strands 适配层在 callback_handler 的 current_tool_use 事件中提取 tool_use_id（Strands 提供）作为 tool_call_id。

**验证方法**：
`python
# 单测：模拟 Strands 连续两次同名工具调用
def test_concurrent_same_tool_pairing():
    collected = []
    adapter = SidecarAdapter()  # mock
    adapter.onToolCall({"tool_name":"ssh_command","status":"started","params":{"cmd":"ls"}})
    adapter.onToolCall({"tool_name":"ssh_command","status":"started","params":{"cmd":"pwd"}})
    adapter.onToolCall({"tool_name":"ssh_command","status":"completed","result":"file1\nfile2"})
    adapter.onToolCall({"tool_name":"ssh_command","status":"completed","result":"/home"})
    # 修复前：第 1 个 output 配对到第 2 个 input
    # 修复后：FIFO 配对，第 1 个 output 配第 1 个 input
`

---

### P1-NEW-v3-3：SSH 主机审批无超时，用户关闭弹窗导致连接线程永久挂起

**严重度**：P1（资源泄漏 + 连接线程永久阻塞 + 内存累积）

**位置**：src-tauri/src/modules/ssh/handler.rs:184-269

**证据**：
`ust
// handler.rs:247-249
// 5. 异步等待用户响应 (无超时,用户必须显式决策)
//    前端应提供"信任"/"拒绝"按钮,调用 ssh_approve_host 命令
let approved = rx.await.unwrap_or(false);  // ← 无超时，永久挂起
`

**证据 - registry 无清理机制**：
`ust
// handler.rs:38-39
static HOST_APPROVAL_REGISTRY: LazyLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// ← 无 TTL 清理线程，无超时扫描
`

**问题链推演**：
1. 用户连接新 SSH 主机，check_server_key 触发 TOFU 询问
2. sk_user_to_trust_host 生成 approval_id，注册到 HOST_APPROVAL_REGISTRY
3. Tauri emit ssh:host_verify 事件到前端，前端弹窗
4. x.await 挂起等待用户响应（无超时）
5. **用户直接关闭弹窗**（点 X 按钮 / ESC / 切换页面）
6. 前端未调用 ssh_approve_host（approval_id 未被消费）
7. x.await 永久挂起 → SSH 连接 tokio task 永久阻塞
8. approval_id 永留 HOST_APPROVAL_REGISTRY
9. SSH 会话在 sshStore.sessions 中处于 HostVerifying 状态，无法重连（task 未退出）
10. 多次触发累积内存泄漏 + 连接 task 累积

**影响**：
- 用户关闭主机验证弹窗后，SSH 连接永久卡在 HostVerifying 状态
- 无法重连（旧 task 未退出，新连接可能冲突）
- HOST_APPROVAL_REGISTRY 累积未消费的 sender，内存泄漏
- 极端情况：用户反复尝试连接多个新主机都关弹窗，registry 无限增长

**根因**：
- 设计假设"用户必须显式决策"，未考虑用户关闭弹窗的常见场景
- x.await 无超时，无兜底退出机制
- 前端弹窗关闭时未通知后端清理（无 ssh_cancel_host_approval 命令）

**修复建议**：
方案 A（推荐）——x.await 加超时 + 超时后自动拒绝：
`ust
// handler.rs:247-249 改为
let approved = tokio::time::timeout(
    std::time::Duration::from_secs(300),  // 5min 超时
    rx,
).await.unwrap_or(Ok(false)).unwrap_or(false);  // 超时或 sender drop 都返回 false

// 超时后清理 registry（sender 已 drop，registry 中的 entry 需手动删）
// 注：oneshot::Sender drop 后 rx.await 返回 Err，unwrap_or(false) 处理
// 但 registry 中的 entry 仍在（sender 已 drop 但 key 未删）
// 需在超时后手动 remove：
if let Ok(mut registry) = HOST_APPROVAL_REGISTRY.lock() {
    registry.remove(&approval_id);
}
`

方案 B（前端补 cancel 命令）——前端弹窗关闭时调 ssh_cancel_host_approval：
`ust
// 新增命令
#[tauri::command]
pub fn ssh_cancel_host_approval(approval_id: String) -> Result<(), String> {
    let mut registry = HOST_APPROVAL_REGISTRY.lock().map_err(|e| e.to_string())?;
    registry.remove(&approval_id);  // sender drop → rx.await 返回 Err → unwrap_or(false)
    Ok(())
}
`
前端弹窗 onClose 调用此命令。

方案 C（最彻底）——A + B 叠加：超时兜底 + 前端主动取消。

**验证方法**：
`ash
# 1. 连接一个新 SSH 主机（触发 host_verify 弹窗）
# 2. 直接关闭弹窗（不点信任/拒绝）
# 3. 修复前：sshStore.sessions 中该会话永久 HostVerifying，无法重连
# 4. 修复后（方案 A）：5min 后自动拒绝，会话变 Failed，可重连
# 5. 修复后（方案 B）：关闭弹窗立即拒绝
`

---

### P1-NEW-v3-4：_main_executor.shutdown(wait=False) 仍可能阻塞 sidecar 退出

**严重度**：P1（进程退出卡死 + Rust 侧 SIGTERM 强杀 + zombie 进程）

**位置**：src-tauri/sidecar/main.py:886-891

**证据**：
`python
# main.py:886-891
# P1-NEW-v2-6 修复 (2026-07-30): shutdown(wait=True) 无超时保护，
# 若 LLM HTTP 请求 hang 住会导致 sidecar 退出卡死。改为 wait=False，
# 不等待正在执行的 future，由 Rust 侧 SHUTDOWN_GRACE=3s + SIGKILL 兜底。
# （cancel_futures=True 仍取消排队中的 future；正在执行的 future 在
#   进程退出时由 OS 回收，LLM HTTP 连接会被强制断开）
if _main_executor is not None:
    try:
        _main_executor.shutdown(wait=False, cancel_futures=True)
        logger.info("slow method executor shutdown initiated (non-blocking)")
    except Exception as e:
        logger.debug(f"executor shutdown on exit: {e}")
`

**证据 - Python ThreadPoolExecutor 线程默认非 daemon**：
`python
# Python 3.9+ concurrent/futures/thread.py
# _threads_queues: dict[Thread, Queue] = WeakKeyDictionary()
# _python_exit 函数在 atexit 时遍历 _threads_queues，join 所有线程
# ThreadPoolExecutor 创建的线程默认 daemon=False（除非显式设置）
# 因此即使 shutdown(wait=False)，主线程退出时 _python_exit 仍会 join
`

**问题链推演**：
1. sidecar 收到 shutdown 信号（SIGTERM / _shutdown_flag=True）
2. 主循环退出，进入清理阶段
3. _main_executor.shutdown(wait=False, cancel_futures=True) 执行
4. cancel_futures=True 取消排队中的 future
5. **正在执行的 agent.invoke**（如 call_llm 内的 HTTP 请求）不被取消
6. wait=False 让 shutdown 立即返回，主线程继续执行后续清理
7. main() 函数返回，Python 解释器准备退出
8. **_python_exit atexit handler 触发**，遍历 _threads_queues
9. 对每个非 daemon 线程调 	.join()，等待线程结束
10. 正在执行 agent.invoke 的线程因 LLM HTTP 请求 hang 住而不结束
11. **	.join() 永久阻塞**，Python 解释器无法退出
12. Rust 侧等待进程退出超时后 SIGKILL 强杀

**影响**：
- P1-NEW-v2-6 的修复（wait=False）实际未解决问题
- 注释"由 OS 回收"是错误的——Python atexit 会等待非 daemon 线程
- LLM HTTP 请求 hang 住时 sidecar 仍卡死，与 v2 修复预期不符
- Rust 侧 SIGKILL 强杀产生 zombie 进程风险（端口/资源竞争）

**根因**：
- Python ThreadPoolExecutor 的线程默认 daemon=False
- _python_exit atexit handler join 所有非 daemon 线程
- shutdown(wait=False) 只是不在 shutdown 调用处等待，不影响 atexit 行为
- v2 修复方案对 Python 线程模型理解有误

**修复建议**：
方案 A（推荐）——设线程为 daemon + os._exit(0) 强制退出：
`python
# main.py 线程池创建时设线程为 daemon
import threading
class DaemonThreadPoolExecutor(ThreadPoolExecutor):
    def _adjust_thread_count(self):
        # 重写以创建 daemon 线程
        while len(self._threads) < self._max_workers:
            t = threading.Thread(
                name=f"{self._thread_name_prefix or self}_{len(self._threads)}",
                target=self._worker,
                args=(weakref.ref(self, lambda _: self._work_queue.put(None)), self._work_queue),
                daemon=True,  # ← 关键：设为 daemon
            )
            t.start()
            self._threads.add(t)

_main_executor = DaemonThreadPoolExecutor(max_workers=2, thread_name_prefix="sidecar-async")

# main() 末尾强制退出（绕过 atexit join）
import os
os._exit(0)  # ← 不执行 atexit，直接退出
`
局限：os._exit(0) 跳过 atexit，可能丢失清理（如 log flush）。需在调用前手动 flush。

方案 B（更安全）——给 LLM HTTP 请求加超时：
`python
# core/llm_config.py make_llm_call 内，HTTP 请求加 timeout
# OpenAI client: client.chat.completions.create(..., timeout=25)
# 确保 LLM 请求不会无限 hang，线程池线程能在超时后退出
`
配合 shutdown(wait=False, cancel_futures=True) + 短超时 join：
`python
if _main_executor is not None:
    _main_executor.shutdown(wait=False, cancel_futures=True)
    # 显式短超时 join 工作线程
    import concurrent.futures
    try:
        concurrent.futures.wait(
            _main_executor._threads,  # type: ignore[attr-defined]
            timeout=3.0,
        )
    except Exception:
        pass
`

方案 C（最简单）——仅 os._exit(0)，不设 daemon：
`python
# main() 末尾
logger.info("sidecar exiting")
sys.stderr.flush()
os._exit(0)  # 强制退出，不等待线程
`
局限：跳过所有 atexit 清理（needs_you stop / rust_bridge stop 等需手动调）。

**验证方法**：
`ash
# 1. 启动 sidecar，触发一个长时间 LLM 调用
# 2. 在 LLM 响应前发送 SIGTERM
# 3. 修复前：sidecar 进程卡死（ps aux | grep python，状态 D 或 S 不退出）
# 4. 修复后：sidecar 在 3s 内退出
time (kill -TERM <sidecar_pid>; wait <sidecar_pid>)
`

---

### P2-NEW-v3-1：sidecar-adapter.ts timeout Promise 的 timer 在 invoke 完成后未清理

**严重度**：P2（资源泄漏：每次 invoke 泄漏 30s timer）

**位置**：src/modules/ai/lib/sidecar-adapter.ts:416-430

**证据**：
`	ypescript
// sidecar-adapter.ts:416-430
const timeout = new Promise<never>((_, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Sidecar 调用超时（30s）")),
    SIDECAR_TIMEOUT_MS,
  );
  // 让 abortSignal 触发时能立即 reject（避免 Promise 泄漏）
  abortSignal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);  // ← abort 时清理 timer
      reject(new Error("用户取消"));
    },
    { once: true },
  );
});

const raw = await Promise.race([
  invoke<AgentInvokeResult>("ipc_invoke", {...}),
  timeout,
]);
// ← invoke 正常完成后，timer 未清理，仍挂 30s 才自动触发
`

**问题**：
- Promise.race 拿到 invoke 结果后，timeout Promise 仍在等待
- timer 30s 后才触发 reject（虽然已无人 await，但 timer 仍占资源）
- abortSignal 监听器也仍挂着（见 P2-NEW-v3-2）
- 每次正常 invoke 都泄漏一个 30s timer + 一个 abort listener
- 高频对话场景累积大量 pending timer

**修复建议**：
`	ypescript
let timer: ReturnType<typeof setTimeout> | undefined;
const timeout = new Promise<never>((_, reject) => {
  timer = setTimeout(
    () => reject(new Error("Sidecar 调用超时（30s）")),
    SIDECAR_TIMEOUT_MS,
  );
  abortSignal?.addEventListener("abort", () => {
    if (timer) clearTimeout(timer);
    reject(new Error("用户取消"));
  }, { once: true });
});

try {
  const raw = await Promise.race([invoke(...), timeout]);
  result = raw;
} finally {
  if (timer) clearTimeout(timer);  // ← 无论成功失败都清理
}
`

**验证方法**：React DevTools / 浏览器 DevTools 观察 timer 数量，多次对话后不应累积。

---

### P2-NEW-v3-2：sidecar-adapter.ts abortSignal 监听器在 invoke 正常完成时未移除

**严重度**：P2（资源泄漏：abortSignal listener 累积）

**位置**：src/modules/ai/lib/sidecar-adapter.ts:422-429

**证据**：
`	ypescript
// sidecar-adapter.ts:422-429
abortSignal?.addEventListener(
  "abort",
  () => {
    clearTimeout(timer);
    reject(new Error("用户取消"));
  },
  { once: true },  // ← 仅在触发时移除，未触发时一直挂着
);
`

**问题**：
- { once: true } 仅在 abort 事件触发时自动移除监听器
- invoke 正常完成、abortSignal 从未触发时，监听器一直挂在 abortSignal 上
- 如果 abortSignal 是 long-lived 的（如 useChat 的全局 AbortController），监听器会累积
- 每次 runSidecarStream 调用都注册一个新监听器，N 次对话后 abortSignal 有 N 个监听器
- 虽然 abort 未触发时监听器 no-op，但占内存 + AbortSignal.dispatchEvent 开销

**影响**：微小（abortSignal 通常随消息周期结束被 GC），但违反"用完即清"原则。

**修复建议**：
`	ypescript
const onAbort = () => {
  if (timer) clearTimeout(timer);
  reject(new Error("用户取消"));
};
abortSignal?.addEventListener("abort", onAbort, { once: true });

try {
  const raw = await Promise.race([invoke(...), timeout]);
  result = raw;
} finally {
  abortSignal?.removeEventListener("abort", onAbort);  // ← 主动移除
  if (timer) clearTimeout(timer);
}
`

**验证方法**：单测 mock AbortController，多次调 runSidecarStream 后 listeners 数应为 0。

---

### P2-NEW-v3-3：SSH 终端 onExit 时 transport.close() 不会被调用，subscribers 可能残留

**严重度**：P2（资源泄漏：sshStore terminalSubscribers 残留）

**位置**：
- src/modules/terminal/lib/useTerminalSession.ts:671-692（openPtyForSession SSH 分支）
- src/modules/ssh-explorer/SshTerminalHost.tsx:92-96（transport.close 仅 unsubscribe）
- src/modules/ssh-explorer/sshStore.ts:390-398（clearTerminalSubscribers 仅 disconnect 调用）

**证据**：
`	ypescript
// useTerminalSession.ts:671-685 SSH onExit
if (s.openTransport) {
  const transport = await s.openTransport({
    onData: (bytes) => deliverPtyBytes(leafId, bytes),
    onExit: (code) => {
      s.shellExited = true;
      s.pty = null;  // ← pty 置 null，但 transport.close() 未调用
      // ... s.callbacks.onExit?.(code)
    },
  });
  return transport;
}

// SshTerminalHost.tsx:92-96 transport.close 定义
close: () => {
  unsubscribe();  // ← 调 sshStore.subscribeTerminalData 返回的 unsubscribe
},
`

**问题**：
- SSH 终端 onExit（用户敲 exit 退出 shell）时，s.pty = null 但 	ransport.close() 未调用
- transport.close 是 unsubscribe()（清理 sshStore.terminalSubscribers 中的订阅）
- onExit 路径不触发 close → subscribers 残留
- 后续 SSH 会话数据（如 SFTP 操作触发的输出）仍 fan-out 到已卸载的订阅
- clearTerminalSubscribers 只在 sshStore.disconnect 时调用，shell 退出 ≠ disconnect

**影响**：
- 用户敲 exit 退出 SSH shell 后，terminalSubscribers 残留
- 若用户重连同一 SSH 主机，新订阅与旧订阅共存，输出 fan-out 到两个订阅
- 旧订阅的 cb 可能已指向已卸载组件，触发 console.warn
- 内存泄漏（每个未清理的 subscriber 留 1 个闭包）

**修复建议**：
`	ypescript
// useTerminalSession.ts:671-685 SSH onExit 内补 transport.close
onExit: (code) => {
  s.shellExited = true;
  // P2-NEW-v3-3 修复：onExit 时主动 close transport，清理 sshStore subscribers
  if (s.pty) {
    try { s.pty.close(); } catch { /* ignore */ }
  }
  s.pty = null;
  // ... s.callbacks.onExit?.(code)
},
`
注意：s.pty.close() 在 onExit 回调内调用，可能 transport.close 内的 unsubscribe 与 emitTerminalData 并发（Map 操作），但 JS 单线程无竞态。

**验证方法**：
`ash
# 1. 连接 SSH 主机
# 2. 在终端敲 exit 退出 shell（不 disconnect SSH 会话）
# 3. 检查 sshStore.terminalSubscribers 是否有残留 entry
# 4. 修复前：残留 1 个 subscriber
# 5. 修复后：subscribers 已清理
`

---

### P2-NEW-v3-4：emitTerminalData 缓冲区溢出处理逻辑复杂，边界 case 需测试覆盖

**严重度**：P2（潜在 bug + 可读性差）

**位置**：src/modules/ssh-explorer/sshStore.ts:357-378

**证据**：
`	ypescript
// sshStore.ts:357-378
if (cur + bytes.byteLength > BUFFER_LIMIT_BYTES) {
  const overflow = cur + bytes.byteLength - BUFFER_LIMIT_BYTES;
  const newBuf: Uint8Array[] = [];
  let dropped = 0;
  for (const chunk of buf) {
    if (dropped >= overflow) {
      newBuf.push(chunk);  // ← 已丢弃足够字节，保留剩余
      continue;
    }
    if (dropped + chunk.byteLength <= overflow) {
      dropped += chunk.byteLength;  // ← 整个 chunk 丢弃
    } else {
      const remain = dropped + chunk.byteLength - overflow;
      newBuf.push(chunk.slice(remain));  // ← 部分丢弃
      dropped = overflow;
    }
  }
  pendingBuffer.set(sessionId, newBuf);
  cur = newBuf.reduce((s, c) => s + c.byteLength, 0);
}
buf.push(bytes);  // ← 注意：buf 可能已是 newBuf
bufferedSize.set(sessionId, cur + bytes.byteLength);
`

**问题**：
1. **uf 变量在溢出分支后被重新赋值**：pendingBuffer.set(sessionId, newBuf) 后 uf 仍指向旧数组，uf.push(bytes) push 到旧数组，newBuf 未收到新数据
2. **修复检查**：仔细看 pendingBuffer.set(sessionId, newBuf) 后没有 uf = newBuf，所以 uf.push(bytes) 确实 push 到旧数组
3. **下次 emitTerminalData 时** pendingBuffer.get(sessionId) 返回 newBuf（不含 bytes），bytes 丢失

**确认 bug**：
- 溢出分支重建 newBuf 后，uf 局部变量未更新为 newBuf
- uf.push(bytes) push 到旧 buf，但 pendingBuffer 已指向 newBuf
- 新数据 bytes 丢失，且旧 buf 被 GC（无人引用）
- 这意味着缓冲区溢出时，新数据**直接丢失**

**影响**：
- SSH 终端无订阅者时，缓冲区超 256KB 后新数据丢失
- 虽然溢出本身是异常场景（256KB 无订阅者），但数据丢失无告警
- 用户挂起终端 5min 后回来，缓冲区已满，新数据全丢

**修复建议**：
`	ypescript
if (cur + bytes.byteLength > BUFFER_LIMIT_BYTES) {
  // ... 重建 newBuf 逻辑 ...
  pendingBuffer.set(sessionId, newBuf);
  cur = newBuf.reduce((s, c) => s + c.byteLength, 0);
  buf = newBuf;  // ← 补这行：更新局部变量
}
buf.push(bytes);
bufferedSize.set(sessionId, cur + bytes.byteLength);
`

**验证方法**：
`	ypescript
// 单测：填充超过 256KB 后再 push 新数据
const sessionId = "test";
for (let i = 0; i < 300; i++) emitTerminalData(sessionId, new Uint8Array(1024)); // 300KB
emitTerminalData(sessionId, new Uint8Array(64)); // 触发溢出
// 修复前：pendingBuffer.get(sessionId) 不含最后 64 字节
// 修复后：含最后 64 字节
`

---

## 3. 未修复的 v2 问题状态确认

| v2 问题 | v3 状态 | 备注 |
|---------|---------|------|
| P1-NEW-v2-3（fix-loop 在 override 路径失效） | ❌ 未修 | dapter.py 无 fix-loop 集成，	ools/__init__.py grep 0 处 fix_loop 引用。Strands 模式下 max_retry=3 保护仍失效 |
| P2-NEW-v2-1（max_iterations 死代码） | ❌ 未修 | dapter.py:247,255,784 字段仍保留但 Strands 1.50.2 不支持，get_stats 仍报告误导值 |
| P2-NEW-v2-2（_extract_response_text 启发式误判） | ❌ 未修 | dapter.py:616 
ot text.startswith("<") 仍存在，XML/HTML 文本会被丢弃 |
| P2-NEW-v2-3（call_tool 越权仅 warning） | ❌ 未修 | ase.py:622-628 仍仅 warning，Strands 路径无 permission_check。当前风险低（工具集固定） |
| P2-NEW-v2-4（_mock_warning_dedup_ts 死代码） | ❌ 未修 | ase.py:163,165 字段仍 init 但无 read/write，_publish_mock_warning 仍无 dedup，llm_call_failed 路径仍每次都 emit |
| P2-NEW-v2-5（SshTerminalHost render 写 ref） | ❌ 未修 | SshTerminalHost.tsx:63-64 仍 render 阶段写 ref。可接受现状 |
| P2-NEW-v2-6（sshStore Map 无锁） | ❌ 未修 | sshStore.ts:274-283 module-level Map 无锁。当前安全（Tauri event 主线程同步） |
| P2-NEW-v2-7（setStatus 无 shallow compare） | ❌ 未修 | BackendPill.tsx:218-231 每次都创建新对象。性能微损 |
| P2-NEW-v2-8（_sidecar_health 闭包 import） | ❌ 未修 | main.py:700 仍闭包内 import agents。开销极小 |
| P2-NEW-v2-9（_sidecar_health 未捕获 ImportError） | ❌ 未修 | main.py:700 未 try/except，agents 加载失败时 sidecar.health RPC 也失败 |

---

## 4. 横向检查（CLAUDE.md §3 防污染红线 + §5 诊断方法论）

### 4.1 useEffect 依赖数组自反循环检查 ✅

| 组件 | useEffect deps | 自反风险 | 结论 |
|------|----------------|----------|------|
| BackendPill.tsx:168 | [] | 无 | ✅ 安全 |
| SshTerminalHost.tsx:105 | [] | 无 | ✅ 安全 |
| useTerminalSession.ts:1051 | [leafId, container, blocks] | 无 | ✅ 安全 |
| useTerminalSession.ts:1076 | [leafId, blocks] | 无 | ✅ 安全 |
| useTerminalSession.ts:1124 | [leafId, visible, focused, blocks] | 无 | ✅ 安全 |

### 4.2 Context Provider value useMemo 检查 ✅

未在本次审查范围新增 Provider 组件。v1 已查 composer.tsx，本次未涉及。

### 4.3 zustand selector 返回新引用检查 ⚠️

| 位置 | selector | 新引用风险 | 结论 |
|------|----------|------------|------|
| SshTerminalHost.tsx:56-58 | s.sessions.find(...) | 返回数组元素引用（非新对象） | ⚠️ O(n) 遍历，但 find 返回同一对象引用时不触发 rerender。v2 已记录 |
| BackendPill.tsx | 无 zustand selector | 无 | ✅ |

### 4.4 render 阶段写 ref 检查 ⚠️

| 位置 | 模式 | 结论 |
|------|------|------|
| SshTerminalHost.tsx:63-64 | handleRef.current = session?.handle ?? null | ⚠️ v2 已记录（P2-NEW-v2-5），可接受 |
| useTerminalSession.ts:1046-1049 | openTransportRef.current = openTransport 等 | ⚠️ 同模式，与 initialCwd 一致，可接受 |

### 4.5 Tauri event listener 泄漏检查 ✅

| 位置 | subscribe 模式 | 泄漏风险 | 结论 |
|------|----------------|----------|------|
| BackendPill.tsx:201-238 | then 回调检查 cancelled | ✅ 已修（P1-NEW-v2-4） |
| sidecar-adapter.ts:270-339 | registerSidecarListeners 返回 unlisten，finally 调用 | ✅ 安全 |
| sidecar-adapter.ts:422-429 | abortSignal addEventListener { once: true } | ⚠️ P2-NEW-v3-2，未触发时残留 |

---

## 5. 上游对比（crynta/terax-ai v0.8.6）

本次审查的魔改模块均为 TDSF 原创，上游 terax-ai 无对应实现：

| 模块 | 上游对应 | 魔改性质 |
|------|----------|----------|
| strands_backend/ | 无 | TDSF 原创（Strands 后端适配层） |
| agents/__init__.py set_backend/clear_backend | 无 | TDSF 原创（后端切换接口） |
| agents/__init__.py _rpc_agent_configure | 上游有 agent.configure | TDSF 扩展（支持运行时重配 LLM） |
| main.py _backend_status + sidecar.health | 无 | TDSF 原创（后端可观测性） |
| main.py _main_executor 线程池 | 无 | TDSF 原创（慢方法异步派发） |
| ssh-explorer/SshTerminalHost.tsx | 无 | TDSF 原创（SSH 终端复用 rendererPool） |
| terminal/lib/pty-bridge.ts TerminalTransport | 上游有 PtySession | TDSF 扩展（传输层抽象 seam） |
| terminal/lib/useTerminalSession.ts openTransport | 上游有 openPtyForSession | TDSF 扩展（SSH 分支） |
| ssh/handler.rs HOST_APPROVAL_REGISTRY | 无 | TDSF 原创（TOFU 主机审批） |
| ssh/session.rs open_pty | 无 | TDSF 原创（SSH PTY 会话） |
| ai/lib/sidecar-adapter.ts | 上游有 sidecar-adapter | TDSF 扩展（Strands 工具调用收集） |

**结论**：本次审查的魔改均为 TDSF 原创或对上游的扩展，未破坏上游架构。上游 terax-ai 的 sidecar-adapter.ts 无工具调用收集逻辑（仅 text-delta + finish），TDSF 扩展的 tool-input/tool-output part 是新增功能，P1-NEW-v3-2 是该扩展的 bug。

---

## 6. 推荐修复顺序

### 优先级 1（P1，影响核心功能 / 资源泄漏 / 安全）

1. **P1-NEW-v3-1**（agent.configure Strands 失效）→ StrandsAgentAdapter 加 update_model + clear_cache，_rpc_agent_configure override 路径调用
   - 工作量：中（需改 adapter.py + agents/__init__.py + 持有 adapter 引用）
   - 影响：Strands 模式下配置热更新
   - 建议：立即修复

2. **P1-NEW-v3-3**（SSH 审批无超时）→ rx.await 加 5min 超时 + 前端补 cancel 命令
   - 工作量：小（10 分钟）
   - 影响：用户关闭弹窗后 SSH 连接永久卡死
   - 建议：立即修复

3. **P1-NEW-v3-2**（toolCallId 配对错乱）→ 前端改 FIFO 队列或 Python 端发 tool_call_id
   - 工作量：小（前端 FIFO）/ 中（Python 端协议变更）
   - 影响：Strands 并发同名工具调用时工具行渲染错乱
   - 建议：短期前端 FIFO，长期 Python 端发 id

4. **P1-NEW-v3-4**（线程池退出卡死）→ 设 daemon 线程 + os._exit(0) 或 LLM HTTP 加超时
   - 工作量：小（os._exit）/ 中（LLM 超时）
   - 影响：sidecar 退出卡死
   - 建议：与 P1-NEW-v2-3（fix-loop）一起修复（都涉及 Strands 路径完善）

5. **P1-NEW-v2-3**（fix-loop 在 override 路径失效）→ adapter.invoke 集成 fix-loop 或用 Strands HookProvider
   - 工作量：中（需理解 Strands hook 机制）
   - 影响：Strands 模式安全护栏
   - 建议：与 Strands LimitToolCounts hook 一起实现

### 优先级 2（P2，改进建议）

6. **P2-NEW-v3-4**（emitTerminalData 缓冲区 buf 变量未更新）→ 补 uf = newBuf
   - 工作量：小（1 行）
   - 影响：缓冲区溢出时新数据丢失
   - 建议：立即修复（1 行改动）

7. **P2-NEW-v3-1**（timeout timer 未清理）→ finally clearTimeout
8. **P2-NEW-v3-2**（abortSignal listener 未移除）→ finally removeEventListener
9. **P2-NEW-v3-3**（SSH onExit 未 close transport）→ onExit 内调 s.pty.close()

### 优先级 3（v2 未修 P2，按需推进）

10. P2-NEW-v2-4（dedup_ts 死代码激活）
11. P2-NEW-v2-2（_extract_response_text 启发式）
12. P2-NEW-v2-1（max_iterations 死代码）
13. P2-NEW-v2-7/8/9（BackendPill 浅比 / sidecar.health import）

---

## 7. 审查文件清单

| # | 文件 | 行数 | 角色 | 审查动作 |
|---|------|------|------|----------|
| 1 | src-tauri/sidecar/main.py | 912 | Python Sidecar 入口 + 线程池 + Strands 注入 | 全量复读（v2 修复验证 + P1-NEW-v3-4） |
| 2 | src-tauri/sidecar/agents/__init__.py | 393 | Agent 注册表 + invoke_agent override + agent.configure | 全量复读（P1-NEW-v3-1） |
| 3 | src-tauri/sidecar/agents/base.py | 926 | BaseAgent PAOR + fix-loop + mock warning | 部分复读（P2-NEW-v2-4 验证） |
| 4 | src-tauri/sidecar/strands_backend/adapter.py | 792 | Strands 适配层 + Agent 缓存 + 事件转发 | 全量复读（v2 修复验证 + P1-NEW-v3-1） |
| 5 | src-tauri/sidecar/strands_backend/__init__.py | 139 | configure_strands 便捷函数 | grep 复读（P1-NEW-v3-1 验证） |
| 6 | src-tauri/sidecar/strands_backend/tools/__init__.py | 407+ | Strands 运维工具 + RiskChecker | grep 复读（fix-loop 集成验证） |
| 7 | src-tauri/src/modules/ssh/handler.rs | 309 | SSH 主机审批 + TOFU | 全量复读（P1-NEW-v3-3） |
| 8 | src-tauri/src/modules/ssh/session.rs | 425+ | SSH PTY 会话 | 部分复读（v2 已查） |
| 9 | src/modules/ai/lib/sidecar-adapter.ts | 698 | 前端 AI 对话流 + Sidecar 协议适配 | 全量复读（P1-NEW-v3-2 + P2-NEW-v3-1/2） |
| 10 | src/modules/ssh-explorer/SshTerminalHost.tsx | 125 | SSH 终端宿主 + transport 注入 | 全量复读（v2 修复验证 + P2-NEW-v3-3） |
| 11 | src/modules/ssh-explorer/sshStore.ts | 1123 | SSH 会话 store + 终端 fan-out | 部分复读（P2-NEW-v3-3/4） |
| 12 | src/modules/terminal/lib/useTerminalSession.ts | 1280 | 终端会话管理 + PTY/SSH transport | 部分复读（openPtyForSession + hook） |
| 13 | src/modules/ai/components/BackendPill.tsx | 288 | 后端类型指示器 | 全量复读（v2 修复验证） |
| 14 | src/modules/terminal/lib/pty-bridge.ts | 93 | TerminalTransport 接口 | 全量复读（v2 已查） |
| 15 | docs/reports/modded-agent-code-review-2026-07-30-v2.md | 1243 | v2 审查报告 | 全量复读（去重 + 修复验证） |

---

## 8. 简短总结

**v3 新发现数量**：P0=0，P1=4，P2=4

**最严重的 v3 新问题**：
1. **P1-NEW-v3-1**：gent.configure 在 Strands 模式下静默失效——仅更新 LangGraph 路径，Strands adapter.strands_model 和 _agent_cache 未更新，前端误报成功
2. **P1-NEW-v3-2**：sidecar 流协议按 tool_name 配对 toolCallId，Strands 并发同名工具调用时第二次 started 覆盖第一次的 id，导致工具行渲染错乱（tool-1 永远 pending，output 错配）
3. **P1-NEW-v3-3**：SSH 主机审批 x.await 无超时，用户关闭弹窗不点按钮时连接线程永久挂起 + registry 内存泄漏
4. **P1-NEW-v3-4**：_main_executor.shutdown(wait=False) 仍可能阻塞 sidecar 退出——Python ThreadPoolExecutor 线程默认非 daemon，atexit 时 _python_exit 会 join 所有非 daemon 线程

**v2 修复确认**：6 个 P1 中 5 个已正确修复，1 个未修（P1-NEW-v2-3 fix-loop）；P1-NEW-v2-6 部分修（wait=False 但仍卡死，见 P1-NEW-v3-4）。

**P2-NEW-v3-4 是隐藏 bug**：emitTerminalData 缓冲区溢出重建 newBuf 后，局部变量 uf 未更新为 newBuf，uf.push(bytes) push 到旧数组，新数据丢失。1 行修复。

**推荐修复优先级**：
1. P1-NEW-v3-1（agent.configure Strands 失效，需持有 adapter 引用）
2. P1-NEW-v3-3（SSH 审批无超时，10 分钟修复）
3. P2-NEW-v3-4（emitTerminalData buf 变量，1 行修复）
4. P1-NEW-v3-2（toolCallId 配对，前端 FIFO）
5. P1-NEW-v3-4（线程池退出，os._exit 或 daemon 线程）
6. P1-NEW-v2-3（fix-loop 集成，与 Strands hook 一起）
7. P2 改进项按需推进

**与 v2 的关系**：v2 的 P1-NEW-v2-1/2/4/5 已正确修复，P1-NEW-v2-6 部分修（wait=False 但 atexit 仍卡），P1-NEW-v2-3 未修。v2 的 9 个 P2 全部未修。v3 在 v2 基础上发现 4 个新 P1 + 4 个新 P2，主要集中在"配置热更新路径完整性"、"Strands 并发工具调用协议"、"资源生命周期管理"三个维度。

---

> **审查员**：GLM-5.2 子 Agent（代码审查模式 v3）
> **审查性质**：只读静态审查（未运行代码、未修改任何源文件）
> **报告生成**：2026-07-30
> **上一版本**：docs/reports/modded-agent-code-review-2026-07-30-v2.md
> **审查范围**：魔改 agent 适配层（重点）+ SSH 终端深度集成 + sidecar 流协议 + Rust SSH 后端
