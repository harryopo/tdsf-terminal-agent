import type { SshSessionStateValue } from "@/lib/ssh-bridge";
import { cn } from "@/lib/utils";
import { AiDiffStack, EditorStack, GitDiffStack } from "@/modules/editor";
import { GitHistoryStack } from "@/modules/git-history";
import { MarkdownStack } from "@/modules/markdown";
import { PreviewStack } from "@/modules/preview";
import { SshConnectingOverlay } from "@/modules/ssh-explorer/SshConnectingOverlay";
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
  // 2026-08-11 (#21): SSH 终端渲染已迁入 TerminalStack → PaneTreeView leaf 级，
  // 本组件不再接收 sshSessionId/allocId/onSshLeafId，也无需 SshTerminalHost 覆盖。
  /** 当 SSH 会话处于 connecting 等中间状态时，终端区域显示连接进度界面。 */
  sshConnectingInfo?: {
    host: string;
    port: number;
    user: string;
    state: SshSessionStateValue;
  } | null;
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
  sshConnectingInfo,
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

  // TDSF 魔改 2026-08-11 (#21): SSH 终端渲染已迁入 TerminalStack → PaneTreeView
  // leaf 级（SSH 叶子与本地叶子共用 PaneTree，支持分屏），本层不再做 workspace
  // 级 SshTerminalHost 覆盖。此处仅保留 SSH 连接中的进度界面：
  //   - 连接中: 显示 SshConnectingOverlay（覆盖在 TerminalStack 之上）
  //   - 连接成功: overlay 消失，TerminalStack 里的 SSH leaf 自动接管
  // 用户核心诉求："终端流畅最优先，资源管理器异步加载不阻塞终端"。
  const showSshConnecting = !!sshConnectingInfo && isTerminalTab;

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
      {/* 渲染顺序：空状态页 → connecting overlay → TerminalStack (后者覆盖前者)。
          SSH 连接成功后 overlay 消失，PaneTreeView 的 SSH leaf 接管渲染。
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

      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          // TDSF 修复 2026-08-08: 隐藏必须叠加 opacity-0 —— TerminalPane
          // 按内部 active 状态设 inline visibility:visible, 覆盖外层 invisible
          // 类, 导致 SSH 终端接管时本地终端内容仍显示 (盖在 SSH 之上,
          // 用户看到"本地桌面终端")。opacity 无继承覆盖问题, 强制整树透明。
          // 2026-08-11 (#21): showSshTerminal 已删除（SSH 渲染在 PaneTree 内）。
          (!isTerminalTab || showEmptyState || showSshConnecting) &&
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
