import type { SearchTarget } from "@/modules/header";
import { MAX_PANES_PER_TAB, type Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";
import {
  Cancel01Icon,
  DashboardSquare01Icon,
  FileEditIcon,
  FileSearchIcon,
  Globe02Icon,
  IncognitoIcon,
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
  "录制",
  "AI",
] as const;

export type CommandPaletteActionContext = {
  tabs: Tab[];
  activeId: number;
  searchTarget: SearchTarget;
  explorerRoot: string | null;
  home: string | null;
  openNewTab: () => void;
  openNewBlock: () => void;
  openNewPrivate: () => void;
  openNewEditor: () => void;
  openNewPreview: () => void;
  openGitGraph: () => void;
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
  /** P1-v5-6: asciicast 会话录制（开始/停止导出） */
  recordStart: () => void;
  recordStop: () => void;
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
    {
      id: "tab.newBlock",
      title: "新建块状终端",
      group: "标签页",
      keywords: ["blocks", "warp", "command blocks", "terminal", "new block terminal"],
      icon: DashboardSquare01Icon,
      run: ctx.openNewBlock,
    },
    {
      id: "tab.newPrivate",
      title: "新建隐私终端",
      group: "标签页",
      keywords: ["privacy", "private", "incognito", "hidden from ai", "new private terminal"],
      icon: IncognitoIcon,
      shortcutId: "tab.newPrivate",
      run: ctx.openNewPrivate,
    },
    {
      id: "tab.newEditor",
      title: "新建编辑器标签页",
      group: "标签页",
      keywords: ["file", "editor", "create", "new editor tab", "bianjiqi"],
      icon: FileEditIcon,
      shortcutId: "tab.newEditor",
      disabledReason: noWorkspaceRoot ? "无工作区根目录" : undefined,
      run: ctx.openNewEditor,
    },
    {
      id: "tab.newPreview",
      title: "新建网页预览",
      group: "标签页",
      keywords: ["browser", "web", "localhost", "preview", "new web preview"],
      icon: Globe02Icon,
      shortcutId: "tab.newPreview",
      // TDSF 修复 2026-08-01: SSH 空间无本地网页预览（预览指向本地 localhost 服务），
      // 隐藏该命令避免用户误操作。
      hidden: ctx.isSshSpace === true,
      run: ctx.openNewPreview,
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
    {
      id: "git.graph",
      title: "打开 Git 提交图",
      group: "Git",
      keywords: ["git", "graph", "history", "log", "commits", "open git graph"],
      icon: SourceCodeIcon,
      run: ctx.openGitGraph,
    },
    {
      id: "git.source",
      title: "切换源代码管理",
      group: "Git",
      keywords: ["git", "source control", "changes", "staging", "diff"],
      icon: SourceCodeIcon,
      shortcutId: "pane.source",
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
      id: "record.start",
      title: "开始录制终端会话",
      group: "录制",
      keywords: ["record", "asciicast", "cast", "capture", "session", "luzhi"],
      icon: SidebarLeftIcon,
      run: ctx.recordStart,
    },
    {
      id: "record.stop",
      title: "停止录制并导出 (asciicast v2)",
      group: "录制",
      keywords: ["record", "stop", "export", "cast", "asciicast", "daochu"],
      icon: SidebarLeftIcon,
      run: ctx.recordStop,
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
