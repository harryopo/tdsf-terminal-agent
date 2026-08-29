// ============================================================================
// AgentStatusPill — 三模式信任体系模式指示器（v3.1 改造，方案书 §3.1/§4.1）
// ============================================================================
//
// v3.1 收敛：4 子 agent 委派机制（含 agent_switch 路由事件）已下线，
// 本组件从"显示当前路由到的子 Agent"改为"指示当前信任模式 + 教学皮肤"：
//   - 观察 · 只读（observe）：只读分析，不执行任何写操作
//   - 确认 · 审批（confirm）：写操作逐条审批后执行（默认）
//   - 自动 · 执行（auto）：低危自动放行，高危仍需确认
//   - teach 开启时叠加"教学"标记（叠加在任意模式上，不改变权限矩阵）
//
// 设计要点：
//   - 订阅本地 zustand 状态（agentMode/teach），无 agent 切换动画
//     （子 agent 路由动画随委派机制一并移除）
//   - busy 时状态圆点 emerald pulse（运行中反馈，与模式无关，保留）
//   - 统一 muted 灰字风格，teach 标记用 violet（对齐 TeachCard 色系）
//
// 消费方：Header（顶栏）、StatusBar（状态栏）、AiComposerInput（输入区）、
//         AiMiniWindow（浮动小窗 Header）——全部只读显示。
// ============================================================================

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BookOpen01Icon,
  EyeIcon,
  FlashIcon,
  ShieldUserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AGENT_MODE_META, type AgentMode } from "../agents/registry";
import { useChatStore } from "../store/chatStore";

/** 模式 → 图标（观察=眼 / 确认=盾 / 自动=闪电，与切换器一致） */
const MODE_ICON: Record<AgentMode, typeof EyeIcon> = {
  observe: EyeIcon,
  confirm: ShieldUserIcon,
  auto: FlashIcon,
};

/**
 * AgentStatusPill — 只读指示当前信任模式（+ 教学皮肤标记）
 *
 * @param isMiniWindow 是否在小窗口（mini window）模式下显示
 * @param onClick      可选点击回调（保留给未来"点击打开模式菜单"扩展）
 */
export function AgentStatusPill({
  isMiniWindow,
  onClick,
  "data-testid": dataTestId,
}: {
  isMiniWindow?: boolean;
  onClick?: () => void;
  "data-testid"?: string;
}) {
  const agentMode = useChatStore((s) => s.agentMode);
  const teach = useChatStore((s) => s.teach);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy = status === "thinking" || status === "streaming";

  const meta = AGENT_MODE_META[agentMode];
  const ModeIcon = MODE_ICON[agentMode];

  return (
    <Button
      data-testid={dataTestId}
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
      title={`信任模式：${meta.badge} — ${meta.desc}${teach ? "（教学皮肤已开启）" : ""}`}
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
        icon={ModeIcon}
        size={11}
        strokeWidth={1.75}
        className="text-muted-foreground"
      />
      <span className="max-w-[8rem] truncate text-muted-foreground">
        {meta.badge}
      </span>
      {teach && (
        <span className="flex items-center gap-0.5 rounded bg-violet-500/15 px-1 py-px text-violet-600 dark:text-violet-400">
          <HugeiconsIcon icon={BookOpen01Icon} size={9} strokeWidth={1.75} />
          <span>教学</span>
        </span>
      )}
    </Button>
  );
}
