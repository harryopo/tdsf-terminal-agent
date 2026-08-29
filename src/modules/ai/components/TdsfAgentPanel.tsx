// TDSF 魔改: AgentPanel — 对齐原自研项目视觉风格（mood 表情 + 4 Agent Tab + tokens）
// -----------------------------------------------------------------------------
// 设计参考: tdsf-terminal-agent/src/components/AgentPanel.tsx
// 适配策略:
//   - useRuntime → useChatStore (mini.open / agentMeta / focusInput / closeMini)
//   - state.mood → agentMeta.status 映射到原表情 (idle/thinking/streaming/awaiting-approval/error)
//   - state.agentBusy → status !== "idle" && status !== "error"
//   - state.tokens → agentMeta.tokens.inputTokens + outputTokens
//   - 消息渲染复用 clone 的 AiChatView (避免重复造轮子)
//   - 4 TDSF Agent Tab: Coder / Explore / History / Teach
//     TDSF 阶段3改造: Tab 切换状态从本地 useState 改为读 chatStore.tdsfAgentId，
//     通过 setTdsfAgent 联动 transport 路由（让 runSidecarStream 收到正确的 agentId）
//
// 组件结构 (对齐 AiMiniWindow 模式):
//   - TdsfAgentPanel (外层): 处理 PresenceState + ESC 关闭 + sessionId 路由 + 拖动
//   - Body (内层): sessionId 已确认非空，调用 getOrCreateChat 拿到 chat 实例
//   - LoadingShell: sessionId 为 null 时的加载占位
// 这样 chat 类型严格非空，与 AiMiniWindow.Body 完全一致。
//
// TDSF 魔改 P1-1: 浮动窗口支持拖动 + 高度调整
//   - 通过 mousedown/mousemove/mouseup 实现拖动（Header 区域可拖）
//   - 通过右下角 resize handle 实现高度调整
//   - 位置和大小持久化到 localStorage
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  ArrowUp01Icon,
  Cancel01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { PresenceState } from "@/lib/usePresence";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AGENT_MODE_META } from "../agents/registry";
import { getOrCreateChat, sendMessage } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import { AiChatView } from "./AiChat";
import { AgentModeSwitcher } from "./AgentModeSwitcher";
// TDSF 魔改 (P4-T4.4): 集成 Skill 调用 — /skill:<name> <args>
import {
  parseSkillCommand,
  useSkillsStore,
} from "@/modules/skills";

// === 浮动窗口位置/大小持久化 ================================================
// TDSF 魔改 P1-1: 拖动 + 高度调整后的位置和大小持久化到 localStorage，
// 下次打开时恢复。默认靠右下角，宽度 420px，高度 540px。
const PANEL_STORAGE_KEY = "tdsf-agent-panel-geometry";
const DEFAULT_GEOMETRY = {
  x: -1, // -1 表示使用默认 right: 12px
  y: -1, // -1 表示使用默认 bottom: 36px
  width: 420,
  height: 540,
};

function loadGeometry(): typeof DEFAULT_GEOMETRY {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_GEOMETRY>;
      return { ...DEFAULT_GEOMETRY, ...parsed };
    }
  } catch {
    // ignore
  }
  return DEFAULT_GEOMETRY;
}

function saveGeometry(g: typeof DEFAULT_GEOMETRY) {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(g));
  } catch {
    // ignore
  }
}

// === mood 表情映射 ==========================================================
// clone 的 agentMeta.status: idle | thinking | streaming | awaiting-approval | error
// 原项目的 mood: idle | thinking | stream | working | waiting | done | error
// 映射关系:
//   idle            → idle    ⬡‿⬡
//   thinking        → thinking ⬡_⬡
//   streaming       → stream   ⬡~⬡
//   awaiting-approval → waiting ⬡⏸⬡
//   error           → error   ⬡✗⬡
const MOOD_FACE: Record<string, string> = {
  idle: "⬡‿⬡",
  thinking: "⬡_⬡",
  streaming: "⬡~⬡",
  "awaiting-approval": "⬡⏸⬡",
  error: "⬡✗⬡",
};

const MOOD_COLOR: Record<string, string> = {
  idle: "var(--color-muted-foreground, #6b7280)",
  thinking: "var(--color-primary, #10b981)",
  streaming: "var(--color-primary, #10b981)",
  "awaiting-approval": "var(--color-warning, #f59e0b)",
  error: "var(--color-error, #ef4444)",
};

// === 模式指示（v3.1 改造：三模式信任体系） =================================
// 旧版：面板顶部只读显示 main_agent 路由到的子 Agent（SUB_AGENT_META）
// v3.1：子 agent 委派机制已删除（方案书 §4.1），顶部改为显示当前信任模式
// （观察/确认/自动）+ 教学皮肤标记；输入框上方工具行挂 AgentModeSwitcher。

interface TdsfAgentPanelProps {
  state: PresenceState;
}

export function TdsfAgentPanel({ state }: TdsfAgentPanelProps) {
  const closeMini = useChatStore((s) => s.closeMini);
  const sessionId = useChatStore((s) => s.activeSessionId);

  // === TDSF 魔改 P1-1: 拖动 + resize 状态 ===
  const [geometry, setGeometry] = useState(loadGeometry);
  const [dragging, setDragging] = useState(false);
  // 2026-07-28 P-E: 改为多向 resize 模式，支持底部/右侧/右下角 3 个 handle
  // 用户痛点: 浮动窗口无法横向拉伸
  const [resizeDir, setResizeDir] = useState<null | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw">(null);
  const dragStartRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const resizeStartRef = useRef<{ mx: number; my: number; pw: number; ph: number; px: number; py: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // ESC 关闭（与 AiMiniWindow 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      closeMini();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeMini]);

  // === TDSF 魔改 P1-1: 拖动 Header 移动浮动窗口 ===
  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // 仅左键 + 非按钮区域才触发拖动
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // 点到按钮时不拖动
      if (target.closest("button") || target.closest("[data-no-drag]")) return;
      setDragging(true);
      dragStartRef.current = {
        mx: e.clientX,
        my: e.clientY,
        px: geometry.x === -1 ? window.innerWidth - 12 - geometry.width : geometry.x,
        py: geometry.y === -1 ? window.innerHeight - 36 - geometry.height : geometry.y,
      };
      e.preventDefault();
    },
    [geometry.x, geometry.y, geometry.width, geometry.height],
  );

  // === 2026-07-28 P-E: 多向 resize handle（n/s/e/w/ne/nw/se/sw） ===
  // 支持横向拉伸（用户痛点: 之前只能拉高度）
  const handleResizeMouseDown = useCallback(
    (dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw") =>
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        setResizeDir(dir);
        resizeStartRef.current = {
          mx: e.clientX,
          my: e.clientY,
          pw: geometry.width,
          ph: geometry.height,
          px: geometry.x === -1 ? window.innerWidth - 12 - geometry.width : geometry.x,
          py: geometry.y === -1 ? window.innerHeight - 36 - geometry.height : geometry.y,
        };
        e.preventDefault();
        e.stopPropagation();
      },
    [geometry.x, geometry.y, geometry.width, geometry.height],
  );

  // 全局 mousemove / mouseup 监听（拖动 + 多向 resize）
  useEffect(() => {
    if (!dragging && !resizeDir) return;

    const onMove = (e: MouseEvent) => {
      if (dragging && dragStartRef.current) {
        const dx = e.clientX - dragStartRef.current.mx;
        const dy = e.clientY - dragStartRef.current.my;
        const newX = Math.max(0, Math.min(window.innerWidth - geometry.width, dragStartRef.current.px + dx));
        const newY = Math.max(0, Math.min(window.innerHeight - 100, dragStartRef.current.py + dy));
        setGeometry((g) => ({ ...g, x: newX, y: newY }));
        return;
      }

      if (resizeDir && resizeStartRef.current) {
        const dx = e.clientX - resizeStartRef.current.mx;
        const dy = e.clientY - resizeStartRef.current.my;
        const start = resizeStartRef.current;
        let newW = start.pw;
        let newH = start.ph;
        let newX = start.px;
        let newY = start.py;

        // 横向调整
        if (resizeDir.includes("e")) {
          newW = Math.max(320, Math.min(window.innerWidth - 40, start.pw + dx));
        }
        if (resizeDir.includes("w")) {
          const proposedW = Math.max(320, Math.min(start.pw - dx, start.px + start.pw - 40));
          newW = proposedW;
          newX = start.px + (start.pw - proposedW);
        }
        // 纵向调整
        if (resizeDir.includes("s")) {
          newH = Math.max(360, Math.min(window.innerHeight - 80, start.ph + dy));
        }
        if (resizeDir.includes("n")) {
          const proposedH = Math.max(360, Math.min(start.ph - dy, start.py + start.ph - 80));
          newH = proposedH;
          newY = start.py + (start.ph - proposedH);
        }

        setGeometry((g) => ({ ...g, width: newW, height: newH, x: newX, y: newY }));
      }
    };

    const onUp = () => {
      if (dragging) setDragging(false);
      if (resizeDir) setResizeDir(null);
      dragStartRef.current = null;
      resizeStartRef.current = null;
      // 持久化
      setGeometry((g) => {
        saveGeometry(g);
        return g;
      });
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, resizeDir, geometry.width]);

  if (state === "closed") return null;

  // 计算 style: 当 x/y 为 -1 时使用默认 right/bottom，否则使用 left/top
  const panelStyle: React.CSSProperties = {
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
    maxHeight: "calc(100vh - 80px)",
  };
  if (geometry.x === -1 && geometry.y === -1) {
    panelStyle.right = "12px";
    panelStyle.bottom = "36px";
  } else {
    panelStyle.left = `${geometry.x}px`;
    panelStyle.top = `${geometry.y}px`;
  }

  return (
    <div
      ref={panelRef}
      data-state={state}
      data-tdsf-agent-panel
      className={cn(
        "no-scrollbar-deep fixed z-40 flex flex-col overflow-hidden",
        "rounded-2xl border border-border/60 bg-card/80 backdrop-blur-xl",
        "text-[12px]",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_24px_48px_-12px_rgba(0,0,0,0.45),0_8px_16px_-8px_rgba(0,0,0,0.3)]",
        "ring-1 ring-black/5 dark:ring-white/5",
        "duration-200 ease-out",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-2",
        dragging && "cursor-grabbing transition-none",
      )}
      style={panelStyle}
    >
      {sessionId ? (
        <Body
          sessionId={sessionId}
          onClose={closeMini}
          onHeaderMouseDown={handleHeaderMouseDown}
          onResizeMouseDown={handleResizeMouseDown}
        />
      ) : (
        <LoadingShell
          onClose={closeMini}
          onHeaderMouseDown={handleHeaderMouseDown}
          onResizeMouseDown={handleResizeMouseDown}
        />
      )}

    </div>
  );
}

// ============================================================================
// Body — sessionId 已确认非空，调用 getOrCreateChat 拿到 chat 实例
// 模式参照 AiMiniWindow.Body，保证类型严格 (chat 一定不为 undefined)
// ============================================================================
function Body({
  sessionId,
  onClose,
  onHeaderMouseDown,
  onResizeMouseDown,
}: {
  sessionId: string;
  onClose: () => void;
  onHeaderMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onResizeMouseDown: (dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw") => (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const focusInput = useChatStore((s) => s.focusInput);
  const agentMeta = useChatStore((s) => s.agentMeta);
  // v3.1: 三模式信任体系——顶部指示当前信任模式 + 教学皮肤标记
  // （旧 currentSubAgent 路由状态随子 agent 委派机制删除）
  const agentMode = useChatStore((s) => s.agentMode);
  const teach = useChatStore((s) => s.teach);
  const agentMetaStatus = useChatStore((s) => s.agentMeta.status);
  const isAgentBusy = agentMetaStatus === "thinking" || agentMetaStatus === "streaming";
  const modeMeta = AGENT_MODE_META[agentMode];
  // TDSF 魔改 (P4-T4.4): Skill 调用入口 — /skill:<name> <args>
  const invokeSkill = useSkillsStore((s) => s.invoke);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const mood = agentMeta.status;
  const moodFace = MOOD_FACE[mood] ?? "⬡‿⬡";
  const moodColor = MOOD_COLOR[mood] ?? MOOD_COLOR.idle;
  const isBusy = mood !== "idle" && mood !== "error";
  // TDSF 阶段3: 发送中也视为 busy，避免重复点击
  const isSending = isBusy || sending;
  const tokens = agentMeta.tokens.inputTokens + agentMeta.tokens.outputTokens;

  // 与 AiMiniWindow.Body 同款: chat 一定不为 null
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });

  // TDSF 魔改 (2026-08-09): 终端执行模式开关状态
  const autoExec = useChatStore((s) => s.autoExecuteInTerminal);
  const setAutoExec = useChatStore((s) => s.setAutoExecuteInTerminal);
  // 消息更新时自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [helpers.messages]);

  // === TDSF 阶段3: 提交输入 ===
  // 优先走 sendMessage（chatRuntime.ts → transport.ts → runSidecarStream）
  // 若 sendMessage 返回 false（如缺 API key），降级到 focusInput 让用户在主输入框发送
  //
  // TDSF 魔改 (P4-T4.4): 若输入以 `/skill:<name> <args>` 开头，则走 Skill 调用
  // 路径（useSkillsStore.invoke → executor.invokeSkill → IPC skill.invoke），
  // 不经过 LLM。成功/失败都用 toast 提示（2026-08-15: SkillInvoker 手动调用
  // 弹窗已移除，Agent 在允许时自动调用 skill）。
  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    // === T4.4: /skill:<name> <args> 解析 ===
    const parsed = parseSkillCommand(text);
    if (parsed) {
      setSending(true);
      try {
        const res = await invokeSkill(parsed.name, parsed.args);
        if (res.success) {
          toast.success(`Skill "${parsed.name}" 执行完成`, {
            description: `耗时 ${res.durationMs}ms`,
            duration: 3000,
          });
        } else {
          toast.error(`Skill "${parsed.name}" 执行失败`, {
            description: res.output.slice(0, 120),
            duration: 4000,
          });
        }
      } finally {
        setSending(false);
        setInput("");
      }
      return;
    }

    setSending(true);
    try {
      const ok = await sendMessage(text);
      if (!ok) {
        // 降级：把文本预填到主输入框，让用户手动按 Enter
        focusInput(text);
      }
    } finally {
      setSending(false);
      setInput("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <>
      {/* ===== ① Header (40px) — 可拖动区域 ======================================= */}
      <div
        className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-border/60 px-3 active:cursor-grabbing"
        data-tdsf-agent-header
        onMouseDown={onHeaderMouseDown}
        title="拖动移动浮动窗口"
      >
        {/* mood 表情 */}
        <span
          className="font-mono"
          style={{
            color: moodColor,
            fontSize: "13px",
            letterSpacing: "0.5px",
          }}
          data-testid="tdsf-agent-mood-face"
        >
          {moodFace}
        </span>
        <span
          className="font-semibold tracking-wide text-foreground"
          style={{ fontSize: "12px" }}
        >
          Main
        </span>
        <span
          className="rounded px-1.5 py-0.5 font-mono font-medium"
          style={{
            background:
              "color-mix(in srgb, var(--color-primary, #10b981) 15%, transparent)",
            color: "var(--color-primary, #10b981)",
            fontSize: "10px",
          }}
          data-testid="tdsf-agent-mode-badge"
        >
          {agentMode.toUpperCase()}
          {teach ? " · TEACH" : ""}
        </span>
        {/* tokens */}
        <span
          className="tabular-nums text-muted-foreground"
          style={{ fontSize: "10px" }}
          data-testid="tdsf-agent-tokens"
        >
          {tokens.toLocaleString()} tok
        </span>
        {isBusy && (
          <Spinner className="size-2.5" data-testid="tdsf-agent-busy" />
        )}
        <div className="flex-1" />
        {/* 关闭按钮 */}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onClose}
          className="size-5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="Close"
          title="关闭 (Esc)"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
        </Button>
      </div>

      {/* ===== 信任模式指示 + 切换器（v3.1 改造）
          - 旧版是只读 pill：显示 main_agent 当前路由到的子 Agent
          - v3.1：显示当前信任模式（观察/确认/自动）+ 教学皮肤标记，
            右侧挂 AgentModeSwitcher（三档 segmented control + Teach 开关），
            切换 per-session 持久化并随下一条消息即时生效 === */}
      <div
        className="flex shrink-0 items-center gap-1.5 border-b border-border/60 bg-muted/30 px-2 py-1"
        data-tdsf-agent-tabs
      >
        <span
          className="inline-block size-1.5 rounded-full"
          style={{
            background: isAgentBusy
              ? "var(--color-primary, #10b981)"
              : "var(--color-muted-foreground, #6b7280)",
            animation: isAgentBusy ? "pulse 1.4s ease-in-out infinite" : "none",
          }}
        />
        <span
          className="font-mono text-[10.5px] font-semibold text-foreground"
          data-testid="tdsf-agent-current"
          title={modeMeta.desc}
        >
          Main
        </span>
        <span
          className="truncate font-mono text-[10px] text-muted-foreground/70"
          title={teach ? `${modeMeta.desc}（教学皮肤：输出概念/示例/易错点/练习）` : modeMeta.desc}
        >
          · {modeMeta.badge}
          {teach ? " + 教学" : ""}
        </span>
        <div className="flex-1" />
        <AgentModeSwitcher />
      </div>

      {/* ===== ② Messages ====================================================== */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-tdsf-agent-messages
      >
        {helpers.messages.length === 0 ? (
          <EmptyState agentLabel="Main" />
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
        <div ref={messagesEndRef} />
      </div>

      {/* ===== ③ Input (56px) =================================================== */}
      <div
        className="shrink-0 border-t border-border/60 px-3 py-2"
        data-tdsf-agent-input-wrap
      >
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-2">
            <span
              className="font-mono"
              style={{
                color: "var(--color-primary, #10b981)",
                fontSize: "12px",
              }}
            >
              &gt;
            </span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isSending ? "Main 执行中..." : "输入命令或问题..."
              }
              disabled={isSending}
              maxLength={2000}
              data-testid="tdsf-agent-input"
              className="flex-1 border-none bg-transparent outline-none"
              style={{
                color: "var(--color-foreground, inherit)",
                fontSize: "12px",
                fontFamily: "inherit",
              }}
            />
            <span
              className="tabular-nums text-muted-foreground"
              style={{ fontSize: "10px" }}
            >
              {input.length}/2000
            </span>
          </div>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!input.trim() || isSending}
            variant="default"
            size="icon"
            className="size-7 shrink-0 rounded-full"
            title="发送 (Enter)"
            data-testid="tdsf-agent-send"
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={12} strokeWidth={2} />
          </Button>
        </div>
        {/* 快捷提示 */}
        <div
          className="mt-1.5 flex items-center gap-3 px-0.5 font-mono text-muted-foreground"
          style={{ fontSize: "10px" }}
        >
          <span>
            <span style={{ color: "var(--color-primary, #10b981)" }}>@</span>{" "}
            文件
          </span>
          <span>
            <span style={{ color: "var(--color-primary, #10b981)" }}>#</span>{" "}
            知识库
          </span>
          <span>
            <span style={{ color: "var(--color-primary, #10b981)" }}>/</span>{" "}
            命令
          </span>
          <div className="flex-1" />
          {/* TDSF 魔改 (2026-08-09): 终端执行模式开关 */}
          <button
            type="button"
            onClick={() => setAutoExec(!autoExec)}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
              autoExec
                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground hover:text-foreground",
            )}
            title="打开后 agent 建议的命令自动在终端执行（含回显）"
            data-testid="tdsf-auto-exec-toggle"
          >
            <HugeiconsIcon icon={TerminalIcon} size={10} strokeWidth={1.75} />
            <span>终端执行</span>
          </button>
          <span>
            <span style={{ color: "var(--color-primary, #10b981)" }}>↵</span>{" "}
            发送
          </span>
        </div>
      </div>

      {/* ===== 2026-07-28 P-E: 8 向 resize handle（用户痛点: 之前只能拉高度） ===== */}
      {/* 4 边 (n/s/e/w) + 4 角 (ne/nw/se/sw), 全部 6px 透明命中区 */}
      {/* n 边 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("n")}
        className="absolute left-0 right-0 top-0 z-50 cursor-n-resize"
        style={{ height: "6px", background: "transparent" }}
        title="拖动调整高度"
      />
      {/* s 边 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("s")}
        className="absolute bottom-0 left-0 right-0 z-50 cursor-s-resize"
        style={{ height: "6px", background: "transparent" }}
        title="拖动调整高度"
      />
      {/* w 边 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("w")}
        className="absolute bottom-0 left-0 top-0 z-50 cursor-w-resize"
        style={{ width: "6px", background: "transparent" }}
        title="拖动调整宽度"
      />
      {/* e 边 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("e")}
        className="absolute bottom-0 right-0 top-0 z-50 cursor-e-resize"
        style={{ width: "6px", background: "transparent" }}
        title="拖动调整宽度"
      />
      {/* ne 角 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("ne")}
        className="absolute right-0 top-0 z-[51] cursor-ne-resize"
        style={{ width: "12px", height: "12px", background: "transparent" }}
        title="拖动调整宽高"
      />
      {/* nw 角 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("nw")}
        className="absolute left-0 top-0 z-[51] cursor-nw-resize"
        style={{ width: "12px", height: "12px", background: "transparent" }}
        title="拖动调整宽高"
      />
      {/* se 角 (主拖拽区, 含视觉指示) */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("se")}
        className="absolute bottom-0 right-0 z-[51] cursor-nwse-resize"
        style={{ width: "14px", height: "14px", background: "transparent" }}
        title="拖动调整宽高"
      />
      {/* sw 角 */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("sw")}
        className="absolute bottom-0 left-0 z-[51] cursor-sw-resize"
        style={{ width: "12px", height: "12px", background: "transparent" }}
        title="拖动调整宽高"
      />
    </>
  );
}

// ============================================================================
// LoadingShell — sessionId 为 null 时的加载占位 (与 AiMiniWindow.EmptyShell 对齐)
// ============================================================================
function LoadingShell({
  onClose,
  onHeaderMouseDown,
  onResizeMouseDown,
}: {
  onClose: () => void;
  onHeaderMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onResizeMouseDown: (dir: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw") => (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-testid="tdsf-agent-panel-shell"
      className="flex h-full w-full flex-col"
    >
      <div
        className="flex h-10 shrink-0 cursor-grab items-center justify-between border-b border-border/60 px-3 active:cursor-grabbing"
        onMouseDown={onHeaderMouseDown}
        title="拖动移动浮动窗口"
      >
        <span
          className="font-mono"
          style={{
            color: "var(--color-muted-foreground, #6b7280)",
            fontSize: "13px",
          }}
        >
          ⬡‿⬡
        </span>
        <span className="text-[11px] text-muted-foreground">加载中…</span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onClose}
          className="size-5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="Close"
          title="关闭 (Esc)"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
        </Button>
      </div>
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        正在加载会话…
      </div>
      {/* === 2026-07-28 P-E: 4 角 resize handle（与 Body 一致） === */}
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("s")}
        className="absolute bottom-0 left-0 right-0 z-50 cursor-s-resize"
        style={{ height: "6px", background: "transparent" }}
      />
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("e")}
        className="absolute bottom-0 right-0 top-0 z-50 cursor-e-resize"
        style={{ width: "6px", background: "transparent" }}
      />
      <div
        data-no-drag
        onMouseDown={onResizeMouseDown("se")}
        className="absolute bottom-0 right-0 z-[51] cursor-nwse-resize"
        style={{ width: "14px", height: "14px", background: "transparent" }}
      />
    </div>
  );
}

// ============================================================================
// 子组件: EmptyState — 空状态提示
// ============================================================================
function EmptyState({ agentLabel }: { agentLabel: string }) {
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center"
      data-testid="tdsf-agent-empty"
    >
      <div
        className="font-mono"
        style={{
          color: "var(--color-primary, #10b981)",
          fontSize: "28px",
          letterSpacing: "1px",
        }}
      >
        ⬡‿⬡
      </div>
      <div
        className="font-semibold text-foreground"
        style={{ fontSize: "13px" }}
      >
        {agentLabel} Agent
      </div>
      <div
        className="max-w-[18rem] text-muted-foreground"
        style={{ fontSize: "11px", lineHeight: 1.55 }}
      >
        TDSF Linux 运维教学 Agent
        <br />
        输入问题（如「nginx 启动失败」）开始对话
      </div>
    </div>
  );
}
