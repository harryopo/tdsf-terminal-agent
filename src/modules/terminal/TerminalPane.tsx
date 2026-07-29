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
              />
            </div>
          </div>
          {riskGuardDialog}
        </>
      );
    }

    return (
      <>
        <div
          ref={containerRef}
          className="zoom-exempt h-full w-full"
          style={hideStyle}
        />
        {riskGuardDialog}
      </>
    );
  }),
);
