import { IS_MAC, MOD_PROP } from "@/lib/platform";

/**
 * Single source of truth for keyboard shortcuts.
 * TDSF 魔改 (2026-08-29): label 全面中文化（快捷键设置页 / 命令面板 / 状态栏
 * 均消费此字段；本项目为中文教学产品，id 仍保持英文稳定标识）。
 */

export type ShortcutId =
  | "commandPalette.open"
  | "commandPalette.content"
  | "tab.new"
  | "tab.newEditor"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.selectByIndex"
  | "space.next"
  | "space.prev"
  | "space.overview"
  | "pane.splitRight"
  | "pane.splitDown"
  // TDSF 魔改 (2026-08-11): iTerm2 风格分屏快捷键（Ctrl/Cmd+Shift+H/V）。
  // 与 splitRight/splitDown 语义等价——splitActivePane 已自动继承 SSH 会话，
  // 只是提供用户熟悉的按键组合（H=horizontal 左右 / V=vertical 上下）。
  | "pane.splitSshRight"
  | "pane.splitSshDown"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "pane.swapLeft"
  | "pane.swapRight"
  | "pane.swapUp"
  | "pane.swapDown"
  | "pane.source"
  | "terminal.clear"
  | "terminal.toggleInput"
  | "terminal.translate"
  // TDSF 魔改 2026-08-28 (B1-G4): 终端内搜索（xterm SearchAddon UI）。
  // Ctrl+Shift/F 避开 search.focus 的 Ctrl+F（文件/tab 搜索）；Windows Terminal 同惯例。
  | "terminal.find"
  | "blocks.prev"
  | "blocks.next"
  | "search.focus"
  | "explorer.search"
  | "explorer.focus"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.zenMode"
  | "ai.toggle"
  | "ai.toggleMini"
  | "ai.askSelection"
  | "agent.focusAttention"
  | "settings.open"
  | "sidebar.toggle"
  | "editor.undo"
  | "editor.redo"
  | "editor.aiComplete"
  | "editor.codeComplete";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Spaces"
  | "Panes"
  | "Terminal"
  | "Search"
  | "AI"
  | "View"
  | "Editor";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
  allowRepeat?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: "commandPalette.open",
    label: "打开命令面板",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "p" }],
  },
  {
    id: "commandPalette.content",
    label: "全局搜索文件",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "p" }],
  },
  {
    id: "settings.open",
    label: "打开设置",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "," }],
  },
  {
    id: "tab.new",
    label: "新建标签页",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "t" }],
  },
  // TDSF 魔改 2026-08-31（用户钦定）: 删 tab.newBlock / tab.newPrivate /
  // tab.newPreview 三项——Blocks/隐私终端/网页预览入口与本项目定位无关，
  // 已从 + 菜单与命令面板整体移除（原 Ctrl+R / Ctrl+Shift+O 绑定随之释放）。
  {
    id: "tab.newEditor",
    label: "新建编辑器标签",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "e" }],
  },
  {
    id: "tab.close",
    label: "关闭标签页或分屏",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "w" }],
  },
  {
    id: "tab.next",
    label: "下一个标签页",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, key: "Tab" }],
    allowRepeat: true,
  },
  {
    id: "tab.prev",
    label: "上一个标签页",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
    allowRepeat: true,
  },
  {
    id: "tab.selectByIndex",
    label: "跳转到标签页 1–9",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "1" }],
  },
  {
    id: "space.next",
    label: "下一个工作区",
    group: "Spaces",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "]" }],
  },
  {
    id: "space.prev",
    label: "上一个工作区",
    group: "Spaces",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "[" }],
  },
  {
    id: "space.overview",
    label: "打开工作区列表",
    group: "Spaces",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "s" }],
  },
  {
    id: "pane.splitRight",
    label: "向右分屏",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "d" }],
  },
  {
    id: "pane.splitDown",
    label: "向下分屏",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "d" }],
  },
  {
    // TDSF 魔改 (2026-08-11): iTerm2 风格分屏（H=horizontal）。
    id: "pane.splitSshRight",
    label: "向右分屏（备选键）",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "h" }],
  },
  {
    // TDSF 魔改 (2026-08-11): iTerm2 风格分屏（V=vertical）。
    id: "pane.splitSshDown",
    label: "向下分屏（备选键）",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "v" }],
  },
  {
    id: "pane.focusNext",
    label: "聚焦下一个分屏",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "]" }],
  },
  {
    id: "pane.focusPrev",
    label: "聚焦上一个分屏",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "[" }],
  },
  {
    id: "pane.swapLeft",
    label: "与左侧分屏交换位置",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowLeft" }],
  },
  {
    id: "pane.swapRight",
    label: "与右侧分屏交换位置",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowRight" }],
  },
  {
    id: "pane.swapUp",
    label: "与上方分屏交换位置",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowUp" }],
  },
  {
    id: "pane.swapDown",
    label: "与下方分屏交换位置",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, alt: true, key: "ArrowDown" }],
  },
  {
    id: "pane.source",
    label: "切换来源面板",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "g" }],
  },
  {
    id: "terminal.clear",
    label: "清空终端",
    group: "Terminal",
    // macOS Terminal's ⌘K (clear scrollback, keep the prompt). Default only on
    // macOS — on other platforms Ctrl+K is readline's kill-line, so we leave it
    // unbound and let users assign their own in settings.
    defaultBindings: IS_MAC ? [{ meta: true, key: "k" }] : [],
  },
  {
    id: "terminal.toggleInput",
    label: "切换终端 / AI 输入",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, key: "u" }],
  },
  {
    // TDSF 魔改 2026-07-29: 终端选词翻译开关
    id: "terminal.translate",
    label: "开关终端翻译",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "t" }],
  },
  {
    // TDSF 魔改 2026-08-28 (B1-G4): 终端内搜索（Ctrl/Cmd+Shift+F）
    id: "terminal.find",
    label: "终端内查找",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "f" }],
  },
  {
    id: "blocks.prev",
    label: "上一个命令块",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, key: "ArrowUp" }],
    allowRepeat: true,
  },
  {
    id: "blocks.next",
    label: "下一个命令块",
    group: "Terminal",
    defaultBindings: [{ [MOD_PROP]: true, key: "ArrowDown" }],
    allowRepeat: true,
  },
  {
    id: "explorer.search",
    label: "搜索文件",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "f" }],
  },
  {
    id: "search.focus",
    label: "标签页内查找",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, key: "f" }],
  },
  {
    id: "ai.toggle",
    label: "显示 / 隐藏 AI 面板",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "i" }],
  },
  {
    id: "ai.toggleMini",
    label: "显示 / 隐藏 AI 小窗",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "i" }],
  },
  {
    id: "ai.askSelection",
    label: "询问 AI 选中内容",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "j" }],
  },
  {
    id: "agent.focusAttention",
    label: "跳转到待处理 Agent",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "a" }],
  },
  {
    id: "sidebar.toggle",
    label: "显示 / 隐藏文件资源管理器",
    group: "View",
    // Plain Mod+B toggles the sidebar everywhere EXCEPT a focused terminal,
    // where it's handed to the shell / Claude Code (its "run in background"
    // key). Mod+Shift+B always toggles, including from inside a terminal.
    defaultBindings: [
      { [MOD_PROP]: true, key: "b" },
      { [MOD_PROP]: true, shift: true, key: "b" },
    ],
  },
  {
    id: "explorer.focus",
    label: "聚焦文件资源管理器",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "e" }],
  },
  {
    id: "view.zoomIn",
    label: "放大界面",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "=" },
      { [MOD_PROP]: true, shift: true, key: "+" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomOut",
    label: "缩小界面",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "-" },
      { [MOD_PROP]: true, shift: true, key: "_" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomReset",
    label: "重置缩放",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "0" }],
  },
  {
    id: "view.zenMode",
    label: "切换专注模式",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "'" }],
  },
  // Editor entries are display-only: CodeMirror's historyKeymap binds these
  // keys natively. We register them here so the shortcuts dialog can surface
  // them — they don't have App-level handlers, so `useGlobalShortcuts` falls
  // through without `preventDefault`, leaving CodeMirror to handle the event.
  // Also excluded from the customization UI in ShortcutsSection.
  {
    id: "editor.undo",
    label: "撤销",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "z" }],
  },
  {
    id: "editor.redo",
    label: "重做",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "y" }],
  },
  {
    id: "editor.aiComplete",
    label: "触发 AI 补全",
    group: "Editor",
    defaultBindings: [{ alt: true, key: "\\" }],
  },
  {
    id: "editor.codeComplete",
    label: "触发代码补全",
    group: "Editor",
    defaultBindings: [{ ctrl: true, key: " " }],
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Panes",
  "Terminal",
  "View",
  "Search",
  "AI",
  "Editor",
];

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
const CODE_TO_KEY: Record<string, string> = {
  Backslash: "\\",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: " ",
};

// macOS Option combinations rewrite e.key ("«", "…", dead keys); the
// physical key survives in e.code.
function keyFromCode(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_TO_KEY[code] ?? null;
}

export function matchBinding(
  e: KeyboardEvent,
  binding: KeyBinding,
  id?: ShortcutId
): boolean {
  const eventKey = e.key.toLowerCase();
  const bindingKey = binding.key.toLowerCase();

  // Special case for Jump to Tab 1-9
  if (id === "tab.selectByIndex") {
    if (!/^[1-9]$/.test(e.key)) return false;
  } else if (eventKey !== bindingKey) {
    if (!binding.alt || keyFromCode(e.code) !== bindingKey) return false;
  }

  return (
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (IS_MAC) {
    if (binding.ctrl) tokens.push("⌃");
    if (binding.alt) tokens.push("⌥");
    if (binding.shift) tokens.push("⇧");
    if (binding.meta) tokens.push("⌘");
  } else {
    if (binding.ctrl) tokens.push("Ctrl");
    if (binding.alt) tokens.push("Alt");
    if (binding.shift) tokens.push("Shift");
    if (binding.meta) tokens.push("Win");
  }

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
