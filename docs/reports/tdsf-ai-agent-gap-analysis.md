# TDSF AI/Agent 子系统差距分析报告

> **版本**：v1.0（2026-07-31）  
> **范围**：TDSF Terminal Agent（基于 crynta/terax-ai v0.8.6 魔改）的 AI / Agent 子系统  
> **分析目的**：对照用户反馈与上游 Terax 实现，识别当前代码在“深度思考 UI、主入口输入条、流式输出、工具调用与命令回显、终端内容可见性、LLM 配置同步”六个维度的差距，并给出可执行的修复建议。

---

## 1. 执行摘要

| 维度 | 当前状态 | 与 Terax 的主要差距 | 优先级 |
|------|----------|----------------------|--------|
| 深度思考 UI | 已修复字段名与切片逻辑，可显示 but schema 不统一 | Terax 原生 reasoning part 标准化，TDSF 双后端事件格式不一致 | P0 |
| Main 按钮 / 底部输入条 | 已合并为 Ctrl+I 统一入口，Header 精简完成 | 输入条仍有压缩空间，体验未完全对齐 Terax 紧凑设计 | P1 |
| 流式输出 | Strands 路径为真流式；LangGraph 路径为 mock 流式 | Terax 统一真流式；TDSF 双路径行为分裂 | P0 |
| 工具调用 UI / 命令回显 | 工具输入/输出可渲染，但终端侧无回显 | Terax 工具执行结果与终端 pane 状态联动更强 | P1 |
| 终端内容可见性 | 调用前静态快照注入，无实时订阅 | Terax 通过 context / tool 深度集成终端，TDSF 仅静态 buffer | P1 |
| LLM 配置（DeepSeek） | 单配置源 + update_model 热更新已接入 | 双后端实例缓存不一致，前端设置面板与后端模型未完全对齐 | P1 |

**核心结论**：TDSF 在 LLM 调用链路上同时存在 **LangGraph BaseAgent PAOR 路径** 与 **Strands 后端路径**，导致行为分裂、事件 schema 不统一、用户体验不可预期。建议逐步收敛到 Strands 单路径，并在过渡期内补齐双路径的 schema 对齐与配置一致性。

---

## 2. 分析范围与方法

### 2.1 分析文件清单

| 维度 | 前端文件 | 后端文件 |
|------|----------|----------|
| 深度思考 UI | `src/modules/ai/lib/sidecar-adapter.ts` | `src-tauri/sidecar/agents/base.py`、`src-tauri/sidecar/strands_backend/adapter.py`、`src-tauri/sidecar/event_bus.py` |
| Main 按钮 / 输入条 | `src/app/App.tsx`、`src/modules/header/Header.tsx`、`src/app/components/WorkspaceInputBar.tsx`、`src/modules/ai/store/chatStore.ts` | — |
| 流式输出 | `src/modules/ai/lib/sidecar-adapter.ts`、`src/modules/ai/lib/transport.ts` | `src-tauri/sidecar/agents/base.py`、`src-tauri/sidecar/strands_backend/adapter.py` |
| 工具调用 / 命令回显 | `src/components/ai-elements/tool.tsx`、`src/modules/ai/tools/terminal.ts`、`src/modules/ai/lib/useAiLiveBridge.ts` | `src-tauri/sidecar/strands_backend/tools/skill_invoke.py`、`src-tauri/sidecar/tools/__init__.py` |
| 终端内容可见性 | `src/modules/ai/lib/transport.ts`、`src/modules/ai/tools/terminal.ts`、`src/modules/ai/lib/useAiLiveBridge.ts` | `src-tauri/sidecar/strands_backend/adapter.py` |
| LLM 配置同步 | `src/modules/ai/config.ts`（引用） | `src-tauri/sidecar/core/llm_config.py`、`src-tauri/sidecar/agents/__init__.py`、`src-tauri/sidecar/strands_backend/model_adapter.py`、`src-tauri/sidecar/strands_backend/adapter.py` |

### 2.2 方法

1. **源码静态阅读**：梳理事件流、状态流、调用链。
2. **双路径对比**：对比 LangGraph PAOR 路径与 Strands 路径在同一功能点上的差异。
3. **上游 Terax 对照**：以 `https://github.com/crynta/terax-ai` 为基线，识别 TDSF 在 UI 组件、流式协议、终端集成上的偏离。

---

## 3. 分维度差距分析

### 3.1 深度思考 UI 不显示

#### 当前实现

- `base.py` 在 `invoke()` 中调用 `_emit_mood("thinking", session_id)`，并通过 `_emit_message()` 推送“规划完成，共 N 个子任务”等文本。
- `strands_backend/adapter.py` 同样调用 `_emit_mood("thinking", ...)` 与 `_emit_agent_message(..., msg_type="thinking")`。
- `event_bus.py` 修复字段名后，将事件广播到 Rust 侧。
- `sidecar-adapter.ts` 使用 `AsyncQueue`，把事件切片为 `reasoning` / `text` / `tool-input` / `tool-output` 等 part。

#### 差距

1. **事件 schema 不统一**：
   - LangGraph 路径：mood 事件 + message 事件并存，message 的 `msg_type` 为 `thinking`。
   - Strands 路径：mood 事件 + `msg_type="thinking"` 的 agent_message。
   - 前端 `sidecar-adapter.ts` 需要同时识别 `mood_change` 与 `agent_message`，并把它们映射到 `reasoning` part；字段名一旦出现差异（如此前的 `detail` vs `details`）就会丢失 UI。

2. **缺少 reasoning_token 标记**：
   - Terax / Vercel AI SDK 的 reasoning part 通常带有明确的 `type: "reasoning"`，而 TDSF 依赖 `msg_type` 字符串推断，容易受后端改动影响。

3. **思考过程不可折叠 / 不可复制**：
   - 当前 `tool.tsx` 与消息渲染对 reasoning 的展示较简单，缺少 Terax 中常见的“展开/折叠思考过程”交互。

#### 建议

1. 在 Python 侧定义统一的 `ThinkingEvent` schema（字段：`session_id`、`agent_id`、`content`、`stage: plan|select_tool|reflect`）。
2. `sidecar-adapter.ts` 中增加 `isReasoningEvent(payload)` 类型守卫，避免字段漂移导致 UI 丢失。
3. 前端增加 `ReasoningBlock` 组件，支持展开/折叠、复制思考内容。

---

### 3.2 Main 按钮与底部输入条

#### 当前实现

- `chatStore.ts` 中 `tdsfAgentId` 默认 `'main'`，所有消息统一走 Main Agent。
- `Header.tsx` 已移除 `Main` brand section 与地址显示。
- `WorkspaceInputBar.tsx` 作为工作区底部的统一输入入口。
- `focusInput(prefill?)` 通过 `focusSignal` 触发输入框聚焦，用于 Ctrl+I 快捷键。

#### 差距

1. **输入条仍有压缩空间**：
   - 当前底部输入条高度、圆角、图标数量与 Terax 的紧凑风格仍有差异，用户反馈“页面多了容易挤”。

2. **未完全消除“双入口”认知**：
   - 虽然 UI 上合并为 Ctrl+I，但代码中仍保留 `mini` 状态、`panelOpen` 与 `focusSignal` 多套状态，长期维护成本高。

#### 建议

1. 将 `mini`、`panelOpen`、`focusSignal` 收敛为单一输入层状态机。
2. 参考 Terax 设计，进一步缩小底部输入条高度，移除不必要的占位图标。

---

### 3.3 非流式输出

#### 当前实现

- **Strands 路径**：`StrandsAgentAdapter.invoke()` 调用 `strands_agent(prompt)`，其内部为真流式；callback handler 实时推送 `agent_message` 事件，`sidecar-adapter.ts` 通过 `AsyncQueue` 实时 yield `text` part。
- **LangGraph / BaseAgent 路径**：`BaseAgent.call_llm()` 返回完整字符串后，再由上层按字符切片模拟流式，属于 **mock streaming**。

#### 差距

1. **双路径体验不一致**：
   - Strands 路径响应快、token 级实时；LangGraph 路径在 LLM 返回前无任何输出，长文本场景下用户感知为“卡住后突然喷字”。

2. **长对话冻结风险**：
   - `transport.ts` 虽已加入消息 trim，但 LangGraph 路径的完整字符串仍会在内存中累积，单轮大回复仍可能触发 UI 卡顿。

3. **与 Terax 差距**：
   - Terax 原生基于 Vercel AI SDK，所有模型路径统一为真流式，且支持 `streamText` 的 `onChunk`、`onFinish` 等生命周期。

#### 建议

1. **P0**：废弃或下线 LangGraph 路径，统一使用 Strands 后端。
2. 若必须保留 LangGraph 路径，则为其接入支持 streaming 的 LLM 调用（如 `langchain` 的 `.astream()`），而非完整返回后切片。
3. 在 `transport.ts` 中增加单条消息最大 token 硬限制，避免超长按住主线程。

---

### 3.4 工具调用 UI 与命令回显

#### 当前实现

- 前端：`tool.tsx` 渲染 `tool-input` / `tool-output` part；`terminal.ts` 提供 `inject_command` 等工具。
- 后端：`skill_invoke.py` 实现 skill 调用工具；`tools/__init__.py` 统一工具注册；`useAiLiveBridge.ts` 提供 `injectIntoActivePty`。

#### 差距

1. **命令执行后终端无回显**：
   - AI 调用 `inject_command` 后，命令在 PTY 中执行，但 stdout 不会自动回流到聊天 UI，用户需要在终端与对话之间切换查看结果。

2. **工具结果与终端 pane 未关联**：
   - `tool-output` 只展示工具返回的 JSON / 文本摘要，缺少“在终端 #N 中执行”的上下文链接。

3. **缺少风险确认UI**：
   - Terax 对高影响工具（写文件、执行命令）有显式 approval 弹窗；TDSF 虽有 `awaiting-approval` 状态，但在 SSH / 终端命令场景下提示不够突出。

#### 建议

1. 在 `useAiLiveBridge.ts` 中增加“执行命令并读取输出”的统一接口，将命令与输出作为 `tool-output` 的一部分回流。
2. 工具卡片展示关联的终端/SSH session id 与执行时间戳。
3. 对 `write_file`、`execute_command`、`ssh_command` 等高风险工具强制弹窗确认。

---

### 3.5 终端内容不可见

#### 当前实现

- `useAiLiveBridge.ts` 提供 `getTerminalContext()`，截取当前终端 buffer（最多 300 行）并做敏感信息脱敏。
- `transport.ts` 在发送消息前调用 `live.getTerminalContext()`，将结果作为 system message 注入。
- SSH 终端通过 `getSshRustSessionId()` 获取 Rust session id，注入到 `state.live.sshSessionId`。

#### 差距

1. **静态快照 vs 实时上下文**：
   - 当前只在用户发送消息瞬间抓取一次终端内容；若 AI 执行命令后终端内容变化，下一轮对话才能看到，无法做到“AI 能实时看到当前终端”。

2. **SSH 终端内容获取不完整**：
   - `getTerminalContext()` 优先取 active terminal；若 active 为 editor 或其他 surface，则回退查找最近一个 terminal tab，但 SSH 终端的 `private` 标记可能阻断读取。

3. **缺少 OSC 7 / cwd 同步**：
   - 终端内 `cd` 后文件资源管理器不会自动刷新，AI 对当前工作目录的认知可能滞后。

#### 建议

1. **P1**：实现终端 buffer 的变更订阅（如 xterm.js `onData` / `onLineFeed`），在变化时更新 `live` 快照。
2. **P1**：接入 OSC 7 序列解析 cwd，实现终端 `cd` 与文件资源管理器同步。
3. 对 SSH 终端移除不必要的 `private` 读取限制，或提供显式“允许 AI 读取此终端”开关。

---

### 3.6 LLM 配置（DeepSeek）同步

#### 当前实现

- `core/llm_config.py`：单一配置源，支持环境变量 `.tdsf-data/llm_config.json`，OpenAI 兼容端点覆盖 DeepSeek。
- `strands_backend/model_adapter.py`：将 `LLMConfig` 转换为 `OpenAIModel` / `AnthropicModel`，与 LangGraph 路径共享同一配置源。
- `agents/__init__.py`：通过 `set_strands_adapter()` 保存全局 adapter 引用；`agent.configure` RPC 触发 `adapter.update_model()` 与 `clear_cache()`。

#### 差距

1. **BaseAgent 实例缓存旧 `llm_call`**：
   - `configure_agents()` 在启动时将所有 Agent 实例化并注入 `llm_call`。运行中 `agent.configure` 调用 `update_model()` 后，Strands 路径会重新创建 model，但 LangGraph 路径的 `_agent_instances` 中每个 `BaseAgent` 仍持有旧的 `llm_call`。

2. **配置变更无事件通知前端**：
   - 后端配置更新后，前端 `selectedModelId` / `apiKeys` 状态不会自动同步，用户切换模型后可能出现“后端已变、前端未变”的认知差。

3. **DeepSeek 专用字段缺失**：
   - 当前通过 `base_url` 支持 DeepSeek，但未提供 DeepSeek 特有的 `reasoner` 模型选择、上下文压缩等选项。

#### 建议

1. **P1**：在 `agent.configure` 成功后，广播 `llm_config_changed` 事件到前端，前端同步刷新 `chatStore.apiKeys` / `selectedModelId`。
2. **P1**：统一热重载逻辑——`update_model()` 同时更新 Strands model 与 LangGraph 的 `_global_llm_call`，并重新注入到所有 `_agent_instances`。
3. **P2**：在 LLM 配置中增加 `reasoner` / `context_compress` 等 DeepSeek 专用选项，并在 `model_adapter.py` 中透传。

---

## 4. 与上游 Terax 的关键架构差距

| 维度 | Terax 原生 | TDSF 当前 | 影响 |
|------|------------|-----------|------|
| 流式协议 | 统一基于 Vercel AI SDK `streamText` | LangGraph 为 mock 流式，Strands 为真流式 | 同一产品两种响应体验 |
| Agent 框架 | 单一、轻量 | BaseAgent PAOR + Strands 双路径并存 | 事件 schema、工具行为、配置同步均需维护两份 |
| 终端集成 | 通过 context / tools 深度联动 | 静态快照 + 手动注入 | AI 对终端状态感知滞后 |
| UI 组件 | 统一的 reasoning / tool / approval 组件 | 组件分散，部分依赖字段推断 | 字段漂移即导致 UI 丢失 |
| 设置架构 | 前端设置面板与后端配置一一对应 | 前端模型选择与后端配置存在不同步窗口 | 用户修改配置后可能未生效 |

---

## 5. 修复优先级与行动项

### P0（影响核心可用性）

1. **统一 thinking / reasoning 事件 schema**：
   - 在 Python 侧定义 `ThinkingEvent` Pydantic 模型；前后端共用同一结构。
   - 文件：`src-tauri/sidecar/event_bus.py`、`src-tauri/sidecar/agents/base.py`、`src-tauri/sidecar/strands_backend/adapter.py`、`src/modules/ai/lib/sidecar-adapter.ts`。

2. **消除 LangGraph 路径的 mock 流式**：
   - 方案 A（推荐）：下线 LangGraph 路径，统一 Strands。
   - 方案 B：为 LangGraph 接入真流式 LLM 调用。

### P1（体验与一致性）

3. **LLM 配置热重载一致性**：
   - `agent.configure` 成功后广播配置变更事件；同时更新 Strands model 与 LangGraph `_global_llm_call`。

4. **工具调用与终端回显打通**：
   - 在 `useAiLiveBridge.ts` 中封装“执行 + 读取输出”接口；工具卡片展示 session id 与执行时间。

5. **终端实时上下文**：
   - 订阅 xterm.js 数据变化更新 `live` 快照；接入 OSC 7 实现 cwd 同步。

6. **进一步压缩输入条与 Header**：
   - 合并 `mini` / `panelOpen` / `focusSignal` 状态；参考 Terax 调整输入条尺寸。

### P2（增强）

7. 增加 DeepSeek reasoner 等专用配置项。
8. 增加 reasoning 内容的展开/折叠/复制交互。
9. 对高风险工具强制 approval 弹窗。

---

## 6. 验证标准

完成上述 P0/P1 修复后，应通过以下验收：

1. **深度思考 UI**：连续 10 轮对话，reasoning 内容每轮均可见，无字段漂移导致丢失。
2. **流式输出**：DeepSeek / OpenAI / Anthropic 三种模型下，首 token 延迟 < 1s，长文本不卡顿。
3. **工具回显**：AI 执行 `ls` / `cat` 等命令后，聊天 UI 自动展示命令与输出摘要。
4. **终端上下文**：在终端内 `cd /var/log` 后，文件资源管理器自动切换目录；AI 下一轮对话能感知新 cwd。
5. **配置同步**：前端修改 LLM 配置后，后端 Strands 与 LangGraph 路径立即生效，无需重启 sidecar。
6. **五绿门禁**：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build:web`、`pnpm tauri:dev` 全部通过。

---

## 7. 附录：关键代码引用

### 7.1 BaseAgent  thinking 事件推送

```python
# src-tauri/sidecar/agents/base.py
self._emit_mood("thinking", session_id)
self._emit_message(
    f"规划完成，共 {len(plan_tasks)} 个子任务",
    "thinking",
    session_id,
)
```

### 7.2 StrandsAdapter thinking 事件推送

```python
# src-tauri/sidecar/strands_backend/adapter.py
self._emit_mood("thinking", agent_id, session_id)
self._emit_agent_message(
    agent_id=agent_id,
    session_id=session_id,
    content=f"开始处理: {input[:100]}",
    msg_type="thinking",
)
```

### 7.3 前端 AsyncQueue 切片

```typescript
// src/modules/ai/lib/sidecar-adapter.ts
const queue = createAsyncQueue<SidecarStreamPart>();
// onToolCall / onMessage 将 event  push 到 queue，主流程 yield
```

### 7.4 LLM 配置共享源

```python
# src-tauri/sidecar/strands_backend/model_adapter.py
# 与现有 LangGraph 路径共享同一份配置源
def create_strands_model(config: Any | None = None) -> Any:
    if config is None:
        from core.llm_config import load_config
        config = load_config()
```

### 7.5 运行时配置更新

```python
# src-tauri/sidecar/agents/__init__.py
_global_strands_adapter: Any = None
# agent.configure RPC 通过此引用调用 adapter.update_model
```

---

**报告结束**
