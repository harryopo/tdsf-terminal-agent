# Terax（crynta/terax-ai）AI Agent 架构对比调研报告

> 调研目标：为 TDSF Terminal Agent 的 AI 对话系统重构提供可落地的架构参考，重点聚焦六大方面：1）AI 入口与面板结构；2）流式输出与深度思考 UI；3）工具调用与 UI；4）终端感知机制；5）LLM 配置与模型管理；6）多 agent 架构。
>
> 调研范围：`opensource-reference/terax-ai` 全量源码（前端 React + Rust Tauri 后端）+ TDSF 对应实现。
> 报告位置：`docs/reports/terax-agent-architecture-research.md`

---

## 1. 总体架构速览

### 1.1 Terax 的 AI 子系统三层结构

```
┌─────────────────────────────────────────────────────────────┐
│  React 19 前端                                               │
│  ├─ @ai-sdk/react 的 Chat 对象（chatRuntime.ts）            │
│  ├─ AiComposerProvider / useComposer（composer.tsx）        │
│  ├─ AiChatView / Reasoning / Tool / MessageResponse         │
│  └─ AiMiniWindow / WorkspaceInputBar / AiStatusBarControls  │
├─────────────────────────────────────────────────────────────┤
│  AI SDK Vercel `ai` v7（streamText + tools）                 │
│  ├─ agent.ts  构建模型 + system prompt + 流式调用           │
│  ├─ transport.ts 上下文注入 + 压缩 + 错误格式化             │
│  └─ tools/*.ts  工具定义（shell / terminal / fs / edit …）  │
├─────────────────────────────────────────────────────────────┤
│  Rust Tauri 后端                                             │
│  ├─ modules/pty/session.rs   本地 PTY 会话                 │
│  ├─ modules/shell/session.rs Agent 持久 shell 会话         │
│  ├─ modules/agent.rs         Claude/Codex/Gemini/PI hooks   │
│  └─ lib.rs 命令注册（pty_* / shell_* / agent_*）           │
└─────────────────────────────────────────────────────────────┘
```

核心依赖：
- 前端状态：`zustand`（chatStore.ts）+ `@ai-sdk/react` 的 `Chat` 类。
- 流式协议：Vercel `ai` 的 `streamText` + `toUIMessageStream()`。
- 本地能力：`@tauri-apps/api/core` 的 `invoke` 调用 Rust 命令。

### 1.2 TDSF 当前 AI 子系统结构

TDSF 在 Terax 架构之上叠加了 **Python sidecar** 路径，形成"双轨"架构：

```
React 19 前端
 ├─ Vercel `ai` SDK 路径（Terax 原生）: transport.ts → runAgentStream
 └─ Python Sidecar 路径（TDSF 新增）: transport.ts → runSidecarStream
        ↓
   ipc_invoke('agent.invoke') → src-tauri/sidecar/main.py
        ↓
   LangGraph PAOR 图（graph/graph.py + nodes.py）
        ↓
   8 子 Agent（main/coding/explore/history/teach/debug/refactor/test/deploy）
```

当前 `transport.ts` 通过 `getTdsfAgentId()` 判断走哪条路径：
- `tdsfAgentId != null` → Sidecar 路径（Python agent）。
- `tdsfAgentId == null` → Vercel AI SDK 路径（Terax 原生）。

这种双轨制是 TDSF 与 Terax 在 AI 子系统上最大的架构差异。

---

## 2. AI 入口与面板结构

### 2.1 Terax 的核心实现

Terax 提供 **两种 AI 入口**，统一由 `chatStore` 管理状态：

1. **底部 AI 输入条 `WorkspaceInputBar`**：嵌入 workspace 底部，与终端输入条切换显示。
2. **浮动小窗 `AiMiniWindow`**：`Ctrl+I` 打开，可拖拽、可缩放，负责历史会话展示。

```tsx
// src/app/components/WorkspaceInputBar.tsx
const effectiveMode = !isBlockTab ? "ai" : hasComposer ? mode : "shell";
...
{renderAi && (
  <div className={cn(effectiveMode !== "ai" && "hidden")}>
    <AiComposerInput />
  </div>
)}
```

```tsx
// src/modules/ai/components/AiMiniWindow.tsx
export function AiMiniWindow({ state }: { state: PresenceState }) {
  const { ref, onHeaderPointerDown, startResize } = useMiniWindowGeometry();
  return (
    <div ref={ref} data-ai-mini-window ...>
      <Body sessionId={sessionId} ... />
    </div>
  );
}
```

快捷键绑定在 `App.tsx` 的 `shortcutHandlers` 中：

```tsx
"ai.toggle": () => {
  if (!hasComposer) { void openSettingsWindow("models"); return; }
  if (panelOpen) { useChatStore.getState().closePanel(); }
  else { openPanel(); focusInput(null); }
},
"ai.toggleMini": () => {
  if (!hasComposer) { void openSettingsWindow("models"); return; }
  toggleMini();
},
```

状态管理：

```ts
// src/modules/ai/store/chatStore.ts
mini: { open: boolean };
openMini: () => void;
closeMini: () => void;
toggleMini: () => void;

panelOpen: boolean;
openPanel: () => void;
closePanel: () => void;
```

`submit` 时若 mini 未打开则自动打开：

```ts
// src/modules/ai/lib/composer.tsx
if (!store.mini.open) store.openMini();
```

### 2.2 TDSF 的现状与差异

TDSF 目前已经做了入口统一的修复（2026-07-30）：

```tsx
// src/app/App.tsx
// TDSF 魔改 2026-07-30: 统一 AI 入口 — Ctrl+I 和 Main 按钮都打开浮动小窗
// 原实现: Ctrl+I 打开右侧面板 (panelOpen), Main 打开浮动小窗 (mini.open),
// 两个独立状态会同时存在两个对话框, 用户困惑。
// 现统一: Ctrl+I / Ctrl+Shift+I / Main 按钮都走 toggleMini, 打开同一个浮动小窗。
"ai.toggle": () => {
  if (!hasComposer) { void openSettingsWindow("models"); return; }
  toggleMini();
  focusInput(null);
},
"ai.toggleMini": () => {
  if (!hasComposer) { void openSettingsWindow("models"); return; }
  toggleMini();
},
```

差异点：

| 维度 | Terax | TDSF 现状 |
|------|-------|-----------|
| AI 入口 | panel + mini 两套独立状态 | 已统一为 mini 浮动窗（用户要求的改造） |
| 浮动窗能力 | 拖拽 + 右下角 resize | 拖拽 + 8 方向 resize（2026-07-28 增强） |
| 面板状态 | `panelOpen` 仍存在 | `panelOpen` 状态仍在 store 中，但实际已弃用 |
| 浮动窗 UI | Terax 原生简洁风格 | TDSF 魔改为 mood 表情 + 子 Agent 状态 pill |
| 底部输入条 | `WorkspaceInputBar` 内置 | 沿用 Terax 结构 |

### 2.3 迁移/修复建议

1. **清理遗留状态**：`chatStore.panelOpen` / `openPanel` / `closePanel` / `togglePanel` 已实际弃用，应删除并清理相关引用，避免状态冗余。
2. **统一 UI 组件**：TDSF 的 `TdsfAgentPanel` 已对齐 `AiMiniWindow` 模式，但仍有 mood 表情、子 Agent pill 等自研 UI。若用户认可当前风格可保留；若需完全回归 Terax，应复用 `AiMiniWindow`。
3. **底部输入条常驻**：Terax 的 `WorkspaceInputBar` 在 AI 模式下常驻，TDSF 应确保底部输入条在任何 tab 下都可用。

---

## 3. 流式输出与深度思考 UI

### 3.1 Terax 的流式输出实现

#### 3.1.1 Chat 对象与 Transport

Terax 不直接使用 `useChat()` 的默认行为，而是手动构造一个 `@ai-sdk/react` 的 `Chat` 实例：

```ts
// src/modules/ai/store/chatRuntime.ts
function makeChat(sessionId: string): Chat<UIMessage> {
  const transport = createContextAwareTransport({ ... }) as unknown as ChatTransport<UIMessage>;
  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => { ... },
  });
}
```

`createContextAwareTransport` 把 `sendMessages` 转接到 `runAgentStream`：

```ts
// src/modules/ai/lib/transport.ts
export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    const projectMemory = await readTeraxMd(live.workspaceRoot);
    const envBlock = formatEnvBlock(live);
    const messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;
    const result = await runAgentStream({ ... });
    return result.toUIMessageStream({
      originalMessages: options.messages,
      onError: formatAiError,
    });
  };
  return { sendMessages: run, reconnectToStream: async () => null };
}
```

#### 3.1.2 LLM 流：runAgentStream

```ts
// src/modules/ai/lib/agent.ts
export async function runAgentStream(opts: RunAgentOptions) {
  const model = await buildConfiguredLanguageModel(modelId, opts.keys, {...});
  ...
  return streamText({
    model,
    system: prompt.system,
    messages: prompt.messages,
    tools: buildTools(opts.toolContext),
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    abortSignal: opts.abortSignal,
    onStepFinish: (step) => { ... },
    onFinish: (result) => { ... },
  });
}
```

要点：
- `streamText` 返回的 `StreamTextResult` 通过 `toUIMessageStream()` 直接转成 `UIMessage` 流。
- 前端 `AiChatView` 用 `useChat({ chat })` 消费 `helpers.messages` / `helpers.status`。
- 文本输出最终由 `MessageResponse` 组件渲染，使用 `streamdown` 做 Markdown 实时解析。

#### 3.1.3 只让最后一个 text part "live"

```tsx
// src/modules/ai/components/AiChat.tsx
const streamingMessageId =
  status === "streaming" && lastMessage?.role === "assistant"
    ? lastMessage.id
    : null;

// 在 RenderedMessage 内部
let lastTextIdx = -1;
for (let i = message.parts.length - 1; i >= 0; i -= 1) {
  if (message.parts[i]?.type === "text") { lastTextIdx = i; break; }
}

<RenderedPart
  part={g.part}
  streaming={streaming && g.idx === lastTextIdx}
/>
```

只有当前正在流式追加的最后一个 `text` part 会传入 `streaming={true}`，避免整段消息重渲染。

### 3.2 Terax 的深度思考（Reasoning）UI

`streamText` 自动识别模型返回的 reasoning 内容，生成 `part.type === "reasoning"` 的 `UIMessagePart`。`AiChatView` 遇到该类型即渲染 `Reasoning` 组件：

```tsx
// src/modules/ai/components/AiChat.tsx
if (part.type === "reasoning") {
  return (
    <Reasoning>
      <ReasoningTrigger />
      <ReasoningContent>{(part as unknown as { text: string }).text}</ReasoningContent>
    </Reasoning>
  );
}
```

```tsx
// src/components/ai-elements/reasoning.tsx
export const Reasoning = memo(({ isStreaming = false, defaultOpen, ... }) => {
  const resolvedDefaultOpen = defaultOpen ?? isStreaming;
  const [isOpen, setIsOpen] = useControllableState<boolean>({
    defaultProp: resolvedDefaultOpen,
    onChange: onOpenChange,
    prop: open,
  });

  // 流式开始时自动展开
  useEffect(() => {
    if (isStreaming && !isOpen && !isExplicitlyClosed) setIsOpen(true);
  }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

  // 流式结束 1s 后自动收起
  useEffect(() => {
    if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
      const timer = setTimeout(() => { setIsOpen(false); setHasAutoClosed(true); }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);
  ...
});
```

System Prompt 对 reasoning 模型的特殊处理：

```ts
// src/modules/ai/lib/agent.ts
const keepsReasoning = modelKeepsReasoning(info);
const prunedHistory = pruneMessages({
  messages: history,
  reasoning: keepsReasoning ? "none" : "before-last-message",
  emptyMessages: "remove",
});
```

`modelKeepsReasoning` 对 `tags.includes("reasoning")` 或本地/兼容 provider 保留 reasoning，避免 tool-call 回合因 reasoning 被剥离而报错。

### 3.3 TDSF 的现状与差异

TDSF 在 2026-07-31 的修复中重构了 sidecar-adapter.ts 为 AsyncQueue 模式，已实现：
- token 级实时流式输出
- reasoning UI 显示
- 长对话消息裁剪（trimMessagesForSidecar，保留最近 20 条）

```ts
// src/modules/ai/lib/transport.ts（TDSF 修复 2026-07-31）
// TDSF 修复 2026-07-31 (P2): 长对话消息裁剪
// 完整 messages 数组可能几十条，JSON 序列化后几 MB，导致 sidecar 传输慢 +
// LLM token 超限 + 长对话"卡住不回复"。保留最近 20 条，避免 token 爆炸。
const trimmedMessages = trimMessagesForSidecar(messagesForRun);
```

但仍有差异：

| 维度 | Terax | TDSF 现状 |
|------|-------|-----------|
| 流式协议 | Vercel `ai` SDK 原生 `streamText` + `toUIMessageStream` | Sidecar 路径：自定义 SSE/AsyncQueue 转换；SDK 路径：与 Terax 一致 |
| 上下文压缩 | `compactModelMessagesDetailed` + `pruneMessages` | 仅简单截断最近 20 条，无 token 预估和智能压缩 |
| Reasoning UI | `ai` SDK 原生 `reasoning` part + 自研 Collapsible | Sidecar 返回的 reasoning 经 mood 事件透传，已实现但字段名曾出错 |
| 加载状态 | `ChatStatus`（submitted/streaming）驱动 Spinner | 通过 mood 事件映射到 `agentMeta.status` |
| 消息持久化 | 300ms debounce 写磁盘 | 沿用 Terax 的 debounce 机制 |

### 3.4 迁移/修复建议

1. **Vercel SDK 路径**：保留 Terax 原生实现，直接可用。
2. **Sidecar 路径流式协议**：当前 AsyncQueue 实现应继续维护，确保 sidecar 每收到一个 token 立即推给前端。
3. **长对话优化**：当前简单截断 20 条不够精细，应引入 token 预估（参考 Terax `compactModelMessagesDetailed`），按 token 数而非消息数裁剪。
4. **Reasoning 字段校验**：确保 Python sidecar 返回的 reasoning 字段名与前端解析一致（曾有 `event_bus.py` 字段名错误导致根因不显示的问题）。

---

## 4. 工具调用与 UI

### 4.1 Terax 的工具定义与审批策略

Terax 把所有工具按能力分组：

```ts
// src/modules/ai/tools/tools.ts
export function buildTools(ctx: ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
  } as const;
}
```

审批策略：
- 只读工具（`read_file`, `list_directory`, `grep`, `glob`, `get_terminal_output`）自动执行。
- 变异工具（`write_file`, `edit`, `bash_run`, `bash_background`）设置 `needsApproval: true`，AI SDK 会暂停并生成 `approval-requested` part。

```ts
// src/modules/ai/tools/shell.ts
bash_run: tool({
  description: "Run a foreground shell command ...",
  inputSchema: z.object({ command: z.string(), timeout_secs: z.number().int().min(1).max(300).optional() }),
  needsApproval: true,
  execute: async ({ command, timeout_secs }) => { ... },
})
```

### 4.2 Terax 的工具 UI 状态机

`Tool` 组件根据 `ToolPart["state"]` 渲染不同颜色与文案：

```ts
// src/components/ai-elements/tool.tsx
const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};
```

每一行工具卡片包含：状态圆点、图标、标签、摘要（如文件路径或命令）、可展开的 Input/Output。

### 4.3 命令类工具的特殊 UI

#### 4.3.1 `bash_run` —— 显示 stdout/stderr 与 exit code

```tsx
function BashRunOutput({ data }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  ...
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map(t => <button ...>{t.label}</button>)}
        {exit != null ? <span className={...}>exit {exit}</span> : null}
        {timedOut ? <span>timed out</span> : null}
        {truncated ? <span>truncated</span> : null}
      </div>
      <pre className="max-h-72 overflow-auto ...">{stdout || stderr}</pre>
    </div>
  );
}
```

#### 4.3.2 `suggest_command` —— 插入到终端但不自动执行

```tsx
function SuggestCommandCard({ command, explanation }) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore.getState().live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div ...>
      <pre>{command}</pre>
      <button onClick={onInsert} disabled={inserted}>
        {inserted ? "Inserted" : "Insert"}
      </button>
    </div>
  );
}
```

这是 Terax 的"命令建议"设计：Agent 只负责建议，用户点击后才注入，**不自动执行**。

### 4.4 审批卡片

当工具进入 `approval-requested` 状态时，`AiChatView` 渲染 `AiToolApproval`：

```tsx
// src/modules/ai/components/AiChat.tsx
if (part.state === "approval-requested") {
  return <AiToolApproval part={...} toolName={toolName} onRespond={(approved) => onApproval(part.approval.id, approved)} />;
}
```

`AiToolApproval` 对 `bash_run` / `bash_background` / `write_file` / `edit` / `multi_edit` / `create_directory` 提供差异化预览，并给出 Approve / Deny 按钮。

### 4.5 TDSF 的现状与差异

TDSF 的 Python sidecar 拥有自己的工具体系（`src-tauri/sidecar/tools/`），包括 `risk`、`decision`、`ground`、`history`、`confidence` 等，以及通过 RustBridge 调用的 `ssh_command`、`sftp_*` 等。

差异点：

| 维度 | Terax | TDSF 现状 |
|------|-------|-----------|
| 工具框架 | Vercel `ai` SDK 的 `tool()` 定义，前端状态机完整 | Python sidecar 自研工具，前端通过 mood/消息事件间接展示 |
| 审批机制 | `needsApproval: true` + `approval-requested` part | Python `permissions.py` 4 档 × 3 mode 融合，通过 event_bus 推送 |
| 工具 UI | `Tool` 卡片状态机（input/output/denied/error） | 工具结果以文本/代码块形式嵌入回答，无统一状态卡片 |
| 命令建议 | `suggest_command` + `injectIntoActivePty` | 已实现类似能力，但 UI 不够显式 |
| Skill 调用 | Terax 无此概念 | TDSF 新增 `/skill:<name>` 命令和 skill registry |

### 4.6 迁移/修复建议

1. **统一工具状态机**：Sidecar 路径的工具调用应返回结构化事件（`tool-call` / `tool-result` / `approval-requested`），前端用 `Tool` 卡片统一渲染。
2. **审批 UI 对齐**：将 Python 的权限决策映射到 Vercel AI SDK 的 `approval-requested` part，复用 `AiToolApproval` 组件。
3. **命令建议可视化**：为 `suggest_command` 类结果提供显式卡片，包含"插入终端"按钮。
4. **Skill UI**：保留 TDSF 的 skill 调用能力，但为其设计专属工具卡片，显示调用状态（running / done / error）。

---

## 5. 终端感知机制

### 5.1 Terax 的终端缓冲区读取

前端通过 `useAiLiveBridge` 把当前终端上下文注入 `chatStore.live`：

```ts
// src/modules/ai/lib/useAiLiveBridge.ts
setLive({
  getTerminalContext: () => {
    const t = tabs.find((x) => x.id === activeId);
    if (t?.kind !== "terminal") return null;
    if (t.private) return null;
    const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
    return buf ? redactSensitive(buf) : null;
  },
  ...
});
```

工具层 `get_terminal_output` 调用该 getter：

```ts
// src/modules/ai/tools/terminal.ts
get_terminal_output: tool({
  description: "Return the tail of the active terminal's scrollback ...",
  inputSchema: z.object({ lines: z.number().int().min(1).max(2000).optional() }),
  execute: async ({ lines }) => {
    if (ctx.isActiveTerminalPrivate()) return { error: "active terminal is in Privacy mode ..." };
    const buffer = ctx.getTerminalContext();
    if (!buffer) return { output: "", note: "no active terminal" };
    const n = lines ?? 80;
    const parts = buffer.split("\n");
    const sliced = parts.length <= n ? buffer : parts.slice(parts.length - n).join("\n");
    const MAX = 24_000;
    const capped = sliced.length > MAX ? `…[truncated]…\n${sliced.slice(sliced.length - MAX)}` : sliced;
    return { output: capped, lines_returned: Math.min(parts.length, n) };
  },
});
```

缓冲区来自 xterm.js 的 `getBuffer(300)`，并经过 `redactSensitive` 做敏感信息脱敏。

### 5.2 Terax 的终端命令注入

```ts
// src/modules/ai/lib/useAiLiveBridge.ts
injectIntoActivePty: (text) => {
  const t = tabs.find((x) => x.id === activeId);
  if (t?.kind !== "terminal") return false;
  const term = terminalRefs.current.get(t.activeLeafId);
  if (!term) return false;
  term.write(text);
  term.focus();
  return true;
}
```

`term.write(text)` 直接把字符写入 PTY。对于 `suggest_command`，只写入命令字符串；如果要做"run 命令并显示在终端"，应写入 `command + "\r"` 让 shell 执行。

### 5.3 Rust 层：本地 PTY 与会话隔离

#### 5.3.1 本地 PTY（用户可见终端）

```rust
// src-tauri/src/modules/pty/session.rs
pub fn spawn(id: u32, app: AppHandle, cols: u16, rows: u16, cwd: Option<String>, ...)
  -> Result<(Arc<Session>, PtySize), String> {
  let pair = pty_system.openpty(size)?;
  let cmd = shell_init::build_command(cwd, workspace, blocks, shell)?;
  let mut child = pair.slave.spawn_command(cmd)?;
  ...
  // reader / flusher / waiter 三线程
}
```

输出通过 Tauri Channel 推送到前端；输入通过 `pty_write` 写入。

#### 5.3.2 Agent 持久 Shell 会话（工具执行用）

```rust
// src-tauri/src/modules/shell/session.rs
pub struct ShellSession {
  pub cwd: Mutex<String>,
  pub workspace: WorkspaceEnv,
  pub pristine: AtomicBool,
  sentinel: String,
}
```

`bash_run` 调用 `shell_session_run`，由 Rust 在独立线程中执行命令，并通过 **sentinel 标记** 在 stdout 末尾回传当前 `pwd`，从而保持 `cwd` 跨命令持久化。

### 5.4 TDSF 的现状与差异

TDSF 已经实现了：
- `getTerminalContext()` 读取本地终端 buffer
- `injectIntoActivePty()` 向本地终端写入
- 注入 `sshSessionId` 到 `<env>` 块，让 Python agent 感知 SSH 会话

```ts
// src/modules/ai/lib/transport.ts
if (live.sshSessionId !== null) {
  lines.push(`ssh_session_id: ${live.sshSessionId}`);
}
```

差异点：

| 维度 | Terax | TDSF 现状 |
|------|-------|-----------|
| 终端 buffer 读取 | `getBuffer(300)` + `redactSensitive` | 已实现，但 SSH 终端 buffer 读取可能仍有边界问题 |
| 命令注入 | `term.write(text)` 到活动 PTY | 已实现本地注入，SSH 注入需验证 |
| 隐私模式 | `isActiveTerminalPrivate()` 拒绝读取 | 已实现 |
| Agent shell 会话 | Rust `ShellSession` 持久化 cwd | TDSF 通过 Python sidecar 直接执行，无 Rust 级持久 shell |
| SSH 感知 | 无 SSH 场景 | TDSF 增强：注入 `ssh_session_id` 到 env 块 |

### 5.5 迁移/修复建议

1. **SSH 终端 buffer**：确保 `terminalRefs` 包含 SSH 终端 leaf，或 SSH Pane 提供同质 `getBuffer` 接口。
2. **SSH 命令注入**：验证 `injectIntoActivePty` 在 SSH tab 激活时是否路由到 SSH PTY writer。
3. **敏感信息脱敏**：为 SSH 终端输出也应用 `redactSensitive`，避免密码/密钥泄露给 LLM。
4. **run_in_terminal 工具**：若需要 Agent 命令显示在终端中，新增工具：Agent 生成命令 → 前端 `injectIntoActivePty(command + "\r")`。

---

## 6. LLM 配置与模型管理

### 6.1 Terax 的模型注册表

```ts
// src/modules/ai/config.ts
export const PROVIDERS = [...]; // 14 个 provider
export const MODELS = [...];    // 数十个模型，含 capabilities / tags / pricing
export const DEFAULT_MODEL_ID: ModelId = "gpt-5.4-mini";
```

每个模型带 `tags: ("vision" | "reasoning" | "tools" | "coding")[]` 和 `capabilities: { intelligence, speed, cost }`。

### 6.2 Terax 的密钥管理

```ts
// src/modules/ai/lib/keyring.ts
export async function getAllKeys(): Promise<ProviderKeys> { ... }
```

通过 Rust `secrets.rs`（系统 keyring）读写 API key，前端不持久化明文。

### 6.3 Terax 的模型选择 UI

```tsx
// src/modules/ai/components/AiStatusBarControls.tsx
function ModelDropdown() {
  const selected = useChatStore((s) => s.selectedModelId);
  const apiKeys = useChatStore((s) => s.apiKeys);
  ...
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ...>{current.label}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[28rem] ...">
        {/* 搜索 + All/Favorites/Recent tabs + provider 侧边栏 + 模型列表 */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

特性：
- 按 provider 分类，已配置 key 的排前面。
- 支持收藏、最近使用、自定义 OpenAI-compatible endpoint。
- 当前模型无 key 时显示 amber 警告色。

### 6.4 Terax 的配置同步

```ts
// src/modules/ai/hooks/useAiBootstrap.ts
export function useAiBootstrap(): { hasComposer: boolean; keysLoaded: boolean } {
  // 1. 加载 provider keys
  // 2. 同步 preference store 的 defaultModelId → chatStore.selectedModelId
  // 3. hydrate sessions / agents / snippets
}
```

### 6.5 TDSF 的现状与差异

TDSF 的 Settings 界面和 AI 面板模型选择已逐步对齐 Terax，但仍有差异：

| 维度 | Terax | TDSF 现状 |
|------|-------|-----------|
| 模型注册表 | `modules/ai/config.ts` 单一真源 | 沿用 Terax 的 config.ts |
| 密钥存储 | Rust keyring | 沿用 Tauri keyring |
| Settings 与 AI 面板配置 | 共用 `preferences` store | 已对齐 |
| Sidecar LLM 配置 | 无 | Python sidecar 有自己的 `.tdsf-data/llm_config.json`，与前端的模型选择解耦 |
| 模型下拉 UI | 搜索 + 收藏 + 最近 + provider 筛选 | 已复用 Terax 结构 |

### 6.6 迁移/修复建议

1. **统一 LLM 配置真源**：Agent 配置与 Settings 界面应统一读取 `modules/ai/config.ts` 和 `preferences` store。
2. **Sidecar 配置同步**：Python sidecar 的 `.tdsf-data/llm_config.json` 应与前端的 `selectedModelId` 保持一致，避免用户感知"两套配置"。
3. **密钥安全**：继续沿用 Tauri keyring，不在前端 localStorage 存 key。
4. **自定义 endpoint**：确保 OpenAI-compatible 自定义 endpoint 在 Settings 和 AI 面板都能配置。

---

## 7. 多 agent 架构

### 7.1 Terax 的 Subagent 架构

Terax 的前端多 agent 能力非常轻量：通过 `run_subagent` 工具调用 **只读子 agent**。子 agent 定义在 `registry.ts`：

```ts
// src/modules/ai/agents/registry.ts
export type SubagentType = "explore" | "code-review" | "security" | "general";

export type SubagentDef = {
  id: SubagentType;
  label: string;
  description: string;
  tools: string[];
  systemPrompt: string;
};

const READ_ONLY_TOOLS = ["read_file", "list_directory", "grep", "glob"];

export const SUBAGENTS: Record<SubagentType, SubagentDef> = {
  explore: {
    id: "explore",
    label: "Explore",
    description: "Read-only codebase explorer...",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are an exploration subagent...`,
  },
  "code-review": {
    id: "code-review",
    label: "Code review",
    description: "Reviews changed code for correctness...",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a code-review subagent...`,
  },
  security: {
    id: "security",
    label: "Security review",
    description: "Audits code/configuration for security risks...",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a security-review subagent...`,
  },
  general: {
    id: "general",
    label: "General research",
    description: "General-purpose worker for multi-step research...",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a general-purpose research subagent...`,
  },
};
```

子 agent 通过 `runSubagent.ts` 执行，使用 `generateText` 而非 `streamText`，是**一次性的只读调研任务**：

```ts
// src/modules/ai/agents/runSubagent.ts
export async function runSubagent({
  type, prompt, keys, modelId, toolContext, ...
}: Args): Promise<RunResult> {
  const def = SUBAGENTS[type];
  ...
  const result = await generateText({
    model,
    system: def.systemPrompt,
    prompt,
    tools: tools as Parameters<typeof generateText>[0]["tools"],
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
    onStepFinish: (step) => { ... },
  });

  return {
    summary: result.text || "(no output)",
    stepCount: result.steps?.length ?? 0,
    durationMs: Date.now() - start,
  };
}
```

`tools/subagent.ts` 把 `run_subagent` 注册为一个可被主 agent 调用的工具：

```ts
// src/modules/ai/tools/subagent.ts
export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn an isolated subagent with its own restricted toolset and a fresh message history...`,
      inputSchema: z.object({
        type: z.enum(TYPE_KEYS),
        prompt: z.string().describe("Self-contained instruction..."),
        description: z.string().optional().describe("Short label shown in the chat UI..."),
      }),
      execute: async ({ type, prompt, description }) => {
        const { apiKeys, selectedModelId, patchAgentMeta } = useChatStore.getState();
        const r = await runSubagent({ type, prompt, keys: apiKeys, modelId: selectedModelId, toolContext: ctx });
        return { type, description, summary: r.summary, stepCount: r.stepCount, durationMs: r.durationMs };
      },
    }),
  } as const;
}
```

关键设计：
- 子 agent 是**工具级别**的，由主 agent 显式调用。
- 子 agent 只读，不修改代码/执行命令，避免权限扩散。
- 子 agent 有独立的 system prompt 和受限工具集。
- 子 agent 结果是文本摘要，返回给主 agent 后继续主流程。

### 7.2 TDSF 的多 agent 架构

TDSF 自研了更重的 **Python sidecar 多 agent 体系**，与 Terax 的轻量 subagent 完全不同：

#### 7.2.1 LangGraph PAOR 监督循环

```python
# src-tauri/sidecar/graph/graph.py
def build_agent_graph():
    builder: StateGraph = StateGraph(AgentState)
    builder.add_node("supervisor", supervisor_node)
    builder.add_node("plan", plan_node)
    builder.add_node("act", act_node)
    builder.add_node("observe", observe_node)
    builder.add_node("reflect", reflect_node)
    builder.add_node("tool_call", tool_call_node)
    builder.add_node("permission_check", permission_check_node)
    ...
    return builder.compile()
```

流程：
- `supervisor` → `plan` → `act` → `tool_call` → `permission_check` → `observe` → `reflect` → (continue/done/error)

#### 7.2.2 8 子 Agent + Main Agent

```python
# src-tauri/sidecar/agents/main_agent.py
class MainAgent(BaseAgent):
    def __init__(self, event_bus=None, llm_call=None):
        super().__init__(
            name="main",
            role="主 Agent（PAOR 监督 + 路由）",
            tools=["risk", "decision", "confidence"],
            ...
        )

    def plan_task(self, user_input: str, state: dict) -> list[str]:
        # 基于关键词路由到 8 子 Agent
        ...
```

子 Agent 包括：`coding`、`explore`、`history`、`teach`、`debug`、`refactor`、`test`、`deploy`。

#### 7.2.3 前端 Agent Persona 与 Sidecar Agent 解耦

TDSF 前端 `modules/ai/lib/agents.ts` 定义了 UI 层 persona（Coder / Architect / Reviewer / Security / Designer），通过 `useAgentsStore` 管理：

```ts
// src/modules/ai/lib/agents.ts
export const BUILTIN_AGENTS: readonly Agent[] = [
  { id: "builtin:coder", name: "Coder", ... },
  { id: "builtin:architect", name: "Architect", ... },
  { id: "builtin:reviewer", name: "Code Reviewer", ... },
  { id: "builtin:security", name: "Security", ... },
  { id: "builtin:designer", name: "Designer", ... },
];
```

这些 persona 用于 Vercel SDK 路径的 `agentPersona`；而 Sidecar 路径的 8 子 Agent 由 Python `main_agent.plan_task()` 关键词路由。

### 7.3 TDSF 与 Terax 多 agent 架构的差异

| 维度 | Terax | TDSF 现状 |
|------|-------|-----------|
| 架构层级 | 前端工具层：`run_subagent` 调用只读子 agent | 后端图引擎：LangGraph PAOR + 8 子 Agent |
| 执行方式 | `generateText` 一次性只读任务 | `graph.stream` 多轮循环，可调用工具 |
| 权限控制 | 子 agent 只读工具，主 agent 控制审批 | `permissions.py` 4 档 × 3 mode 风险审批 |
| 子 agent 数量 | 4 个（explore/code-review/security/general） | 8 个（coding/explore/history/teach/debug/refactor/test/deploy） |
| 与主 agent 关系 | 子 agent 是主 agent 的工具 | 主 agent 是调度器，子 agent 是独立节点 |
| 前端状态 | 通过 `Tool` 卡片展示子 agent 调用 | 通过 mood 事件 + AgentStatusPill 展示当前子 agent |
| 教学场景 | 无专门教学 agent | 专门 `TeachAgent`，但用户反馈"每次说话后弹出一堆知识点" |

### 7.4 迁移/修复建议

1. **保留 Sidecar PAOR 架构**：TDSF 的 8 子 Agent 是核心差异化能力，不应简单替换为 Terax 的 4 subagent。
2. **修复 Teach 模式知识点轰炸**：用户明确要求"Teach 模式不应在每次说话后弹出一堆知识点"。应在 `TeachAgent` 中控制教学内容的触发频率，或把知识点聚合到单一回答中。
3. **子 agent 调用 UI**：为 `main_agent` 路由到子 agent 的过程提供显式 UI（如 Terax 的 `Tool` 卡片或 `AgentStatusPill` 增强），让用户看到当前正在哪个子 agent 中执行。
4. **前端 persona 与后端 agent 对齐**：当前前端 persona（Coder/Architect/Reviewer/Security/Designer）与后端 8 子 Agent 不完全对应。可考虑：
   - 方案 A：删除前端 persona 切换，统一走 `main` → 后端自动路由。
   - 方案 B：把前端 persona 映射为后端 agent 的初始倾向（如 Security persona 优先路由到 debug/security）。
5. **权限审批 UI 统一**：将 Python `permissions.py` 的决策映射到前端 `AiToolApproval`，实现与 Vercel SDK 路径一致的审批体验。

---

## 8. 差异总表

| 方面 | Terax 核心方式 | TDSF 现状 | 主要差异 | 建议 |
|------|---------------|-----------|----------|------|
| AI 入口 | `WorkspaceInputBar` + `AiMiniWindow`，`panelOpen` 仍保留 | 已统一为 mini 浮动窗 | TDSF 已按用户要求改造 | 清理 `panelOpen` 遗留状态 |
| 流式输出 | `streamText` + `toUIMessageStream` | 双轨：SDK 路径 + Sidecar AsyncQueue | Sidecar 路径为自研 | 继续优化 Sidecar 流式，引入 token 级压缩 |
| 深度思考 UI | `ai` SDK `reasoning` part + Collapsible | Sidecar mood 事件透传 reasoning | 字段一致性曾出错 | 校验 Python-前端 reasoning 字段 |
| 工具调用 UI | `Tool` 状态机 + `AiToolApproval` | 工具结果嵌入文本，无状态卡片 | UI 表达不足 | 为 sidecar 工具设计结构化事件和卡片 |
| 终端感知 | `getBuffer` + `injectIntoActivePty` + `redactSensitive` | 已实现本地，SSH 待完善 | SSH 场景有边界问题 | 补齐 SSH buffer 读取和注入 |
| LLM 配置 | `config.ts` + keyring + `preferences` store | 沿用 Terax + sidecar 自有配置 | sidecar 配置与前端的解耦 | 同步 sidecar 与前端模型选择 |
| 多 agent | 4 只读 subagent 作为工具 | 8 子 Agent + LangGraph PAOR | TDSF 更重、更自研 | 保留 PAOR，修复 Teach 知识点问题，统一审批 UI |

---

## 9. 对 TDSF 的具体改造建议（按优先级）

### 9.1 P0：流式与入口稳定性

1. 继续维护 Sidecar 路径的 AsyncQueue 流式实现，确保长对话不卡顿。
2. 删除 `chatStore` 中已弃用的 `panelOpen` 相关状态。
3. 修复 `event_bus.py` 等字段名错误，确保 reasoning / agent_switch / mood 事件稳定透传。

### 9.2 P1：工具调用 UI 与审批

1. 为 Python sidecar 的工具调用设计结构化事件格式：`tool-call` → `tool-result` / `approval-requested`。
2. 前端复用 Terax 的 `Tool` 组件和 `AiToolApproval` 组件渲染 sidecar 工具。
3. 将 Python `permissions.py` 的决策映射到 `approval-requested` 状态。

### 9.3 P1：终端感知完善

1. 为 SSH 终端 Pane 提供与本地终端同质的 `getBuffer` 和 `write` 接口。
2. 为 SSH 终端输出应用 `redactSensitive` 脱敏。
3. 新增 `run_in_terminal` 工具，让 Agent 命令显示在终端中。

### 9.4 P2：多 agent 体验优化

1. 修复 `TeachAgent` 知识点轰炸问题，控制知识点输出频率。
2. 增强 `AgentStatusPill` 或新增子 agent 调用卡片，让用户看到 PAOR 循环中的当前子 agent。
3. 统一前端 persona 与后端 8 子 Agent 的映射关系。

### 9.5 P2：LLM 配置统一

1. 将 Python sidecar 的 LLM 配置（`.tdsf-data/llm_config.json`）与前端 `selectedModelId` 同步。
2. 在 Settings 中提供 sidecar 模型配置的显式入口。

---

## 10. 风险与注意事项

1. **双轨架构维护成本**：TDSF 同时维护 Vercel SDK 路径和 Python Sidecar 路径，两套路径的工具、审批、流式协议都需要分别维护。建议长期看收敛到一套核心路径。
2. **Sidecar 流式性能**：大 Buffer、长对话、复杂 PAOR 循环都可能拖慢响应，需要持续的 debounce、截断、流式优化。
3. **Windows 终端注入**：SSH 或本地 PTY 的 `write("\r")` 在 Windows 部分 shell 上可能需要 `\r\n`，需按 shell 类型适配。
4. **大 Buffer 性能**：`getBuffer(300)` 每次请求都全量读取并脱敏，长会话需限制行数与字符数（Terax 用 24KB cap）。
5. **Approval 状态同步**：`approvalResponder` 在 `AgentRunBridge` 中每 render 更新一次，确保外部面板（如 AI diff tab）也能响应审批。
6. **Reasoning 模型兼容性**：`pruneMessages` 对 reasoning 模型保留 reasoning part，否则会触发 provider 报错。
7. **子 agent 权限边界**：TDSF 的 8 子 Agent 中部分可能执行命令/修改文件，必须确保 `permissions.py` 和风险引擎覆盖所有变异操作。

---

## 11. 结论

Terax 的 AI 子系统是一个以 **Vercel `ai` SDK 为流式与工具调用核心、以 Rust 后端为本地/终端能力底座、以精细化 React 组件为 UI 表达** 的完整实现。TDSF 在此基础上叠加了 **Python sidecar + LangGraph PAOR + 8 子 Agent** 的运维教学专用能力，形成了独特的双轨架构。

TDSF 当前已经修复了最核心的流式输出、入口统一、长对话截断等问题，但仍需在以下方面继续改进：

1. **P0**：稳定 Sidecar 流式协议，清理已弃用 panel 状态。
2. **P1**：为 sidecar 工具调用提供结构化事件和统一 UI 卡片。
3. **P1**：补齐 SSH 终端的 buffer 读取和命令注入。
4. **P2**：修复 Teach 模式知识点轰炸，优化多 agent 前端表达。
5. **P2**：统一 sidecar 与前端 LLM 配置。

最终目标是：保留 TDSF 在运维教学场景的多 agent 差异化能力，同时让前端交互、流式体验、工具 UI、终端感知对齐 Terax 的成熟实现。

---

*报告生成时间：2026-07-31*  
*源码基线：*
- *`opensource-reference/terax-ai`（crynta/terax-ai）*
- *`d:\ai\linux教学一体\tdsf-terminal-agent-clone\src\modules\ai`（TDSF 前端 AI 模块）*
- *`d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar`（TDSF Python sidecar）*  
*分析方式：全量源码阅读 + 关键路径代码引用 + 双架构差异对比*
