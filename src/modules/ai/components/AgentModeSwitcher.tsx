// ============================================================================
// AgentModeSwitcher — 四档信任模式折叠选择器（v3.1.4，用户钦定）
// ============================================================================
//
// 四档：观察 / 确认 / 自动 / 教学（AgentMode = observe|confirm|auto|teach）。
// 教学档 = 只读 + 教学 prompt 的预置组合（toSidecarMode 展开为
// observe + teach=true 下发 sidecar），与其他三档的区别见 AGENT_MODE_META。
//
// v3.1.4 变更（用户反馈 2026-08-31）：
//   - 从"四档横排 segmented control + 底部说明行"改为折叠面板：
//     触发按钮只显示当前模式，点击向上弹出面板，每档 = 图标 + 名称 + 描述
//   - 原底部常驻说明行删除（描述移入面板，避免与按钮挤在一起）
//
// 状态：chatStore.agentMode（会话级，per-session 持久化到 SessionMeta，
// 切换会话/重启自动恢复）。切换即时生效：下一条消息的 agent.invoke 就会
// 带新模式（state.live.agentMode / state.live.teach）。
//
// 实现：自实现折叠面板（受控 open + 点外/Esc 关闭），不用 Radix Popover
// ——面板内选项直接参与 vitest 查询（无 Portal），且避免弹层焦点问题。
// 风格：跟随 AgentStatusPill 的小号按钮惯例（text-[10.5px]、激活态
// emerald 高亮、教学档 violet）；弹层 bg-popover 跟随明暗主题；无 emoji。
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  EyeIcon,
  FlashIcon,
  ShieldUserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AGENT_MODES, AGENT_MODE_META, type AgentMode } from "../agents/registry";
import { useChatStore } from "../store/chatStore";

/** 模式 → 图标（观察=眼 / 确认=盾 / 自动=闪电 / 教学=书，与 AgentStatusPill 一致） */
const MODE_ICON: Record<AgentMode, typeof EyeIcon> = {
  observe: EyeIcon,
  confirm: ShieldUserIcon,
  auto: FlashIcon,
  teach: BookOpen01Icon,
};

/** 模式激活色（教学档 violet，其余 emerald） */
function activeColorClass(mode: AgentMode): string {
  return mode === "teach"
    ? "text-violet-600 dark:text-violet-400"
    : "text-emerald-600 dark:text-emerald-400";
}

export function AgentModeSwitcher({ className }: { className?: string }) {
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const meta = AGENT_MODE_META[agentMode];
  const ActiveIcon = MODE_ICON[agentMode];

  // 打开时：点击面板外 / Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (mode: AgentMode) => {
    setAgentMode(mode);
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={cn("relative shrink-0", className)}
      data-testid="agent-mode-switcher"
    >
      {/* 触发按钮：显示当前模式（激活态配色跟随档位） */}
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Agent 信任模式：${meta.label}`}
        onClick={() => setOpen((v) => !v)}
        data-testid="agent-mode-trigger"
        className={cn(
          "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
          open
            ? "border-border/60 bg-accent/60"
            : "border-border/40 bg-card/40 hover:bg-accent/40",
          activeColorClass(agentMode),
        )}
      >
        <HugeiconsIcon icon={ActiveIcon} size={10} strokeWidth={1.75} />
        <span>{meta.label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={10}
          strokeWidth={1.75}
          className="opacity-60"
        />
      </button>

      {/* 折叠面板：向上弹出，每档 = 图标 + 名称 + 描述 */}
      {open && (
        <div
          role="radiogroup"
          aria-label="Agent 信任模式"
          data-testid="agent-mode-menu"
          className="absolute bottom-full left-0 z-50 mb-1.5 w-64 rounded-xl border border-border/60 bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {AGENT_MODES.map((mode) => {
            const active = mode === agentMode;
            const m = AGENT_MODE_META[mode];
            const Icon = MODE_ICON[mode];
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => pick(mode)}
                data-testid={`agent-mode-${mode}`}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                  active ? "bg-accent/50" : "hover:bg-accent/40",
                )}
              >
                <HugeiconsIcon
                  icon={Icon}
                  size={12}
                  strokeWidth={1.75}
                  className={cn(
                    "mt-0.5 shrink-0",
                    active ? activeColorClass(mode) : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block text-[11px] font-medium leading-tight",
                      active
                        ? activeColorClass(mode)
                        : "text-foreground",
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                    {m.desc}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
