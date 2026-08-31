import type { SearchTarget } from "@/modules/header";
import { MAX_PANES_PER_TAB, type Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
import {
  Cancel01Icon,
  DashboardSquare01Icon,
  FileEditIcon,
  FileSearchIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PaintBoardIcon,
  Search01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  SourceCodeIcon,
  SparklesIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import type { PaletteItem } from "./types";

export const COMMAND_GROUPS = [
  "常规",
  "空间",
  "标签页",
  "窗格",
  "Git",
  "搜索",
  "视图",
  "AI",
] as const;

export type CommandPaletteActionContext = {
  tabs: Tab[];
  activeId: number;
  searchTarget: SearchTarget;
  explorerRoot: string | null;
  home: string | null;
  openNewTab: () => void;
  openNewEditor: () => void;
  toggleSourceControl: () => void;
  closeActiveTabOrPane: () => void;
  splitPaneRight: () => void;
  splitPaneDown: () => void;
  focusSearch: () => void;
  focusExplorerSearch: () => void;
  toggleSidebar: () => void;
  toggleAi: () => void;
  askAiSelection: () => void;
  openSettings: () => void;
  openKeyboardShortcuts: () => void;
  spaces: { id: string; name: string }[];
  activeSpaceId: string | null;
  openSpacesOverview: () => void;
  newSpace: () => void;
  switchSpace: (id: string) => void;
  /** TDSF 修复 2026-08-01: 当前 Space 是 SSH 时隐藏本地专属命令（网页预览等） */
  isSshSpace?: boolean;
};

const noop = () => {};

export function createCommandItems(
  ctx: CommandPaletteActionContext,
): PaletteItem[] {
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeId);
  const activeTerminalTab = activeTab?.kind === "terminal" ? activeTab : null;
  const activePaneCount = activeTerminalTab
    ? leafIds(activeTerminalTab.paneTree).length
    : 0;
  const onlyOneTab = ctx.tabs.length < 2;
  const noWorkspaceRoot = !ctx.explorerRoot && !ctx.home;
  const splitDisabled = !activeTerminalTab
    ? "无终端标签页"
    : activePaneCount >= MAX_PANES_PER_TAB
      ? "窗格已达上限"
      : undefined;
  const closeDisabled =
    onlyOneTab && activePaneCount < 2 ? "最后一个标签页" : undefined;

  return [
    {
      id: "settings.open",
      title: "打开设置",
      group: "常规",
      keywords: ["preferences", "config", "open settings", "shezhi"],
      icon: Settings01Icon,
      shortcutId: "settings.open",
      run: ctx.openSettings,
    },
    {
      id: "theme.pick",
      title: "切换主题...",
      group: "常规",
      keywords: ["theme", "appearance", "color", "dark", "light", "change theme", "zhuti"],
      icon: PaintBoardIcon,
      run: noop,
    },
    {
      id: "shortcuts.open",
      title: "键盘快捷键",
      group: "常规",
      keywords: ["keys", "keybindings", "settings", "keyboard shortcuts", "kuaijiejian"],
      icon: KeyboardIcon,
      run: ctx.openKeyboardShortcuts,
    },
    {
      id: "spaces.overview",
      title: "空间总览",
      group: "空间",
      keywords: [
        "spaces",
        "sessions",
        "overview",
        "organize",
        "manage",
        "move",
        "kongjian",
      ],
      icon: DashboardSquare01Icon,
      run: ctx.openSpacesOverview,
    },
    {
      id: "spaces.new",
      title: "新建空间",
      group: "空间",
      keywords: ["space", "session", "workspace", "group", "create", "new space"],
      icon: DashboardSquare01Icon,
      run: ctx.newSpace,
    },
    ...ctx.spaces.map((sp) => ({
      id: `spaces.switch.${sp.id}`,
      title: `切换到 ${sp.name}`,
      group: "空间" as const,
      keywords: ["space", "switch", "session", sp.name],
      icon: DashboardSquare01Icon,
      disabledReason: sp.id === ctx.activeSpaceId ? "当前空间" : undefined,
      run: () => ctx.switchSpace(sp.id),
    })),
    {
      id: "tab.new",
      title: "新建终端",
      group: "标签页",
      keywords: ["shell", "terminal", "new tab", "new terminal", "zhongduan"],
      icon: TerminalIcon,
      shortcutId: "tab.new",
      run: ctx.openNewTab,
    },
    // TDSF 魔改 2026-08-31（用户钦定）: 删"新建块状终端/隐私终端/网页预览"
    // 三条命令——入口与本项目 Linux 运维教学定位无关，点击后功能残缺。
    {
      id: "tab.newEditor",
      title: "新建编辑器标签页",
      group: "标签页",
      keywords: ["file", "editor", "create", "new editor tab", "bianjiqi"],
      icon: FileEditIcon,
      shortcutId: "tab.newEditor",
      disabledReason: noWorkspaceRoot ? "无工作区根目录" : undefined,
      // TDSF 魔改 2026-08-28: SSH 空间隐藏（新建文件走远程文件树，非本地编辑器）
      hidden: ctx.isSshSpace === true,
      run: ctx.openNewEditor,
    },
    {
      id: "tab.close",
      title: "关闭标签页或窗格",
      group: "标签页",
      keywords: ["close", "remove", "pane", "close tab"],
      icon: Cancel01Icon,
      shortcutId: "tab.close",
      disabledReason: closeDisabled,
      run: ctx.closeActiveTabOrPane,
    },
    {
      id: "pane.splitRight",
      title: "向右拆分窗格",
      group: "窗格",
      keywords: ["terminal", "pane", "split", "right", "column", "split pane right"],
      icon: LayoutTwoColumnIcon,
      shortcutId: "pane.splitRight",
      disabledReason: splitDisabled,
      run: ctx.splitPaneRight,
    },
    {
      id: "pane.splitDown",
      title: "向下拆分窗格",
      group: "窗格",
      keywords: ["terminal", "pane", "split", "down", "row", "split pane down"],
      icon: LayoutTwoRowIcon,
      shortcutId: "pane.splitDown",
      disabledReason: splitDisabled,
      run: ctx.splitPaneDown,
    },
    // TDSF 魔改 2026-08-31（用户钦定）: 删"打开 Git 提交图"命令——Git Graph
    // 入口与 + 菜单同步移除（源代码管理面板仍可从侧栏打开）。
    {
      id: "git.source",
      title: "切换源代码管理",
      group: "Git",
      keywords: ["git", "source control", "changes", "staging", "diff"],
      icon: SourceCodeIcon,
      shortcutId: "pane.source",
      // TDSF 魔改 2026-08-28: SSH 空间隐藏（源代码管理基于本地 git 仓库）
      hidden: ctx.isSshSpace === true,
      run: ctx.toggleSourceControl,
    },
    {
      id: "search.content",
      title: "在文件中查找内容",
      group: "搜索",
      keywords: ["grep", "ripgrep", "text", "contents", "search in files", "find content"],
      icon: FileSearchIcon,
      trailing: "#",
      run: noop,
    },
    {
      id: "history.open",
      title: "搜索命令历史",
      group: "搜索",
      keywords: ["history", "shell", "rerun", "previous commands", "search command history"],
      icon: TerminalIcon,
      trailing: ">",
      run: noop,
    },
    {
      id: "search.focus",
      title: "在当前标签页中查找",
      group: "搜索",
      keywords: ["find", "terminal", "editor", "current", "find in current tab"],
      icon: Search01Icon,
      shortcutId: "search.focus",
      disabledReason: ctx.searchTarget ? undefined : "无可搜索视图",
      run: ctx.focusSearch,
    },
    {
      id: "explorer.search",
      title: "按名称搜索文件",
      group: "搜索",
      keywords: ["explorer", "workspace", "file", "open", "search files by name"],
      icon: Search01Icon,
      shortcutId: "explorer.search",
      disabledReason: ctx.explorerRoot ? undefined : "无工作区根目录",
      run: ctx.focusExplorerSearch,
    },
    {
      id: "sidebar.toggle",
      title: "切换文件资源管理器",
      group: "视图",
      keywords: ["sidebar", "files", "explorer", "toggle file explorer"],
      icon: SidebarLeftIcon,
      shortcutId: "sidebar.toggle",
      run: ctx.toggleSidebar,
    },
    {
      id: "ai.toggle",
      title: "切换 AI 智能体",
      group: "AI",
      keywords: ["assistant", "chat", "agent", "toggle ai agent"],
      icon: SparklesIcon,
      shortcutId: "ai.toggle",
      run: ctx.toggleAi,
    },
    {
      id: "ai.askSelection",
      title: "询问 AI 关于选中内容",
      group: "AI",
      keywords: ["selection", "explain", "assistant", "chat", "ask ai"],
      icon: SparklesIcon,
      shortcutId: "ai.askSelection",
      run: ctx.askAiSelection,
    },
  ];
}
