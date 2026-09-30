import { cn } from "@/lib/utils";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 36;

type RailItem = {
  id: SidebarViewId;
  /** 界面上真正显示的那两个字（一格只有 36px，装不下"图标 + 三个字"） */
  label: string;
  /** 悬停与读屏拿到的全名 —— 缩字不许把信息一起缩掉 */
  fullLabel: string;
  badge?: number;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
};

export function SidebarRail({ activeView, onSelectView, changedCount }: Props) {
  const items: RailItem[] = [
    // TDSF 2026-08-29: rail 标签中文化（用户钦定，推翻 2026-08-18 统一英文决策）
    // TDSF 2026-08-11 (P2): 代码片段 / SSH 隧道两个视图入口
    //
    // #166 真机看图（2026-09-29）：这一排原来**每个标签都被切剩一个字** ——
    // 图标 14 + 间距 6 + 「文件」25 = 45px，而一格只有 36px（侧栏最窄 220 时 31px）。
    // 上一手知道它长，加的却是 `truncate` + `data-allow-truncate`（全仓唯一一处豁免），
    // 等于让真机 UI 探针别看这里 —— 缺陷被写成了"设计意图"。
    // 现在的口径：**只留两个字、不放图标**，25px 在最窄一格（31px）也放得下，
    // 于是没有任何一处需要被裁；全名进 title 与 aria-label，缩字不缩信息。
    { id: "explorer", label: "文件", fullLabel: "文件" },
    {
      id: "source-control",
      label: "源码",
      fullLabel: "源代码管理",
      badge: changedCount,
    },
    { id: "skills", label: "技能", fullLabel: "技能管理" },
    { id: "knowledge", label: "知识", fullLabel: "知识库" },
    { id: "snippets", label: "片段", fullLabel: "代码片段" },
    { id: "tunnels", label: "隧道", fullLabel: "SSH 隧道" },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-stretch gap-1 border-t border-border/60 bg-card/85 px-1.5 py-1 backdrop-blur"
    >
      {items.map((item) => {
        const isActive = item.id === activeView;
        const badge = item.badge;
        const showBadge = !!badge && badge > 0;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.fullLabel}
            title={item.fullLabel}
            aria-pressed={isActive}
            onClick={() => onSelectView(item.id)}
            className={cn(
              // 不给左右 padding：宽度全留给那两个字的自然宽（见上方算式）
              "group relative flex min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md text-[11px] font-medium outline-none transition-colors duration-[var(--dur-base)]",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            {item.label}
            {showBadge && badge ? (
              // 角标挂在角上、不进布局流：内联的话「源码 + 数字」在最窄一格又会被挤掉
              <span className="absolute top-0.5 right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-border/60 bg-card px-0.5 text-[9px] font-semibold leading-none tabular-nums text-muted-foreground/95">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
