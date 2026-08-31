// TDSF 魔改 2026-08-31（用户钦定）: 开始界面 + 菜单只保留 Terminal 与 Editor。
// 上游遗留的 Blocks / Privacy / Preview / Git Graph 入口与本项目 Linux 运维教学
// 定位无关（点击后功能残缺），已从 + 菜单、命令面板、快捷键中整体移除。
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import {
  ComputerTerminal02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

type Props = {
  onNew: () => void;
  onNewEditor: () => void;
};

export function NewTabMenu({ onNew, onNewEditor }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New tab"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuItem onSelect={onNew}>
          <HugeiconsIcon
            icon={ComputerTerminal02Icon}
            size={14}
            strokeWidth={1.75}
          />
          <span className="flex-1">Terminal</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, "T")}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewEditor}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} />
          <span className="flex-1">Editor</span>
          <span className="text-xs text-muted-foreground">
            {fmtShortcut(MOD_KEY, "E")}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
