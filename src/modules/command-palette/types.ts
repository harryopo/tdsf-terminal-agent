import type { ShortcutId } from "@/modules/shortcuts";
import type { TerminalIcon } from "@hugeicons/core-free-icons";

export type PaletteIcon = typeof TerminalIcon;

export type PaletteItem = {
  id: string;
  title: string;
  group: string;
  keywords?: string[];
  icon?: PaletteIcon;
  iconUrl?: string;
  shortcutId?: ShortcutId;
  trailing?: string;
  disabledReason?: string;
  /** TDSF 修复 2026-08-01: 当前上下文不适用时从命令面板隐藏（如 SSH 空间的本地预览） */
  hidden?: boolean;
  run: () => void;
};

export type PaletteMode = "commands" | "history" | "content" | "help";
