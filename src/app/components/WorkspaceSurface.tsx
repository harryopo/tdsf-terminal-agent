import type { SshSessionStateValue } from "@/store/runtime";
import { cn } from "@/lib/utils";
import { AiDiffStack, EditorStack, GitDiffStack } from "@/modules/editor";
import { GitHistoryStack } from "@/modules/git-history";
import { MarkdownStack } from "@/modules/markdown";
import { PreviewStack } from "@/modules/preview";
import { SshConnectingOverlay } from "@/modules/ssh-explorer/SshConnectingOverlay";
import { SshTerminalHost } from "@/modules/ssh-explorer/SshTerminalHost";
import type { Tab } from "@/modules/tabs";
import { TerminalStack } from "@/modules/terminal";
import { NoTerminalEmptyState } from "@/modules/terminal/NoTerminalEmptyState";
import type { ComponentProps } from "react";

type TerminalStackProps = ComponentProps<typeof TerminalStack>;
type EditorStackProps = ComponentProps<typeof EditorStack>;
type PreviewStackProps = ComponentProps<typeof PreviewStack>;
type AiDiffStackProps = ComponentProps<typeof AiDiffStack>;
type GitHistoryStackProps = ComponentProps<typeof GitHistoryStack>;

type Props = {
  tabs: Tab[];
  activeId: number;
  activeTab: Tab | undefined;
  registerTerminalHandle: TerminalStackProps["registerHandle"];
  onSearchReady: TerminalStackProps["onSearchReady"];
  onCwd: TerminalStackProps["onCwd"];
  onExit: TerminalStackProps["onExit"];
  onFocusLeaf: TerminalStackProps["onFocusLeaf"];
  registerEditorHandle: EditorStackProps["registerHandle"];
  onEditorDirtyChange: EditorStackProps["onDirtyChange"];
  onEditorCloseTab: EditorStackProps["onCloseTab"];
  registerPreviewHandle: PreviewStackProps["registerHandle"];
  onPreviewUrlChange: PreviewStackProps["onUrlChange"];
  onAiDiffAccept: AiDiffStackProps["onAccept"];
  onAiDiffReject: AiDiffStackProps["onReject"];
  onOpenCommitFile: GitHistoryStackProps["onOpenCommitFile"];
  onGitHistorySearchHandle: GitHistoryStackProps["onSearchHandle"];
  onSetMarkdownView: EditorStackProps["onSetMarkdownView"];

  // === TDSF 魔改 2026-07-28 (P1-A): 未连接 SSH 时显示空状态页 ===
  /** 当 default cold tab + 无 SSH 时, 渲染 NoTerminalEmptyState 替代 TerminalStack */
  showNoTerminalEmptyState?: boolean;
  /** 强行 warm 一个 cold tab, 启动本地 shell (从 NoTerminalEmptyState 调用) */
  onWarmUpColdTab?: (tabId: number) => void;
  /** 唤起 AI Agent 面板 (从 NoTerminalEmptyState 调用) */
  onOpenAgentFromEmptyState?: () => void;
  /** 切侧栏到 ssh 视图 (从 NoTerminalEmptyState 调用) */
  onSwitchToSshFromEmptyState?: () => void;

  // === TDSF 魔改 2026-07-28 (P1-D): SSH 终端接管右侧工作区 ===
  /** 当前活跃的 SSH 会话前端 id */
  sshSessionId?: string | null;
  /**
   * TDSF 魔改 (2026-08-09): SSH 连接进度信息。
   * 当 SSH 会话处于 connecting/handshaking/authenticating 等中间状态时，
   * 终端区域显示美观的连接进度界面（而非空状态引导页），
   * 让用户明确知道"正在连接"而非"终端坏了"。
   * SSH 连接成功后此值为 null，SshTerminalHost 接管渲染。
   */
  sshConnectingInfo?: {
    host: string;
    port: number;
    user: string;
    state: SshSessionStateValue;
  } | null;
  /**
   * TDSF 魔改 (#19): 分配稳定 leafId 的函数，透传给 SshTerminalHost。
   * 来自 useTabs.allocId（共享 nextIdRef 计数器，与本地 leaf 不撞号）。
   */
  allocId?: () => number;
  /**
   * 2026-07-31 翻译模块修复: SSH 终端挂载时上报 leafId，App 层用于
   * captureActiveSelection 感知 SSH 终端（SSH 终端不在 tab.paneTree 里）。
   */
  onSshLeafId?: (leafId: number | null) => void;
};

/**
 * Stacks every tab-kind surface absolutely on top of each other and toggles
 * visibility off the active tab, so panes keep their mounted state (terminal
 * buffers, editor scroll, ...) when switching tabs.
 */
export function WorkspaceSurface({
  tabs,
  activeId,
  activeTab,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
  registerEditorHandle,
  onEditorDirtyChange,
  onEditorCloseTab,
  registerPreviewHandle,
  onPreviewUrlChange,
  onAiDiffAccept,
  onAiDiffReject,
  onOpenCommitFile,
  onGitHistorySearchHandle,
  onSetMarkdownView,
  showNoTerminalEmptyState,
  onWarmUpColdTab,
  onOpenAgentFromEmptyState,
  onSwitchToSshFromEmptyState,
  sshSessionId,
  sshConnectingInfo,
  allocId,
  onSshLeafId,
}: Props) {
  const kind = activeTab?.kind;
  const isTerminalTab = kind === "terminal";
  const isEditorTab = kind === "editor";
  const isPreviewTab = kind === "preview";
  const isMarkdownTab = kind === "markdown";
  const isAiDiffTab = kind === "ai-diff";
  const isGitDiffTab = kind === "git-diff" || kind === "git-commit-file";
  const isGitHistoryTab = kind === "git-history";

  // TDSF 魔改 2026-07-28 (P1-A): 空状态页的可见性
  // 仅在 active tab 是 terminal 且 App 判定需要空状态时显示
  const showEmptyState = isTerminalTab && !!showNoTerminalEmptyState;

  // TDSF 魔改 2026-07-28 (P1-D): SSH 终端接管右侧工作区
  // 2026-07-29 重构: 仅在 active tab 是 terminal 时接管, 让 editor / preview /
  // ai-diff / git-history 等"特殊视图 tab"独立渲染。
  //
  // 原因: 用户明确需求"SSH 连接后, 左侧 = 子文件资源管理器, 右侧 = 终端,
  // 跟本地打开一模一样"。本地打开默认 active tab 就是 terminal, SSH 连接
  // 后保持这个布局:
  //   - active tab = terminal → 右侧显示 SshTerminalPane (接管)
  //   - active tab = editor / preview / ai-diff / git-history / markdown
  //     → 右侧显示对应的 tab 内容 (让位), 用户要看的是那个视图
  //
  // 边沿处理: SSH 自动连接成功时 App.tsx 已自动切 sidebarView 到 "ssh",
  // 用户在 SSH 视图下默认 active tab 仍是 terminal (跟本地一致),
  // 所以 SshTerminalPane 会立即接管右侧, 满足"打开就看到终端"的需求。
  const showSshTerminal = !!sshSessionId && isTerminalTab;

  // TDSF 魔改 (2026-08-09): SSH 连接进度界面——仅在终端 tab 且 SSH 尚未连接时显示
  const showSshConnecting =
    !!sshConnectingInfo && isTerminalTab && !showSshTerminal;

  return (
    <div className="relative h-full min-h-0">
      {/* === TDSF 魔改 2026-07-28 (P1-A): 空状态页 (覆盖在 terminal 之上) === */}
      {showEmptyState &&
      activeTab &&
      onWarmUpColdTab &&
      onOpenAgentFromEmptyState &&
      onSwitchToSshFromEmptyState ? (
        <div className="absolute inset-0 px-3 pt-2 pb-2">
          <NoTerminalEmptyState
            defaultTabId={activeTab.id}
            onWarmUp={onWarmUpColdTab}
            onOpenAgent={onOpenAgentFromEmptyState}
            onSwitchToSsh={onSwitchToSshFromEmptyState}
          />
        </div>
      ) : null}

      {/* === TDSF 魔改 (2026-08-09): SSH 连接进度界面 === */}
      {/* 渲染顺序：空状态页 → connecting overlay → SSH 终端 (后者覆盖前者)。
          SSH 连接成功后 showSshTerminal=true → showSshConnecting 自动 false,
          SshTerminalHost 在上层接管渲染, connecting overlay 自然被覆盖。
          用户核心诉求："终端流畅最优先，资源管理器异步加载不阻塞终端"。 */}
      {showSshConnecting && sshConnectingInfo ? (
        <div className="absolute inset-0">
          <SshConnectingOverlay
            host={sshConnectingInfo.host}
            port={sshConnectingInfo.port}
            user={sshConnectingInfo.user}
            state={sshConnectingInfo.state}
          />
        </div>
      ) : null}

      {/* === TDSF 魔改 2026-07-28 (P1-D): SSH 终端接管右侧工作区 === */}
      {/* 2026-07-30 (#19): SshTerminalPane → SshTerminalHost, 走本地 rendererPool,
          与本地终端同一套主题/字体/字号/保活, 不再独立渲染。 */}
      {showSshTerminal && sshSessionId && allocId ? (
        <div className="absolute inset-0 px-3 pt-2 pb-2">
          <SshTerminalHost
            sessionId={sshSessionId}
            allocId={allocId}
            className="h-full w-full overflow-hidden rounded-md border border-border/40"
            onLeafId={onSshLeafId}
            registerHandle={registerTerminalHandle}
          />
        </div>
      ) : null}

      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          // TDSF 修复 2026-08-08: 隐藏必须叠加 opacity-0 —— TerminalPane
          // 按内部 active 状态设 inline visibility:visible, 覆盖外层 invisible
          // 类, 导致 SSH 终端接管时本地终端内容仍显示 (盖在 SSH 之上,
          // 用户看到"本地桌面终端")。opacity 无继承覆盖问题, 强制整树透明。
          (!isTerminalTab || showEmptyState || showSshTerminal || showSshConnecting) &&
            "invisible opacity-0 pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerTerminalHandle}
          onSearchReady={onSearchReady}
          onCwd={onCwd}
          onExit={onExit}
          onFocusLeaf={onFocusLeaf}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isEditorTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isEditorTab}
      >
        <EditorStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={onEditorDirtyChange}
          onCloseTab={onEditorCloseTab}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isPreviewTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isPreviewTab}
      >
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={onPreviewUrlChange}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isMarkdownTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack
          tabs={tabs}
          activeId={activeId}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isAiDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isAiDiffTab}
      >
        <AiDiffStack
          tabs={tabs}
          activeId={activeId}
          onAccept={onAiDiffAccept}
          onReject={onAiDiffReject}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={onOpenCommitFile}
          onSearchHandle={onGitHistorySearchHandle}
        />
      </div>
    </div>
  );
}
