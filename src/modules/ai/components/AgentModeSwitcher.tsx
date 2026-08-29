// ============================================================================
// AgentModeSwitcher — 三档信任模式 segmented control + Teach 教学皮肤开关
// ============================================================================
//
// v3.1 三模式信任体系（方案书 §4.3 / spec: add-agent-trust-modes）：
//   - 三档 segmented control：观察 / 确认 / 自动（AgentMode = observe|confirm|auto）
//   - Teach 开关：教学皮肤，叠加在任意模式上（不占独立档位、不改权限矩阵）
//
// 状态：chatStore.agentMode / chatStore.teach（会话级，per-session 持久化到
// SessionMeta，切换会话/重启自动恢复）。切换即时生效：下一条消息的
// agent.invoke 就会带新模式（state.live.agentMode / state.live.teach）。
//
// 风格：跟随 AgentStatusPill / TdsfAgentPanel 快捷行的小号按钮惯例
// （text-[10.5px]、rounded、激活态 emerald 高亮）；无 emoji，用文字+图标。
// ============================================================================

import { cn } from "@/lib/utils";
import {
  BookOpen01Icon,
  EyeIcon,
  FlashIcon,
  KeyboardIcon,
  ShieldUserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAgentTypingMode } from "@/modules/settings/store";
import { AGENT_MODES, AGENT_MODE_META, type AgentMode } from "../agents/registry";
import { useChatStore } from "../store/chatStore";

/** 模式 → 图标（观察=眼 / 确认=盾 / 自动=闪电，与 AgentStatusPill 一致） */
const MODE_ICON: Record<AgentMode, typeof EyeIcon> = {
  observe: EyeIcon,
  confirm: ShieldUserIcon,
  auto: FlashIcon,
};

export function AgentModeSwitcher({ className }: { className?: string }) {
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const teach = useChatStore((s) => s.teach);
  const setTeach = useChatStore((s) => s.setTeach);
  // TDSF B2 (2026-08-29): 可视教学打字机快捷开关（与设置页同一 preferences store）
  const agentTypingMode = usePreferencesStore((s) => s.agentTypingMode);
  const humanTyping = agentTypingMode === "human";

  return (
    <div
      className={cn("flex shrink-0 items-center gap-1", className)}
      data-testid="agent-mode-switcher"
    >
      {/* 三档信任模式 segmented control */}
      <div
        role="radiogroup"
        aria-label="Agent 信任模式"
        className="flex items-center gap-0.5 rounded-md border border-border/40 bg-card/40 p-0.5"
      >
        {AGENT_MODES.map((mode) => {
          const active = mode === agentMode;
          const meta = AGENT_MODE_META[mode];
          const Icon = MODE_ICON[mode];
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setAgentMode(mode)}
              title={`${meta.badge} — ${meta.desc}`}
              data-testid={`agent-mode-${mode}`}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
                active
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={Icon} size={10} strokeWidth={1.75} />
              <span>{meta.label}</span>
            </button>
          );
        })}
      </div>

      {/* Teach 教学皮肤开关（叠加档位，不占独立档） */}
      <button
        type="button"
        aria-pressed={teach}
        onClick={() => setTeach(!teach)}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
          teach
            ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="教学皮肤 — 输出结构化教学内容（概念/示例/易错点/练习），不改变权限矩阵"
        data-testid="agent-teach-toggle"
      >
        <HugeiconsIcon icon={BookOpen01Icon} size={10} strokeWidth={1.75} />
        <span>教学</span>
      </button>

      {/* TDSF B2 (2026-08-29): 可视教学打字机快捷开关（逐字演示 ↔ 整段注入） */}
      <button
        type="button"
        aria-pressed={humanTyping}
        onClick={() => void setAgentTypingMode(humanTyping ? "instant" : "human")}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
          humanTyping
            ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
            : "text-muted-foreground hover:text-foreground",
        )}
        title="可视执行演示 — Agent 批准的命令在终端逐字敲入（教学演示）；演示中按任意键接管"
        data-testid="agent-typing-toggle"
      >
        <HugeiconsIcon icon={KeyboardIcon} size={10} strokeWidth={1.75} />
        <span>逐字</span>
      </button>
    </div>
  );
}
