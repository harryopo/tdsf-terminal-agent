// ============================================================================
// AgentModeSwitcher — 四档信任模式 segmented control（v3.1.3，用户钦定）
// ============================================================================
//
// 四档：观察 / 确认 / 自动 / 教学（AgentMode = observe|confirm|auto|teach）。
// 教学档 = 只读 + 教学 prompt 的预置组合（toSidecarMode 展开为
// observe + teach=true 下发 sidecar），与其他三档的区别见 AGENT_MODE_META。
//
// v3.1.3 变更（用户反馈 2026-08-29）：
//   - "教学"从独立开关改为第四档；切换器下方显示当前档位区别说明
//   - "逐字"快捷开关移除（设置 → 智能体 → 可视执行演示 卡片统一管理）
//
// 状态：chatStore.agentMode（会话级，per-session 持久化到 SessionMeta，
// 切换会话/重启自动恢复）。切换即时生效：下一条消息的 agent.invoke 就会
// 带新模式（state.live.agentMode / state.live.teach）。
//
// 风格：跟随 AgentStatusPill / TdsfAgentPanel 快捷行的小号按钮惯例
// （text-[10.5px]、rounded、激活态 emerald 高亮、教学档 violet）；无 emoji。
// ============================================================================

import { cn } from "@/lib/utils";
import {
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

export function AgentModeSwitcher({ className }: { className?: string }) {
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const meta = AGENT_MODE_META[agentMode];

  return (
    <div
      className={cn("flex shrink-0 flex-col gap-0.5", className)}
      data-testid="agent-mode-switcher"
    >
      <div
        role="radiogroup"
        aria-label="Agent 信任模式"
        className="flex items-center gap-0.5 rounded-md border border-border/40 bg-card/40 p-0.5"
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
              onClick={() => setAgentMode(mode)}
              title={`${m.badge} — ${m.desc}`}
              data-testid={`agent-mode-${mode}`}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
                active
                  ? mode === "teach"
                    ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                    : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <HugeiconsIcon icon={Icon} size={10} strokeWidth={1.75} />
              <span>{m.label}</span>
            </button>
          );
        })}
      </div>

      {/* 当前档位区别说明（用户要求：教学模式与其他三档的区别要写出来） */}
      <p
        className="max-w-[22rem] truncate text-[10px] leading-none text-muted-foreground/80"
        data-testid="agent-mode-hint"
      >
        {meta.label}：{meta.desc}
      </p>
    </div>
  );
}
