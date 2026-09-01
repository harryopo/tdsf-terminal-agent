import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { PresenceState } from "@/lib/usePresence";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  FilterIcon,
  PlusSignIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { useSpaces } from "@/modules/spaces";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo } from "react";
import {
  estimateCost,
  getModel,
  getModelContextLimit,
  type ModelId,
} from "../config";
import type { ResizeDir } from "../lib/miniWindowGeometry";
import type { SessionMeta } from "../lib/sessions";
import { useMiniWindowGeometry } from "../lib/useMiniWindowGeometry";
import { useAgentsStore } from "../store/agentsStore";
import { getOrCreateChat } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import { usePlanStore } from "../store/planStore";
import { AgentStatusPill } from "./AgentStatusPill";
import { WorkspaceGate } from "./WorkspaceGate";
import { AiChatView } from "./AiChat";
import { PlanDiffReview } from "./PlanDiffReview";
import { TodoStrip } from "./TodoStrip";

const SUGGESTIONS = [
  {
    label: "解释上一个错误",
    hint: "读取终端缓冲区",
    icon: AlertCircleIcon,
    text: "解释终端里的上一个错误。",
  },
  {
    label: "生成一条命令",
    hint: "告诉 AI 你想做什么",
    icon: TerminalIcon,
    text: "帮我写一条命令：",
  },
  {
    label: "总结缓冲区",
    hint: "回顾最近的活动",
    icon: FilterIcon,
    text: "总结一下终端里刚刚发生了什么。",
  },
];

export function AiMiniWindow({ state }: { state: PresenceState }) {
  const closeMini = useChatStore((s) => s.closeMini);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const openPanel = useChatStore((s) => s.openPanel);
  const expandToPanel = () => {
    closeMini();
    openPanel();
  };

  const { ref, onHeaderPointerDown, startResize } = useMiniWindowGeometry();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        closeMini();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeMini]);

  return (
    <div
      ref={ref}
      data-state={state}
      data-ai-mini-window
      className={cn(
        "no-scrollbar-deep fixed z-40 flex flex-col overflow-hidden",
        "rounded-2xl border border-border/60 bg-card text-[12px]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_24px_48px_-12px_rgba(0,0,0,0.45),0_8px_16px_-8px_rgba(0,0,0,0.3)]",
        "ring-1 ring-black/5 dark:ring-white/5",
        "duration-200 ease-out",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2",
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-foreground/[0.03] to-transparent"
      />
      {RESIZE_DIRS.map((dir) => (
        <ResizeHandle key={dir} dir={dir} onPointerDown={startResize(dir)} />
      ))}
      {sessionId ? (
        <Body
          sessionId={sessionId}
          onClose={closeMini}
          onExpand={expandToPanel}
          onHeaderPointerDown={onHeaderPointerDown}
        />
      ) : (
        <EmptyShell
          onClose={closeMini}
          onExpand={expandToPanel}
          onHeaderPointerDown={onHeaderPointerDown}
        />
      )}
      <PlanDiffReview />
    </div>
  );
}

const RESIZE_HANDLE_CLASS: Record<ResizeDir, string> = {
  n: "top-0 left-3 right-3 h-1.5 cursor-ns-resize",
  s: "bottom-0 left-3 right-3 h-1.5 cursor-ns-resize",
  w: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize",
  e: "top-3 bottom-3 right-0 w-1.5 cursor-ew-resize",
  nw: "top-0 left-0 size-3 cursor-nwse-resize",
  ne: "top-0 right-0 size-3 cursor-nesw-resize",
  sw: "bottom-0 left-0 size-3 cursor-nesw-resize",
  se: "bottom-0 right-0 size-3 cursor-nwse-resize",
};

const RESIZE_DIRS: ResizeDir[] = ["n", "s", "w", "e", "nw", "ne", "sw", "se"];

function ResizeHandle({
  dir,
  onPointerDown,
}: {
  dir: ResizeDir;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      data-no-drag
      onPointerDown={onPointerDown}
      className={cn(
        "absolute z-50 touch-none select-none",
        RESIZE_HANDLE_CLASS[dir],
      )}
    />
  );
}

function Body({
  sessionId,
  onClose,
  onExpand,
  onHeaderPointerDown,
}: {
  sessionId: string;
  onClose: () => void;
  onExpand: () => void;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
}) {
  const focusInput = useChatStore((s) => s.focusInput);
  const step = useChatStore((s) => s.agentMeta.step);

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";
  // 工作区门控（用户钦定 2026-09-01）: 未绑定工作区的会话 agent 不运行
  const sessionScope = useChatStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.scope,
  );
  const gated = sessionScope?.kind !== "workspace";

  return (
    <>
      <Header
        step={step}
        isBusy={isBusy}
        onClose={onClose}
        onExpand={onExpand}
        messages={helpers.messages}
        onHeaderPointerDown={onHeaderPointerDown}
      />

      <PlanModeStrip />

      <div className="flex min-h-0 flex-1 flex-col">
        {gated ? (
          <WorkspaceGate />
        ) : helpers.messages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
            <AiChatView
              messages={helpers.messages}
              status={helpers.status}
              error={helpers.error}
              clearError={helpers.clearError}
              addToolApprovalResponse={helpers.addToolApprovalResponse}
              stop={helpers.stop}
            />
          </div>
        )}
      </div>

      <TodoStrip sessionId={sessionId} />
    </>
  );
}

function PlanModeStrip() {
  const active = usePlanStore((s) => s.active);
  const queueLen = usePlanStore((s) => s.queue.length);
  const disable = usePlanStore((s) => s.disable);
  if (!active) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-muted/40 px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      <span className="text-[11px] font-medium text-foreground">规划模式</span>
      <span className="text-[11px] text-muted-foreground">
        {queueLen > 0 ? `· ${queueLen} 项排队` : "· 无待应用编辑"}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => disable()}
        className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        退出
      </button>
    </div>
  );
}

function EmptyShell({
  onClose,
  onExpand,
  onHeaderPointerDown,
}: {
  onClose: () => void;
  onExpand: () => void;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <>
      <Header
        step={null}
        isBusy={false}
        onClose={onClose}
        onExpand={onExpand}
        onHeaderPointerDown={onHeaderPointerDown}
      />
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        正在加载会话…
      </div>
    </>
  );
}

function Header({
  step,
  isBusy,
  onClose,
  messages,
  onHeaderPointerDown,
}: {
  step: string | null;
  isBusy: boolean;
  onClose: () => void;
  onExpand: () => void;
  messages?: UIMessage[];
  onHeaderPointerDown: (e: React.PointerEvent) => void;
}) {
  const customAgents = useAgentsStore((s) => s.customAgents);
  void customAgents;

  return (
    <div
      onPointerDown={onHeaderPointerDown}
      className="relative flex h-11 shrink-0 cursor-grab items-center justify-between gap-2 border-b border-border/60 px-3 active:cursor-grabbing"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {/* 用户钦定 2026-09-01: 最左侧新建对话（须绑定工作区，否则引导创建） */}
        <NewChatButton />
        <AgentStatusPill isMiniWindow />
        <WorkspaceChip />
        {messages !== undefined ? (
          <ContextIndicator messages={messages} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isBusy ? (
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Spinner className="size-2.5" />
            <span className="max-w-32 truncate">{step ?? "思考中…"}</span>
          </span>
        ) : null}
        <SessionPicker />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onClose}
          className="size-5"
          aria-label="关闭"
          title="关闭 (Esc)"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

/** 最左侧新建对话（用户钦定 2026-09-01）——无工作区时引导创建而非直接建会话 */
function NewChatButton() {
  const newSession = useChatStore((s) => s.newSession);
  const hasSpace = useSpaces((s) => s.activeId !== null);
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="size-6 shrink-0"
      aria-label="新建对话"
      title={hasSpace ? "新建对话" : "请先创建/选择工作区"}
      data-testid="new-chat-button"
      onClick={() => {
        if (hasSpace) newSession();
        else window.dispatchEvent(new CustomEvent("tdsf:spaces-create"));
      }}
    >
      <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={2} />
    </Button>
  );
}

/** 工作区徽章：显示当前绑定的工作区，点击打开工作区总览 */
function WorkspaceChip() {
  const active = useSpaces((s) =>
    s.spaces.find((x) => x.id === s.activeId),
  );
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(new CustomEvent("tdsf:spaces-overview"))
      }
      className={cn(
        "flex h-6 min-w-0 max-w-32 shrink-0 items-center rounded-md px-1.5",
        "text-[10.5px] transition-colors",
        active
          ? "text-muted-foreground hover:bg-accent hover:text-foreground"
          : "font-medium text-amber-600 hover:bg-amber-500/10 dark:text-amber-400",
      )}
      title="切换工作区（agent 按工作区隔离运行）"
      data-testid="workspace-chip"
    >
      <span className="truncate">{active ? active.name : "选择工作区"}</span>
    </button>
  );
}

function estimateTokens(messages: UIMessage[]): number {  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (p.type === "reasoning") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tp = p as unknown as { input?: unknown; output?: unknown };
        if (tp.input) chars += JSON.stringify(tp.input).length;
        if (tp.output) chars += JSON.stringify(tp.output).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * 上下文模块占比分解（参照主流 AI IDE，2026-09-01）。
 * 固定件为保守估算（工具 schema/组合系统提示/技能描述），消息为真实
 * chars/4 估算；真实 lastInput 可用时其他行按剩余量封顶。
 */
const CONTEXT_TOOL_DEF_TOKENS = 3600; // 23 工具 schema 估算
const CONTEXT_SYS_PROMPT_TOKENS = 1000; // 组合系统提示 ~3.9k chars / 4
const CONTEXT_SKILL_TOKENS = 600; // 7 技能包描述估算

function contextBreakdownRows(
  messages: UIMessage[],
  used: number,
): { label: string; tokens: number }[] {
  const msgTokens = estimateTokens(messages);
  const total = used > 0 ? used : msgTokens + CONTEXT_TOOL_DEF_TOKENS + CONTEXT_SYS_PROMPT_TOKENS + CONTEXT_SKILL_TOKENS;
  let remaining = Math.max(0, total);
  const rows = [
    { label: "消息", tokens: msgTokens },
    { label: "工具定义", tokens: CONTEXT_TOOL_DEF_TOKENS },
    { label: "系统提示词", tokens: CONTEXT_SYS_PROMPT_TOKENS },
    { label: "技能", tokens: CONTEXT_SKILL_TOKENS },
  ].map((p) => {
    const v = Math.min(p.tokens, remaining);
    remaining -= v;
    return { label: p.label, tokens: v };
  });
  rows.push({ label: "其他", tokens: Math.max(0, remaining) });
  return rows;
}

function ContextIndicator({ messages }: { messages: UIMessage[] }) {
  const modelId = useChatStore((s) => s.selectedModelId);
  const tokens = useChatStore((s) => s.agentMeta.tokens);
  const lastInput = useChatStore((s) => s.agentMeta.lastInputTokens);
  const lastCached = useChatStore((s) => s.agentMeta.lastCachedTokens);
  const estimated = useMemo(() => estimateTokens(messages), [messages]);
  const used = lastInput > 0 ? lastInput : estimated;
  const reported = tokens.inputTokens + tokens.outputTokens;
  const openaiCompatibleContextLimit = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
  );
  const max = getModelContextLimit(modelId, openaiCompatibleContextLimit);
  const modelLabel = useMemo(() => {
    try {
      return getModel(modelId as ModelId).label;
    } catch {
      return modelId;
    }
  }, [modelId]);
  const cost = estimateCost(modelId, tokens);
  const cacheRate =
    tokens.inputTokens > 0
      ? Math.round((tokens.cachedInputTokens / tokens.inputTokens) * 100)
      : 0;

  return (
      <Context usedTokens={used} maxTokens={max}>
      <ContextTrigger className="h-6 gap-1 px-0 text-[10.5px]" />
      <ContextContent className="w-64 text-[11px]">
        <ContextContentHeader />
        <ContextContentBody>
          {/* 模块占比分解（参照主流 AI IDE 上下文面板，2026-09-01） */}
          <div className="space-y-1 border-b border-border/40 pb-2">
            {contextBreakdownRows(messages, used).map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between"
              >
                <span className="text-muted-foreground">{row.label}</span>
                <span className="font-mono text-foreground">
                  {used > 0
                    ? `${Math.round((row.tokens / Math.max(used, 1)) * 100)}%`
                    : "—"}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">平均缓存命中率</span>
              <span className="font-mono text-foreground">
                {tokens.inputTokens > 0 ? `${cacheRate}%` : "—"}
              </span>
            </div>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Model</span>
            <span className="font-mono text-foreground">{modelLabel}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-muted-foreground">
            <span>{lastInput > 0 ? "Last request" : "Estimated context"}</span>
            <span className="font-mono text-foreground">
              {formatTokens(used)}
            </span>
          </div>
          {lastCached > 0 && (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Of which cached</span>
              <span className="font-mono text-foreground">
                {formatTokens(lastCached)}
              </span>
            </div>
          )}
          {reported > 0 && (
            <>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span>Session input</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.inputTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Session output</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.outputTokens)}
                </span>
              </div>
              {tokens.cachedInputTokens > 0 && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Cache hit</span>
                  <span className="font-mono text-foreground">
                    {cacheRate}%
                  </span>
                </div>
              )}
              {cost != null && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Session cost</span>
                  <span className="font-mono text-foreground">
                    ${cost.toFixed(cost < 0.01 ? 4 : cost < 1 ? 3 : 2)}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Window</span>
            <span className="font-mono text-foreground">
              {formatTokens(max)}
            </span>
          </div>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-[10px] italic text-muted-foreground">
            {lastInput > 0
              ? "Last request reflects current context size; session totals are cumulative."
              : "Token count is approximate (chars / 4)."}
          </span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}

function SessionPicker() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  if (!active) return null;

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-w-0 max-w-48 items-center gap-1 rounded-md px-1.5 py-1",
            "text-[11px] text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
          )}
          title="切换会话"
        >
          <span className="truncate">{active.title || "新会话"}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="opacity-70"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuItem
          onSelect={() => newSession()}
          className="gap-2 text-xs"
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
          新建会话
        </DropdownMenuItem>
        {sorted.length > 0 ? <DropdownMenuSeparator /> : null}
        {sorted.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId}
            onSelect={() => switchSession(s.id)}
            onDelete={() => deleteSession(s.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 工作区 scope 徽章：显示绑定的工作区名（A1 工作区隔离联动） */
function WorkspaceBadge({ spaceId }: { spaceId: string }) {
  const name = useSpaces((s) => s.spaces.find((x) => x.id === spaceId)?.name);
  return (
    <span
      className="shrink-0 rounded bg-violet-500/10 px-1 py-px text-[10px] text-violet-600 dark:text-violet-400"
      title={`绑定工作区 ${name ?? spaceId}`}
    >
      {name ?? "工作区"}
    </span>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {  return (
    <DropdownMenuItem
      onSelect={(e) => {
        // Don't dismiss if user clicked the trash icon — handle below.
        const target = e.target as HTMLElement | null;
        if (target?.closest("[data-session-delete]")) {
          e.preventDefault();
          return;
        }
        onSelect();
      }}
      className={cn(
        "group flex items-center justify-between gap-2 text-xs",
        active && "bg-accent/40",
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {session.title || "新会话"}
      </span>
      {/* A1 多服务器隔离: 会话绑定的环境范围徽章——工作区名/主机/本地，
          用户可直观区分"这个对话属于哪个工作空间"防上下文混淆 */}
      {session.scope?.kind === "workspace" ? (
        <WorkspaceBadge spaceId={session.scope.spaceId} />
      ) : session.scope?.kind === "ssh" ? (
        <span
          className="shrink-0 rounded bg-sky-500/10 px-1 py-px text-[10px] text-sky-600 dark:text-sky-400"
          title={`绑定服务器 ${session.scope.user}@${session.scope.host}`}
        >
          {session.scope.host}
        </span>
      ) : session.scope?.kind === "local" ? (
        <span
          className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground"
          title="本地工作区会话"
        >
          本地
        </span>
      ) : null}
      <button
        type="button"
        data-session-delete
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="删除会话"
        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
      >
        <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
      </button>
    </DropdownMenuItem>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-10 text-center">
      <img
        src="/logo.svg"
        alt="TDSF"
        className="size-14 rounded-lg opacity-90"
      />
      <div className="space-y-1.5">
        <p className="text-[14px] font-semibold tracking-tight">
          向 TDSF 提问
        </p>
        <p className="max-w-[18rem] text-[11.5px] leading-relaxed text-muted-foreground">
          TDSF 能感知当前终端 —— 工作目录、最近命令与输出。
        </p>
      </div>
      <div className="flex w-full flex-col gap-2.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(s.text)}
            className={cn(
              "group flex items-center gap-2.5 bg-card/70 rounded-lg px-2.5 py-2 border border-border text-left",
              "transition-colors hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground transition-colors group-hover:bg-foreground/5 group-hover:text-foreground">
              <HugeiconsIcon icon={s.icon} size={13} strokeWidth={1.75} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-foreground">
                {s.label}
              </div>
              <div className="text-[10.5px] text-muted-foreground">
                {s.hint}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
