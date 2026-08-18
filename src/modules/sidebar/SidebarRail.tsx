import { cn } from "@/lib/utils";
import {
  BookOpen01Icon,
  CodeIcon,
  FolderGitTwoIcon,
  FolderTreeIcon,
  Router01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 36;

type RailItem = {
  id: SidebarViewId;
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  badge?: number;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
};

export function SidebarRail({ activeView, onSelectView, changedCount }: Props) {
  // TDSF 魔改 (P4-T4.1): 新增 SSH 远程视图入口 (cloud-server 图标)
  // TDSF 魔改 (P4-T4.4): 新增 Skills 管理视图入口 (sparkles 图标)
  const items: RailItem[] = [
    { id: "explorer", label: "Files", icon: FolderTreeIcon },
    {
      id: "source-control",
      label: "Source Control",
      icon: FolderGitTwoIcon,
      badge: changedCount,
    },

    { id: "skills", label: "Skills", icon: SparklesIcon },
    // TDSF 魔改 2026-08-18: 视图标签统一英文, 与 Files/Skills 一致
    { id: "knowledge", label: "Knowledge", icon: BookOpen01Icon },
    // TDSF 魔改 2026-08-11 (P2 代码片段管理): 代码片段视图入口
    { id: "snippets", label: "Snippets", icon: CodeIcon },
    // TDSF 魔改 2026-08-11 (P2 SSH 隧道): SSH 隧道视图入口
    { id: "tunnels", label: "Tunnels", icon: Router01Icon },
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
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() => onSelectView(item.id)}
            className={cn(
              "group relative flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[11px] font-medium outline-none transition-colors duration-[var(--dur-base)]",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={item.icon}
              size={14}
              strokeWidth={isActive ? 2 : 1.75}
              className="shrink-0 transition-[stroke-width] duration-[var(--dur-base)]"
            />
            <span>{item.label}</span>
            {showBadge && badge ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 bg-card px-1 text-[9px] font-semibold leading-none tabular-nums text-muted-foreground/95">
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
