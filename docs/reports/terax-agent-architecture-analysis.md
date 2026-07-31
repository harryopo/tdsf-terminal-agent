# Terax AI Agent 源码级架构分析报告

> 分析对象：本地克隆的上游 `crynta/terax-ai`（路径 `opensource-reference/terax-ai`）
> 分析日期：2026-07-31
> 分析重点：终端感知、流式/深度思考 UI、工具调用与命令注入、AI 入口统一、LLM 配置

---

## 1. 终端感知（Terminal Awareness）

### 1.1 关键文件与组件

| 层级 | 文件路径 | 职责 |
|------|----------|------|
| Live 桥接 | `opensource-reference/terax-ai/src/modules/ai/lib/useAiLiveBridge.ts` | 把前端实时状态封装成 `Live` 对象注入 chat store |
| 工具上下文 | `opensource-reference/terax-ai/src/modules/ai/tools/context.ts` | 定义 `ToolContext`，所有 AI 工具通过它读取环境 |
| 终端工具 | `opensource-reference/terax-ai/src/modules/ai/tools/terminal.ts` | `get_terminal_output` / `suggest_command` / `open_preview` |
| 上下文注入 | `opensource-reference/terax-ai/src/modules/ai/lib/transport.ts` | `formatEnvBlock` + `injectEnvIntoLastUser` 把环境塞进最后一条 user message |
| 内容脱敏 | `opensource-reference/terax-ai/src/modules/ai/lib/redact.ts` | 终端缓冲在喂给 LLM 前做密钥/Token 脱敏 |

### 1.2 核心机制：从终端到 LLM 上下文

**1) `useAiLiveBridge` 把多变的运行时状态“冻结”成 getter 集合**

```ts
// useAiLiveBridge.ts (L79-L107)
setLive({
  getCwd: findCwd,
  getTerminalContext: () => {
    const { activeId, tabs } = ref.current;
    const t = tabs.find((x) => x.id === activeId);
    if (t?.kind !== "terminal") return null;
    if (t.private) return null;
    const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
    return buf ? redactSensitive(buf) : null;
  },
  isActiveTerminalPrivate: () => {
    const { activeId, tabs } = ref.current;
    const t = tabs.find((x) => x.id === activeId);
    return t?.kind === "terminal" && t.private === true;
  },
  injectIntoActivePty: (text) => { /* ... */ },
  getWorkspaceRoot: () => { /* ... */ },
  getActiveFile: () => { /* ... */ },
  openPreview: (url) => { /* ... */ },
  // ...
});
```

> 设计要点：没有把 `tabs`/`activeId` 直接放进依赖数组导致反复重建，而是用 `ref.current` 做“只读快照”。这是上游避免 React 无限重渲染的关键模式（TDSF 此前在 theme file editing 踩过同类坑）。

**2) `getTerminalContext` 读取 xterm 缓冲并脱敏**

`getBuffer(300)` 是 `TerminalPaneHandle` 上的方法，返回最近 300 行（与 `TERMINAL_BUFFER_LINES` 对齐）。然后经过 `redactSensitive` 处理：

```ts
// redact.ts (L1-L27)
const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\bgh[opsur]_[A-Za-z0-9]{36,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: "env-assign",
    re: /\b((?:[A-Z][A-Z0-9_]*)?(?:API[_-]?KEY|SECRET(?:[_-]?KEY)?|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_]*)\s*[:=]\s*(["']?)([^\s"';|&]+)\2/gi,
  },
];

export function redactSensitive(text: string): string {
  let out = text;
  for (const { kind, re } of PATTERNS) {
    if (kind === "env-assign") {
      out = out.replace(re, (_m, name, q, _val) => `${name}=${q}<REDACTED>${q}`);
    } else {
      out = out.replace(re, `<REDACTED:${kind}>`);
    }
  }
  return out;
}
```

**3) `ToolContext` 是工具侧的统一抽象**

```ts
// tools/context.ts (L1-L23)
export type ToolContext = {
  getCwd: () => string | null;
  getWorkspaceRoot: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  openPreview: (url: string) => boolean;
  spawnAgent: (prompt: string) => { tabId: number; leafId: number } | null;
  readAgentOutput: (leafId: number) => string | null;
  readCache: Map<string, { size: number; hash: number }>;
  getSessionId: () => string | null;
};
```

**4) `get_terminal_output` 工具按需拉取缓冲**

```ts
// tools/terminal.ts (L32-L61)
get_terminal_output: tool({
  description:
    "Return the tail of the active terminal's scrollback. Use this when the user references 'this error', 'the last command', or you need to interpret recent terminal output. ...",
  inputSchema: z.object({
    lines: z.number().int().min(1).max(2000).optional().describe("Number of trailing lines to return. Default 80."),
  }),
  execute: async ({ lines }) => {
    if (ctx.isActiveTerminalPrivate()) {
      return { error: "active terminal is in Privacy mode; its buffer is withheld. ..." };
    }
    const buffer = ctx.getTerminalContext();
    if (!buffer) return { output: "", note: "no active terminal" };
    const n = lines ?? 80;
    const parts = buffer.split("\n");
    const sliced = parts.length <= n ? buffer : parts.slice(parts.length - n).join("\n");
    const MAX = 24_000;
    const capped =
      sliced.length > MAX ? `…[truncated]…\n${sliced.slice(sliced.length - MAX)}` : sliced;
    return { output: capped, lines_returned: Math.min(parts.length, n) };
  },
}),
```

> 重要原则：**终端缓冲不是自动注入**，而是由模型主动调用 `get_terminal_output`；系统 prompt 也明确提示“ONLY call when genuinely needed”。

**5) `transport.ts` 把环境信息注入最后一条 user message**

```ts
// lib/transport.ts (L75-L114)
export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    const projectMemory = await readTeraxMd(live.workspaceRoot);
    const envBlock = formatEnvBlock(live);
    const messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;
    const result = await runAgentStream({
      /* ... 传递 keys/modelId/toolContext/回调 ... */
      projectMemory,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
      onError: formatAiError,
    });
  };
  return { sendMessages: run, async reconnectToStream(): Promise<null> { return null; } };
}

// lib/transport.ts (L154-L162)
function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}
```

环境块被拼接到最新一条 `user` 消息的文本 part 最前面，这样模型每一轮都能看到准确的 cwd/active file/privacy 状态。

### 1.3 对 TDSF 的借鉴点

| 借鉴项 | TDSF 现状/需补齐 |
|--------|------------------|
| **终端缓冲按需读取** | TDSF 目前倾向于把缓冲塞进 system prompt 或上下文；应改成模型主动调用 `get_terminal_output`，减少 token 浪费 |
| **Privacy mode 保护** | TDSF 尚无“隐私终端”概念，建议引入 `private` 标记并拒绝 LLM 读取 |
| **缓冲脱敏** | TDSF 没有 `redactSensitive`，需在喂给 LLM 前做密钥/密码正则过滤 |
| **Live getter 快照** | TDSF 的 AI bridge 应学习用 ref 快照，避免把 tab/activeId 放进 effect 依赖导致无限循环 |
| **`<env>` 块注入** | TDSF 可以把 workspace_root、active_cwd、active_file 统一拼成结构化 env 块，prepend 到最后一条 user message |

---

## 2. 流式输出与深度思考 UI

### 2.1 关键文件

| 文件路径 | 职责 |
|----------|------|
| `src/modules/ai/lib/agent.ts` | `runAgentStream`：调用 Vercel `ai` SDK 的 `streamText`，管理 reasoning 保留/剪枝 |
| `src/modules/ai/lib/transport.ts` | 把 `streamText` 结果转成 UI message stream |
| `src/modules/ai/store/chatRuntime.ts` | 构造 `Chat` 实例，注册 `onStep`/`onUsage`/`onCompact` 回调 |
| `src/components/ai-elements/reasoning.tsx` | Reasoning 折叠/展开/自动关闭 UI |
| `src/components/ai-elements/tool.tsx` | 工具卡片渲染 |
| `src/modules/ai/components/AiChat.tsx` | 把 `UIMessage.parts` 渲染成 reasoning/tool/text 组件 |

### 2.2 数据流

```
AiChatView (useChat hook)
  → messages: UIMessage[]
    → message.parts: UIMessagePart[]
      → type="text"        → MessageResponse (Streamdown)
      → type="reasoning"   → Reasoning + ReasoningTrigger + ReasoningContent
      → type="tool-*" / "dynamic-tool" → Tool
```

### 2.3 关键代码

**1) `runAgentStream` 中对 reasoning 的处理**

```ts
// lib/agent.ts (L395-L413)
const history = await convertToModelMessages(opts.uiMessages);
const keepsReasoning = modelKeepsReasoning(info);
const prunedHistory = pruneMessages({
  messages: history,
  reasoning: keepsReasoning ? "none" : "before-last-message",
  emptyMessages: "remove",
});
```

`modelKeepsReasoning` 对 Anthropic/DeepSeek/OpenAI GPT-5 等 reasoning 模型保留 reasoning tokens，避免模型因 reasoning 被剥离而拒绝工具调用；非 reasoning 模型则把历史 reasoning 内容从上下文中去掉。

**2) `streamText` 与步骤/用量回调**

```ts
// lib/agent.ts (L423-L468)
return streamText({
  model,
  system: prompt.system,
  messages: prompt.messages,
  allowSystemInMessages: false,
  tools: buildTools(opts.toolContext),
  stopWhen: stepCountIs(MAX_AGENT_STEPS),
  abortSignal: opts.abortSignal,
  onStepFinish: (step) => {
    stepsSeen++;
    if (opts.onStep) {
      const last = step.toolCalls?.[step.toolCalls.length - 1];
      if (last) {
        const label = TOOL_LABELS[last.toolName];
        opts.onStep(label ? label((last.input ?? {}) as Record<string, unknown>) : `Calling ${last.toolName}`);
      } else if (step.text) {
        opts.onStep("Writing");
      }
    }
    if (opts.onUsage && step.usage) {
      const u = step.usage;
      opts.onUsage({
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
        lastInputTokens: u.inputTokens ?? 0,
        lastCachedTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
      });
    }
  },
  onFinish: (result) => { /* ... */ },
});
```

**3) `chatRuntime.ts` 把回调落到 zustand store**

```ts
// store/chatRuntime.ts (L78-L100)
onStep: (step) => { useChatStore.getState().patchAgentMeta({ step }); },
onCompact: (info) => { useChatStore.getState().patchAgentMeta({ compactionNotice: { droppedCount: info.droppedCount, at: Date.now() } }); },
onFinishMeta: (info) => { useChatStore.getState().patchAgentMeta({ hitStepCap: info.hitStepCap }); },
onUsage: (delta) => {
  const cur = useChatStore.getState().agentMeta.tokens;
  useChatStore.getState().patchAgentMeta({
    tokens: {
      inputTokens: cur.inputTokens + delta.inputTokens,
      outputTokens: cur.outputTokens + delta.outputTokens,
      cachedInputTokens: cur.cachedInputTokens + delta.cachedInputTokens,
    },
    lastInputTokens: delta.lastInputTokens,
    lastCachedTokens: delta.lastCachedTokens,
  });
},
```

**4) Reasoning 折叠组件**

```tsx
// components/ai-elements/reasoning.tsx (L53-L144)
export const Reasoning = memo(({
  isStreaming = false,
  open, defaultOpen, onOpenChange,
  duration: durationProp,
  children,
}: ReasoningProps) => {
  const resolvedDefaultOpen = defaultOpen ?? isStreaming;
  const isExplicitlyClosed = defaultOpen === false;

  const [isOpen, setIsOpen] = useControllableState<boolean>({
    defaultProp: resolvedDefaultOpen,
    onChange: onOpenChange,
    prop: open,
  });

  // streaming 开始时自动展开
  useEffect(() => {
    if (isStreaming && !isOpen && !isExplicitlyClosed) setIsOpen(true);
  }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

  // streaming 结束后 1s 自动收起
  useEffect(() => {
    if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
      const timer = setTimeout(() => { setIsOpen(false); setHasAutoClosed(true); }, AUTO_CLOSE_DELAY);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

  return (
    <ReasoningContext.Provider value={contextValue}>
      <Collapsible open={isOpen} onOpenChange={handleOpenChange}>
        {children}
      </Collapsible>
    </ReasoningContext.Provider>
  );
});
```

**5) 消息渲染中识别 reasoning part**

```tsx
// modules/ai/components/AiChat.tsx (L606-L615)
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

**6) 流式文本由 `Streamdown` 渲染**

```tsx
// components/ai-elements/message.tsx (L326-L338)
export const MessageResponse = memo(({ streaming = false, ...props }: MessageResponseProps) => (
  <ChatStreamingProvider value={streaming}>
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      components={streamdownComponents}
      {...props}
    />
  </ChatStreamingProvider>
), (prevProps, nextProps) =>
  prevProps.children === nextProps.children &&
  prevProps.streaming === nextProps.streaming &&
  nextProps.isAnimating === prevProps.isAnimating
);
```

### 2.4 对 TDSF 的借鉴点

| 借鉴项 | TDSF 需补齐 |
|--------|-------------|
| **reasoning 保留策略** | TDSF 直接过滤 reasoning，导致 Claude/DeepSeek 工具调用失败；应引入 `modelKeepsReasoning` 与 `pruneMessages` 策略 |
| **reasoning 折叠 UI** | TDSF 无 thinking 折叠，应实现 `Reasoning`/`ReasoningTrigger`/`ReasoningContent` |
| **step/usage 回调落地 store** | TDSF 的 token 统计与“当前步骤”靠临时 state，应参考 `chatRuntime.ts` 的回调设计 |
| **Streamdown 流式 markdown** | TDSF 流式输出用普通 markdown，易产生闪烁；可引入类似 `streamdown` 的增量渲染方案 |
| **工具调用按状态分组** | `AiChat.tsx` 把连续 `read_file` 合并成 `ReadGroup`，TDSF 可借鉴减少卡片刷屏 |

---

## 3. 工具调用 UI 与命令注入

### 3.1 关键文件

| 文件路径 | 职责 |
|----------|------|
| `src/components/ai-elements/tool.tsx` | 通用工具卡片 `<Tool />` + `SuggestCommandCard` |
| `src/modules/ai/tools/shell.ts` | `bash_run` / `bash_background` / `bash_logs` / `bash_list` / `bash_kill` |
| `src/modules/ai/tools/terminal.ts` | `suggest_command`（只生成命令，不执行） |
| `src/modules/ai/lib/useAiLiveBridge.ts` | `injectIntoActivePty` 把文本写到活动终端 |
| `src/modules/ai/components/AiChat.tsx` | 根据 `part.state` 渲染 `Tool` 或 `AiToolApproval` |

### 3.2 工具卡片渲染

**1) `<Tool />` 的 props 与状态**

```tsx
// components/ai-elements/tool.tsx (L116-L236)
export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string] = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};
```

**2) 重内容工具避免逐 token 重渲染**

```tsx
// components/ai-elements/tool.tsx (L129-L136)
const HEAVY_CONTENT_TOOLS = new Set([
  "write_file", "edit", "multi_edit", "run_subagent", "todo_write",
]);

// L226-L236
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (HEAVY_CONTENT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) === deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});
```

**3) `suggest_command` 的 Insert 按钮**

```tsx
// components/ai-elements/tool.tsx (L704-L750)
function SuggestCommandCard({ command, explanation }: { command: string; explanation: string | null }) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore.getState().live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div className="space-y-1.5">
      {explanation ? <div className="text-[11px] text-muted-foreground">{explanation}</div> : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">{command}</pre>
        <button type="button" onClick={onInsert} disabled={inserted} aria-label="Insert into active terminal">
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
    </div>
  );
}
```

**4) `injectIntoActivePty` 把命令写入终端**

```ts
// useAiLiveBridge.ts (L94-L103)
injectIntoActivePty: (text) => {
  const { activeId, tabs } = ref.current;
  const t = tabs.find((x) => x.id === activeId);
  if (t?.kind !== "terminal") return false;
  const term = terminalRefs.current.get(t.activeLeafId);
  if (!term) return false;
  term.write(text);
  term.focus();
  return true;
},
```

> 注意：只 `term.write(text)`，不自动加 `\r`，所以只插入不执行；用户按回车后才真正运行。`suggest_command` 的 description 也明确说“NOT written automatically”。

**5) `bash_run` 工具通过持久 shell session 执行**

```ts
// tools/shell.ts (L30-L67)
bash_run: tool({
  description:
    "Run a foreground shell command in this session's persistent agent shell. cwd persists across calls ...",
  inputSchema: z.object({ command: z.string(), timeout_secs: z.number().int().min(1).max(300).optional() }),
  needsApproval: true,
  execute: async ({ command, timeout_secs }) => {
    const safety = checkShellCommand(command);
    if (!safety.ok) return { error: safety.reason };
    const sid = ctx.getSessionId();
    if (!sid) return { error: "no active chat session" };
    try {
      const cwd = ctx.getCwd();
      const shellId = await getSessionShell(workspaceSessionKey(sid), cwd);
      const r = await native.shellSessionRun(shellId, command, cwd, timeout_secs);
      return { command, stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, timed_out: r.timed_out, truncated: r.truncated, cwd_after: r.cwd_after };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),
```

`needsApproval: true` 会让 AI SDK 暂停并生成 `tool-approval-request` part，UI 渲染确认卡片。

**6) 工具审批 UI 入口**

```tsx
// modules/ai/components/AiChat.tsx (L644-L652)
if (part.state === "approval-requested") {
  return (
    <AiToolApproval
      part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
      toolName={toolName}
      onRespond={(approved) => onApproval(part.approval.id, approved)}
    />
  );
}
```

### 3.3 对 TDSF 的借鉴点

| 借鉴项 | TDSF 需补齐 |
|--------|-------------|
| **命令只插入不执行** | TDSF 目前部分路径会把命令直接 `writeToSession(cmd + "\r")` 执行；建议区分 `suggest_command`（Insert）与 `bash_run`（Approval 后执行） |
| **工具状态机 UI** | TDSF 缺少 `input-streaming`/`output-available`/`approval-requested` 等状态的可视化，应补齐 `STATUS_DOT/STATUS_LABEL` |
| **重内容工具 memo 优化** | TDSF 的 `write_file`/`edit` 卡片会随流式输入重渲染，需引入 `HEAVY_CONTENT_TOOLS` + `deriveSummary` 的 memo 策略 |
| **持久 shell session** | TDSF 的 `bash_run` 应该像 Terax 一样给每个 chat session 一个 `shell_session`，保证 `cd` 跨调用存活 |
| **命令安全校验** | TDSF 已有 `checkShellCommand`，但 `suggest_command` 也应做控制字节校验（`/[\n\r\x00\x1b\x07]/`） |

---

## 4. AI 入口统一

### 4.1 关键文件

| 文件路径 | 职责 |
|----------|------|
| `src/app/App.tsx` | 注册快捷键 `ai.toggleMini`、`ai.toggle`、`ai.askSelection`；挂载 `<AiMiniWindow />` |
| `src/modules/ai/components/AiMiniWindow.tsx` | 浮动小窗：拖拽、缩放、会话切换、token 指示器 |
| `src/modules/ai/components/AiInputBar.tsx` | 仅保留“Connect provider”的 mini 态未配置引导 |
| `src/modules/ai/lib/composer.tsx` | `AiComposerProvider`：统一输入框状态、附件、snippet、slash command |
| `src/modules/ai/store/chatStore.ts` | `mini.open` / `panelOpen` / `focusInput` / `focusSignal` |

### 4.2 统一入口机制

**1) App.tsx 快捷键绑定**

```ts
// app/App.tsx (L742-L791)
const shortcutHandlers = useMemo<ShortcutHandlers>(() => ({
  "ai.toggle": togglePanelAndFocus,
  "ai.toggleMini": () => {
    if (!hasComposer) { void openSettingsWindow("models"); return; }
    toggleMini();
  },
  "ai.askSelection": askFromSelection,
  // ...
}), [/* ... */]);

useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });
```

**2) `togglePanelAndFocus` 打开右侧大面板**

```ts
// app/App.tsx (L446-L457)
const togglePanelAndFocus = useCallback(() => {
  if (!hasComposer) { void openSettingsWindow("models"); return; }
  if (panelOpen) { useChatStore.getState().closePanel(); }
  else { openPanel(); focusInput(null); }
}, [hasComposer, panelOpen, openPanel, focusInput]);
```

**3) 浮动小窗根据 `miniPresence` 挂载**

```tsx
// app/App.tsx (L1365-L1367)
{hasComposer && miniPresence.mounted ? (
  <AiMiniWindow state={miniPresence.state} />
) : null}
```

`usePresence(miniOpen, 200)` 给退出动画留出 200ms 的 mount 时间。

**4) `AiMiniWindow` 内部复用 `AiChatView`**

```tsx
// modules/ai/components/AiMiniWindow.tsx (L91-L130)
export function AiMiniWindow({ state }: { state: PresenceState }) {
  const closeMini = useChatStore((s) => s.closeMini);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const openPanel = useChatStore((s) => s.openPanel);
  const expandToPanel = () => { closeMini(); openPanel(); };
  const { ref, onHeaderPointerDown, startResize } = useMiniWindowGeometry();
  // ...
  return (
    <div ref={ref} data-state={state} data-ai-mini-window className={cn("fixed z-40 ...")}>
      {RESIZE_DIRS.map((dir) => <ResizeHandle key={dir} dir={dir} onPointerDown={startResize(dir)} />)}
      {sessionId ? <Body sessionId={sessionId} ... /> : <EmptyShell ... />}
      <PlanDiffReview />
    </div>
  );
}
```

**5) `Body` 内部用 `useChat` 拿到 chat 状态**

```tsx
// modules/ai/components/AiMiniWindow.tsx (L175-L207)
function Body({ sessionId, ... }: { sessionId: string; ... }) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  const isBusy = helpers.status === "submitted" || helpers.status === "streaming";
  return (
    <>
      <Header step={step} isBusy={isBusy} ... />
      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : (
          <AiChatView
            messages={helpers.messages}
            status={helpers.status}
            error={helpers.error}
            clearError={helpers.clearError}
            addToolApprovalResponse={helpers.addToolApprovalResponse}
            stop={helpers.stop}
          />
        )}
      </div>
      <TodoStrip sessionId={sessionId} />
    </>
  );
}
```

**6) 没有配置 key 时统一引导到设置**

```ts
// app/App.tsx (L461-L476)
const handleAttachFileToAgent = useCallback((path: string) => {
  if (!hasComposer) { void openSettingsWindow("models"); return; }
  window.dispatchEvent(new CustomEvent<string>("terax:ai-attach-file", { detail: path }));
  openPanel(); focusInput(null);
}, [hasComposer, openPanel, focusInput]);
```

```tsx
// modules/ai/components/AiInputBar.tsx (L1-L20)
export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <span className="text-muted-foreground">Connect any AI provider (or use local models) - your key stays in your OS keychain.</span>
      <Button size="xs" onClick={onAdd}>
        <HugeiconsIcon icon={Key01Icon} />
        Connect provider
      </Button>
    </div>
  );
}
```

### 4.3 对 TDSF 的借鉴点

| 借鉴项 | TDSF 需补齐 |
|--------|-------------|
| **统一 mini/panel 状态** | TDSF 的 mini 窗与右侧 panel 是两套独立状态，建议合并到 `chatStore` 的 `mini`/`panelOpen`/`focusSignal` |
| **无 key 统一拦截** | TDSF 多处直接打开面板，未配置模型时会报错；应学习 `if (!hasComposer) openSettingsWindow("models")` 的兜底 |
| **浮动窗几何记忆** | Terax 用 `useMiniWindowGeometry` 保存位置/大小，TDSF mini 窗每次重新打开都复位 |
| **Esc 关闭 mini** | TDSF mini 窗缺少键盘关闭逻辑 |
| **同一个 `Chat` 实例** | mini 与 panel 共享 `getOrCreateChat(sessionId)`，TDSF 目前两个入口可能创建不同实例 |

---

## 5. LLM 配置

### 5.1 关键文件

| 文件路径 | 职责 |
|----------|------|
| `src/modules/ai/config.ts` | Provider/Model 清单、价格、上下文限制、system prompt |
| `src/modules/ai/lib/keyring.ts` | 通过 Tauri `secrets_*` 读写 OS keychain |
| `src/settings/sections/ModelsSection.tsx` | 设置 UI：添加 provider、输入 key、本地模型 URL/模型 ID、测试连通性 |
| `src/modules/ai/store/chatStore.ts` | 保存 `apiKeys`、`customEndpointKeys`、`selectedModelId` |
| `src/modules/ai/lib/agent.ts` | `buildConfiguredLanguageModel` 根据配置构造 `@ai-sdk/*` provider |

### 5.2 关键代码

**1) Provider 元数据**

```ts
// modules/ai/config.ts (L28-L121)
export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "openai", label: "OpenAI", keyringAccount: "openai-api-key", keyPrefix: "sk-", consoleUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", keyringAccount: "anthropic-api-key", keyPrefix: "sk-ant-", consoleUrl: "https://console.anthropic.com/settings/keys" },
  { id: "lmstudio", label: "LM Studio", keyringAccount: "", keyPrefix: null, consoleUrl: "https://lmstudio.ai/docs/basics/server" },
  // ...
] as const;
```

**2) 模型清单与标签**

```ts
// modules/ai/config.ts (L190-L273)
export const MODELS = [
  {
    id: "gpt-5.6",
    provider: "openai",
    label: "GPT-5.6 Sol",
    hint: "Flagship",
    description: "Frontier model for complex professional and agentic work.",
    capabilities: { intelligence: 5, speed: 4, cost: 1 },
    tags: ["vision", "reasoning", "tools", "coding"],
    supportsTemperature: false,
  },
  // ...
] as const satisfies readonly ModelInfo[];
```

**3) keyring 读写**

```ts
// modules/ai/lib/keyring.ts (L30-L88)
export async function getKey(provider: ProviderId): Promise<string | null> {
  if (!providerSupportsKey(provider)) return null;
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: getProvider(provider).keyringAccount,
    });
    return v && v.length > 0 ? v : null;
  } catch { return null; }
}

export async function setKey(provider: ProviderId, key: string): Promise<void> {
  if (!providerSupportsKey(provider)) throw new Error(`${provider} does not use an API key`);
  const trimmed = key.trim();
  if (!trimmed) throw new Error("API key is empty");
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: getProvider(provider).keyringAccount,
    password: trimmed,
  });
}

export async function getAllKeys(): Promise<ProviderKeys> {
  const out = { ...EMPTY_PROVIDER_KEYS };
  const need = PROVIDERS.filter((p) => providerSupportsKey(p.id));
  try {
    const results = await invoke<(string | null)[]>("secrets_get_all", {
      service: KEYRING_SERVICE,
      accounts: need.map((p) => p.keyringAccount),
    });
    need.forEach((p, i) => { const v = results[i]; out[p.id] = v && v.length > 0 ? v : null; });
    return out;
  } catch { /* fallback 逐个读取 */ }
}
```

**4) 设置页面保存 key 后广播变更**

```tsx
// settings/sections/ModelsSection.tsx (L179-L189)
const onSaveKey = async (provider: ProviderId, value: string) => {
  await setKey(provider, value);
  setKeys((prev) => (prev ? { ...prev, [provider]: value } : prev));
  await emitKeysChanged();
};

const onClearKey = async (provider: ProviderId) => {
  await clearKey(provider);
  setKeys((prev) => (prev ? { ...prev, [provider]: null } : prev));
  await emitKeysChanged();
};
```

**5) chatStore 加载 key 并构造 Chat**

```ts
// store/chatRuntime.ts (L40-L101)
const transport = createContextAwareTransport({
  getKeys: () => useChatStore.getState().apiKeys,
  toolContext,
  getModelId: () => useChatStore.getState().selectedModelId,
  getCustomInstructions: () => usePreferencesStore.getState().customInstructions,
  getAgentPersona: () => { /* ... */ },
  getLive: () => { /* ... */ },
  // ...
}) as unknown as ChatTransport<UIMessage>;
```

**6) 根据 modelId 动态构造 `@ai-sdk/*` provider**

```ts
// lib/agent.ts (L76-L217)
export async function buildLanguageModel(provider: ProviderId, keys: ProviderKeys, resolvedModelId: string, options: BuildModelOptions, customEndpointKey?: string | null): Promise<LanguageModel> {
  if (providerNeedsKey(provider) && !keys[provider]) {
    throw new Error(`No API key configured for ${provider}. Open Settings → AI to add one.`);
  }
  // ...
  switch (provider) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      built = createOpenAI({ apiKey: key })(resolvedModelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      built = createAnthropic({ apiKey: key })(resolvedModelId);
      break;
    }
    case "deepseek": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      built = createOpenAICompatible({ name: "deepseek", baseURL: "https://api.deepseek.com", apiKey: key })(resolvedModelId);
      break;
    }
    // ...
  }
}
```

### 5.3 对 TDSF 的借鉴点

| 借鉴项 | TDSF 需补齐 |
|--------|-------------|
| **集中 model/provider 配置** | TDSF 的模型列表散落多处，应集中到 `config.ts` 并用 `ModelInfo` 描述能力/标签/价格 |
| **系统密钥库存 key** | TDSF 目前把 key 存在前端 store 或明文，应迁移到 Tauri `secrets_get`/`secrets_set` |
| **Custom endpoint 机制** | TDSF 只有固定 provider，建议引入 `CustomEndpoint` + `compatModelIdForEndpoint` 支持任意 OpenAI-compatible 接口 |
| **key 变更广播** | TDSF 修改 key 后需要刷新才能生效，应引入 `emitKeysChanged` 事件 |
| **本地模型统一走 `openai-compatible`** | TDSF 的 LM Studio/Ollama/MLX 应像 Terax 一样用 `@ai-sdk/openai-compatible` + baseURL |

---

## 6. 总结：TDSF 最优先补齐的 10 个点

1. **终端缓冲按需读取**：引入 `get_terminal_output` 工具，替代自动全量注入。
2. **环境块 `<env>` 注入**：把 cwd/active file/workspace root 拼成结构化块 prepend 到最后一条 user message。
3. **终端缓冲脱敏**：实现 `redactSensitive`，过滤 API key/密码/JWT 等敏感内容。
4. **Privacy 模式**：给终端 tab 增加 `private` 标记，拒绝 LLM 读取。
5. **Reasoning UI 与保留策略**：实现 `Reasoning` 折叠组件 + `modelKeepsReasoning` + `pruneMessages`。
6. **工具状态可视化**：补齐 `Tool` 卡片的 `approval-requested`/`input-streaming`/`output-available` 等状态。
7. **命令插入不执行**：`suggest_command` 点击 Insert 只写终端不加 `\r`。
8. **重内容工具 memo 优化**：引入 `HEAVY_CONTENT_TOOLS` + `deriveSummary` 避免逐 token 重渲染。
9. **统一 AI 入口状态**：合并 mini/panel/focus 状态到 chatStore，并做无 key 统一拦截。
10. **LLM key 走系统密钥库 + 配置中心**：集中到 `config.ts`/`keyring.ts`/`ModelsSection.tsx`，支持 custom endpoint 与本地模型。

---

*报告生成结束，未修改任何源文件。*
