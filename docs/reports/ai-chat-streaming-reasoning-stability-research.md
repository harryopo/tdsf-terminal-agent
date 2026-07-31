# AI 对话流式输出 / 深度思考 UI / 长对话稳定性 调研报告

> **位置**：`docs/reports/ai-chat-streaming-reasoning-stability-research.md`
> **类型**：只读分析报告（未修改任何源文件，未 commit）
> **生成**：2026-07-31
> **调研对象**：TDSF Terminal Agent（crynta/terax-ai v0.8.6 魔改版）
> **覆盖范围**：前端 `src/modules/ai/` + Rust `src-tauri/src/modules/sidecar.rs` + Python `src-tauri/sidecar/`

---

## 0. 调研目标与三个用户反馈

| 编号 | 用户反馈 | 简称 |
|------|----------|------|
| Q1 | 回复慢，流式输出需要等一阵子才输出 | 延迟问题 |
| Q2 | 没有深度思考的 UI 显示 | reasoning 缺失 |
| Q3 | 对话长了就会卡住，不回复了 | 稳定性问题 |

调研约束：只读分析、文件:行号定位、不泛泛而谈、Python sidecar 同样分析。

---

## 1. 当前实现链路全景

### 1.1 调用链

```
用户输入
  ↓
chatRuntime.ts: sendMessage(text)            ← 入口（line 183）
  ↓ c.sendMessage({ text })
Vercel AI SDK useChat
  ↓ transport.sendMessages
transport.ts: createContextAwareTransport  ← 路由分发（line 111）
  ├─ tdsfAgentId != null → runSidecarStream   ← Python 路径（line 140）
  └─ tdsfAgentId == null → runAgentStream       ← Vercel SDK 路径（line 166）
  ↓
sidecar-adapter.ts: runSidecarStream       ← 主流程（line 361）
  ├─ registerSidecarListeners               ← Tauri event 监听（line 270）
  ├─ invoke('ipc_invoke', {method:'agent.invoke'})
  │     ↓
  │   Rust ipc_invoke (src-tauri/src/modules/ipc.rs)
  │     ↓ stdin JSON-RPC
  │   Python MethodDispatcher
  │     ↓ agents/__init__._rpc_agent_invoke
  │   BaseAgent.invoke / MainAgent.invoke  ← PAOR 同步执行
  │     ↓ 单次返回完整 dict（observation / mood / tokens）
  │   Python stdout notification (mood_change / tool_call / agent_message)
  │     ↓ Rust reader_task
  │   Tauri emit("sidecar:*")
  │     ↓ 前端 listen
  │   registerSidecarListeners 收到 → onMood / onStep / onToolCall
  ↓
拿到完整 dict 后 → streamText 切片伪流式  ← 关键瓶颈点（line 241）
  ↓ yield text-delta / reasoning-delta
sidecarStreamToUIMessageStream 转换       ← line 561
  ↓ ReadableStream<UIMessageChunk>
useChat 消费 → AiChat.tsx 渲染
```

### 1.2 关键模块清单

| 层 | 文件 | 角色 |
|----|------|------|
| 入口 | `src/modules/ai/store/chatRuntime.ts` | 创建 Chat 实例，注入 transport 与 mood→status 映射 |
| 路由 | `src/modules/ai/lib/transport.ts` | 依据 tdsfAgentId 走 sidecar / Vercel SDK 分支 |
| 适配 | `src/modules/ai/lib/sidecar-adapter.ts` | 协议转换 + 伪流式切片 + Tauri event 监听 |
| 渲染 | `src/modules/ai/components/AiChat.tsx` | UIMessage parts 渲染，含 Reasoning 折叠 |
| 桥接 | `src/lib/sidecar-bridge.ts` | invokeRpc / subscribe 基础封装 |
| 状态 | `src/modules/ai/store/chatStore.ts` | zustand store，messages / sessions / agentMeta |
| Sidecar 进程 | `src-tauri/src/modules/sidecar.rs` | Rust 侧进程管理 + notification emit |
| Python 引擎 | `src-tauri/sidecar/agents/base.py` | BaseAgent PAOR 模板方法 |
| 路由 Agent | `src-tauri/sidecar/agents/main_agent.py` | 主 Agent 路由 8 子 Agent |
| 事件总线 | `src-tauri/sidecar/event_bus.py` | Python 内 pub-sub + Rust 推送 |

---

## 2. Q1 流式输出延迟 — 根因分析

### 2.1 根因 A：Python sidecar 是"同步阻塞 + 一次性返回"

**位置**：`src-tauri/sidecar/agents/base.py:191-390`

```python
def invoke(self, state: dict[str, Any]) -> dict[str, Any]:
    # === 1. Plan 阶段 ===
    self._emit_mood("thinking", session_id)         # line 222
    plan_tasks = self.plan_task(task_to_plan, state) # line 229

    # === 2. Act 阶段：选择工具并调用 ===
    self._emit_mood("working", session_id)            # line 244
    tool_call_result = self.call_tool(...)            # line 253  ← 阻塞

    # === 3. Observe 阶段 ===
    observation = self.format_observation(...)         # line 262

    # === 4. Reflect 阶段 ===
    reflection_result = self.reflect_on_result(state) # line 265
    ...
    return result.to_state_update()                   # line 365 ← 一次性返回
```

**结论**：BaseAgent.invoke() 是**同步阻塞**方法，PAOR 4 个阶段全部跑完才返回。期间没有任何 token 流式推送，仅靠 `_emit_mood` / `_emit_message` 推 mood 与 thinking 状态事件。

**关键证据**：`AgentResult.to_state_update()` (base.py:86-100) 返回的字段是 `observation / next_step / reflection / mood / intermediate_results / error`，**没有 streaming token 序列**。

### 2.2 根因 B：前端用切片模拟流式（伪流式）

**位置**：`src/modules/ai/lib/sidecar-adapter.ts:241-255`

```typescript
const STREAM_CHUNK_SIZE = 24;       // line 41
const STREAM_CHUNK_DELAY_MS = 8;    // line 44

async function* streamText(
  text: string,
  id: string,
  kind: "text" | "reasoning" = "text",
): AsyncIterable<SidecarStreamPart> {
  if (!text) return;
  for (let i = 0; i < text.length; i += STREAM_CHUNK_SIZE) {
    const delta = text.slice(i, i + STREAM_CHUNK_SIZE);
    yield kind === "reasoning"
      ? { type: "reasoning-delta", id, delta }
      : { type: "text-delta", id, delta };
    await new Promise((r) => setTimeout(r, STREAM_CHUNK_DELAY_MS));
  }
}
```

**结论**：拿到 Python 完整返回后，再按 24 字符切片 + 8ms 延迟"假装"流式。
- 用户感知延迟 = **Python 完整计算时间** + **打字时间**（每 24 字符 8ms ≈ 3000 字符/秒，5000 字需 1.7 秒额外延迟）。
- 期间用户只看到 spinner（AiChat.tsx:240-245），无法看到任何中间内容。

### 2.3 根因 C：30s 超时硬上限

**位置**：`src/modules/ai/lib/sidecar-adapter.ts:38`

```typescript
const SIDECAR_TIMEOUT_MS = 30_000;
```

`runSidecarStream` 在 `Promise.race` 中使用此超时（line 416-430）。复杂任务超过 30s 直接 `yield { type: "error" }`，前端显示"Sidecar 调用超时（30s）"。

### 2.4 根因 D：主 Agent 串行调用子 Agent，且子 Agent 内部又 5 步循环

**位置**：`src-tauri/sidecar/agents/main_agent.py:522-641`

```python
def _invoke_sub_agent(self, agent_name, task_content, state):
    MAX_SUB_ITER = 5                                   # line 569
    for step_idx in range(MAX_SUB_ITER):
        update = invoke_agent(agent_name, sub_state)   # line 574  ← 阻塞
        ...
        if update.get("next_step") in ("done", "error"):
            break
```

`MainAgent.invoke` 又在 plan_task 拆出多任务时循环调用 `_invoke_sub_agent`（main_agent.py:282-467）。最坏情况延迟 = `plan 长度 × 5 × 单步 invoke 时长`，每个子 Agent 调用都是串行阻塞。

### 2.5 根因 E：跨进程通知链路有固有延迟

**链路**：`Python send_notification → stdout → Rust reader_task 解析 → Tauri emit → 前端 listen 回调`

每条 mood/agent_message/tool_call 事件都走这条跨进程链路。虽然单条 < 5ms，但累积起来在长任务中可感知。

### 2.6 根因 F：用户已感知到的"等一阵子才输出"具体场景

- 用户问题需要 main_agent 路由（额外 1 次 invoke）
- 子 Agent plan_task 拆出多步（每步一次 invoke_agent）
- 子 Agent 调工具（call_tool 同步阻塞 RustBridge → Rust → SSH/本地 PTY）
- 子 Agent 反思调 LLM（teach_agent 调 call_llm，网络往返）
- 上述全部完成 → 一次性返回前端 → 前端再切片"打字"

---

## 3. Q2 缺少深度思考 UI — 根因分析

### 3.1 根因 A：`agent_message` 事件被显式"暂不处理"

**位置**：`src/modules/ai/lib/sidecar-adapter.ts:264-268`

```typescript
// v2026-07-29: 主 Agent 路由子 Agent 事件
// ...
// Line 264: "agent_message" event is received but not processed
//   - sidecar:agent_message: Agent 中途推送的消息片段（暂不处理，预留）
```

`registerSidecarListeners` (line 270-339) 只 listen 了三件事：
- `EVENT_MOOD_CHANGE` (line 281) → `onMood`
- `EVENT_TOOL_CALL` (line 297) → `onStep` + `onToolCall`
- `EVENT_AGENT_SWITCH` (line 316) → `chatStore.setCurrentSubAgent`

**完全没有 listen `sidecar:agent_message`**。Python 端通过 `BaseAgent._emit_message("thinking", content, ...)` (base.py:713-746) 推送的 thinking 内容到了前端被丢弃。

### 3.2 根因 B：reasoning-delta 只能来自 `result.thinking` 字段，而 Python 根本不返回该字段

**位置**：`src/modules/ai/lib/sidecar-adapter.ts:488-491`

```typescript
// 7. 流式输出 thinking（如有）作为 reasoning 折叠段（Reasoned）
if (result.thinking) {
  onStep?.("Thinking");
  yield* streamText(result.thinking, thinkingId, "reasoning");
}
```

`AgentInvokeResult.thinking` 字段定义在 line 139，但 Python `AgentResult.to_state_update()` (base.py:86-100) 只产出：

```python
update: dict[str, Any] = {
    "observation": self.observation,
    "next_step": self.next_step,
    "reflection": self.reflection,
    "mood": self.mood,
}
if self.intermediate_results:
    update["intermediate_results"] = self.intermediate_results
if self.error:
    update["error"] = self.error
update.update(self.extra_update)
```

**没有 `thinking` 字段**。`MainAgent.invoke` 返回 (main_agent.py:446-467) 也没 thinking。结果：`result.thinking` 永远 undefined，`streamText` 直接 return，`reasoning-delta` 永远不 yield。

### 3.3 根因 C：AiChat.tsx 的 Reasoning 渲染分支永远不触发

**位置**：`src/modules/ai/components/AiChat.tsx:676-685`

```typescript
if (part.type === "reasoning") {
  return (
    <Reasoning>
      <ReasoningTrigger />
      <ReasoningContent>
        {(part as unknown as { text: string }).text}
      </ReasoningContent>
    </Reasoning>
  );
}
```

由于 sidecarStreamToUIMessageStream 只在收到 `reasoning-delta` part 时才 emit `reasoning-start`/`reasoning-delta` chunk（sidecar-adapter.ts:612-624），而 reasoning-delta 永远不来（见 3.2），消息 parts 永远不含 `type: "reasoning"`，此分支永远不进入。

### 3.4 根因 D：mood="thinking" 一闪即过

**位置**：`src-tauri/sidecar/agents/base.py:222-244`

```python
self._emit_mood("thinking", session_id)   # line 222  ← Plan 阶段开始
plan_tasks = self.plan_task(...)            # line 229
...
self._emit_mood("working", session_id)     # line 244  ← 立即切到 working
```

`thinking` mood 仅在 plan_task() 期间存活（通常 < 5ms）。前端 chatRuntime.ts:38-56 把 `thinking` 映射到 `AgentRunStatus = "thinking"`，AiChat.tsx:190 `isBusy = status === "submitted" || status === "streaming"`，**thinking status 不在 isBusy 内**，spinner 显示文本是 `step ?? "Thinking…"`（line 243），但 `step` 在 onStep 回调未触发时为 null。

### 3.5 根因 E：旧 AgentPanel.tsx 订阅了 agent_message，但已不在主对话流上

**位置**：`src/components/AgentPanel.tsx:99-117`

```typescript
subscribe('agent_message', (payload) => {
  const p = payload as { content?: string; type?: AgentMessageType; ... };
  if (p.content) {
    dispatch({ type: 'add-agent-message', message: { ... } });
  }
}).then((un) => unlistens.push(un));
```

此 AgentPanel.tsx 是 P2-A 阶段的旧实现，使用 `useRuntime()` + dispatch reducer（旧 sidecar runtime store）。TDSF 阶段3 已切到 `useChat` (Vercel SDK) + sidecar-adapter 路径，主对话 UI 是 `src/modules/ai/components/AiChat.tsx`。

旧 AgentPanel 若仍渲染（如浮动卡片），它订阅的事件会推到独立的旧 store，**与新对话流互不相通**，用户在主对话里看不到 thinking 内容。

### 3.6 根因 F：`_emit_message` 推送的 thinking 内容数据形态

**位置**：`src-tauri/sidecar/agents/base.py:713-746`

```python
def _emit_message(self, content, message_type="output", session_id="", extra=None):
    payload = {
        "content": content,
        "type": message_type,           # "thinking" / "working" / "output" / "tool_call"
        "agent": self.name,
    }
    ...
    self.event_bus.publish(Event(
        event_type=EventType.AGENT_MESSAGE.value,
        payload=payload,
        ...
    ))
```

`MainAgent.invoke` 内多处调用 `_emit_message`：
- line 321: `f"规划完成，共 {len(plan)} 个子任务"` type=`thinking`
- line 560: `f"路由到 {agent_name} Agent: ..."` type=`thinking`
- line 587: `f"子 Agent {agent_name} 第 {step_idx+1} 步: ..."` type=`tool_call`

这些事件 payload 完整可用，但前端未消费 → reasoning/thinking 流式 UI 完全空缺。

---

## 4. Q3 对话长了卡住 — 根因分析

### 4.1 根因 A：chatStore.messages 无上限，messages 数组无限增长

**位置**：`src/modules/ai/store/chatStore.ts:111-198`

StoreState 类型定义中 messages 字段未在 store 直接持有（由 useChat 内部维护），但 `persistMessages` (line 451-478) 把全部 messages 通过 `saveMessages(id, entry.latest)` 写盘，无裁剪逻辑。

### 4.2 根因 B：transport 把全量历史每次都传给 Python

**位置**：`src/modules/ai/lib/transport.ts:140-158`

```typescript
const sidecarStream = runSidecarStream({
  agentId: tdsfAgent,
  messages: messagesForRun,   // ← 全量历史
  input,
  live,
  ...
});
```

`sidecar-adapter.ts:441-450` 又通过 JSON-RPC 把全量 messages 传给 Python：

```typescript
const raw = await Promise.race([
  invoke<AgentInvokeResult>("ipc_invoke", {
    method: "agent.invoke",
    params: {
      name: pythonName,
      state: { input, messages, live },   // ← 全量历史
    },
  }),
  timeout,
]);
```

JSON 序列化 + IPC 跨进程传输 + Python 反序列化，随消息数线性增长。

### 4.3 根因 C：`long_context.py` 默认 disabled 且 agent 路径不调用

**位置**：`src-tauri/sidecar/long_context.py:88-93`

```python
def __init__(
    self,
    enabled: bool = False,                            # ← 默认关闭
    max_tokens_per_chunk: int = _DEFAULT_MAX_TOKENS_PER_CHUNK,
    summary_max_tokens: int = _DEFAULT_SUMMARY_MAX_TOKENS,
) -> None:
```

且该模块只通过 JSON-RPC 方法 `long_context.chunk/merge/summarize/status` 暴露（long_context.py 顶部 docstring 第 18-22 行），**BaseAgent / MainAgent / TeachAgent 都不主动调用它**。grep 显示仅在 `tests/test_long_context.py` 测试中引用。

### 4.4 根因 D：Python 侧无 token 预算 / 消息裁剪

**位置**：`src-tauri/sidecar/agents/base.py:526-564` (call_llm)

```python
def call_llm(self, messages: list[dict[str, Any]]) -> str:
    self._stats["llm_calls"] += 1
    if self.llm_call is not None:
        try:
            return self.llm_call(messages)   # ← messages 原样传入，无裁剪
```

只有 TeachAgent 会调 `call_llm`（teach_agent.py），其他 Agent 走 mock LLM。但 TeachAgent 也没做 token 预算控制，messages 越长 LLM API 越慢、越易超时。

### 4.5 根因 E：事件监听器在 `await listen` 期间可能泄漏

**位置**：`src/modules/ai/lib/sidecar-adapter.ts:270-339, 406, 529`

```typescript
async function registerSidecarListeners(...) {
  const unlisteners: UnlistenFn[] = [];

  if (onMood) {
    try {
      unlisteners.push(
        await listen<{ mood?: string }>(EVENT_MOOD_CHANGE, (e) => {  // ← listen 是 Promise
          ...
        }),
      );
    } catch { /* 非 Tauri 环境（如 vitest）listen 会 reject，忽略 */ }
  }
  ...
  return () => {
    for (const un of unlisteners) {
      try { un(); } catch { /* ignore */ }
    }
  };
}
```

`runSidecarStream` 用法：

```typescript
// line 406
const unlisten = await registerSidecarListeners(onMood, onStep, onToolCall);
try {
  ...
} finally {
  unlisten();   // line 529
}
```

**风险场景**：若 `await registerSidecarListeners` 内部某个 `await listen(...)` 尚未 resolve 时被外部 abortSignal 取消，`unlisten` 仍是空数组，已注册的 listener 无法清理。多次 sendMessage 累积 → 监听器泄漏 → 性能下降。

### 4.6 根因 F：CHATS_LRU_CAP=8 但 evict 不删持久化数据

**位置**：`src/modules/ai/store/chatStore.ts:213-227`

```typescript
const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();

export function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  while (chats.size > CHATS_LRU_CAP) {
    const oldest = chats.keys().next().value;
    if (!oldest || oldest === id) break;
    if (useChatStore.getState().activeSessionId === oldest) break;
    flushPersistEntry(oldest);
    void chats.get(oldest)?.stop();
    chats.delete(oldest);
  }
}
```

evict 只 `chats.delete(oldest)`，**不删 `seedMessages` / `pendingPersist` / IndexedDB 持久化数据**。切回旧 session 时 `switchSession` (chatStore.ts:390-408) 会重新 `loadMessages(id)` 全量加载，长会话仍是巨量消息。

### 4.7 根因 G：ConfidenceMarker 每条 assistant 消息都异步评分

**位置**：`src/modules/ai/components/AiChat.tsx:332-386`

```typescript
const ConfidenceMarker = memo(function ConfidenceMarker({ message, streaming, children }) {
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    if (streaming) { setScore(null); return; }
    if (message.role !== "assistant") return;
    const text = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (!text.trim()) return;
    let cancelled = false;
    void scoreConfidenceRpc(text).then((r) => {       // ← 每条消息都调 RPC
      if (!cancelled) setScore(r.score);
    });
    return () => { cancelled = true; };
  }, [streaming, message.role, message.parts]);
  ...
});
```

长对话累积 N 条 assistant 消息 → N 个并发 `scoreConfidenceRpc` Promise。RPC 走 Rust → Python → 评分逻辑，若 Python 侧忙（处理新消息）会排队，导致评分 Promise 长期未决，组件 useEffect 闭包无法释放。

### 4.8 根因 H：persistMessages 300ms debounce 在长对话中不够

**位置**：`src/modules/ai/store/chatStore.ts:236-256, 451-478`

```typescript
const PERSIST_DEBOUNCE_MS = 300;
```

`saveMessages` 把 messages 数组 JSON 序列化写盘。长对话 messages 可能几 MB，序列化 + IO 单次数百毫秒。streaming 期间每个 chunk 都触发 `persistMessages`，300ms debounce 后仍可能跟上一次写盘未完成，造成 IO 队列堆积。

### 4.9 根因 I：AiChat.tsx groups.map 全量重渲染

**位置**：`src/modules/ai/components/AiChat.tsx:443-472`

```typescript
<ConfidenceMarker message={message} streaming={streaming}>
  <div className="flex flex-col gap-3">
    {groups.map((g) => {                              // ← 全量 map
      if (g.kind === "reads") { return (<PartAppear ...><ReadGroup .../></PartAppear>); }
      ...
      return (
        <PartAppear key={`${message.id}-${g.key}`}>
          <RenderedPart part={g.part} ... />
        </PartAppear>
      );
    })}
  </div>
</ConfidenceMarker>
```

每个 message 的 `groups` 由 `buildPartGroups(message.parts)` 构建（line 502-533）。`RenderedPart` (line 659-700) 是 `memo`，但 `streaming` prop 变化会触发所有 part 重渲染。长对话 streaming 时，最后一条 assistant 消息的所有 part 都在 re-render。

### 4.10 根因 J：Vercel SDK useChat 把 streaming 累积到 messages

Vercel AI SDK 的 `useChat` 默认把每个 chunk 通过 React state 更新合并到 messages 数组。每个 text-delta chunk 触发一次 setState → 一次 re-render。长消息 + 长历史下，每次 re-render 都遍历所有 messages × all parts，React 调和成本 O(N×M)。

---

## 5. 最佳实践对比

### 5.1 Vercel AI SDK 官方流式协议

参考 Vercel AI SDK v7（项目已用 `ai` 包 + `@ai-sdk/react`）：

| 特性 | 官方推荐 | TDSF 当前 | 差距 |
|------|----------|-----------|------|
| Token 级流式 | `streamText()` 返回 `StreamTextResult`，通过 `fullStream` async iterable 直接 yield token | Python 一次性返回 dict + 前端切片模拟 | **核心缺失** |
| Reasoning UI | `reasoning-start` / `reasoning-delta` / `reasoning-end` chunk（已实现于 sidecarStreamToUIMessageStream:586-624） | 协议层已支持，但 `reasoning-delta` 永远不来 | 数据源未接 |
| Tool call streaming | `tool-input-available` + `tool-output-available`（已实现 line 625-657） | 已正确接入 sidecar:tool_call 事件 | ✅ |
| 消息压缩 | `onStepFinish` + `prepareStep` 回调，可在每步前裁剪历史 | 全量 messages 传给 Python | **未实现** |
| 错误降级 | `onError` + `repairText` | yield error + 用户 dismiss | 部分 |

### 5.2 LangChain / LangGraph 流式模式

LangGraph（sidecar/graph/ 已有雏形）：
- **`astream_events` v2**：节点内部每个 LLM 调用都通过 `astream_events` 推 `on_chat_model_stream` 事件，token 级流式。
- **`send` API**：并行 fan-out 多个子图，避免串行累加。
- **`Checkpoint` + `Memory`**：长期记忆压缩，超过阈值自动 summarize 旧消息。

TDSF 当前 graph/nodes.py 未启用流式，main_agent 直接调 `invoke_agent`（同步函数）。

### 5.3 Anthropic Claude Code 模式（同项目类型参考）

- **Streaming-first**：所有 LLM 调用默认 stream，通过 SSE 直接推 token。
- **Context compaction**：上下文接近限制时自动 summarize 旧 turn，保留最近 N 轮 + summary。
- **Tool call 实时**：tool 执行进度实时推送（input/output 分别 stream）。

### 5.4 React 长列表最佳实践

- **虚拟滚动**：长对话应用 `react-virtuoso` / `@tanstack/react-virtual`，仅渲染可见消息。
- **消息分组**：按日期分组 + 折叠旧消息。
- **streaming 隔离**：streaming 中的消息用独立 React state，避免触发列表 re-render。

TDSF AiChat.tsx 当前 `messages.map` 全量渲染，无虚拟化。

---

## 6. 修复建议（按优先级 P0/P1/P2）

### P0-1 接入 `agent_message` 事件流式推送 thinking（解决 Q2 + 缓解 Q1）

**改 `sidecar-adapter.ts`**：

1. 在 `SidecarStreamOptions` 增加 `onThinking?: (delta: string) => void`。
2. 在 `registerSidecarListeners` 增加 `sidecar:agent_message` 监听：

```typescript
// 新增常量（与 src-tauri/src/modules/ipc.rs 对齐）
const EVENT_AGENT_MESSAGE = "sidecar:agent_message";

async function registerSidecarListeners(
  onMood?, onStep?, onToolCall?,
  onThinking?,  // 新增
): Promise<() => void> {
  ...
  // 新增 agent_message 订阅
  if (onThinking) {
    try {
      unlisteners.push(
        await listen<{
          content?: string;
          type?: string;  // "thinking" / "working" / "output" / "tool_call"
          agent?: string;
        }>(EVENT_AGENT_MESSAGE, (e) => {
          const p = e.payload;
          if (!p) return;
          // 只处理 thinking / working 类，避免 output 与最终 observation 重复
          if (p.type === "thinking" || p.type === "working") {
            if (p.content) onThinking?.(p.content);
          }
        }),
      );
    } catch { /* 非 Tauri 环境 */ }
  }
  ...
}
```

3. 在 `runSidecarStream` 中：

```typescript
let thinkingBuffer = "";
const onThinking = (delta: string) => {
  thinkingBuffer += delta + "\n";
};

// 注册监听
const unlisten = await registerSidecarListeners(
  onMood, onStep, onToolCall, onThinking,
);

try {
  onStep?.("调用 Sidecar Agent");

  // 在 invoke 之前就开始 yield reasoning-delta（实时）
  // 用一个独立的 async iterator 把 thinkingBuffer 增量推出
  // ...
  
  // invoke 完成后，把剩余 thinkingBuffer 作为 reasoning-delta yield
  if (thinkingBuffer.trim()) {
    onStep?.("Thinking");
    yield* streamText(thinkingBuffer, thinkingId, "reasoning");
  }
  ...
}
```

**影响**：
- 修复 Q2（thinking UI 实时显示）。
- 缓解 Q1（用户在 Python 计算期间就能看到 thinking 内容，感知延迟大幅降低）。
- Python 端无需改动，event_bus 已正确推送 agent_message。

**风险**：
- thinking 内容可能重复（plan + route + sub-step）。建议去重或分多段 reasoning。
- `agent_message` payload 格式与 `MessagePart.reasoning` 协议需对齐。

### P0-2 Python 端暴露 `thinking` 字段（备选方案 / 与 P0-1 二选一）

**改 `src-tauri/sidecar/agents/base.py`**：

在 `AgentResult` 增加 `thinking: str = ""` 字段，`to_state_update()` 输出该字段。

```python
@dataclass
class AgentResult:
    observation: str = ""
    thinking: str = ""                                  # 新增
    intermediate_results: list[dict[str, Any]] = field(default_factory=list)
    ...

    def to_state_update(self) -> dict[str, Any]:
        update: dict[str, Any] = {
            "observation": self.observation,
            "thinking": self.thinking,                  # 新增
            "next_step": self.next_step,
            ...
        }
```

各 Agent 在 `invoke()` 中累积 thinking 文本（如 plan + tool_call 描述 + reflection），赋给 `result.thinking`。

**前端**：sidecar-adapter.ts:488-491 已有 `if (result.thinking)` 分支，自动生效。

**对比 P0-1**：
- P0-1 更实时（事件流式），P0-2 实现更简单（字段拼接）。
- 推荐组合：P0-1 推实时增量 + P0-2 推最终总结。

### P0-3 移除 30s 超时或改为可配置

**改 `sidecar-adapter.ts:38`**：

```typescript
// 从常量改为 options 参数
const SIDECAR_TIMEOUT_MS_DEFAULT = 60_000;  // 默认提升到 60s
// 或完全移除超时，依赖 abortSignal
```

更彻底的方案：移除 `Promise.race` 的超时分支，依赖用户主动点 Stop（abortSignal）。Python sidecar 应有自己的内部超时（如 LLM API 30s），不要在前端硬切。

### P0-4 接入消息压缩（解决 Q3 核心）

**改 `src-tauri/sidecar/agents/base.py` invoke 流程**：

在 `invoke` 入口检查 `state["messages"]` 长度：

```python
def invoke(self, state: dict[str, Any]) -> dict[str, Any]:
    # 新增：消息历史压缩
    messages = state.get("messages", [])
    if len(messages) > 20:  # 阈值可配置
        try:
            from long_context import LongContextManager
            mgr = LongContextManager(enabled=True)
            # 保留最近 10 条 + 旧消息 summarize
            recent = messages[-10:]
            old = messages[:-10]
            old_text = "\n".join(self._serialize_messages(old))
            summary = mgr.summarize(old_text, max_tokens=2000)
            state["messages"] = [
                {"role": "system", "content": f"Earlier conversation summary:\n{summary}"},
                *recent,
            ]
            # 推送 compaction 通知
            self._emit_message(
                f"已压缩 {len(old)} 条旧消息", "working", state.get("session_id", ""),
                extra={"compacted_count": len(old)},
            )
        except Exception as e:
            logger.warning(f"long_context compaction failed: {e}")
    
    # 继续 PAOR 流程...
```

**前端**：transport.ts 在 sendMessage 前也可做客户端裁剪，仅传最近 N 条 + summary。

### P1-1 修复事件监听器泄漏（解决 Q3 长期使用）

**改 `sidecar-adapter.ts:registerSidecarListeners`**：

用 `Promise.allSettled` 等所有 listen resolve 后再返回 unlisten，并支持 abortSignal 取消：

```typescript
async function registerSidecarListeners(
  onMood?, onStep?, onToolCall?, onThinking?,
  abortSignal?,  // 新增
): Promise<() => void> {
  const pending: Promise<UnlistenFn>[] = [];
  
  if (onMood) {
    pending.push(listen<{ mood?: string }>(EVENT_MOOD_CHANGE, (e) => {
      const mood = e.payload?.mood;
      if (mood) onMood(mood);
    }).catch(() => null as UnlistenFn));
  }
  // ... 其他 listener 同样推入 pending
  
  const resolved = await Promise.allSettled(pending);
  const unlisteners = resolved
    .filter((r): r is PromiseFulfilledResult<UnlistenFn> => r.status === "fulfilled")
    .map(r => r.value)
    .filter((fn): fn is UnlistenFn => fn !== null);
  
  // abortSignal 触发时立即取消所有已注册 listener
  const onAbort = () => unlisteners.forEach(un => { try { un(); } catch {} });
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }
  
  return () => {
    unlisteners.forEach(un => { try { un(); } catch {} });
    abortSignal?.removeEventListener("abort", onAbort);
  };
}
```

### P1-2 长对话虚拟化（解决 Q3 渲染压力）

**改 `AiChat.tsx`**：

引入 `react-virtuoso`：

```bash
pnpm add react-virtuoso
```

```typescript
import { Virtuoso } from "react-virtuoso";

// 替换 ConversationContent 内的 messages.map
<Virtuoso
  data={messages}
  itemContent={(index, m) => (
    <RenderedMessage key={m.id} message={m} onApproval={onApproval} ... />
  )}
  followOutput={'smooth'}
  className="flex-1"
/>
```

### P1-3 ConfidenceMarker 限流（解决 Q3 评分 Promise 累积）

**改 `AiChat.tsx:343-361`**：

```typescript
useEffect(() => {
  if (streaming) { setScore(null); return; }
  if (message.role !== "assistant") return;
  // 新增：仅对最近 5 条 assistant 消息评分
  if (index < messages.length - 5) return;
  // ... 其余逻辑
}, [streaming, message.role, message.parts, index, messages.length]);
```

或更彻底：把 ConfidenceMarker 改为按需触发（hover 时才评分）。

### P1-4 前端消息裁剪（解决 Q3 网络传输）

**改 `transport.ts:140-158`**：

```typescript
const sidecarStream = runSidecarStream({
  agentId: tdsfAgent,
  // 仅传最近 20 条 + 系统消息，避免全量历史
  messages: trimMessages(messagesForRun, { keepLast: 20 }),
  input,
  live,
  ...
});

function trimMessages(msgs: UIMessage[], opts: { keepLast: number }): UIMessage[] {
  if (msgs.length <= opts.keepLast) return msgs;
  return msgs.slice(-opts.keepLast);
}
```

### P2-1 子 Agent 并行调用（缓解 Q1）

`MainAgent.invoke` 的 plan_task 拆出多任务时（如 `[coding] 修复 + [teach] 讲解`），目前串行调用 `_invoke_sub_agent`。

**改 `main_agent.py:282-467`**：用 `concurrent.futures.ThreadPoolExecutor` 并行执行无依赖的子任务：

```python
from concurrent.futures import ThreadPoolExecutor

# 在 invoke 内部
independent_tasks = [t for t in plan if not t.depends_on_others]
with ThreadPoolExecutor(max_workers=4) as executor:
    futures = {
        executor.submit(self._invoke_sub_agent, prefix, content, state): prefix
        for prefix, content in independent_tasks
    }
    for future in concurrent.futures.as_completed(futures):
        result = future.result()
        # 合并 observation
```

**风险**：event_bus 是线程安全的（threading.RLock，event_bus.py:144-160），但子 Agent 内部状态（如 `_stats`、`_mock_warning_emitted`）非线程安全，需评估。

### P2-2 改用 LangGraph astream_events（架构级）

`src-tauri/sidecar/graph/` 已有 LangGraph 雏形。改用 LangGraph 的 `astream_events` v2，让每个 LLM 调用都通过事件流推送 token。前端直接订阅事件流，无需切片模拟。

**改动量大**，建议作为长期演进方向，不在本次修复范围。

### P2-3 Reasoning 折叠 UI 优化

当前 AiChat.tsx:676-685 的 `Reasoning` 组件来自 `@/components/ai-elements/reasoning`（terax 上游）。默认折叠态展示 `ReasoningTrigger`，展开后展示 `ReasoningContent`。

建议：
- 折叠态显示 thinking 摘要前 50 字。
- 流式 thinking 时自动展开。
- thinking 结束后自动折叠。

---

## 7. 风险与影响评估

| 修复项 | 影响文件 | 风险等级 | 验证方式 |
|--------|----------|----------|----------|
| P0-1 接入 agent_message 事件 | sidecar-adapter.ts | 中（事件协议可能不一致） | CDP 9222 抓事件 payload 比对 |
| P0-2 Python 暴露 thinking 字段 | base.py / main_agent.py / teach_agent.py | 低（纯增量字段） | Python 单测 test_agents.py |
| P0-3 移除 30s 超时 | sidecar-adapter.ts | 低（abortSignal 已有） | 手动 Stop 测试 |
| P0-4 消息压缩 | base.py / long_context.py | 中（压缩可能丢上下文） | 长对话 e2e 测试 |
| P1-1 监听器泄漏修复 | sidecar-adapter.ts | 低（纯重构） | 现有单测 sidecar-adapter.test.ts |
| P1-2 虚拟化 | AiChat.tsx + package.json | 中（依赖 +1） | 视觉回归 |
| P1-3 Confidence 限流 | AiChat.tsx | 低（纯条件判断） | 长对话测试 |
| P1-4 前端消息裁剪 | transport.ts | 中（Python 看不到完整历史） | 多轮对话一致性 |
| P2-1 子 Agent 并行 | main_agent.py | 高（线程安全） | 现有 Python 测试 + 压测 |
| P2-2 LangGraph 流式 | graph/* | 极高（架构级重构） | 全量回归 |

---

## 8. 验证清单

修复后应通过：

- [ ] **五绿门禁**：`pnpm typecheck && pnpm lint && pnpm test && pnpm build:web && pnpm tauri:dev`
- [ ] **流式感知**：发送复杂问题（如"解释 nginx systemctl 命令并修复配置"），用户在 1s 内看到 thinking 内容
- [ ] **Reasoning 渲染**：消息 parts 中出现 `type: "reasoning"`，Reasoning 折叠组件可见
- [ ] **长对话不卡**：连续对话 50 轮，UI 响应时间 < 200ms
- [ ] **无监听器泄漏**：DevTools Memory 快照对比，多次 sendMessage 后 listener 数稳定
- [ ] **Confidence 评分限流**：长对话中旧消息不触发 scoreConfidenceRpc
- [ ] **Python 单测全过**：`cd src-tauri/sidecar && python -m pytest tests/`

---

## 9. 关键文件路径索引

### 前端

| 文件 | 关键行 | 角色 |
|------|--------|------|
| `src/modules/ai/store/chatRuntime.ts` | 38-56, 77-153 | mood→status 映射、transport 注入 |
| `src/modules/ai/store/chatStore.ts` | 111-198, 213-227, 451-478 | store 定义、LRU、persist debounce |
| `src/modules/ai/lib/transport.ts` | 111-205 | sidecar/Vercel 路由分发 |
| `src/modules/ai/lib/sidecar-adapter.ts` | 38-44, 241-255, 264-339, 361-531, 561-697 | **核心瓶颈**：超时、伪流式、agent_message 未接入 |
| `src/modules/ai/components/AiChat.tsx` | 197-275, 332-386, 443-472, 676-700 | 渲染逻辑、Reasoning 分支、ConfidenceMarker |
| `src/lib/sidecar-bridge.ts` | 110-123, 221-235 | invokeRpc / subscribe 基础封装 |

### Python sidecar

| 文件 | 关键行 | 角色 |
|------|--------|------|
| `src-tauri/sidecar/agents/base.py` | 86-100, 191-390, 526-564, 713-746 | AgentResult / invoke / call_llm / _emit_message |
| `src-tauri/sidecar/agents/main_agent.py` | 113-208, 282-467, 522-641 | plan_task / invoke / _invoke_sub_agent |
| `src-tauri/sidecar/agents/teach_agent.py` | 53-67, 99+ | 唯一调 call_llm 的子 Agent |
| `src-tauri/sidecar/event_bus.py` | 48-65, 230-289, 387-411 | EventType / publish / emit_agent_message |
| `src-tauri/sidecar/long_context.py` | 67-108 | LongContextManager（默认 disabled） |

### Rust

| 文件 | 角色 |
|------|------|
| `src-tauri/src/modules/sidecar.rs` | Sidecar 进程管理 + reader_task notification emit |
| `src-tauri/src/modules/ipc.rs` | ipc_invoke / ipc_notify 命令 |

---

## 10. 总结

### Q1 流式延迟
- **核心根因**：Python sidecar 同步返回完整 dict + 前端 24 字符切片伪流式 + 30s 超时硬上限 + 子 Agent 串行 5 步循环。
- **最简修复**：P0-1 接入 agent_message 事件（让用户在 Python 计算期间就看到 thinking） + P0-3 移除/放宽 30s 超时。

### Q2 Reasoning UI 缺失
- **核心根因**：`sidecar-adapter.ts:264` 显式"暂不处理"agent_message 事件 + Python `AgentResult` 不返回 `thinking` 字段 + AiChat.tsx Reasoning 分支永远不触发。
- **最简修复**：P0-1（监听 agent_message 推 reasoning-delta）+ P0-2（Python 端 AgentResult 增 thinking 字段）。两者二选一或组合。

### Q3 长对话卡住
- **核心根因**：messages 全量传 Python（无裁剪）+ long_context.py 默认 disabled + 事件监听器可能泄漏 + ConfidenceMarker 每条都评分 + 无虚拟化。
- **最简修复**：P0-4 接入消息压缩 + P1-1 修复监听器泄漏 + P1-3 Confidence 限流。

### 优先级建议
1. **先做 P0-1 + P0-2**（修 Q1+Q2，影响最大，改动集中在 sidecar-adapter.ts + base.py）
2. **再做 P0-4 + P1-1**（修 Q3，关键稳定性）
3. **最后 P1-2/P1-3/P1-4**（性能优化）
4. P2 项作为长期演进，不在本次范围

---

> **说明**：本报告为只读分析，未修改任何源文件，未 commit。所有结论均基于代码静态分析 + 行号定位。建议实施前在 CDP 9222 实际抓事件 payload 验证字段格式。
