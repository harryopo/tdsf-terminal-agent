# AI 对话/主题/翻译/Skill 综合调研报告

> **位置**：`docs/reports/ai-theme-translate-streaming-research-2026-07-31.md`
> **日期**：2026-07-31
> **调研方法**：多子 agent 并行调研 + 主 agent 深度代码审查
> **上游参考**：https://github.com/crynta/terax-ai（v0.8.6 魔改基线）
> **范围**：AI 对话流式输出 / 深度思考 UI / 长对话稳定性 / 主题浅色模式 / SSH 翻译划词 / AI skill 调用 / 工具流式 UI

---

## 0. 调研结论摘要

| 问题 | 根因 | 修复优先级 | 修复规模 |
|------|------|------------|----------|
| Q1 流式输出延迟 | Python 同步阻塞 + 前端伪流式切片 + `sidecar:agent_message` 事件被显式忽略 | P1 | 中 |
| Q2 无深度思考 UI | 前端 UI 已就绪（`Reasoning` 组件），但 Python `to_state_update()` 不返回 thinking + 事件被忽略 | P1 | 小 |
| Q3 工具读写不流式 | `collectedTools` 在 invoke 完成后一次性 yield（L496-501），非实时 | P1 | 中 |
| Q4 长对话卡住 | 30s 硬超时 + messages 全量传输无裁剪 + `long_context` 模块未启用 | P2 | 中 |
| Q5 浅色模式缺失 | `terax-default` light 变体为空对象 + `:root` 默认变量已存在但可能被覆盖 | P3 | 小 |
| Q6 SSH 翻译划词 | 修复**已存在**（onLeafId 上报 + sshActiveLeafIdRef 优先），可能颜色适配问题 | P3 | 小 |
| Q7 AI 无法调用 skill | Sidecar 路径只调 Python `agent.invoke`，前端 `buildTools` 未接入 | P4 | 大 |

**关键发现**：Q1/Q2/Q3 是同一根因（前端忽略 `sidecar:agent_message` 事件），可一次性修复。

---

## 1. 上游 terax-ai 实现分析

### 1.1 AI 对话流式架构（上游）
上游 terax-ai 使用 **Vercel AI SDK v7** 原生流式：
- `streamText()` 返回 `StreamTextResult`，天然支持 `text-delta` / `reasoning-delta` / `tool-input` / `tool-output` 流式 chunk
- `useChat` 直接消费 `toUIMessageStream()`，无需手动切片
- 工具调用通过 `tools` 参数注册，SDK 自动处理 `tool-call` / `tool-result` 配对
- 深度思考通过模型原生 reasoning（如 Claude `thinking` 字段）+ `reasoning-delta` chunk 实现

### 1.2 主题系统（上游）
上游 terax-ai 主题系统：
- `ThemeProvider` 支持 dark/light/system 三模式
- 16 内置主题（terax-default / tokyo-night / catppuccin / dracula / nord / ...）
- `terax-default` 主题 light/dark 变体都是空对象 → 使用 `globals.css` 原生 CSS 变量
- `:root` 默认浅色变量 + `.dark` 暗色覆盖
- 主题切换通过 `setMode()` 持久化到 localStorage

### 1.3 翻译模块（上游）
上游无翻译模块（本项目 TDSF 魔改原创）。本项目实现：
- `useTranslateSelection` 监听 window `mouseup` 事件
- `isInContentArea` 检查 `.xterm, .cm-editor` 类
- `TranslateTooltip` 渲染翻译卡片，使用 `bg-card/95 + backdrop-blur-md`

### 1.4 工具调用 UI（上游）
上游 terax-ai 用 Vercel SDK 原生 `tool-input-available` / `tool-output-available` chunk，`AiChat.tsx` 通过 `RenderedTool` 组件渲染工具行，支持 `dynamic-tool` 和 `tool-*` 两种 part 类型。

---

## 2. 本项目实现现状

### 2.1 AI 对话架构（魔改后）
本项目魔改后新增 **Sidecar 路径**（transport.ts L130-163）：
```
前端 useChat
   ↓ transport.sendMessages
   ↓ deps.getTdsfAgentId() 非 null?
   ├─ 是：runSidecarStream → invoke('ipc_invoke', {method:'agent.invoke'})
   │       ↓ Python BaseAgent.invoke (PAOR 同步循环)
   │       ↓ event_bus.emit_agent_message (实时推送，前端忽略)
   │       ↓ 返回 dict {observation, mood, tokens}
   │       ↓ 前端切片模拟流式 (24字符/8ms)
   └─ 否：runAgentStream (Vercel SDK 原生流式)
```

### 2.2 关键文件清单

| 文件 | 行号 | 职责 |
|------|------|------|
| `src/modules/ai/lib/transport.ts` | L130-163 | Sidecar 路由分支 |
| `src/modules/ai/lib/sidecar-adapter.ts` | L38 / L264 / L488-501 | 超时 / 事件忽略 / 流式切片 |
| `src-tauri/sidecar/agents/base.py` | L86-100 / L191-390 | to_state_update / invoke PAOR |
| `src-tauri/sidecar/strands_backend/adapter.py` | L128-207 | Strands callback_handler 实时转发 |
| `src/modules/ai/components/AiChat.tsx` | L676-697 | reasoning + tool 渲染（已就绪） |
| `src/modules/theme/ThemeProvider.tsx` | L73-225 | 主题切换（已支持 light） |
| `src/styles/globals.css` | L56-124 | `:root` 浅色 + `.dark` 暗色变量 |
| `src/modules/translate/useTranslateSelection.ts` | L42-93 | 划词事件绑定 |
| `src/modules/translate/TranslateTooltip.tsx` | L41-96 | 翻译卡片渲染 |
| `src/modules/ssh-explorer/SshTerminalHost.tsx` | L46-60 | SSH 终端 leafId 上报 |
| `src/app/App.tsx` | L209 / L789-801 / L1783-1785 | sshActiveLeafIdRef + captureActiveSelection |
| `src/modules/ai/tools/tools.ts` | L31-42 | buildTools（fs/shell/edit/search/...） |

---

## 3. 根因分析

### 3.1 Q1 流式输出延迟

**根因链**：
1. **Python sidecar 同步阻塞**（`base.py:191-390`）：`BaseAgent.invoke()` 跑完整个 PAOR 循环（plan → act → observe → reflect）才一次性返回 dict
2. **Strands 后端已流式但前端不接收**（`adapter.py:128-207`）：`TdsfStrandsCallbackHandler._handle_event()` 实时把 Strands `data` 事件通过 `event_bus.emit_agent_message` 推送，但前端 `sidecar-adapter.ts:264` 显式忽略 `sidecar:agent_message` 事件（注释"暂不处理，预留"）
3. **前端伪流式切片**（`sidecar-adapter.ts:241-255`）：拿到完整 dict 后按 24 字符/8ms 切片"打字"
4. **30s 超时硬上限**（`sidecar-adapter.ts:38`）：`SIDECAR_TIMEOUT_MS = 30_000`

**关键代码证据**：
```typescript
// sidecar-adapter.ts:264（显式忽略实时事件）
// sidecar:agent_message: Agent 中途推送的消息片段（暂不处理，预留）

// sidecar-adapter.ts:241-255（伪流式切片）
async function* streamText(text: string, id: string, kind: "text" | "reasoning" = "text") {
  for (let i = 0; i < text.length; i += STREAM_CHUNK_SIZE) {
    const delta = text.slice(i, i + STREAM_CHUNK_SIZE);
    yield kind === "reasoning" ? { type: "reasoning-delta", id, delta } : { type: "text-delta", id, delta };
    await new Promise((r) => setTimeout(r, STREAM_CHUNK_DELAY_MS));
  }
}
```

```python
# adapter.py:196-207（Python 已实时推送，前端忽略）
def _emit_agent_message(self, text: str, msg_type: str = "output") -> None:
    if self.event_bus is None or not text:
        return
    self.event_bus.emit_agent_message(
        content=text,
        message_type=msg_type,
        session_id=self.session_id or None,
        source=f"{self.agent_name}_agent.strands",
    )
```

### 3.2 Q2 无深度思考 UI

**根因**：
1. **前端 UI 已就绪**（`AiChat.tsx:676-685`）：`part.type === "reasoning"` 已渲染 `<Reasoning>` 组件
2. **Python `to_state_update()` 不返回 thinking 字段**（`base.py:86-100`）：只返回 `observation / next_step / reflection / mood`
3. **`sidecar:agent_message` 事件被忽略**（`sidecar-adapter.ts:264`）：Python 通过 `_emit_message(content, "thinking", ...)` 推送的思考片段前端不接收
4. **sidecar-adapter.ts:488-491 已有 thinking 流式逻辑**，但 `result.thinking` 永远是 undefined

**关键代码证据**：
```python
# base.py:86-100（to_state_update 不含 thinking）
def to_state_update(self) -> dict[str, Any]:
    update: dict[str, Any] = {
        "observation": self.observation,
        "next_step": self.next_step,
        "reflection": self.reflection,
        "mood": self.mood,
    }
    # 没有 thinking 字段
```

```typescript
// sidecar-adapter.ts:488-491（thinking 流式逻辑已存在，但 result.thinking 永远 undefined）
if (result.thinking) {
  onStep?.("Thinking");
  yield* streamText(result.thinking, thinkingId, "reasoning");
}
```

### 3.3 Q3 工具读写不流式

**根因**：
1. **工具事件实时收集但不实时 yield**（`sidecar-adapter.ts:376-403, 496-501`）：`collectedTools` 数组在 invoke 期间通过 `onToolCall` 回调实时收集，但要等 invoke 完成后才一次性 yield
2. **工具调用 UI 已就绪**（`AiChat.tsx:688-697`）：`RenderedTool` 组件支持 `dynamic-tool` 和 `tool-*` part

**关键代码证据**：
```typescript
// sidecar-adapter.ts:496-501（工具行在 invoke 完成后才 yield）
if (!abortSignal?.aborted) {
  await new Promise((r) => setTimeout(r, TOOL_DRAIN_MS));
  for (const toolPart of collectedTools) {
    yield toolPart;  // 一次性全部 yield
  }
}
```

### 3.4 Q4 长对话卡住

**根因**：
1. **30s 硬超时**（`sidecar-adapter.ts:38`）：长对话 LLM 调用容易超 30s，超时后 `yield { type: "error" }`
2. **messages 全量传输**（`transport.ts:140-158` + `sidecar-adapter.ts:441-450`）：所有历史消息（含 parts）全量传给 Python，无裁剪
3. **`long_context.py` 默认 disabled**（根据 subagent-1 报告，long_context.py:88-93）且 agent 路径不调用
4. **事件监听器潜在泄漏**：每次 `runSidecarStream` 注册 3 个 listener（mood/tool_call/agent_switch），finally 块清理但并发调用时可能累积

### 3.5 Q5 浅色模式缺失

**根因**：
1. **`terax-default` light 变体为空对象**（`terax-default.ts:17`）：`light: {}` → applyTheme 时不注入任何变量
2. **`:root` 默认变量已存在**（`globals.css:56-88`）：浅色变量（白色背景）已定义
3. **`.dark` 选择器**（`globals.css:92`）：暗色覆盖变量
4. **ThemeProvider 默认 mode="dark"**（`ThemeProvider.tsx:73`）：用户首次启动是暗色
5. **可能问题**：用户切到 light 后，部分组件（如终端、卡片）颜色不变，因为：
   - 终端 xterm 主题可能独立配置（不跟随 `--background`）
   - 某些硬编码颜色未用 CSS 变量
   - `clearTheme()` 在 light 模式下可能清除必要变量

### 3.6 Q6 SSH 翻译划词不显示

**修复已存在**（2026-07-31 已修）：
- `SshTerminalHost.tsx:46-60`：`onLeafId` 回调上报 leafId
- `App.tsx:1783-1785`：`onSshLeafId={(lid) => { sshActiveLeafIdRef.current = lid; }}`
- `App.tsx:789-801`：`captureActiveSelection` 优先用 `sshActiveLeafIdRef`
- `useTranslateSelection.ts:42-46`：`.xterm, .cm-editor` 选择器（TerminalPane 用 xterm，SSH 复用 TerminalPane）

**可能残留问题**：
1. **翻译卡片颜色不适配深浅色**（`TranslateTooltip.tsx:67`）：`bg-card/95` 用 CSS 变量，应该自动适配，但 `text-amber-600 dark:text-amber-400` 是硬编码
2. **SSH 终端焦点丢失时 `sshActiveLeafIdRef` 未清除**（`App.tsx:418-422`）：仅在 `!showSshTerminalInWorkspace` 时清除，切到本地终端 tab 但 SSH 仍连接时不清除
3. **CDP 实测确认**：需 Tauri 桌面端实测验证

### 3.7 Q7 AI 无法调用 skill

**根因**：
1. **Sidecar 路径不调前端 buildTools**（`transport.ts:130-163`）：当 `tdsfAgent` 非 null 时走 `runSidecarStream`，只调 Python `agent.invoke`，不注册前端工具
2. **Python `tools.invoke_tool` 只调注册的 MCP 工具**（`base.py:632`）：risk/confidence/ground/decision/credibility/history，不含 fs/shell/edit/search/terminal/todo/subagent/agent
3. **Strands 后端有独立工具集**（`adapter.py:498-500`）：`make_all_ops_tools(ctx)` 构造 ssh_command/read_remote_file/analyze_logs/inspect_processes/network_diagnose
4. **前端 buildTools 定义的 skill 工具**（`tools.ts:31-42`）：fs/shell/edit/search/terminal/todo/subagent/agent，**完全没接入 Sidecar 路径**

**关键代码证据**：
```typescript
// transport.ts:130-163（Sidecar 路径不传 buildTools）
if (tdsfAgent) {
  const sidecarStream = runSidecarStream({
    agentId: tdsfAgent,
    messages: messagesForRun,
    input,
    live,
    abortSignal: options.abortSignal,
    onStep: deps.onStep,
    onMood: deps.onMood,
    onUsage: ...,
  });
  return sidecarStreamToUIMessageStream(sidecarStream, {...});
  // 没有 buildTools(ctx)！
}
```

---

## 4. 修复方案

### 4.1 P1 修复：AI 流式 + 深度思考 UI + 工具流式（一次性修复）

**修复点 1：Python `base.py` `to_state_update()` 添加 thinking 字段**
```python
# base.py:86-100 修改后
def to_state_update(self) -> dict[str, Any]:
    update: dict[str, Any] = {
        "observation": self.observation,
        "next_step": self.next_step,
        "reflection": self.reflection,
        "mood": self.mood,
        "thinking": self.thinking,  # 新增：暴露思考过程
    }
    if self.intermediate_results:
        update["intermediate_results"] = self.intermediate_results
    if self.error:
        update["error"] = self.error
    update.update(self.extra_update)
    return update
```

需要在 `AgentResult` dataclass 添加 `thinking: str = ""` 字段，并在 `invoke()` 中收集思考片段。

**修复点 2：前端 `sidecar-adapter.ts` 订阅 `sidecar:agent_message` 事件**
```typescript
// sidecar-adapter.ts:264 修改后
// sidecar:agent_message: Agent 中途推送的消息片段（实时流式 yield）
if (onAgentMessage) {
  try {
    unlisteners.push(
      await listen<AgentMessagePayload>(EVENT_AGENT_MESSAGE, (e) => {
        const p = e.payload;
        if (!p) return;
        onAgentMessage?.(p);
      }),
    );
  } catch {
    // 非 Tauri 环境
  }
}
```

新增 `onAgentMessage` 回调，在 `runSidecarStream` 中实时 yield `reasoning-delta` / `text-delta`。

**修复点 3：前端 `collectedTools` 实时 yield**
```typescript
// sidecar-adapter.ts:379-403 修改后
// 用 AsyncGenerator 替代数组收集，实时 yield
const onToolCall = (p: ToolCallPayload) => {
  const name = p.tool_name;
  if (!name) return;
  if (p.status === "started") {
    const toolCallId = `${streamId}-tool-${++toolSeq}`;
    toolIdByName.set(name, toolCallId);
    // 实时 enqueue 到 stream（通过 controller 或 yield）
    realtimeToolQueue.push({
      type: "tool-input",
      toolCallId,
      toolName: name,
      input: p.params ?? {},
    });
  } else if (p.status === "completed" || p.status === "error") {
    const toolCallId = toolIdByName.get(name) ?? `${streamId}-tool-${++toolSeq}`;
    toolIdByName.delete(name);
    realtimeToolQueue.push({
      type: "tool-output",
      toolCallId,
      toolName: name,
      output: p.result ?? null,
      isError: p.status === "error",
    });
  }
};
```

需要重构 `runSidecarStream` 为真正的流式：在 invoke 进行中通过 `realtimeToolQueue` 实时 yield 工具事件，invoke 返回后只 yield 最终文本。

### 4.2 P2 修复：长对话稳定性

**修复点 1：前端消息裁剪**
```typescript
// sidecar-adapter.ts 新增
const MAX_MESSAGES_TO_PYTHON = 20; // 最近 20 条消息

function trimMessages(messages: UIMessage[]): UIMessage[] {
  if (messages.length <= MAX_MESSAGES_TO_PYTHON) return messages;
  // 保留第一条（system/首条 user）+ 最近 N 条
  const first = messages[0];
  const recent = messages.slice(-MAX_MESSAGES_TO_PYTHON + 1);
  return [first, ...recent];
}
```

**修复点 2：超时可配置**
```typescript
// sidecar-adapter.ts:38 修改
const SIDECAR_TIMEOUT_MS = Number(import.meta.env.VITE_SIDECAR_TIMEOUT_MS) || 60_000; // 默认 60s
```

**修复点 3：启用 `long_context` 模块**（Python 端）
- 在 `base.py` invoke 中调用 `long_context.compact()` 压缩上下文
- 或在 `agents/__init__.py` `invoke_agent` 入口调用

### 4.3 P3 修复：主题浅色模式 + 翻译卡片深浅色

**修复点 1：检查 `applyTheme.ts` light 模式逻辑**
- 确认 `clearTheme()` 不清除 `:root` 默认变量
- 确认 light 模式下 `terax-default` 不被错误覆盖

**修复点 2：终端主题跟随系统**
- 检查 xterm 主题是否独立配置
- 确保终端 `--terminal-background` 跟随 `--background`

**修复点 3：翻译卡片颜色适配**
```typescript
// TranslateTooltip.tsx:55 修改
// 已用 dark: 前缀适配，但需验证 dark 模式下 amber-400 可见性
<div className="mb-0.5 font-mono font-semibold text-amber-600 dark:text-amber-400">
```

### 4.4 P4 修复：AI skill 调用接入

**方案 A（推荐）：Sidecar 路径集成前端 buildTools**
- 在 `runSidecarStream` 中调用 `buildTools(ctx)` 注册前端工具
- Python agent 通过 `event_bus.emit_tool_call` 触发工具调用
- 前端 listener 接收事件后实际执行工具，通过 `event_bus.emit_tool_result` 返回结果

**方案 B：Python 后端调用前端工具**
- Python 通过 Tauri event 请求前端执行工具
- 前端执行后通过 RPC 返回结果

**方案 A 优势**：复用前端 buildTools 现有实现，避免重复
**方案 B 优势**：Python agent 完全控制工具调用流程

**建议**：方案 A，符合"站在巨人肩膀上"原则。

---

## 5. 风险评估

| 修复项 | 风险 | 缓解措施 |
|--------|------|----------|
| P1-1 Python to_state_update 加 thinking | 低：AgentResult 已有 reflection 字段，thinking 类似 | 单测覆盖 |
| P1-2 前端订阅 agent_message | 中：可能引入无限循环（事件触发 setState 再触发事件） | 用 ref 缓存最新 callback，useEffect 不依赖 state |
| P1-3 工具实时 yield | 中：需要重构 runSidecarStream 为真正流式 | 保留旧路径作为 fallback，feature flag 控制 |
| P2-1 消息裁剪 | 低：只裁剪传输给 Python 的消息，前端完整保留 | 保留首条 + 最近 N 条 |
| P2-2 超时可配 | 低：env 变量控制 | 默认 60s |
| P3 主题浅色 | 低：CSS 变量已存在 | CDP 实测验证 |
| P4 skill 接入 | 高：架构改动大 | 分阶段实施，先 PoC 再全面接入 |

---

## 6. 实施建议

### 6.1 优先级排序
1. **P1（最高）**：AI 流式 + 深度思考 UI + 工具流式（一次性修复，影响最大）
2. **P2（高）**：长对话稳定性（消息裁剪 + 超时可配置）
3. **P3（中）**：主题浅色模式 + 翻译卡片深浅色（CDP 实测确认问题）
4. **P4（低）**：AI skill 调用接入（架构改动大，建议单独迭代）

### 6.2 验证方式
- **五绿门禁**：`pnpm typecheck && pnpm lint && pnpm test && pnpm build:web`
- **CDP 9222 实测**：`pnpm tauri:dev` 启动后 CDP 连接验证
  - AI 对话流式输出：观察 text-delta chunk 实时到达
  - 深度思考 UI：确认 `<Reasoning>` 组件渲染
  - 工具流式：确认工具行实时出现（不等 invoke 完成）
  - 主题切换：light/dark 切换 + 截图对比
  - SSH 划词：SSH 连接后选词 + 翻译卡片出现
- **commit 规范**：`fix(ai): ...` / `fix(theme): ...` / `fix(translate): ...`

### 6.3 不修复项
- **Q6 SSH 翻译划词**：修复已存在（2026-07-31），仅需 CDP 实测确认。若实测仍有问题，再针对性修复。

---

## 7. 附录：关键代码片段索引

### 7.1 sidecar-adapter.ts 关键行
- L38: `SIDECAR_TIMEOUT_MS = 30_000`
- L264: `// sidecar:agent_message: Agent 中途推送的消息片段（暂不处理，预留）`
- L376-403: `collectedTools` 数组收集
- L488-491: `if (result.thinking) yield* streamText(...)`
- L496-501: `for (const toolPart of collectedTools) yield toolPart;`

### 7.2 base.py 关键行
- L86-100: `to_state_update()` 不含 thinking
- L191-390: `invoke()` PAOR 同步循环
- L713-746: `_emit_message()` 推送 agent_message 事件
- L632: `from tools import invoke_tool` 调 MCP 工具

### 7.3 adapter.py 关键行
- L128-165: `TdsfStrandsCallbackHandler._handle_event()` 实时转发 Strands 事件
- L196-207: `_emit_agent_message()` 推送流式文本
- L348: `response = strands_agent(prompt)` 同步调用（期间 callback_handler 实时推送）

### 7.4 主题系统关键行
- `globals.css:56-88`: `:root` 默认浅色变量
- `globals.css:92-124`: `.dark` 暗色覆盖
- `terax-default.ts:17`: `light: {}` 空变体
- `ThemeProvider.tsx:73`: `defaultMode = "dark"`
- `ThemeProvider.tsx:148-149`: `root.classList.add(resolvedMode)`
- `Header.tsx:141-143`: `setMode(resolvedMode === "dark" ? "light" : "dark")`

### 7.5 SSH 翻译划词关键行
- `SshTerminalHost.tsx:46-60`: `onLeafId` 上报
- `App.tsx:209`: `sshActiveLeafIdRef` ref
- `App.tsx:789-801`: `captureActiveSelection` 优先用 sshLid
- `App.tsx:1783-1785`: `onSshLeafId` 赋值
- `useTranslateSelection.ts:42-46`: `.xterm, .cm-editor` 选择器

---

> **最后更新**：2026-07-31 · 多子 agent 并行调研 + 主 agent 深度审查 · 上游参考：https://github.com/crynta/terax-ai
