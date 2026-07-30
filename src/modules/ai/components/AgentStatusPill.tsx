// ============================================================================
// AgentStatusPill — 统一主 Agent 入口状态指示器（v2026-07-29 改造）
// ============================================================================
//
// 与旧版 AgentSwitcher 的区别：
//   - 旧版是"让用户手动切换 4 个 Agent Tab"的下拉菜单
//   - 新版是"只读显示当前由 main_agent 路由到的子 Agent"的 pill
//   - 用户无需选择，main_agent 在 Python 端根据意图自动路由
//   - 通过 event_bus 推送的 agent_switch 事件实时更新
//
// 设计要点：
//   - 视觉上像 Terax 的 AgentStatusPill：小巧、pulse 动画、清晰标签
//   - 空闲时显示 "Main"（统一入口标识）
//   - 工作时显示 "Teach" / "Coding" / "Debug" 等子 Agent 名
//   - 思考中时 pulse 动画 + 圆点
//
// 状态映射（与 Python AGENT_REGISTRY 对齐）：
//   - null / "main" → "Main"（统一入口，调度中）
//   - "coding"      → "Coding"
//   - "explore"     → "Explore"
//   - "history"     → "History"
//   - "teach"       → "Teach"
//   - "debug"       → "Debug"
//   - "refactor"    → "Refactor"
//   - "test"        → "Test"
//   - "deploy"      → "Deploy"
//
// 复用：保留原 ICONS 导出（AGENT_ICONS）让 Header 等位置还能用 icon 集合。
// ============================================================================

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AbsoluteIcon,
  CodeIcon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  ShieldUserIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChatStore } from "../store/chatStore";

// TDSF 魔改 2026-07-30: 视觉收敛 — 对齐上游 terax 风格
// 原实现: 8 个子 Agent 各一种彩色 (emerald/sky/amber/violet/rose/cyan/lime/orange)
//   → 视觉花哨, 与上游 terax 低调灰字风格不符。
// 新实现: 所有子 Agent 统一用 muted-foreground 灰字, 仅状态点用单一 emerald 色
//   表示"工作中"。空闲时状态点为 muted 灰。保持标签语义, 去除彩色噪音。
/** 子 Agent 名称 → 显示标签的映射（统一灰字风格，对齐上游 terax） */
const SUB_AGENT_LABEL: Record<string, { label: string }> = {
  main: { label: "Main" },
  coding: { label: "Coding" },
  explore: { label: "Explore" },
  history: { label: "History" },
  teach: { label: "Teach" },
  debug: { label: "Debug" },
  refactor: { label: "Refactor" },
  test: { label: "Test" },
  deploy: { label: "Deploy" },
};

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "spark";

/** 向后兼容：保留旧版 ICONS 导出（Header 等位置仍在使用） */
export const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  spark: SparklesIcon,
};

/**
 * AgentStatusPill — 只读显示当前由 main_agent 路由到的子 Agent
 *
 * 不再让用户手动切换 4 Agent Tab。统一入口 main_agent 在 Python 端
 * 根据用户意图自动路由到 8 个子 Agent，前端通过订阅 agent_switch
 * 事件实时更新 currentSubAgent。
 *
 * @param isMiniWindow 是否在小窗口（mini window）模式下显示
 */
export function AgentStatusPill({
  isMiniWindow,
  onClick,
}: {
  isMiniWindow?: boolean;
  onClick?: () => void;
}) {
  const currentSubAgent = useChatStore((s) => s.currentSubAgent);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy = status === "thinking" || status === "streaming";

  // 路由到的子 Agent 信息
  const routed = currentSubAgent
    ? SUB_AGENT_LABEL[currentSubAgent] ?? SUB_AGENT_LABEL.main
    : SUB_AGENT_LABEL.main;
  const isRouted = currentSubAgent && currentSubAgent !== "main";

  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={!onClick}
      onClick={onClick}
      className={cn(
        "h-6 gap-1.5 rounded-md px-1.5 text-[10.5px] font-medium",
        onClick ? "cursor-pointer" : "cursor-default",
        "border border-border/40 bg-card/40 text-muted-foreground",
        isMiniWindow && "text-xs mr-1",
      )}
      title={
        isRouted
          ? `主 Agent 正在调度 ${routed.label} Agent`
          : "统一主 Agent（自动路由到子 Agent）"
      }
    >
      {/* 状态圆点：busy 时 emerald pulse, 空闲时 muted 灰 */}
      <span className="relative flex size-1.5 items-center justify-center">
        <span
          className={cn(
            "absolute inline-flex size-full rounded-full opacity-60",
            isBusy ? "animate-ping bg-emerald-500" : "opacity-0",
          )}
        />
        <span
          className={cn(
            "relative inline-flex size-1.5 rounded-full",
            isBusy ? "bg-emerald-500" : "bg-muted-foreground/60",
          )}
        />
      </span>
      <HugeiconsIcon
        icon={SparklesIcon}
        size={11}
        strokeWidth={1.75}
        className="text-muted-foreground"
      />
      <span className="max-w-[7rem] truncate text-muted-foreground">
        {routed.label}
      </span>
    </Button>
  );
}

// ============================================================================
// 向后兼容导出：保留 AgentSwitcher 别名指向新组件
// ============================================================================
//
// v2026-07-29：旧版 AgentSwitcher 已废弃，统一为只读 AgentStatusPill。
// 旧代码（AiComposerInput/AiMiniWindow/Header）的 import 仍然有效，
// 行为从"切换菜单"变为"状态指示器"。后续清理时统一替换为 AgentStatusPill。
// ============================================================================
export { AgentStatusPill as AgentSwitcher };
export { ICONS as AGENT_ICONS };
