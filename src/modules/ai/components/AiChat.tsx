import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  CodeIcon,
  File01Icon,
  HashtagIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useMemo } from "react";
import { isLiveMessage, LiveMessageProvider } from "../lib/autoTypeProvenance";
import { sendMessage } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import {
  isAwaitingUser,
  useNeedsYouWait,
} from "../store/needsYouWaitStore";
// Task 6.5: sidecar needs_you 审批闭环（approval 类请求渲染四层审批卡）
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { NeedsYouApprovalFallback } from "../lib/needsYouApprovalContext";
// P2-1: teach 教学卡片（6 大板块分区渲染）
import { shouldRenderTeachCard, stripTeachOutputMarker } from "./teachParser";
import { TeachCard } from "./TeachCard";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE = /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function compactReasoningText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: context chips are static display items that never reorder; composite key with index is sufficient for React reconciliation.
          key={`${chipLabel(c)}-${i}`}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="opacity-70">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop: () => void | PromiseLike<void>;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const step = useChatStore((s) => s.agentMeta.step);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  // #133 本会话有 needs_you 挂着 = 整轮停在"等你回答"上，不是 AI 在想事情。
  // 这一行与 sidecar-adapter 的无活动停表读同一个事实，两边不许分叉。
  const awaitingUser = useNeedsYouWait((s) =>
    isAwaitingUser(s, activeSessionId),
  );
  const hitStepCap = useChatStore((s) => s.agentMeta.hitStepCap);
  const compactionNotice = useChatStore((s) => s.agentMeta.compactionNotice);
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const showContinue =
    !isBusy && hitStepCap && lastMessage?.role === "assistant";

  const onApproval = useCallback(
    (id: string, approved: boolean, reason?: string) =>
      // Task 6.5: reason 透传拒绝/附言（AI SDK addToolApprovalResponse 原生字段，
      // 随审批响应发给模型）；为空时省略，保持与旧调用形态一致
      addToolApprovalResponse({ id, approved, ...(reason ? { reason } : {}) }),
    [addToolApprovalResponse],
  );

  if (messages.length === 0) {
    return (
      <NeedsYouApprovalCards>
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Ask TDSF anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
          <NeedsYouApprovalFallback />
        </ConversationContent>
      </Conversation>
      </NeedsYouApprovalCards>
    );
  }

  return (
    <NeedsYouApprovalCards>
    <Conversation>
      <ConversationContent className="gap-3 p-3">
        {messages.map((m) => (
          // 出身闸门：只有本次运行生成的消息，其命令卡才允许自动打字到终端。
          // 从盘上读回来的历史消息（打开旧对话 / 冷启动后再进来）一律不许——
          // 否则每条历史命令都会被重新打一遍，auto 档下等于重新执行。
          <LiveMessageProvider key={m.id} value={isLiveMessage(m.id)}>
            <RenderedMessage
              message={m}
              onApproval={onApproval}
              streaming={m.id === streamingMessageId}
            />
          </LiveMessageProvider>
        ))}
        {/* Task 6.5: sidecar needs_you 审批闭环——approval 类 HITL 请求渲染
            四层审批卡（semantic/command/explanation/impact），三按钮经
            needs_you.respond RPC 回传 Python 唤醒阻塞的工具线程 */}
        <NeedsYouApprovalFallback />
        {compactionNotice && (
          <CompactionNotice
            droppedCount={compactionNotice.droppedCount}
            onDismiss={() => patchAgentMeta({ compactionNotice: null })}
          />
        )}
        {showSpinner && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span className="truncate">
              {awaitingUser ? "等待你的确认" : (step ?? "Thinking…")}
            </span>
          </div>
        )}
        {showContinue && (
          <ContinueRow
            onContinue={() => {
              patchAgentMeta({ hitStepCap: false });
              void sendMessage(
                "Continue from where you stopped. Don't recap — just keep going.",
              );
            }}
          />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">请求失败</div>
            <div className="mt-0.5 leading-relaxed whitespace-pre-wrap break-words opacity-90">
              {error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 underline opacity-80 hover:opacity-100"
            >
              关闭
            </button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
    </NeedsYouApprovalCards>
  );
}

const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  onDismiss,
}: {
  droppedCount: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500/80" />
      <span className="flex-1 truncate">
        Context compacted — {droppedCount} older tool result
        {droppedCount === 1 ? "" : "s"} elided to save tokens.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

const ContinueRow = memo(function ContinueRow({
  onContinue,
}: {
  onContinue: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-[11px]">
      <span className="flex-1 text-muted-foreground">
        Hit the step limit. Continue to keep going.
      </span>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      >
        Continue
      </button>
    </div>
  );
});

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean, reason?: string) => void;
  streaming: boolean;
}) {
  // Index of the trailing text part — only that one is "live" mid-stream.
  // Earlier text parts (separated by tool calls) are already finalized.
  let lastTextIdx = -1;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  const groups = useMemo(
    () => buildPartGroups(message.parts as AnyPart[]),
    [message.parts],
  );
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const stripped = stripUserContextBlocks(rawText);

    return (
      <Message from="user">
        <MessageContent>
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {stripped.text ? (
            <p className="whitespace-pre-wrap wrap-break-word">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-2">
          {groups.map((g) => {
            if (g.kind === "reads") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadGroup parts={g.parts} />
                </PartAppear>
              );
            }
            const isReadSingle =
              partType(g.part) === "tool-read_file" &&
              ((g.part as { state?: string }).state ?? "") !==
                "approval-requested";
            if (isReadSingle) {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadRow part={g.part} />
                </PartAppear>
              );
            }
            return (
              <PartAppear key={`${message.id}-${g.key}`}>
                <RenderedPart
                  part={g.part}
                  onApproval={onApproval}
                  streaming={streaming && g.idx === lastTextIdx}
                />
              </PartAppear>
            );
          })}
        </div>
      </MessageContent>
    </Message>
  );
});

type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string };

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    if (run.parts.length >= 2) {
      out.push({
        kind: "reads",
        parts: run.parts,
        key: `reads-${partKey(run.parts[0], run.startIdx)}`,
      });
    } else {
      const startIdx = run.startIdx;
      run.parts.forEach((p, k) => {
        const idx = startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  parts.forEach((p, i) => {
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  return out;
}

function readPathFromPart(p: AnyPart): string | null {
  const input = (p as { input?: { path?: unknown } }).input;
  const path = input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const ReadGroup = memo(function ReadGroup({ parts }: { parts: AnyPart[] }) {
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const path = readPathFromPart(p);
      if (!path) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [parts]);
  const count = paths.length || parts.length;
  const preview = paths.map(basename).join(", ");

  return (
    <Collapsible className="group/read overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/read:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Read</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} file{count === 1 ? "" : "s"}
        </span>
        {paths.length > 0 ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/read:invisible">
            · {preview}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="tdsf-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            >
              <HugeiconsIcon
                icon={File01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 opacity-60"
              />
              <span className="truncate text-foreground">{basename(path)}</span>
              <span className="truncate opacity-60">{path}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

const PartAppear = memo(function PartAppear({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out">
      {children}
    </div>
  );
});

const ReadRow = memo(function ReadRow({ part }: { part: AnyPart }) {
  const path = readPathFromPart(part);
  const state = (part as { state?: string }).state ?? "";
  const isError = state === "output-error";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError
            ? "bg-destructive"
            : "border border-muted-foreground/40 bg-transparent",
        )}
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 font-medium text-foreground">Read</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {path ?? ""}
      </span>
    </div>
  );
});

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean, reason?: string) => void;
  streaming: boolean;
}) {
  if (part.type === "text") {
    const text = (part as unknown as { text: string }).text;
    // Teach 模式的显式标记可在流式期间直接渲染；无标记的旧输出则等
    // 流式结束后按结构标题兼容解析，知识检索仍保持普通 Markdown。
    const teach = useChatStore.getState().teach;
    if (shouldRenderTeachCard(text, teach, streaming)) {
      return <TeachCard content={text} />;
    }
    // A marker can arrive alone before a tool boundary. It has no visible
    // content, but MessageResponse still reserves vertical space for it.
    const visibleText = stripTeachOutputMarker(text);
    if (!visibleText.trim()) return null;
    return (
      <MessageResponse
        streaming={streaming}
        className="max-w-none text-[12.5px] leading-[1.65] text-foreground [&>*:not(:first-child)]:mt-1.5 [&_p]:my-1 [&_code]:rounded [&_code]:bg-muted/70 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.94em] [&_pre]:my-1.5 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/50 [&_pre]:p-2 [&_pre]:leading-relaxed [&_[data-streamdown=heading-1]]:mt-2.5 [&_[data-streamdown=heading-1]]:text-[15px] [&_[data-streamdown=heading-1]]:font-semibold [&_[data-streamdown=heading-1]]:tracking-tight [&_[data-streamdown=heading-2]]:mt-2.5 [&_[data-streamdown=heading-2]]:text-[14px] [&_[data-streamdown=heading-2]]:font-semibold [&_[data-streamdown=heading-3]]:mt-2 [&_[data-streamdown=heading-3]]:text-[13px] [&_[data-streamdown=heading-3]]:font-semibold [&_ul]:my-1.5 [&_ul]:pl-4 [&_ol]:my-1.5 [&_ol]:pl-4 [&_li]:my-0.5 [&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/35 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_table]:my-1.5 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
      >
        {visibleText}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    const text = compactReasoningText(
      (part as unknown as { text: string }).text,
    );
    if (!text) return null;
    return (
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>{text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    // TDSF 2026-08-31 (问题1修复): Teach 教学模式下不渲染命令预测卡片——
    // suggest_command 的 SuggestCommandCard（含"预测回显"）属于终端补全链路
    // UI，教学契约由 TeachCard 的「操作示例」命令块承担（复制/插入按钮齐全）。
    // 双保险的后端配套：教学皮肤 prompt 已明令"严禁调用 suggest_command"。
    // （过滤在 RenderedPart 分支处做——RenderedTool 内有 useCallback Hook，
    //   early return 会触发 rules-of-hooks。）
    const toolName =
      part.type === "dynamic-tool"
        ? part.toolName
        : part.type.replace(/^tool-/, "");
    if (toolName === "suggest_command" && useChatStore.getState().teach) {
      return null;
    }
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean, reason?: string) => void;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  // Task 6.5: approval-requested → 四层审批卡（ToolApprovalCard：语义/命令原文/
  // 解释/影响预测 + 拒绝附言/⚡会话免审/执行 三按钮）。回调双写：
  //   ① AI SDK 审批状态机（part → approval-responded，AgentRunBridge 的
  //      approvalsPending/awaiting-approval 状态随之推进——旧状态机不破坏），
  //      note 作为 reason 原生透传模型；
  //   ② 此 SDK 审批父回调维护前端会话免审标志，通用按钮只回传意图。
  const approvalId =
    part.state === "approval-requested" ? part.approval.id : null;
  const handleApprovalRespond = useCallback(
    (resp: { approved: boolean; note?: string; sessionTrust?: boolean }) => {
      if (!approvalId) return;
      if (resp.sessionTrust) {
        useChatStore.getState().setSessionReadOnlyTrust(true);
      }
      onApproval(approvalId, resp.approved, resp.note);
    },
    [approvalId, onApproval],
  );

  if (part.state === "approval-requested" && approvalId) {
    return (
      <Tool
        toolName={toolName}
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        onApprovalRespond={handleApprovalRespond}
      />
    );
  }

  return (
    <Tool
      toolName={toolName}
      toolCallId={part.toolCallId}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
      // Knowledge calls are first-class evidence in teaching mode.  Keep their
      // compact result visible by default so a retrieval is distinguishable
      // from the lesson prose that may follow it; the full document body is
      // still collapsible inside KnowledgeDocCard.
      defaultOpen={
        toolName === "list_directory" ||
        toolName === "knowledge_search" ||
        toolName === "knowledge_get_doc"
      }
    />
  );
});
