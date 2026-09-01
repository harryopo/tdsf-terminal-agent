// TDSF 魔改 2026-07-28: 隔离侧栏组件错误, 防止单个组件抛错导致整页空白
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { consumeLaunchFiles, getLaunchDir } from "@/lib/launchDir";
import { quoteShellArg } from "@/lib/shellQuote";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { usePresence } from "@/lib/usePresence";
import { useZoom } from "@/lib/useZoom";
import { isMarkdownPath } from "@/lib/utils";
import {
  AgentNotificationsBridge,
  nextAttentionTarget,
} from "@/modules/agents";
import {
  AgentRunBridge,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
  useAiBootstrap,
  useAiLiveBridge,
  useChatStore,
  useSelectionAskAi,
} from "@/modules/ai";
import { AiMiniWindow } from "@/modules/ai/components/lazy";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { native } from "@/modules/ai/lib/native";
import { CommandPalette, createCommandItems } from "@/modules/command-palette";
import {
  type EditorPaneHandle,
  NewEditorDialog,
  useApplyEditorFontSize,
  useEditorFileSync,
} from "@/modules/editor";
import { FileExplorer, type FileExplorerHandle } from "@/modules/explorer";
import { useWorkspaceFsStore } from "@/modules/explorer/lib/workspaceFsStore";
import type { GitHistorySearchHandle } from "@/modules/git-history";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { setLspNavigator } from "@/modules/lsp";
import type { PreviewPaneHandle } from "@/modules/preview";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type ShortcutHandlers,
  type ShortcutId,
  shouldDisablePaneSwapShortcut,
  useGlobalShortcuts,
} from "@/modules/shortcuts";
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarRail,
  useSidebarPanel,
} from "@/modules/sidebar";
// TDSF 魔改 (P4-T4.4): Skill 管理面板
import { SkillsPanel } from "@/modules/skills";
// TDSF 魔改 2026-08-11 (P2 代码片段管理): 代码片段面板
import { SnippetsPanel } from "@/modules/snippets";
// TDSF 魔改 2026-08-11 (P2 SSH 隧道): SSH 隧道面板
import { TunnelPanel } from "@/modules/tunnels";
import { KnowledgePanelLazy } from "@/modules/ai/components/lazy";
import {
  SourceControlPanel,
  useSourceControlContext,
} from "@/modules/source-control";
import {
  SpaceCreateDialog,
  SpaceSwitcher,
  type SpaceMeta,
  useSpacePersistence,
  useSpaces,
  useSpacesBoot,
  WelcomeScreen,
} from "@/modules/spaces";
// TDSF 魔改 (P4-T4.1): SSH 远程资源管理器
import {
  isSessionConnected,
  selectActiveSession,
  selectSessionById,
  selectSessionCurrentPath,
  useSshStore,
} from "@/modules/ssh-explorer";
// TDSF 魔改 2026-08-18 (P1-6): 主机审批订阅提升到顶层——
// SshExplorer 只在 ssh 视图挂载, 其他视图首次连接未知主机时审批事件
// 无人订阅会永久挂起; 订阅 + HostApprovalDialog 现由 App 顶层常驻。
import {
  subscribeHostKeyMismatch,
  subscribeHostVerify,
} from "@/lib/ssh-bridge";
import { HostApprovalDialog } from "@/modules/ssh-explorer/SshExplorer";
// TDSF 魔改 2026-07-29: SSH 远程文件编辑器（远程文件点击后编辑）
// TDSF 魔改 2026-07-30: SshFileEditor（侧栏 textarea）已废弃，
// 远程文件改走主区 EditorStack（与本地文件同一套 CodeMirror + tab 流程）。
import { StatusBar } from "@/modules/statusbar";
import {
  TabSwitcherHud,
  useTabSwitcher,
  useTabs,
  useWindowTitle,
  useWorkspaceCwd,
} from "@/modules/tabs";
import { DEFAULT_SPACE_ID } from "@/modules/tabs/lib/useTabs";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafGridSelection,
  leafIds,
  navigateFocusedBlocks,
  type PaneBounds,
  type TerminalPaneHandle,
  useTerminalFileDrop,
  writeToSession,
} from "@/modules/terminal";
// TDSF 魔改 (2026-08-11 #21): effectiveLeafSsh 用于派生 sshActiveLeafIdRef
import { effectiveLeafSsh } from "@/modules/terminal/lib/panes";
// TDSF debug (#20): 仅用于 CDP 实测诊断（只读不改业务）
import {
  getRendererPoolDebug,
  getSlotTerm,
} from "@/modules/terminal/lib/rendererPool";
// TDSF 修复 2026-07-30 (Bug 3): 暴露 formatEnvBlock 供 CDP 验证 <env> 注入
// 注意: 不静态 import formatEnvBlock (会拉入 @ai-sdk 污染启动包, 见 eager-budget.test.ts)
// getEnvBlock 内联 formatEnvBlock 逻辑, 与 transport.ts:249-257 保持同步
import { ThemeProvider, useThemeFileEditing } from "@/modules/theme";
import { UpdaterDialog } from "@/modules/updater";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { SearchAddon } from "@xterm/addon-search";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// TDSF 魔改 2026-07-28 (P1-C): 应用顶层触发 SSH 自动登录, 不依赖 SshExplorer 挂载
import { toast } from "sonner";

// TDSF 魔改 2026-07-29: 终端选词翻译（离线词典），模块已恢复
// P2 (2026-08-01): 触发方式改为选中浮层点「翻译」按钮（SelectionAskAi），
// useTranslateSelection 自动翻译逻辑已移除
import { TranslateTooltip, useTranslateStore } from "@/modules/translate";
// TDSF 魔改 2026-08-28 (B1-G4): terminal.find 快捷键 → 终端搜索浮层开关
import { useTerminalSearchStore } from "@/modules/terminal/terminal-search-store";
// TDSF 魔改 2026-08-09: 服务器实时监控仪表盘（参考 iShell Pro，右上角浮动面板）
import { ServerMonitorEntry } from "@/modules/server-monitor";
// TDSF B2 (2026-08-29): 可视教学打字机"演示中"状态条
import { AgentTypingIndicator } from "@/modules/ai/components/AgentTypingIndicator";
// TDSF 魔改 2026-08-09: 终端命令预测弹窗（统一本地+SSH）
import { TerminalCompletionPopup } from "@/modules/terminal/components/TerminalCompletionPopup";
import { translateText } from "@/modules/translate/translateApi";

import { CloseDialogs } from "./components/CloseDialogs";
import {
  TOGGLE_BLOCK_INPUT_EVENT,
  WorkspaceInputBar,
} from "./components/WorkspaceInputBar";
import { WorkspaceSurface } from "./components/WorkspaceSurface";
import { useAppCloseGuard } from "./hooks/useAppCloseGuard";
import { useTabCloseGuards } from "./hooks/useTabCloseGuards";
import { useWorkspaceSwitcher } from "./hooks/useWorkspaceSwitcher";

export default function App() {
  const {
    tabs,
    activeId,
    setActiveId,
    // TDSF 魔改 2026-08-11 (#21): allocId 原为 SshTerminalHost 分配游离 leafId，
    // SSH 渲染迁入 PaneTree 后不再需要。
    moveTabToSpace,
    reorderTab,
    reorderTabByGap,
    newTabInSpace,
    removeTabsForSpace,
    clearTabs,
    markBooted,
    setActiveSpaceForNewTabs,
    warmUpTab,
    newTab,
    // TDSF 魔改 2026-08-31: newBlockTab / newPrivateTab 入口已移除（Blocks/隐私终端）
    newAgentTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    newMarkdownTab,
    setMarkdownView,
    setOverrideLanguage,
    openAiDiffTab,
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    focusPane,
    focusNextPaneInTab,
    swapActivePaneInDirection,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    resetWorkspace,
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // TDSF 魔改 2026-07-30: activeId 也镜像到 ref, 供 SSH 会话绑定的副作用
  // (useEffect 内订阅 zustand) 读取最新值, 避免闭包过期。
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useRef<Map<number, SearchAddon>>(new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useRef<Map<number, TerminalPaneHandle>>(new Map());
  // 2026-07-31 翻译模块修复: SSH 终端的 leafId（SSH 终端不在 tab.paneTree 里，
  // captureActiveSelection 需要优先用这个 leafId 查 terminalRefs）
  const sshActiveLeafIdRef = useRef<number | null>(null);
  const editorRefs = useRef<Map<number, EditorPaneHandle>>(new Map());
  const previewRefs = useRef<Map<number, PreviewPaneHandle>>(new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useApplyEditorFontSize();
  const terminalPathDropTarget = useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useRef<Set<number>>(new Set());

  const clearWorkspaceState = useCallback(() => {
    for (const id of liveLeavesRef.current) disposeSession(id);
    searchAddons.current.clear();
    terminalRefs.current.clear();
    editorRefs.current.clear();
    previewRefs.current.clear();
    setActiveSearchAddon(null);
    setActiveEditorHandle(null);
  }, []);

  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  } = useWorkspaceSwitcher({
    tabsRef,
    workspaceEnv,
    setWorkspaceEnv,
    resetWorkspace,
    clearWorkspaceState,
  });

  const activeSpaceId = useSpaces((s) => s.activeId);
  const spacesHydrated = useSpaces((s) => s.hydrated);
  // TDSF 修复 2026-08-01: 工作区数量（0 = 欢迎界面）
  const spaceCount = useSpaces((s) => s.spaces.length);

  // TDSF 魔改 2026-08-28（用户反馈）: 环境切换 pending 态——WSL 首次冷启动
  // 要串行探测 home/login shell/zdotdir（多次 wsl.exe），期间无反馈会显得"卡死"。
  const [workspaceSwitching, setWorkspaceSwitching] = useState(false);
  const handleWorkspaceChange = useCallback(
    async (env: WorkspaceEnv) => {
      setWorkspaceSwitching(true);
      try {
        const switched = await switchWorkspace(env);
        if (switched && activeSpaceId) {
          useSpaces.getState().setEnv(activeSpaceId, env);
        }
      } finally {
        setWorkspaceSwitching(false);
      }
    },
    [switchWorkspace, activeSpaceId],
  );

  // TDSF 魔改 2026-08-28（用户反馈）: 左下角环境选择器的 SSH 选项——
  // 与欢迎页同源，打开"新建工作区"对话框的 SSH 模式（SSH 需要主机/凭据，
  // 无法像 WSL 一样一步切换）。
  const handleWorkspaceSshClick = useCallback(() => {
    setSpaceCreateMode("ssh");
    setSpaceCreateOpen(true);
  }, []);

  useSpacesBoot({
    ready: launchCwdResolved,
    markBooted,
  });

  useSpacePersistence({
    tabs,
    activeId,
    activeSpaceId: activeSpaceId ?? DEFAULT_SPACE_ID,
    enabled: spacesHydrated,
  });

  const prevSpaceRef = useRef(activeSpaceId);
  useEffect(() => {
    if (!spacesHydrated || !activeSpaceId) return;
    setActiveSpaceForNewTabs(activeSpaceId);
    const prev = prevSpaceRef.current;
    prevSpaceRef.current = activeSpaceId;
    const meta = useSpaces
      .getState()
      .spaces.find((s) => s.id === activeSpaceId);
    // TDSF 修复 2026-07-31: 切到 SSH Space 时同步切换 sshStore 的 activeSessionId，
    // 让左侧资源管理器/底部 cwd/窗口标题都跟随当前 Space。
    // TDSF 修复 2026-08-01: 加存在性守卫——Space env 持久化可能携带上个
    // 应用生命周期的旧 session UUID（store 里已不存在），直接 setActiveSession
    // 会让 activeSessionId 指向幽灵 session，selectActiveSession 返回 null，
    // SSH 面板误显未连接 + AI 拿不到 ssh_session_id。
    const metaSshSessionId =
      meta && meta.env.kind === "ssh" ? meta.env.sessionId : null;
    if (
      metaSshSessionId &&
      useSshStore
        .getState()
        .sessions.some((s) => s.id === metaSshSessionId)
    ) {
      useSshStore.getState().setActiveSession(metaSshSessionId);
    }
    if (prev === null || prev === activeSpaceId) return;
    if (meta) void adoptWorkspaceEnv(meta.env);
    const inSpace = tabsRef.current.filter((t) => t.spaceId === activeSpaceId);
    if (inSpace.length === 0) return;
    // Keep the active tab if it already belongs to the newly active space (a
    // cross-space jump set it explicitly); else fall to the space's last tab.
    if (inSpace.some((t) => t.id === activeId)) return;
    setActiveId(inSpace[inSpace.length - 1].id);
  }, [
    activeSpaceId,
    activeId,
    spacesHydrated,
    setActiveSpaceForNewTabs,
    setActiveId,
    adoptWorkspaceEnv,
  ]);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [spaceCreateOpen, setSpaceCreateOpen] = useState(false);
  // TDSF 修复 2026-08-01: 创建对话框初始模式（欢迎界面预设 local/wsl/ssh）
  const [spaceCreateMode, setSpaceCreateMode] = useState<
    "local" | "wsl" | "ssh"
  >("local");

  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID)),
    [tabs, activeSpaceId],
  );

  const {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  } = useSidebarPanel(explorerRef);

  const prevSpaceForViewRef = useRef(activeSpaceId);
  useEffect(() => {
    // TDSF 修复 2026-08-01: 真正的 Space 切换（非首次挂载）时左侧跟随
    // 切换为文件资源管理器，避免左侧停留在上一个 Space 的视图（ssh 列表等）
    // 导致"切换工作区后资源管理器不显示"。
    if (
      prevSpaceForViewRef.current !== null &&
      prevSpaceForViewRef.current !== activeSpaceId &&
      sidebarView !== "explorer"
    ) {
      persistSidebarView("explorer");
    }
    prevSpaceForViewRef.current = activeSpaceId;
  }, [activeSpaceId, sidebarView, persistSidebarView]);

  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteInitialMode, setPaletteInitialMode] = useState<
    "commands" | "content"
  >("commands");
  const openCommandPalette = useCallback(
    (mode: "commands" | "content" = "commands") => {
      setPaletteInitialMode(mode);
      setCommandPaletteOpen(true);
    },
    [],
  );
  const miniOpen = useChatStore((s) => s.mini.open);
  const miniPresence = usePresence(miniOpen, 200);
  const openMini = useChatStore((s) => s.openMini);
  const toggleMini = useChatStore((s) => s.toggleMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);

  // TDSF 魔改: 4 Agent 状态由 Header 直接读取 chatStore（单层 UI 整合后）
  const { hasComposer, keysLoaded } = useAiBootstrap();

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isBlockTab = activeTerminalTab?.blocks === true;
  const isEditorTab = activeTab?.kind === "editor";
  const isGitHistoryTab = activeTab?.kind === "git-history";

  // TDSF 魔改 2026-07-28 (P1-A): 空状态页判定
  // 当 default cold tab (id 1) 是 active tab, 且没有任何活跃 SSH session,
  // 在 WorkspaceSurface 渲染 NoTerminalEmptyState 替代 TerminalStack,
  // 避免空跑本地 shell 出现黑屏.
  //
  // TDSF 魔改 2026-07-28 (P1-D): SSH 连接后, 右侧工作区应显示 SSH 终端,
  // 而不是本地终端。
  //
  // TDSF 魔改 2026-07-28 (P1-D+ 修复): 取消"必须在 default cold tab 才接管"限制。
  // 原条件 isDefaultColdTab 太严格, SSH 自动连接完成后用户切到任何 terminal tab,
  // 右侧都应该显示 SSH 终端, 而不是本地 PTY。这里把条件放宽为
  // "active tab 是 terminal 且有活跃 SSH session" 即接管。
  // TDSF 修复 2026-07-31: SSH 状态按当前 Space 隔离，避免多个 SSH Space
  // 切换时左侧资源管理器/底部 cwd 仍停留在上一个 Space。
  const activeSpace = useSpaces((s) =>
    s.spaces.find((sp) => sp.id === activeSpaceId),
  );
  const spaceSshSessionId =
    activeSpace?.env.kind === "ssh" ? activeSpace.env.sessionId ?? null : null;
  const spaceSshSession = useSshStore((s) =>
    selectSessionById(s, spaceSshSessionId),
  );
  const spaceSshCurrentPath = useSshStore((s) =>
    selectSessionCurrentPath(s, spaceSshSessionId),
  );
  const isSpaceSshConnected =
    !!spaceSshSession && isSessionConnected(spaceSshSession);
  // 保留全局 active SSH session 用于非 Space 场景（自动登录、SshExplorer 视图）
  const activeSshSession = useSshStore(selectActiveSession);
  const activeSshSessionId = activeSshSession?.id ?? null;
  // TDSF 魔改 2026-08-18 (P1-6): 主机审批状态提升到顶层——
  // pendingApproval 由下方常驻订阅 effect 填充, 弹窗任何视图可弹
  const pendingApproval = useSshStore((s) => s.pendingApproval);
  const resolveApproval = useSshStore((s) => s.resolveApproval);
  // Space 环境决定左侧 Files 面板来源：SSH Space 用远程文件资源管理器，
  // 本地/WSL Space 用本地文件资源管理器。
  const explorerSource: "local" | "ssh" = isSpaceSshConnected ? "ssh" : "local";
  const isDefaultColdTab =
    !!activeTab &&
    activeTab.kind === "terminal" &&
    // TDSF 魔改 2026-07-30: 不再限定 id===1。重启恢复的 tab id 会重新分配,
    // 只要 active 的 terminal tab 还是 cold (未跑 shell), 就展示欢迎页引导。
    activeTab.cold === true;
  // TDSF 修复 2026-07-30: 空状态页/终端接管必须以"真正已连接"为准,
  // 而不是 sessionId 一创建就切换。自动连接开始后 sessionId 立即生成,
  // 但此时 Rust SSH 握手/认证/SFTP 还未就绪, 提前切视图会导致
  // FileExplorer 加载远程失败 + 按钮无法点击。
  // TDSF 魔改 (2026-08-09): SSH 连接进度——connecting 态显示进度界面而非空状态页。
  // 用户反馈"资源管理器没加载好终端就不显示"——真相是 SSH 握手期间 (数秒)
  // 终端区域显示 NoTerminalEmptyState 空状态引导页, 用户误以为"终端坏了"。
  // 改为连接过程中显示美观的 5 步进度界面, 连接成功后无缝切换到 SSH 终端。
  // 核心原则："终端流畅最优先, 资源管理器异步加载不阻塞终端"。
  const SSH_CONNECTING_STATES = new Set<string>([
    "connecting",
    "handshaking",
    "host_verifying",
    "authenticating",
    "authenticated",
    "reconnecting",
  ]);
  const isSpaceSshConnecting =
    !!spaceSshSession &&
    !isSpaceSshConnected &&
    SSH_CONNECTING_STATES.has(spaceSshSession.state);
  const sshConnectingInfo = isSpaceSshConnecting
    ? {
        host: spaceSshSession.params?.host ?? "",
        port: spaceSshSession.params?.port ?? 22,
        user: spaceSshSession.params?.user ?? "",
        state: spaceSshSession.state,
      }
    : null;
  const showNoTerminalEmptyState =
    isDefaultColdTab && !isSpaceSshConnected && !isSpaceSshConnecting;
  // TDSF 魔改 2026-08-11 (#21): SSH 终端渲染已迁入 PaneTreeView leaf 级。
  // --------------------------------------------------------------------
  // 此前 (2026-07-30): workspace 级 SshTerminalHost 覆盖右侧工作区, SSH 终端
  // 不在 tab.paneTree 里, 用一个 allocId 分配的游离 leafId 渲染, 无法分屏。
  // 现在: TerminalStack → PaneTreeView 直接渲染 SSH leaf ——
  //   - 单 leaf SSH tab: leaf 继承 tab.sshSessionId → 全屏 SSH (行为不变)
  //   - 分屏后: 每个 SSH leaf 复用 useSshLeafTransport 注入 openTransport,
  //     与本地 leaf 共用 rendererPool / 保活 / 焦点 / 翻译 / AI buffer
  //   - leaf 的「有效会话」计算见 lib/panes.effectiveLeafSsh:
  //     leaf 显式绑定优先 (string=SSH / null=强制本地), 否则继承 tab 绑定
  // sshActiveLeafIdRef 不再由 SshTerminalHost 上报, 改由下方 useEffect
  // 从 active tab + active leaf 派生 (会话必须仍 connected 才算有效)。
  // TDSF 魔改 2026-07-30 注释保留: 绑定仍按 tab 维度 (tab.sshSessionId),
  // 修复"SSH 连接后打开文件再切回 shell tab 变成本地 shell"的 bug。
  // SSH 连接成功后, 会自动把当前 active terminal tab 的 sshSessionId 设为会话 id
  // (见下方 useEffect)。用户也可手动"新建本地 shell tab"获得本地终端。
  // TDSF 调试: 输出关键判定值
  // TDSF 魔改 2026-08-18 (P1-9): 仅开发环境挂载 __TDSF_DBG__——
  // 生产包挂在 window 上无调试价值, 还扩大内存泄漏面/暴露内部状态。
  if (typeof window !== "undefined" && import.meta.env.DEV) {
    (window as unknown as { __TDSF_DBG__?: unknown }).__TDSF_DBG__ = {
      // TDSF debug (AI mini window): 暴露 chatStore 供 CDP 诊断 AI 入口问题
      getChatStore: () => useChatStore,
      // TDSF debug (2026-08-01): 暴露 sshStore 内部状态供 CDP 排查
      // "终端已连但 SSH 面板/activeSessionId 未连" 的状态不一致问题
      getSshStore: () => useSshStore,
      // TDSF debug (2026-08-01): 暴露 spaces/tabs/newTab 供 CDP 实测
      // Space 切换联动（Explorer 跟随 / SSH Space 新建 tab 绑定）
      getSpaces: () => useSpaces,
      getTabs: () => tabs,
      newTab: (cwd?: string) => newTab(cwd ?? inheritedCwdForNewTab()),
      isDefaultColdTab,
      isTerminalTab,
      activeSshSessionId,
      activeTabId: activeTab?.id,
      activeTabKind: activeTab?.kind,
      activeTabCold: activeTab?.cold,
      showNoTerminalEmptyState,
      // TDSF debug (Phase 2): 暴露 SSH cwd / Space session / leafId 供 OSC 7 同步实测
      spaceSshSessionId,
      // TDSF debug (#21): SSH leafId 现由 active tab + active leaf 派生
      sshActiveLeafId: () => sshActiveLeafIdRef.current,
      spaceSshCurrentPath,
      getEffectiveExplorerRoot: () => effectiveExplorerRoot,
      getExplorerRoot: () => explorerRoot,
      // TDSF debug (Phase 2): 通过 shell printf 输出 OSC 7 序列到 SSH 终端，
      // 验证从 xterm 解析 -> registerCwdHandler -> sshStore.setCurrentPath 的完整链路。
      // 注意：直接 writeToSession 写入 ESC 序列只是发给远端 shell 的输入，不会被回显到终端，
      // 必须让 shell 执行 printf 才能产生终端输出。
      writeToSession,
      injectSshOsc7: (cwd: string) => {
        const lid = sshActiveLeafIdRef.current;
        if (lid == null) return { ok: false, reason: "no ssh leaf" };
        const safeCwd = cwd.replace(/'/g, "'\\''");
        const seq = `printf '\\033]7;file://localhost${safeCwd}\\007'\r`;
        writeToSession(lid, seq);
        return { ok: true, leafId: lid, cwd };
      },
      // TDSF debug (#20): 暴露 rendererPool 内部状态供 CDP 实测诊断
      // getRendererPoolDebug 是只读函数, 不改业务逻辑
      rendererPool: () => getRendererPoolDebug(),
      // TDSF debug (Phase 2): 暴露 xterm Terminal 实例，供 CDP 直接注入
      // OSC 7 字节，隔离 xterm 解析层与 SSH 传输层。
      getSlotTerm: (leafId: number) => getSlotTerm(leafId),
      // TDSF debug (2026-08-08): 暴露 terminalRefs 注册状态, 诊断 SSH
      // 选中捕获链路 (captureActiveSelection 依赖 terminalRefs.has(sshLid))
      terminalHasLeaf: (leafId: number) => terminalRefs.current.has(leafId),
      terminalRefsSize: () => terminalRefs.current.size,
      // TDSF 修复 2026-07-30 (Bug 3): 暴露 getLive / getEnvBlock
      // 供 CDP 验证 Python agent 终端上下文感知 (<env> 块注入) 是否生效
      // 之前只挂了 rendererPool, CDP 没法验证 <env> 块是否注入到 messagesForRun
      // 注意: formatEnvBlock 逻辑内联 (不静态 import transport.ts, 避免 @ai-sdk 污染启动包)
      // TDSF 魔改 2026-07-30 (Bug 4): 补 sshSessionId 字段，与 transport.ts LiveSnapshot 对齐，
      // 供 CDP 验证 SSH 会话注入是否生效（active ssh session → env block 含 ssh_session_id）
      getLive: () => {
        const live = useChatStore.getState().live;
        return {
          cwd: live.getCwd(),
          terminalPrivate: live.isActiveTerminalPrivate(),
          workspaceRoot: live.getWorkspaceRoot(),
          activeFile: live.getActiveFile(),
          sshSessionId: live.getSshRustSessionId(),
        };
      },
      getEnvBlock: () => {
        const live = useChatStore.getState().live;
        const lines: string[] = [];
        const workspaceRoot = live.getWorkspaceRoot();
        const cwd = live.getCwd();
        const activeFile = live.getActiveFile();
        const terminalPrivate = live.isActiveTerminalPrivate();
        const sshSessionId = live.getSshRustSessionId();
        if (workspaceRoot) lines.push(`workspace_root: ${workspaceRoot}`);
        if (cwd) lines.push(`active_terminal_cwd: ${cwd}`);
        if (activeFile) lines.push(`active_file: ${activeFile}`);
        if (terminalPrivate) lines.push("active_terminal_mode: private");
        if (sshSessionId !== null) {
          lines.push(`ssh_session_id: ${sshSessionId}`);
        }
        return lines.length === 0
          ? null
          : `<env>\n${lines.join("\n")}\n</env>`;
      },
    };
  }

  // TDSF 魔改 2026-07-28 (P1-C): 应用启动时自动登录最近使用的 SSH 连接
  // ---------------------------------------------------------------
  // 原 SshExplorer.tsx 的自动登录 useEffect 只在 sidebarView === "ssh" 时触发,
  // 但应用启动默认视图是 "explorer", 导致自动登录不执行, 用户反馈"SSH 未自动连接".
  // 修复: 把自动登录提升到 App 顶层, launchCwdResolved 后即触发, 不依赖 SshExplorer 挂载.
  // SshExplorer.tsx 中的重复逻辑已移除, 避免双重登录.
  // TDSF 魔改 2026-08-18 (P1-6): 主机审批事件常驻订阅。
  // 原因: SshExplorer 只在 sidebarView === "ssh" 时挂载, 其他视图下首次
  // 连接未知主机时 ssh:host_verify / ssh:host_key_mismatch 事件无人订阅,
  // 审批永远无人处理, 连接永久挂起。订阅提升到 App 顶层后任何视图可弹框。
  useEffect(() => {
    const off1 = subscribeHostVerify((req) => {
      useSshStore.setState({ pendingApproval: req });
    });
    const off2 = subscribeHostKeyMismatch((req) => {
      useSshStore.setState({ pendingApproval: req });
    });
    return () => {
      off1();
      off2();
    };
  }, []);
  // TDSF 修复 2026-08-01: 欢迎界面（无任何工作区）下不自动连接——用户尚未选择
  // 工作区，登录统一走"新建工作区"流程（SSH Space 创建时显式连接）。
  useEffect(() => {
    if (!launchCwdResolved || !spacesHydrated) return;
    if (useSpaces.getState().spaces.length === 0) return;
    let cancelled = false;
    void (async () => {
      await useSshStore.getState().loadSavedConnections();
      if (cancelled) return;
      const list = useSshStore.getState().savedConnections ?? [];
      // 已按 lastUsed 倒序, 取第一个 = 最近使用的
      if (list.length > 0 && list[0]) {
        const profile = list[0];
        // TDSF 修复 2026-08-31: 仅当存在 host/user 匹配的既有 SSH Space 时才
        // 自动连接。用户删除了服务器工作区后，开机不该再把它连回来（残留会话
        // 正是"关闭工作区却没关连接 → 新建本地工作区被导向服务器"的来源）。
        const hasMatchingSpace = useSpaces
          .getState()
          .spaces.some(
            (s) =>
              s.env.kind === "ssh" &&
              s.env.host === profile.host &&
              s.env.user === profile.user,
          );
        if (!hasMatchingSpace) return;
        try {
          const id = await useSshStore
            .getState()
            .connectWithSaved(profile, { autoConnect: true });
          if (cancelled) return;
          if (!id) {
            // TDSF 修复 2026-08-01: 自动连接失败时把当前 Space 的幽灵 SSH env
            // 降级为 local——Space env 持久化可能引用已不存在的 session UUID
            //（上个生命周期遗留），若一直保持 env.kind=ssh 会导致该 Space
            // 显示异常（左侧文件树/终端行为按 SSH 判定但无可用会话）。
            const spaceId = useSpaces.getState().activeId;
            const space = spaceId
              ? useSpaces
                  .getState()
                  .spaces.find((s) => s.id === spaceId)
              : undefined;
            const ghostSshSessionId =
              space && space.env.kind === "ssh" ? space.env.sessionId : null;
            if (
              ghostSshSessionId &&
              !useSshStore
                .getState()
                .sessions.some((s) => s.id === ghostSshSessionId)
            ) {
              useSpaces.getState().setEnv(spaceId!, { kind: "local" });
              // TDSF 修复 2026-08-31: 降级时同步清掉远程 root（/home/... 是
              // Linux 路径，本地文件树校验会报 InvalidPath）
              useSpaces.getState().setRoot(spaceId!, null);
              console.warn(
                "[App] auto-connect failed, downgraded ghost SSH space to local",
                space?.name,
              );
            }
            // connectWithSaved 返回 null 常见于 keyring 中找不到该 profile 的敏感字段
            toast.warning("自动登录失败", {
              description: `${profile.alias || `${profile.user}@${profile.host}`}: 凭据缺失或已过期, 请重新配置`,
              duration: 6000,
            });
          }
        } catch (e) {
          // connectWithSaved 内部已 toast, 这里兜底防止未捕获异常
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[App] SSH auto-connect failed:", e);
          const isAuthError = /auth|password|public.?key|permission/i.test(msg);
          const isNetworkError =
            /timeout|unreachable|network|refused|reset/i.test(msg);
          const desc = isAuthError
            ? `${profile.alias || `${profile.user}@${profile.host}`}: 认证失败, 请检查密码或密钥`
            : isNetworkError
              ? `${profile.alias || `${profile.user}@${profile.host}`}: 网络不通, 请检查连接\n${msg}`
              : `${profile.alias || `${profile.user}@${profile.host}`}: ${msg}`;
          toast.error("自动登录失败", { description: desc, duration: 8000 });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchCwdResolved, spacesHydrated]);

  // TDSF 修复 2026-08-01: 幽灵 SSH Space 启动清理。
  // 自动连接"无保存凭据"时不会触发 connectWithSaved 的失败分支（§37.9 的
  // 降级逻辑只覆盖"尝试连接但失败"），持久化的 SSH Space（env.sessionId
  // 是上个生命周期的旧 UUID，store 里不存在）会一直保持 env.kind=ssh 却
  // 无可用会话 → 该 Space 显示异常。此处等自动连接 settle（成功或跳过）
  // 后统一扫描降级。
  useEffect(() => {
    if (!launchCwdResolved) return;
    const timer = window.setTimeout(() => {
      const spaces = useSpaces.getState();
      const sessions = useSshStore.getState().sessions;
      for (const sp of spaces.spaces) {
        const sshSessionId = sp.env.kind === "ssh" ? sp.env.sessionId : null;
        if (!sshSessionId) continue;
        if (sessions.some((s) => s.id === sshSessionId)) continue;
        console.warn(
          "[App] ghost SSH space detected at startup, downgrading to local:",
          sp.name,
        );
        useSpaces.getState().setEnv(sp.id, { kind: "local" });
        // TDSF 修复 2026-08-31: 降级时清掉远程 root，否则本地文件树打开
        // /home/... 报 InvalidPath（用户实测截图里的报错）
        useSpaces.getState().setRoot(sp.id, null);
      }
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [launchCwdResolved]);

  // === TDSF 魔改 2026-07-30: SSH 连接成功后绑定 terminal tab + 左侧 explorer 视图 ===
  // ---------------------------------------------------------------
  // 用户明确需求:
  //   1. "SSH 板块只是一个连接的板块; 连接后左侧 Files 面板应显示服务器
  //       的文件资源管理器, 效果跟本地一模一样"
  //   2. "SSH 连接后打开文件再切回 shell tab 应仍是 SSH 服务器的 shell,
  //       而不是 Windows 本地 shell"
  //
  // 实现 (2026-07-30 重构, 按会话维度绑定 tab):
  //   - 维护 boundSshSessionsRef: Set<sessionId> 记录已绑定过 tab 的会话
  //   - 每当有新会话变为 connected:
  //     a) 把当前 active terminal tab (若无则新建一个) 的 sshSessionId 绑定为该会话 id
  //     b) 首次连接成功时切回 explorer 视图
  //   - 当某会话从 connected 变为 disconnected/failed:
  //     a) 找到所有 sshSessionId === 该会话 id 的 terminal tab
  //     b) 解绑 (置 sshSessionId = null), 工作区自动回退到本地 TerminalStack
  //   - 全局无 connected 会话时, 重置 hasConnectedSshRef 让下次连接再切视图
  const hasConnectedSshRef = useRef(false);
  const boundSshSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const unsub = useSshStore.subscribe((state) => {
      const connectedSessions = state.sessions.filter(
        (s) => s.state === "connected" && s.handle !== null,
      );
      const hasConnected = connectedSessions.length > 0;

      // 处理新连接成功的会话: 绑定到当前 active terminal tab
      for (const session of connectedSessions) {
        if (boundSshSessionsRef.current.has(session.id)) continue;
        boundSshSessionsRef.current.add(session.id);
        // TDSF 魔改 2026-08-18 (P1-8): 重连成功后清除 fatalError——
        // 断线时 workspaceFsStore.fatalError 被置为"SSH 连接已断开"且只在
        // Space 切换/重新 navigate 时清除; 同一 Space 内重连成功时残留,
        // 资源管理器会一直显示错误而非远程文件。
        useWorkspaceFsStore.getState().setFatalError(null);

        // TDSF 修复 2026-08-31（用户实测：新建本地工作区被自动导向服务器）:
        // 连接成功只允许绑定"专属 SSH Space"（env.kind==="ssh" 且 host/user 匹配），
        // 绝不改写本地/WSL Space——Space 类型由创建时的用户意图决定。
        //   - 自动连接（开机 connectWithSaved）：只恢复 host/user 匹配的既有 SSH
        //     Space；若无匹配 Space，说明用户此前已删除该服务器工作区 → 直接跳过，
        //     绝不凭空新建并切换（这正是"本地工作区被导向服务器"的根因）。
        //   - 手动连接（对话框 / SSH 面板）：无匹配 Space 时新建一个并切换过去，
        //     给这次连接一个工作区承载。
        const spaces = useSpaces.getState();
        const isAutoConnect = session.autoConnect === true;
        let targetSpace =
          spaces.spaces.find(
            (s) =>
              s.env.kind === "ssh" &&
              s.env.host === session.params.host &&
              s.env.user === session.params.user,
          ) ?? null;
        if (!targetSpace) {
          if (isAutoConnect) {
            // 兜底（正常不会走到——启动 effect 已按"存在匹配 Space"才自动连接）：
            // 孤儿自动连接会话立即断开，不留后台活连接。
            boundSshSessionsRef.current.delete(session.id);
            void useSshStore.getState().disconnect(session.id);
            continue;
          }
          const created = useSpaces.getState().create({
            name: `${session.params.user}@${session.params.host}`,
            root: `/home/${session.params.user}`,
            env: {
              kind: "ssh",
              host: session.params.host,
              user: session.params.user,
              port: session.params.port ?? 22,
              sessionId: session.id,
              label: `${session.params.user}@${session.params.host}`,
            },
          });
          targetSpace = created;
          setActiveSpaceForNewTabs(created.id);
          useSpaces.getState().setActive(created.id);
        } else if (
          targetSpace.env.kind === "ssh" &&
          targetSpace.env.sessionId !== session.id
        ) {
          useSpaces.getState().setEnv(targetSpace.id, {
            kind: "ssh",
            host: session.params.host,
            user: session.params.user,
            port: session.params.port ?? 22,
            sessionId: session.id,
            label: `${session.params.user}@${session.params.host}`,
          });
        }

        // TDSF 修复 2026-08-01: 新连接成功时同步 activeSessionId。
        // 此前只有 Space effect（依赖 activeSpaceId 变化）会 setActiveSession，
        // 而 Space 升级（setEnv）不改 activeSpaceId → activeSessionId 停留在
        // 持久化恢复的旧 UUID（上个生命周期已删除的 session）→
        // selectActiveSession 返回 null → SSH 面板显示未连接 + AI live
        // sshSessionId 注入 null（agent 误判"未连接 SSH"）。此处与 Space
        // env 一起更新，保证 activeSessionId 与终端实际使用的 session 同源。
        useSshStore.getState().setActiveSession(session.id);

        // 首次连接成功: 切回 explorer 视图, 让 FileExplorer 显示远程文件
        if (!hasConnectedSshRef.current) {
          hasConnectedSshRef.current = true;
          if (sidebarView !== "explorer") {
            persistSidebarView("explorer");
          }
        }

        // 把目标 Space 内的 terminal tab 绑定到该 SSH 会话
        // 如果当前 active tab 不是 terminal, 找第一个 terminal tab; 都没有就 newTab()
        // TDSF 修复 2026-07-31: 优先绑定已经预绑定该 session 的 tab（SpaceCreateDialog
        // 创建 SSH Space 时会预先把 tab.sshSessionId 设为 session.id），避免用户
        // 切到其它 Space 后新连接误绑到错误 Space 的 terminal tab。
        // TDSF 修复 2026-08-01: 查找范围限定 targetSpace.id 内的 tab，
        // 防止自动连接把其它 Space（如本地工作区）的 terminal tab 误绑成 SSH。
        // TDSF 修复 2026-08-31: targetSpace 现在恒非空（无匹配则新建）。
        const targetSpaceId = targetSpace.id;
        const currentTabs = tabsRef.current;
        const currentActiveId = activeIdRef.current;
        // TDSF 修复 2026-08-07: tab 绑定条件放宽——绑定的 sessionId 若已失效
        // (幽灵 id: 服务器关闭/断线后残留), 允许新会话重绑。此前要求
        // `!t.sshSessionId || t.sshSessionId === session.id`, 断线重连后旧 tab
        // 绑着失效 id 永远匹配不上 → 终端显示本地。
        const sessionExists = (id: string | null | undefined) =>
          !!id &&
          useSshStore
            .getState()
            .sessions.some((s) => s.id === id);
        const canRebind = (id: string | null | undefined) =>
          !id || !sessionExists(id) || id === session.id;
        // 在 subscribe 回调里用 getState() 读取最新远程路径, 避免 stale closure
        const remoteCwd =
          useSshStore.getState().currentPathBySession[session.id] ?? "/";
        // TDSF 修复 2026-08-31: 只在"属于本 Space 且是本地 shell（未绑会话）或
        // 幽灵绑定"的 terminal tab 上重绑。绝不跨 Space 抢占——此前 canRebind
        // 对无 sshSessionId 的本地 tab 返回 true，若 targetSpace 判定失误会把
        // 别的工作区的本地终端改成 SSH。
        let targetTab = currentTabs.find(
          (t) =>
            t.spaceId === targetSpaceId &&
            t.kind === "terminal" &&
            t.sshSessionId === session.id,
        );
        if (!targetTab) {
          targetTab = currentTabs.find(
            (t) =>
              t.spaceId === targetSpaceId &&
              t.id === currentActiveId &&
              t.kind === "terminal" &&
              canRebind(t.sshSessionId),
          );
        }
        if (!targetTab) {
          targetTab = currentTabs.find(
            (t) =>
              t.spaceId === targetSpaceId &&
              t.kind === "terminal" &&
              canRebind(t.sshSessionId),
          );
        }
        if (targetTab) {
          // TDSF 用户钦定 2026-08-28: SSH tab 固定叫 "shell"（服务器标识已在
          // Space 名 / 左下角状态栏展示，tab 不重复显示 user@host）。
          updateTab(targetTab.id, {
            sshSessionId: session.id,
            customTitle: "shell",
            cwd: remoteCwd,
          });
          // 切到该 tab, 让用户立即看到 SSH 终端
          if (targetTab.id !== currentActiveId) {
            setActiveId(targetTab.id);
          }
        } else {
          // TDSF 修复 2026-08-31: 新建的 SSH Space 里还没有任何 terminal tab
          // （连接来自 SshExplorer 面板 / 欢迎页 cold tab 等无 Space 上下文入口），
          // 主动补一个 shell tab，避免"连上了却没有终端"。
          const tabId = newTabInSpace(targetSpaceId, remoteCwd);
          updateTab(tabId, {
            sshSessionId: session.id,
            customTitle: "shell",
            cwd: remoteCwd,
          });
          setActiveId(tabId);
        }
      }

      // 处理真正断开的会话: 解绑对应的 terminal tab, 并清除 SSH 自定义标题。
      // TDSF 修复 2026-07-31: reconnecting 状态不解绑 ——
      //   重连期间仍保持 tab 绑定 SSH, 避免用户切回 shell 时看到本地终端/主机名丢失。
      const disconnectedSessions = state.sessions.filter(
        (s) => s.state === "closed" || s.state === "failed",
      );
      // TDSF 魔改 2026-08-18 (P1-7): 断开/失败会话立即从 store 移除——
      // 原实现只遍历 boundSshSessionsRef 解绑 tab, 会话仍残留 sessions 数组
      // (且未绑定过的 failed 会话完全不被处理), disconnect 对无 handle 会话
      // 又直接 return, 残留会话只能重启应用清除。disconnect 已支持无 handle
      // 清理, 这里补上生产调用方。
      for (const session of disconnectedSessions) {
        const sessionId = session.id;
        if (boundSshSessionsRef.current.has(sessionId)) {
          boundSshSessionsRef.current.delete(sessionId);
          const currentTabs = tabsRef.current;
          for (const tab of currentTabs) {
            if (tab.kind === "terminal" && tab.sshSessionId === sessionId) {
              updateTab(tab.id, {
                sshSessionId: null,
                customTitle: "",
              });
            }
          }
        }
        // TDSF 修复 2026-08-31: 会话断开 → 所有绑定该会话的 Space 降级为本地
        // （env→local、root→null 让资源管理器回退本地 home）。此前只给"当前
        // Space"设 fatalError 且保留 env.kind=ssh，导致：① 幽灵 SSH Space 的
        // root 还是远程 Linux 路径，本地文件树报 InvalidPath；② 用户删掉工作区
        // 重开时残留 env 继续把新界面导向服务器。降级后重连会生成干净的专属
        // SSH Space（见上方 connected 分支），本地/WSL Space 永不受连接污染。
        const spacesState = useSpaces.getState();
        for (const sp of spacesState.spaces) {
          if (sp.env.kind === "ssh" && sp.env.sessionId === sessionId) {
            spacesState.setEnv(sp.id, { kind: "local" });
            useSpaces.getState().setRoot(sp.id, null);
            if (spacesState.activeId === sp.id) {
              useWorkspaceFsStore.getState().setFatalError(null);
            }
          }
        }
        // 从 store 移除会话（closed/failed 均无继续存在的价值）
        void useSshStore.getState().disconnect(sessionId);
      }

      if (!hasConnected) {
        hasConnectedSshRef.current = false;
      }
    });
    return () => unsub();
  }, [
    persistSidebarView,
    sidebarView,
    updateTab,
    setActiveId,
    newTabInSpace,
    setActiveSpaceForNewTabs,
  ]);

  useEditorFileSync({ tabs, tabsRef, editorRefs });
  useThemeFileEditing({ tabsRef, openFileTab });

  // TDSF 修复 2026-07-31: useWorkspaceCwd 增加 spaceRoot fallback，
  // 切 Space 时若当前 terminal tab 无 cwd 则显示 Space 的 root 目录。
  // TDSF 修复 2026-08-01: 传 spaceId，cwd 记忆按 Space 隔离，
  // 避免 SSH Space 的远程 cwd 泄漏到本地 Space 的 explorerRoot。
  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
    activeSpace?.root ?? null,
    activeSpaceId,
  );
  // SSH 连通时左侧 Files 面板根路径使用当前 Space 的远程当前目录
  const effectiveExplorerRoot =
    explorerSource === "ssh" && activeSpace?.env.kind === "ssh"
      ? (spaceSshCurrentPath ?? activeSpace.root ?? `/home/${activeSpace.env.user}`)
      : explorerRoot;

  // TDSF 修复 2026-07-29: SSH 连接后, 窗口标题/状态栏路径显示 SSH 远程位置。
  // TDSF 修复 2026-07-31: 顶栏项目名固定显示本地工作区, 不显示 SSH 地址
  //   (地址已在左下角 StatusBar 展示, 避免顶栏重复且拥挤)。
  // 按当前 Space 的 SSH session 生成位置标签，切 Space 时标题同步切换。
  const sshLocationLabel =
    isSpaceSshConnected && spaceSshSession && activeSpace?.env.kind === "ssh"
      ? `${spaceSshSession.params.user}@${spaceSshSession.params.host}:${spaceSshCurrentPath ?? "/"}`
      : null;
  // TDSF 修复 2026-08-12 (ROADMAP #9): SSH 位置作为第三参数传入 useWindowTitle，
  // SSH Space 时窗口标题显示 user@host:path（此前混入 explorerRoot 计算导致
  // 标题显示本地目录名、丢主机信息）。
  useWindowTitle(activeTab, effectiveExplorerRoot, sshLocationLabel);

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null
        ? (searchAddons.current.get(activeLeafId) ?? null)
        : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      previewRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  const {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    handleClose,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    handlePathDeleted,
  } = useTabCloseGuards({ tabs, disposeTab });

  const { pendingAppClose, confirmAppClose, cancelAppClose } =
    useAppCloseGuard(tabsRef);

  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    // TDSF 魔改 2026-08-11 (#21): SSH leaf 已进入 tab.paneTree（PaneTreeView
    // 直接渲染），leafIds 自然包含它们，无需再像 SshTerminalHost 时代那样
    // 把游离的 sshLid 手动纳入 live 集合。
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  // Most-recently-used tab ids, most recent first, pruned to live tabs. Drives
  // the Ctrl+Tab quick switcher so it cycles by recency, not strip order.
  const mruRef = useRef<number[]>([activeId]);
  useEffect(() => {
    mruRef.current = [
      activeId,
      ...mruRef.current.filter((id) => id !== activeId),
    ];
  }, [activeId]);
  useEffect(() => {
    const live = new Set(tabs.map((t) => t.id));
    mruRef.current = mruRef.current.filter((id) => live.has(id));
  }, [tabs]);

  // TDSF 魔改 2026-07-30 P1-a → v3.1 移除: sidecar:agent_switch 永久订阅已删除
  // -------------------------------------------------------------------
  // 原用途：main_agent 路由子 Agent 时推送 agent_switch 事件，前端更新
  // currentSubAgent 驱动 AgentStatusPill。v3.1（方案书 §4.1）4 子 agent
  // 委派机制整体下线，该事件不再产生；AgentStatusPill 改为模式指示器
  // （订阅本地状态 agentMode/teach，无 agent 切换动画）。

  const getSwitcherOrder = useCallback(() => {
    const space = activeSpaceId ?? DEFAULT_SPACE_ID;
    const inSpace = tabsRef.current
      .filter((t) => t.spaceId === space)
      .map((t) => t.id);
    const present = new Set(inSpace);
    const ordered = mruRef.current.filter((id) => present.has(id));
    for (const id of inSpace) if (!ordered.includes(id)) ordered.push(id);
    return [activeId, ...ordered.filter((id) => id !== activeId)];
  }, [activeId, activeSpaceId]);

  const { state: switcherState, step: stepSwitcher } = useTabSwitcher({
    getOrder: getSwitcherOrder,
    onCommit: (id) => {
      if (tabsRef.current.some((t) => t.id === id)) setActiveId(id);
    },
  });

  const cycleSpace = useCallback((delta: 1 | -1) => {
    const { spaces, activeId: sid, setActive } = useSpaces.getState();
    if (spaces.length < 2) return;
    const idx = spaces.findIndex((s) => s.id === sid);
    const next = (idx + delta + spaces.length) % spaces.length;
    setActive(spaces[next].id);
  }, []);

  // TDSF 魔改 (2026-08-11 #21): sshActiveLeafIdRef 派生自 active tab + active leaf。
  // -----------------------------------------------------------------------------
  // SshTerminalHost 时代由 onLeafId 上报（组件生命周期驱动）；现在 SSH leaf 就在
  // tab.paneTree 里，本 effect 从 active terminal tab 的 active leaf 计算「有效 SSH
  // 会话」，且会话必须仍 connected（断开自动回退本地渲染，ref 同步置 null）。
  // 订阅 sshStore：连接/断开时无需等 App 重渲染即可同步 ref。
  useEffect(() => {
    const updateRef = () => {
      const t = activeTerminalTab;
      if (t && t.kind === "terminal" && activeLeafId !== null) {
        const eff = effectiveLeafSsh(t.paneTree, activeLeafId, t.sshSessionId);
        if (typeof eff === "string") {
          const sess = useSshStore
            .getState()
            .sessions.find((s) => s.id === eff);
          if (sess?.state === "connected" && sess.handle) {
            sshActiveLeafIdRef.current = activeLeafId;
            return;
          }
        }
      }
      sshActiveLeafIdRef.current = null;
    };
    updateRef();
    const unsub = useSshStore.subscribe(updateRef);
    return () => {
      unsub();
      sshActiveLeafIdRef.current = null;
    };
  }, [activeTerminalTab, activeLeafId]);

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      // TDSF 魔改 2026-08-11 (#21): SSH leaf 已进入 tab.paneTree，activeLeafId
      // 直接指向当前 pane（本地或 SSH 同路径），不再需要 SshTerminalHost 时代的
      // sshActiveLeafIdRef 分支。优先从 rendererPool slot 读选区（leafGridSelection，
      // 与组件生命周期一致、天然自愈），handle 未注册时兜底 terminalRefs。
      const lid = t.activeLeafId;
      return (
        leafGridSelection(lid) ??
        terminalRefs.current.get(lid)?.getSelection() ??
        null
      );
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      // Dispatch a window event the composer listens for. Same pattern as
      // selections — keeps file-explorer decoupled from the AI module.
      window.dispatchEvent(
        new CustomEvent<string>("tdsf:ai-attach-file", { detail: path }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  // A1 explorer 联动 (2026-09-01, §37.88 最小接收端): 远程行 "Attach to Agent"
  // —— 派发 tdsf:ai-attach-remote-file({path, sessionId})，composer 侧 sftpRead
  // 构造附件。sessionId 取当前连接中 SSH 会话的 rustSessionId（Rust u32，
  // sftp_read 反向路由按它寻址；SshSessionInfo.id 是前端 uuid 勿混用）。
  const handleAttachRemoteFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      const sshState = useSshStore.getState();
      const active = sshState.sessions.find(
        (s) => s.id === sshState.activeSessionId,
      );
      const session =
        active && active.state === "connected" && active.handle !== null
          ? active
          : sshState.sessions.find(
              (s) => s.state === "connected" && s.handle !== null,
            );
      const rustId = session?.rustSessionId ?? null;
      if (rustId === null) return;
      window.dispatchEvent(
        new CustomEvent("tdsf:ai-attach-remote-file", {
          detail: { path, sessionId: rustId },
        }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection?.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  const { askPopup, setAskPopup, onAskFromSelection } = useSelectionAskAi({
    captureActiveSelection,
    askFromSelection,
  });
  const askPresence = usePresence(Boolean(askPopup), 120);

  // TDSF 魔改 2026-07-29: 终端选词翻译（与 SelectionAskAi 并列，使用相同的事件机制）
  // P2 (2026-08-01) 重构: 选中浮层点「翻译」按钮 → 这里查离线词典并展示卡片。
  // 本地终端与 SSH 终端统一（captureActiveSelection 已按 tab/leafId/SSH leafId 取文本）
  const translateEnabled = useTranslateStore((s) => s.enabled);
  const onTranslateSelection = useCallback(
    (x: number, y: number) => {
      const text = captureActiveSelection()?.trim() ?? "";
      if (!text || text.length > 64) {
        useTranslateStore.getState().hideTooltip();
        return;
      }
      const result = translateText(text);
      if (result.success && result.entries.length > 0) {
        useTranslateStore.getState().showTooltip(result, x, y);
      } else {
        useTranslateStore.getState().showMissing(text, x, y);
      }
    },
    [captureActiveSelection],
  );
  const onAskWithSelection = useCallback(
    (text: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      attachSelection(text, activeTab?.kind === "editor" ? "editor" : "terminal");
      openPanel();
      focusInput(null);
    },
    [hasComposer, attachSelection, activeTab?.kind, openPanel, focusInput],
  );

  const bindTabToSshSpace = useCallback(
    (tabId: number, spaceId: string) => {
      const space = useSpaces.getState().spaces.find((s) => s.id === spaceId);
      if (space?.env.kind === "ssh" && space.env.sessionId) {
        updateTab(tabId, {
          sshSessionId: space.env.sessionId,
          // 用户钦定 2026-08-28: SSH tab 固定叫 "shell"（原显示 user@host）。
          // customTitle 必须设——tabLabel 里 cwd basename 优先级高于 title，
          // 不设的话远端 cd 后标题会漂移成目录名。
          customTitle: "shell",
        });
      }
    },
    [updateTab],
  );

  const openNewTab = useCallback(() => {
    // TDSF 修复 2026-08-01: SSH Space 新建终端继承远程 cwd（spaceSshCurrentPath），
    // 而非本地 spaceRoot 残留路径（此前新建 SSH tab 的 cwd 是本地 D:/）。
    const isSshSpace = activeSpace?.env.kind === "ssh";
    const cwd = isSshSpace
      ? (spaceSshCurrentPath ?? "/")
      : inheritedCwdForNewTab();
    const tabId = newTab(cwd);
    bindTabToSshSpace(tabId, activeSpaceId ?? DEFAULT_SPACE_ID);
  }, [
    newTab,
    inheritedCwdForNewTab,
    bindTabToSshSpace,
    activeSpaceId,
    activeSpace,
    spaceSshCurrentPath,
  ]);

  const sendCd = useCallback(
    (path: string) => {
      // TDSF 修复 2026-07-29: SSH 模式下状态栏路径显示远程位置,
      // 但本地 terminalRefs 对应的是隐藏的本地终端, 点击 breadcrumb 不应
      // 把 cd 命令写入错误终端。SSH 目录切换由用户在 SSH 终端内操作。
      // TDSF 修复 2026-07-31: 按当前 Space 判定，避免本地 Space 仍受全局 SSH 连接影响。
      if (isSpaceSshConnected) return;
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId, isSpaceSshConnected],
  );

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (tab?.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Markdown opens in its rendered view by default; a per-tab toggle flips
      // it to the raw editor. Other files default to preview (pin=false);
      // explicit actions like context-menu "Open" pass pin=true to persist.
      if (isMarkdownPath(path)) newMarkdownTab(path);
      else openFileTab(path, pin ?? false);
    },
    [openFileTab, newMarkdownTab],
  );

  // TDSF 魔改 2026-07-30: 远程文件点击改走主区 EditorStack（多 tab 并行），
  // 废弃侧栏 SshFileEditor（单文件 singleton textarea）。
  // pin = false 与本地单击行为一致（preview tab，二次单击其他文件替换槽位）。
  const handleOpenRemoteFile = useCallback(
    (path: string) => {
      // TDSF 修复 2026-07-31: 远程文件打开使用当前 Space 的 SSH sessionId，
      // 切 Space 后点击远程文件不会串到其它 session。
      const sessionId = spaceSshSessionId ?? activeSshSessionId;
      if (!sessionId) return;
      openFileTab(path, false, { sessionId });
    },
    [spaceSshSessionId, activeSshSessionId, openFileTab],
  );

  // "Open With" files arrive via the event (warm start) and get_launch_files
  // (cold start, before this listener attaches). Backend already authorized
  // each parent; openFileTab dedupes by path, so both paths can't double-open.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const openAll = (paths: string[]) => {
      for (const path of paths) handleOpenFile(path, true);
    };
    (async () => {
      // TDSF 魔改: terax:open-file → tdsf:open-file（与全局 Terax→TDSF 清洗对齐）
      unlisten = await listen<string[]>("tdsf:open-file", (e) => {
        openAll(e.payload);
      });
      openAll(await consumeLaunchFiles());
    })();
    return () => unlisten?.();
  }, [handleOpenFile]);

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  // TDSF 修复 2026-07-29: 状态栏/输入栏 cwd 在 SSH 连接后显示远程路径。
  // TDSF 修复 2026-07-31: 按当前 Space 的 SSH session 显示路径，切 Space 时同步切换。
  const statusBarCwd =
    isSpaceSshConnected && isTerminalTab
      ? (spaceSshCurrentPath ?? "/")
      : activeTerminalLeafCwd;

  const activeFilePath = (() => {
    if (activeTab?.kind === "editor") return activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const explorerActiveFilePath =
    activeTab?.kind === "editor" || activeTab?.kind === "markdown"
      ? activeTab.path
      : null;
  const { sourceControl, toggleSourceControl, openGitGraphFromContext } =
    useSourceControlContext({
      activeTab,
      tabs,
      activeTerminalLeafCwd,
      explorerRoot,
      launchCwd,
      launchCwdResolved,
      home,
      sidebarView,
      cycleSidebarView,
      openCommitHistoryTab,
    });
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );

  const openPreviewTab = useCallback(
    (url: string) => {
      const id = newPreviewTab(url);
      // Focus the address bar if the URL is empty so the user can type.
      if (!url) {
        setTimeout(() => previewRefs.current.get(id)?.focusAddressBar(), 0);
      }
      return id;
    },
    [newPreviewTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (t?.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const livePaneBounds = useCallback((tabId: number): PaneBounds[] => {
    const tab = document.querySelector<HTMLElement>(
      `[data-terminal-tab="${tabId}"]`,
    );
    if (!tab) return [];
    return [...tab.querySelectorAll<HTMLElement>("[data-pane-leaf]")].flatMap(
      (element) => {
        const id = Number(element.dataset.paneLeaf);
        if (!Number.isFinite(id)) return [];
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return [{ id, left, right, top, bottom }];
      },
    );
  }, []);

  const swapActivePane = useCallback(
    (direction: "left" | "right" | "up" | "down") => {
      swapActivePaneInDirection(activeId, direction, livePaneBounds(activeId));
    },
    [activeId, livePaneBounds, swapActivePaneInDirection],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    void handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const [zenMode, setZenMode] = useState(false);

  // Focus an agent's tab, switching to its space first so the header and tab
  // strip don't end up showing a different space than the focused pane.
  const activateAgentTarget = useCallback(
    (tabId: number, leafId: number) => {
      const space = tabsRef.current.find((t) => t.id === tabId)?.spaceId;
      if (space && space !== useSpaces.getState().activeId) {
        useSpaces.getState().setActive(space);
      }
      setActiveId(tabId);
      focusPane(tabId, leafId);
    },
    [setActiveId, focusPane],
  );

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "commandPalette.open": () => openCommandPalette("commands"),
      "commandPalette.content": () => openCommandPalette("content"),
      "tab.new": openNewTab,
      // TDSF 魔改 2026-08-31（用户钦定）: Blocks/Privacy/Preview 入口整体移除
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => stepSwitcher(1),
      "tab.prev": () => stepSwitcher(-1),
      "tab.selectByIndex": (e) =>
        selectByIndex(
          parseInt(e.key, 10) - 1,
          activeSpaceId ?? DEFAULT_SPACE_ID,
        ),
      "space.next": () => cycleSpace(1),
      "space.prev": () => cycleSpace(-1),
      "space.overview": () => setSwitcherOpen(true),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      // TDSF 魔改 (2026-08-11): iTerm2 风格分屏快捷键（Ctrl/Cmd+Shift+H/V）。
      // 与 splitRight/splitDown 共用 handler——splitActivePane 已自动继承
      // 当前 pane 的有效 SSH 会话（SSH 终端分屏 → 新的 SSH pane）。
      "pane.splitSshRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitSshDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.swapLeft": () => swapActivePane("left"),
      "pane.swapRight": () => swapActivePane("right"),
      "pane.swapUp": () => swapActivePane("up"),
      "pane.swapDown": () => swapActivePane("down"),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "terminal.toggleInput": () =>
        window.dispatchEvent(new CustomEvent(TOGGLE_BLOCK_INPUT_EVENT)),
      // TDSF 魔改 2026-07-29: 终端翻译快捷键 (Ctrl+Shift+T)
      "terminal.translate": () => {
        useTranslateStore.getState().toggleEnabled();
      },
      // TDSF 魔改 2026-08-28 (B1-G4): 终端内搜索（Ctrl/Cmd+Shift+F）
      // 激活 tab 是终端时打开其 active leaf 的搜索浮层（TerminalPane 渲染）；
      // 编辑器 tab 无此响应（编辑器用 Ctrl+F 的 search.focus）。
      "terminal.find": () => {
        const t = tabsRef.current.find((x) => x.id === activeId);
        if (t?.kind === "terminal" && t.activeLeafId != null) {
          useTerminalSearchStore.getState().open(t.activeLeafId);
        }
      },
      "blocks.prev": () => navigateFocusedBlocks(-1),
      "blocks.next": () => navigateFocusedBlocks(1),
      "search.focus": () => {
        const editor = editorRefs.current.get(activeId);
        if (editor) editor.openSearch();
        else searchInlineRef.current?.focus();
      },
      // TDSF 魔改 2026-07-30: 统一 AI 入口 — Ctrl+I 和 Main 按钮都打开浮动小窗
      // 原实现: Ctrl+I 打开右侧面板 (panelOpen), Main 打开浮动小窗 (mini.open),
      // 两个独立状态会同时存在两个对话框, 用户困惑。
      // 现统一: Ctrl+I / Ctrl+Shift+I / Main 按钮都走 toggleMini, 打开同一个浮动小窗。
      "ai.toggle": () => {
        if (!hasComposer) {
          void openSettingsWindow("models");
          return;
        }
        toggleMini();
        focusInput(null);
      },
      "ai.toggleMini": () => {
        if (!hasComposer) {
          void openSettingsWindow("models");
          return;
        }
        toggleMini();
      },
      "ai.askSelection": askFromSelection,
      "agent.focusAttention": () => {
        const t = nextAttentionTarget();
        if (t) activateAgentTarget(t.tabId, t.leafId);
      },
      "settings.open": () => void openSettingsWindow(),
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "view.zenMode": () => setZenMode((v) => !v),
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
      "editor.aiComplete": () =>
        editorRefs.current.get(activeId)?.triggerAiComplete(),
      "editor.codeComplete": () =>
        editorRefs.current.get(activeId)?.triggerCodeComplete(),
    }),
    [
      activeId,
      openCommandPalette,
      stepSwitcher,
      cycleSpace,
      handleCloseTabOrPane,
      openNewTab,
      activeSpaceId,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      swapActivePane,
      toggleSourceControl,
      hasComposer,
      toggleMini,
      focusInput,
      askFromSelection,
      toggleSidebar,
      toggleExplorerFocus,
      zoomIn,
      zoomOut,
      zoomReset,
      activateAgentTarget,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      const terminalPaneCount =
        activeTab?.kind === "terminal"
          ? leafIds(activeTab.paneTree).length
          : null;
      if (shouldDisablePaneSwapShortcut(id, terminalPaneCount)) return true;
      if (
        id === "editor.undo" ||
        id === "editor.redo" ||
        id === "editor.aiComplete" ||
        id === "editor.codeComplete"
      ) {
        return activeTab?.kind !== "editor";
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel?.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (
        id === "terminal.toggleInput" ||
        id === "blocks.prev" ||
        id === "blocks.next"
      ) {
        return !(activeTab?.kind === "terminal" && activeTab.blocks === true);
      }
      if (id === "sidebar.toggle") {
        // Ctrl+B is also Claude Code's "run in background" key. While a terminal
        // is focused, let Ctrl+B reach the shell/Claude instead of toggling the
        // sidebar. Ctrl+Shift+B (second binding) still toggles it from anywhere.
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        // Only defer the plain (no-shift) Ctrl/⌘+B binding; the Shift variant
        // is the always-on toggle and is never claimed by the terminal.
        return inTerminal && !e.shiftKey;
      }
      return false;
    },
    [activeTab, captureActiveSelection],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) {
        editorRefs.current.set(id, h);
        const line = pendingGotoLine.current.get(id);
        if (line != null) {
          pendingGotoLine.current.delete(id);
          h.gotoLine(line);
        }
      } else {
        editorRefs.current.delete(id);
      }
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const registerPreviewHandle = useCallback(
    (id: number, h: PreviewPaneHandle | null) => {
      if (h) previewRefs.current.set(id, h);
      else previewRefs.current.delete(id);
    },
    [],
  );

  const handlePreviewUrl = useCallback(
    (id: number, url: string) => updateTab(id, { url }),
    [updateTab],
  );

  const authorizedCwds = useRef(new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => {
      setLeafCwd(leafId, cwd);

      // TDSF 修复 2026-07-31 (Phase 2): SSH 终端 cd 时同步
      // sshStore.currentPathBySession，让左侧远程资源管理器跟随终端 cwd
      // 自动刷新。本地路径仍走 workspaceAuthorize 申请文件系统权限。
      // TDSF 修复 2026-08-08 (WorkspaceFs): SSH tab 在 TerminalStack 里
      // 也有本地保活 pty, 其 OSC 7 上报本地路径 (C:/...)——绝不能写入 SSH
      // 会话的 currentPath (污染远程路径 → sftp 后端收到本地路径被拒)。
      // 只接受远程绝对路径 (/ 开头); SshTerminalHost 的远程 cwd 走其内部
      // setCurrentPath (SshTerminalHost.tsx:108), 此处不重复写。
      const tab = tabsRef.current.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (
        tab?.kind === "terminal" &&
        tab.sshSessionId &&
        cwd &&
        cwd.startsWith("/")
      ) {
        useSshStore.getState().setCurrentPath(tab.sshSessionId, cwd);
      } else if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const onActivateAgent = activateAgentTarget;

  const onActivateLocalAgent = useCallback(() => {
    openPanel();
    focusInput(null);
  }, [openPanel, focusInput]);

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (tab?.kind !== "terminal") return;
      // Last pane of the last tab: quit instead of respawning a shell.
      if (leafIds(tab.paneTree).length === 1 && all.length === 1) {
        // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 close, 否则浏览器会跳到 about:blank
        if (isTauriRuntime()) void getCurrentWindow().close();
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const handleRenameTab = useCallback(
    (id: number, title: string) => updateTab(id, { customTitle: title.trim() }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  const handleNewSpace = useCallback(() => {
    setSpaceCreateOpen(true);
  }, []);

  // 工作区门控 CTA (2026-09-01): WorkspaceGate/新建对话按钮经 window 事件
  // 请求打开 SpaceCreateDialog / SpaceSwitcher 总览（跨模块解耦，与
  // tdsf:ai-attach-* 事件同模式）
  useEffect(() => {
    const onCreate = () => setSpaceCreateOpen(true);
    const onOverview = () => setSwitcherOpen(true);
    window.addEventListener("tdsf:spaces-create", onCreate);
    window.addEventListener("tdsf:spaces-overview", onOverview);
    return () => {
      window.removeEventListener("tdsf:spaces-create", onCreate);
      window.removeEventListener("tdsf:spaces-overview", onOverview);
    };
  }, []);

  const handleSpaceCreated = useCallback(
    (space: SpaceMeta, sshSessionId?: string) => {
      setActiveSpaceForNewTabs(space.id);
      if (space.env.kind === "ssh" && sshSessionId) {
        // 2026-09-01 修复（配对 SpaceCreateDialog 先建区后连接的时序）：
        // connect-success 订阅可能已自动补建 shell tab——已存在同绑定的
        // tab 时直接激活，不再重复创建（否则一个工作区出两个 shell）。
        const existing = tabsRef.current.find(
          (t) =>
            t.spaceId === space.id &&
            t.kind === "terminal" &&
            t.sshSessionId === sshSessionId,
        );
        if (existing) {
          setActiveId(existing.id);
        } else {
          const tabId = newTabInSpace(space.id, space.root ?? undefined);
          updateTab(tabId, {
            sshSessionId,
            // 用户钦定 2026-08-28: SSH tab 固定叫 "shell"（与 bindTabToSshSpace 一致）
            customTitle: "shell",
          });
          setActiveId(tabId);
        }
      } else if (space.env.kind === "wsl") {
        // TDSF 魔改 2026-08-28: WSL Space 首终端不带 cwd（cwd=null 时 Rust 端
        // build_wsl 用 `--cd ~` 落在 WSL home；传 activeCwd 本地路径反而错误）
        const tabId = newTab(undefined);
        setActiveId(tabId);
      } else {
        // TDSF 修复 2026-08-31: 用新 Space 自己的 root（创建对话框已保证是
        // 本地路径），不再继承 activeCwd——当前激活 tab 是 SSH/WSL 终端时
        // activeCwd 是远程路径，会让新本地工作区的第一个终端跑错目录。
        const tabId = newTab(space.root ?? undefined);
        setActiveId(tabId);
      }
      useSpaces.getState().setActive(space.id);
    },
    [
      newTab,
      newTabInSpace,
      setActiveId,
      setActiveSpaceForNewTabs,
      updateTab,
    ],
  );

  const handleDeleteSpace = useCallback(
    (id: string) => {
      // TDSF 修复 2026-08-31（用户实测：关工作区不关 SSH 连接 → 残留会话把
      // 后续新建的工作区污染成 SSH）：删除前取出该 Space 绑定的 SSH 会话，
      // 若无其他 Space 共用同一会话则一并断开（连接随工作区一起关闭）。
      const spacesState = useSpaces.getState();
      const doomed = spacesState.spaces.find((s) => s.id === id);
      const doomedSessionId =
        doomed?.env.kind === "ssh" ? doomed.env.sessionId : undefined;
      const stillShared =
        !!doomedSessionId &&
        spacesState.spaces.some(
          (s) =>
            s.id !== id &&
            s.env.kind === "ssh" &&
            s.env.sessionId === doomedSessionId,
        );
      const nextSpaceId = spacesState.remove(id);
      if (doomedSessionId && !stillShared) {
        void useSshStore.getState().disconnect(doomedSessionId);
      }
      if (!nextSpaceId) {
        // TDSF 修复 2026-08-01: 最后一个工作区删除 → 清空 tabs 进入欢迎界面
        clearTabs();
        return;
      }
      const root = useSpaces
        .getState()
        .spaces.find((s) => s.id === nextSpaceId)?.root;
      removeTabsForSpace(id, nextSpaceId, root ?? undefined);
    },
    [removeTabsForSpace, clearTabs],
  );

  const handleMoveTab = useCallback(
    (tabId: number, targetSpaceId: string) => {
      if (moveTabToSpace(tabId, targetSpaceId)) {
        useSpaces.getState().setActive(targetSpaceId);
      }
    },
    [moveTabToSpace],
  );

  const handleReorderTab = useCallback(
    (tabId: number, targetTabId: number, edge: "top" | "bottom") => {
      if (reorderTab(tabId, targetTabId, edge)) {
        const target = tabsRef.current.find((x) => x.id === targetTabId);
        if (target) useSpaces.getState().setActive(target.spaceId);
      }
    },
    [reorderTab],
  );

  const handleNewTabInSpace = useCallback(
    (spaceId: string) => {
      const space = useSpaces.getState().spaces.find((s) => s.id === spaceId);
      const root = space?.root;
      // newTabInSpace 内部已按 Space env 绑定有效 sshSessionId（幽灵 id 有校验）
      const tabId = newTabInSpace(spaceId, root ?? undefined);
      if (space?.env.kind === "ssh" && space.env.sessionId) {
        // TDSF 用户钦定 2026-08-28: SSH tab 固定叫 "shell"
        updateTab(tabId, { customTitle: "shell" });
      }
    },
    [newTabInSpace, updateTab],
  );

  const jumpToTab = useCallback(
    (tabId: number) => {
      const t = tabsRef.current.find((x) => x.id === tabId);
      if (!t) return;
      setActiveId(tabId);
      useSpaces.getState().setActive(t.spaceId);
      setSwitcherOpen(false);
    },
    [setActiveId],
  );

  const spaceSwitcher = (
    <SpaceSwitcher
      open={switcherOpen}
      onOpenChange={setSwitcherOpen}
      tabs={tabs}
      onNewSpace={() => void handleNewSpace()}
      onDeleteSpace={handleDeleteSpace}
      onNewTabInSpace={handleNewTabInSpace}
      onJumpTab={jumpToTab}
      onCloseTab={handleClose}
      onMoveTabToSpace={handleMoveTab}
      onReorderTab={handleReorderTab}
      onReorderSpaces={(ids) => useSpaces.getState().reorder(ids)}
    />
  );

  const commandPaletteItems = useMemo(
    () =>
      commandPaletteOpen
        ? createCommandItems({
            tabs,
            activeId,
            searchTarget,
            explorerRoot,
            home,
            openNewTab,
            openNewEditor: () => setNewEditorOpen(true),
            toggleSourceControl,
            closeActiveTabOrPane: handleCloseTabOrPane,
            splitPaneRight: () => splitActivePaneInActiveTab("row"),
            splitPaneDown: () => splitActivePaneInActiveTab("col"),
            focusSearch: () => searchInlineRef.current?.focus(),
            focusExplorerSearch: () => explorerRef.current?.focusSearch(),
            toggleSidebar,
            toggleAi: togglePanelAndFocus,
            askAiSelection: askFromSelection,
            openSettings: () => void openSettingsWindow(),
            openKeyboardShortcuts: () => void openSettingsWindow("shortcuts"),
            spaces: useSpaces.getState().spaces,
            activeSpaceId,
            // TDSF 修复 2026-08-01: SSH 空间隐藏本地专属命令（网页预览）
            isSshSpace: activeSpace?.env.kind === "ssh",
            openSpacesOverview: () => setSwitcherOpen(true),
            newSpace: () => void handleNewSpace(),
            switchSpace: (id) => useSpaces.getState().setActive(id),
          })
        : [],
    [
      commandPaletteOpen,
      tabs,
      activeId,
      searchTarget,
      explorerRoot,
      home,
      openNewTab,
      toggleSourceControl,
      handleCloseTabOrPane,
      splitActivePaneInActiveTab,
      toggleSidebar,
      togglePanelAndFocus,
      askFromSelection,
      activeSpaceId,
      handleNewSpace,
      activeSpace,
    ],
  );

  const pendingGotoLine = useRef<Map<number, number>>(new Map());
  const openContentHit = useCallback(
    (path: string, line: number) => {
      const id = openFileTab(path, true);
      if (id == null) return;
      const h = editorRefs.current.get(id);
      if (h) h.gotoLine(line);
      else pendingGotoLine.current.set(id, line);
    },
    [openFileTab],
  );

  useEffect(() => {
    setLspNavigator({ openFile: openContentHit });
    return () => setLspNavigator(null);
  }, [openContentHit]);

  const insertHistoryCommand = useMemo(
    () =>
      isTerminalTab && activeLeafId !== null
        ? (cmd: string) => {
            writeToSession(activeLeafId, cmd);
            terminalRefs.current.get(activeLeafId)?.focus();
          }
        : null,
    [isTerminalTab, activeLeafId],
  );

  // TDSF 魔改 2026-08-11 (P2 代码片段管理): 片段插入终端回调
  // 语义与 insertHistoryCommand 一致：写入当前活动终端 + 聚焦；无活动终端返回 false
  const handleInsertSnippetCommand = useCallback(
    (cmd: string): boolean => {
      if (!isTerminalTab || activeLeafId === null) return false;
      writeToSession(activeLeafId, cmd);
      terminalRefs.current.get(activeLeafId)?.focus();
      return true;
    },
    [isTerminalTab, activeLeafId],
  );

  useAiLiveBridge({
    setLive,
    activeId,
    tabs,
    explorerRoot,
    launchCwd,
    home,
    openPreviewTab,
    newAgentTab,
    terminalRefs,
    // TDSF 魔改 (2026-08-09): 传 SSH 终端 leafId，让 getTerminalContext
    // 在 SSH 场景下也能读到终端 scrollback（SSH 终端不在 tabs 数组里）
    getSshLeafId: () => sshActiveLeafIdRef.current,
  });

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          {/* TDSF 魔改: 单层顶栏（整合 TdsfTitlebar 项目名/4Agent/主题切换/mood 到 Header） */}
          {!zenMode && (
            <Header
              tabs={spaceTabs}
              activeId={activeId}
              onSelect={setActiveId}
              onNew={openNewTab}
              onNewEditor={() => setNewEditorOpen(true)}
              onClose={handleClose}
              onPin={pinTab}
              onRename={handleRenameTab}
              onReorder={reorderTabByGap}
              onToggleSidebar={toggleSidebar}
              onOpenCommandPalette={() => openCommandPalette("commands")}
              onActivateAgent={onActivateAgent}
              onActivateLocalAgent={onActivateLocalAgent}
              onOpenSettings={() => void openSettingsWindow()}
              spaceSwitcher={spaceSwitcher}
              searchTarget={searchTarget}
              searchRef={searchInlineRef}
              onOverrideLanguage={setOverrideLanguage}
            />
          )}

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1"
            >
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarRef}
                defaultSize={
                  initialSidebarCollapsed
                    ? "0px"
                    : `${sidebarWidthRef.current}px`
                }
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                collapsible
                collapsedSize={0}
                onResize={(size) => {
                  if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                  persistSidebarCollapsed(size.inPixels <= 0);
                }}
              >
                <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                  <div
                    key={sidebarView}
                    className="min-h-0 flex-1 tdsf-panel-in"
                  >
                    {/* TDSF 魔改 2026-07-28: 包裹 ErrorBoundary, 防止 SshConnectDialog
                       等组件在 mock 模式抛错时把整个 root 清空. */}
                    <ErrorBoundary>
                      {sidebarView === "explorer" ? (
                        // TDSF 修复 2026-08-01: 无任何工作区时资源管理器显示
                        // "新建工作区"引导（保留侧栏骨架，用户可看清整体功能）
                        spaceCount === 0 ? (
                          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
                            <div className="text-[13px] font-medium text-foreground">
                              暂无工作区
                            </div>
                            <p className="text-[12px] leading-relaxed text-muted-foreground">
                              点击右侧工作区的「新建本地工作区」或「连接 SSH
                              服务器」开始使用；也可使用 Skills 面板与 AI
                              智能体。
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setSpaceCreateMode("local");
                                setSpaceCreateOpen(true);
                              }}
                              className="mt-1 rounded-md border border-border bg-card px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted"
                            >
                              新建工作区
                            </button>
                          </div>
                        ) : (
                        <div className="flex h-full min-h-0 flex-col">
                          <div className="min-h-0 flex-1">
                          <FileExplorer
                            ref={explorerRef}
                            rootPath={effectiveExplorerRoot}
                            fsSource={
                              // TDSF 魔改 2026-08-28: SSH 判定与 effectiveExplorerRoot 同源
                              // （都要求 env.kind === "ssh"），消除断开瞬间
                              // "rootPath 已回退本地 Windows 路径 × fsSource 仍是 sftp"
                              // 的抖动窗口（validate_sftp_path 报 invalid_path）。
                              explorerSource === "ssh" &&
                              activeSpace?.env.kind === "ssh" &&
                              spaceSshSession?.rustSessionId != null
                                ? {
                                    kind: "sftp",
                                    sessionId: spaceSshSession.rustSessionId,
                                    root: spaceSshCurrentPath ?? "/",
                                  }
                                : { kind: "local" }
                            }
                            gitStatus={
                              explorerSource === "local" &&
                              explorerGitDecorations
                                ? sourceControl.status
                                : null
                            }
                            activeFilePath={
                              explorerSource === "local"
                                ? explorerActiveFilePath
                                : null
                            }
                            onOpenFile={
                              explorerSource === "ssh"
                                ? handleOpenRemoteFile
                                : handleOpenFile
                            }
                            onPathRenamed={
                              explorerSource === "ssh"
                                ? undefined
                                : handlePathRenamed
                            }
                            onPathDeleted={
                              explorerSource === "ssh"
                                ? undefined
                                : handlePathDeleted
                            }
                            onRevealInTerminal={
                              explorerSource === "ssh" ? undefined : cdInNewTab
                            }
                            onAttachToAgent={
                              explorerSource === "ssh"
                                ? handleAttachRemoteFileToAgent
                                : handleAttachFileToAgent
                            }
                            pathDropTarget={
                              explorerSource === "ssh"
                                ? undefined
                                : terminalPathDropTarget
                            }
                          />
                          </div>
                          {/* TDSF 魔改 2026-07-30: 远程文件编辑器已废弃，
                             远程文件点击改走主区 EditorStack（与本地文件同一套 CodeMirror + tab 流程），
                             侧栏只保留 FileExplorer（文件树），不再内嵌 SshFileEditor。 */}
                        </div>
                        )
                      ) : sidebarView === "source-control" ? (
                        <SourceControlPanel
                          open
                          sourceControl={sourceControl}
                          onOpenDiff={openGitDiffTab}
                          onOpenGitGraph={openGitGraphFromContext}
                          onOpenFile={handleOpenFile}
                          onNavigateToPath={cdInNewTab}
                        />
                      ) : sidebarView === "skills" ? (
                        // TDSF 魔改 (P4-T4.4): Skill 管理面板
                        <SkillsPanel />
                      ) : sidebarView === "knowledge" ? (
                        // P2-4: 知识库浏览器（搜索/列表/详情弹窗，lazy 加载）
                        <KnowledgePanelLazy />
                      ) : sidebarView === "snippets" ? (
                        // TDSF 魔改 2026-08-11 (P2 代码片段管理): 代码片段面板
                        <SnippetsPanel
                          onInsertCommand={handleInsertSnippetCommand}
                          currentCwd={activeTerminalLeafCwd ?? undefined}
                        />
                      ) : sidebarView === "tunnels" ? (
                        // TDSF 魔改 2026-08-11 (P2 SSH 隧道): SSH 隧道面板
                        <TunnelPanel />
                      ) : null}
                    </ErrorBoundary>
                  </div>
                  <SidebarRail
                    activeView={sidebarView}
                    onSelectView={persistSidebarView}
                    changedCount={sourceControl.changedCount}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="relative min-h-0 flex-1">
                    {/* TDSF 修复 2026-08-01: 无工作区时终端区域显示欢迎（保留
                        侧栏/顶栏/状态栏，用户可看清整体功能）；否则正常工作区 */}
                    {spaceCount === 0 ? (
                      <WelcomeScreen
                        onCreateLocal={() => {
                          setSpaceCreateMode("local");
                          setSpaceCreateOpen(true);
                        }}
                        onCreateWsl={() => {
                          // TDSF 魔改 2026-08-28（用户反馈）: WSL 加入欢迎页
                          setSpaceCreateMode("wsl");
                          setSpaceCreateOpen(true);
                        }}
                        onCreateSsh={() => {
                          setSpaceCreateMode("ssh");
                          setSpaceCreateOpen(true);
                        }}
                      />
                    ) : (
                    <WorkspaceSurface
                      tabs={tabs}
                      activeId={activeId}
                      activeTab={activeTab}
                      registerTerminalHandle={registerTerminalHandle}
                      onSearchReady={handleSearchReady}
                      onCwd={handleTerminalCwd}
                      onExit={handleLeafExit}
                      onFocusLeaf={handleFocusLeaf}
                      registerEditorHandle={registerEditorHandle}
                      onEditorDirtyChange={handleEditorDirty}
                      onEditorCloseTab={disposeTab}
                      registerPreviewHandle={registerPreviewHandle}
                      onPreviewUrlChange={handlePreviewUrl}
                      onAiDiffAccept={(id) => respondToApproval(id, true)}
                      onAiDiffReject={(id) => respondToApproval(id, false)}
                      onOpenCommitFile={openCommitFileDiffTab}
                      onGitHistorySearchHandle={setGitHistoryHandle}
                      onSetMarkdownView={setMarkdownView}
                      // TDSF 魔改 2026-07-28 (P1-A): 空状态页
                      showNoTerminalEmptyState={showNoTerminalEmptyState}
                      onWarmUpColdTab={warmUpTab}
                      onOpenAgentFromEmptyState={togglePanelAndFocus}
                      onSwitchToSshFromEmptyState={() => {
                        // TDSF 修复 2026-08-01: SSH 登录统一走新建工作区流程
                        setSpaceCreateMode("ssh");
                        setSpaceCreateOpen(true);
                      }}
                      // TDSF 魔改 2026-08-11 (#21): SSH 终端渲染已迁入 PaneTreeView
                      // leaf 级（TerminalStack 透传 tab.sshSessionId），不再需要
                      // workspace 级 SshTerminalHost 覆盖与 sshSessionId/allocId/
                      // onSshLeafId 透传。sshActiveLeafIdRef 改由 App 层派生 effect 维护。
                      sshConnectingInfo={sshConnectingInfo}
                    />
                    )}
                  </div>

                  <WorkspaceInputBar
                    isBlockTab={isBlockTab}
                    isTerminalTab={isTerminalTab}
                    activeLeafId={activeLeafId}
                    cwd={statusBarCwd}
                    home={home}
                    hasComposer={hasComposer}
                    panelOpen={panelOpen}
                    keysLoaded={keysLoaded}
                    onConnect={() => void openSettingsWindow("models")}
                  />
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </main>

          {/* TDSF 魔改 2026-08-18 (P1-6): 主机审批弹窗常驻顶层——任何视图
              首次连接未知主机都能弹审批框, 不依赖 SshExplorer 挂载 */}
          <HostApprovalDialog
            request={pendingApproval}
            onApprove={() => resolveApproval(true)}
            onReject={() => resolveApproval(false)}
          />

          {!zenMode && (
            <StatusBar
              cwd={statusBarCwd}
              filePath={activeFilePath}
              home={home}
              onCd={sendCd}
              onWorkspaceChange={handleWorkspaceChange}
              onWorkspaceSshClick={handleWorkspaceSshClick}
              workspaceSwitching={workspaceSwitching}
              onOpenMini={openMini}
              hasComposer={hasComposer}
              privateActive={
                activeTab?.kind === "terminal" && activeTab.private === true
              }
            />
          )}

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
          />
          <Toaster position="bottom-right" />

          {hasComposer ? (
            <>
              <AgentRunBridge
                openAiDiffTab={openAiDiffTab}
                closeAiDiffTab={closeAiDiffTab}
              />
              <LocalAgentNotificationsBridge />
            </>
          ) : null}

          {/* TDSF 魔改回退 (2026-07-30): 恢复上游 AiMiniWindow（Terax 视觉——
              AgentStatusPill + Context 圆环统计 + SessionPicker + ai-elements
              工具行/Reasoned 折叠），替代自研 TdsfAgentPanel（样式简陋已弃用）。 */}
          {hasComposer && miniPresence.mounted ? (
            <AiMiniWindow state={miniPresence.state} />
          ) : null}
          {askPresence.mounted ? (
            <SelectionAskAi
              state={askPresence.state}
              x={askPopup?.x ?? 0}
              y={askPopup?.y ?? 0}
              onAsk={onAskFromSelection}
              onDismiss={() => setAskPopup(null)}
              showTranslate={translateEnabled}
              onTranslate={onTranslateSelection}
            />
          ) : null}

          {switcherState && (
            <TabSwitcherHud tabs={spaceTabs} state={switcherState} />
          )}

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
            initialMode={paletteInitialMode}
            commandItems={commandPaletteItems}
            workspaceRoot={explorerRoot}
            onOpenContentHit={openContentHit}
            insertCommand={insertHistoryCommand}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <SpaceCreateDialog
            open={spaceCreateOpen}
            onOpenChange={setSpaceCreateOpen}
            // TDSF 修复 2026-08-31: 当前 Space 是 SSH 时 workspaceEnv 为 ssh——
            // 直接透传会让"新建本地工作区"创建出 env.kind=ssh 的幽灵 Space
            // （无会话可用 → 左侧资源管理器/终端行为按 SSH 判定但连不上）。
            // 本地模式只允许继承 local/WSL 环境。
            defaultEnv={
              workspaceEnv.kind === "ssh" ? LOCAL_WORKSPACE : workspaceEnv
            }
            // TDSF 修复 2026-08-31: 本地 Space 的默认根目录必须是本地路径——
            // activeCwd 在 SSH/WSL 终端下是远程 Linux 路径（/root 等），直接
            // 塞给新建本地工作区会让资源管理器打开无效路径（InvalidPath）。
            // 仅当前 Space 是本地时才继承 cwd，否则回退本地 home。
            defaultRoot={
              (activeSpace?.env.kind === "local" ? activeCwd : null) ??
              home ??
              null
            }
            initialMode={spaceCreateMode}
            onCreated={handleSpaceCreated}
          />

          <UpdaterDialog />

          {/* TDSF 魔改 2026-07-29: 终端翻译悬浮面板（全局挂载，fixed 定位）
              P2: 卡片带「Ask TDSF」操作，把选中词/代码片段发给 AI 深入解释 */}
          <TranslateTooltip onAsk={onAskWithSelection} />

          {/* TDSF 魔改 2026-08-09: 服务器实时监控仪表盘（右上角浮动面板，不遮挡 AI 对话） */}
          <ServerMonitorEntry />

          {/* TDSF B2 (2026-08-29): 可视教学打字机"演示中"状态条（顶部居中，事件驱动） */}
          <AgentTypingIndicator />

          {/* TDSF 魔改 2026-08-09: 终端命令预测弹窗（本地+SSH 统一，通过 rendererPool 注入） */}
          <TerminalCompletionPopup />

          <CloseDialogs
            tabs={tabs}
            pendingCloseTab={pendingCloseTab}
            onCancelClose={cancelClose}
            onConfirmClose={confirmClose}
            pendingTerminalCloseTab={pendingTerminalCloseTab}
            onCancelTerminalClose={cancelTerminalClose}
            onConfirmTerminalClose={confirmTerminalClose}
            pendingDeleteTabs={pendingDeleteTabs}
            onCancelDeleteClose={cancelDeleteClose}
            onConfirmDeleteClose={confirmDeleteClose}
            pendingAppClose={pendingAppClose}
            onCancelAppClose={cancelAppClose}
            onConfirmAppClose={confirmAppClose}
          />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return <AiComposerProvider>{shell}</AiComposerProvider>;
}