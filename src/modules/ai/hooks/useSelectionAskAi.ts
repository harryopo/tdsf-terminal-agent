import { useCallback, useEffect, useState } from "react";

type Params = {
  captureActiveSelection: () => string | null;
  askFromSelection: () => void;
};

/**
 * Tracks text selections inside the terminal / editor and surfaces the
 * selection popup at the pointer: 「翻译」+「Ask TDSF」.
 *
 * P2 (2026-08-01) 重构：
 * - 移除与翻译模块的"退让"协调（tdsf:translate-enabled/disabled/hit/miss
 *   事件与 translateActiveRef）——翻译与 Ask 现在共存于同一浮层，
 *   由用户点选，不再需要事件互相压制
 * - 本地终端与 SSH 终端统一走 captureActiveSelection（App 层按
 *   tab/leafId/sshActiveLeafId 取选中文本）
 */
export function useSelectionAskAi({
  captureActiveSelection,
  askFromSelection,
}: Params) {
  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-input-bar]") ||
        el.closest("[data-ai-mini-window]")
      );
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      const el = e.target as HTMLElement | null;
      const inContentArea = el?.closest?.(".xterm, .cm-editor");
      if (!inContentArea) return;
      // Defer one tick so xterm/CodeMirror finalize the selection.
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          setAskPopup({ x: e.clientX, y: e.clientY });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  return { askPopup, setAskPopup, onAskFromSelection };
}
