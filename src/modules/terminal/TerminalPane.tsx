// TDSF 魔改: 接入 RiskGuardDialog (T2.2)
// 订阅 pendingRiskCommand，命中 L3+ 命令时弹出二次确认/拒绝对话框
import { RiskGuardDialog } from "@/lib/risk-engine/guard";
import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { BlockOverlay } from "./block/BlockOverlay";
import { BlockWatermark } from "./block/BlockWatermark";
import {
  cancelPendingRiskCommand,
  confirmPendingRiskCommand,
  focusLeafInput,
  getPendingRiskCommand,
  submitToLeaf,
  subscribePendingRiskCommand,
  useTerminalSession,
} from "./lib/useTerminalSession";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { useTerminalSearchStore } from "./terminal-search-store";
import { useErrorExplainStore } from "./block/errorExplainStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalTransport } from "./lib/pty-bridge";
import type { RiskRpcAssessment } from "@/lib/risk-engine/riskClient";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** Enable command-block decorations (OSC 133) for this terminal. */
  blocks?: boolean;
  // TDSF 魔改 (#17): SSH 传输注入 seam —— 由 SshTerminalHost 提供。
  // 若提供，useTerminalSession 走 SSH 分支，复用 rendererPool 渲染。
  openTransport?: (
    h: { onData: (b: Uint8Array) => void; onExit: (c: number) => void },
  ) => Promise<TerminalTransport>;
  // TDSF 魔改 (#17): remote 护栏标志，透传给 useTerminalSession。
  remote?: boolean;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export const TerminalPane = memo(
  forwardRef<TerminalPaneHandle, Props>(function TerminalPane(
    {
      leafId,
      visible,
      focused = true,
      initialCwd,
      blocks = false,
      openTransport,
      remote = false,
      onSearchReady,
      onExit,
      onCwd,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const downYRef = useRef<number | null>(null);
    const { resolvedMode, activeTheme } = useTheme();

    // TDSF 魔改: 订阅 pendingRiskCommand（L3+ 拦截的命令）
    const [pending, setPending] = useState<{
      text: string;
      assessment: RiskRpcAssessment;
    } | null>(null);
    useEffect(() => {
      const sync = () => setPending(getPendingRiskCommand(leafId));
      sync();
      return subscribePendingRiskCommand(leafId, sync);
    }, [leafId]);
    const onDialogConfirm = useCallback(
      () => confirmPendingRiskCommand(leafId),
      [leafId],
    );
    const onDialogCancel = useCallback(
      () => cancelPendingRiskCommand(leafId),
      [leafId],
    );

    const session = useTerminalSession({
      leafId,
      container: containerRef,
      visible,
      focused,
      initialCwd,
      blocks,
      // TDSF 魔改 (#17): 透传 SSH 传输注入与 remote 护栏。
      openTransport,
      remote,
      onSearchReady: (a) => onSearchReady?.(leafId, a),
      onExit: (c) => onExit?.(leafId, c),
      onCwd: (c) => onCwd?.(leafId, c),
    });

    useEffect(() => {
      // Defer one frame so CSS-variable token resolution sees the new class.
      const id = requestAnimationFrame(() => session.applyTheme());
      return () => cancelAnimationFrame(id);
    }, [resolvedMode, activeTheme, session]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => session.write(data),
        focus: () => session.focus(),
        getBuffer: (max?: number) => session.getBuffer(max),
        getSelection: () => session.getSelection(),
      }),
      [session],
    );

    const hideStyle = {
      visibility: visible ? ("visible" as const) : ("hidden" as const),
      pointerEvents: visible ? ("auto" as const) : ("none" as const),
    };

    const promptReady = session.blockMode === "prompt";

    // TDSF 魔改 2026-08-28 (B1-G3): Teach 开关控制"AI 解释"按钮渲染
    const teachEnabled = usePreferencesStore((s) => s.teachAgentEnabled);

    // TDSF 魔改: RiskGuardDialog（命中 L3+ 命令时弹出，AlertDialog 用 Portal 不影响布局）
    const riskGuardDialog = pending ? (
      <RiskGuardDialog
        open={true}
        onOpenChange={(next) => {
          if (!next) onDialogCancel();
        }}
        assessment={pending.assessment}
        command={pending.text}
        onConfirm={onDialogConfirm}
        onCancel={onDialogCancel}
      />
    ) : null;

    // TDSF 魔改 2026-08-28 (B1-G4): 终端内搜索浮层（Ctrl/Cmd+Shift+F 触发）
    const searchOpen = useTerminalSearchStore((s) => s.openLeafId) === leafId;
    const closeSearch = useCallback(
      () => useTerminalSearchStore.getState().close(leafId),
      [leafId],
    );
    const searchBar = (
      <TerminalSearchBar
        leafId={leafId}
        open={searchOpen}
        onClose={closeSearch}
      />
    );

    if (blocks) {
      return (
        <>
          <div
            className="zoom-exempt flex h-full w-full flex-col"
            style={hideStyle}
          >
            <div className="relative min-h-0 flex-1">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: terminal surface; pointer selects command blocks */}
              <div
                ref={containerRef}
                className="absolute inset-0 z-0"
                onMouseDown={(e) => {
                  downYRef.current = e.clientY;
                }}
                onMouseUp={(e) => {
                  const moved =
                    downYRef.current != null &&
                    Math.abs(e.clientY - downYRef.current) > 4;
                  downYRef.current = null;
                  if (!moved) session.selectBlockAt(e.clientY);
                  if (session.blockMode === "prompt") focusLeafInput(leafId);
                }}
              />
              <BlockWatermark
                leafId={leafId}
                subscribe={session.subscribeBlocks}
              />
              <BlockOverlay
                subscribe={session.subscribeBlocks}
                getVisible={session.visibleBlocks}
                readOutput={(id) => session.readBlockId(id)?.output ?? null}
                searchBlock={session.searchBlock}
                revealMatch={session.revealMatch}
                clearSearch={session.clearSearch}
                promptReady={promptReady}
                onRunAgain={(cmd) => submitToLeaf(leafId, cmd)}
                onRestoreFocus={() => {
                  if (session.blockMode === "prompt") focusLeafInput(leafId);
                }}
                // TDSF 魔改 2026-08-28 (B1-G3): 失败块"AI 解释"（手动触发，
                // Teach 开关关闭时不传回调 → 按钮不渲染）
                onExplainError={
                  teachEnabled
                    ? (block) => {
                        void useErrorExplainStore.getState().request({
                          blockId: block.id,
                          command: block.command,
                          exitCode: block.exitCode,
                          tail:
                            session.readBlockId(block.id)?.output ?? "",
                        });
                      }
                    : undefined
                }
              />
              {searchBar}
            </div>
          </div>
          {riskGuardDialog}
        </>
      );
    }

    return (
      <>
        <div className="relative h-full w-full" style={hideStyle}>
          <div
            ref={containerRef}
            className="zoom-exempt h-full w-full"
          />
          {searchBar}
        </div>
        {riskGuardDialog}
      </>
    );
  }),
);
