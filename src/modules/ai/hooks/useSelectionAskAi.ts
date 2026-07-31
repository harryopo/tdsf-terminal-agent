import { useCallback, useEffect, useRef, useState } from "react";

type Params = {
  captureActiveSelection: () => string | null;
  askFromSelection: () => void;
};

/**
 * Tracks text selections inside the terminal / editor and surfaces the
 * "Ask AI" popup at the pointer. Dismisses on any click outside the AI surface.
 *
 * 2026-07-31 修复：
 * - 监听 tdsf:translate-enabled/disabled：翻译开关开启时，AskTDSF 不自动弹
 *   （用户主动开翻译意图明确，应由翻译接管选中行为）
 * - 监听 tdsf:translate-hit/miss：即使翻译开关因故没拦截，命中/未命中翻译
 *   事件到达后也立刻清除 AskTDSF popup，避免双重弹窗
 */
export function useSelectionAskAi({
  captureActiveSelection,
  askFromSelection,
}: Params) {
  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(
    null,
  );

  // 翻译开关是否开启（ref 避免 effect 重新订阅）
  const translateActiveRef = useRef(false);

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
      // 翻译开关开启时，由翻译 tooltip 接管，AskTDSF 不自动弹
      if (translateActiveRef.current) return;
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

    // 翻译开关事件：开启时禁用 AskTDSF 自动弹，关闭时恢复
    const onTranslateEnabled = () => {
      translateActiveRef.current = true;
      setAskPopup(null);
    };
    const onTranslateDisabled = () => {
      translateActiveRef.current = false;
    };
    // 翻译命中/未命中事件：兜底清除 AskTDSF popup，避免双重弹窗
    const onTranslateHit = () => setAskPopup(null);
    const onTranslateMiss = () => setAskPopup(null);

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    window.addEventListener("tdsf:translate-enabled", onTranslateEnabled);
    window.addEventListener("tdsf:translate-disabled", onTranslateDisabled);
    window.addEventListener("tdsf:translate-hit", onTranslateHit);
    window.addEventListener("tdsf:translate-miss", onTranslateMiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
      window.removeEventListener("tdsf:translate-enabled", onTranslateEnabled);
      window.removeEventListener("tdsf:translate-disabled", onTranslateDisabled);
      window.removeEventListener("tdsf:translate-hit", onTranslateHit);
      window.removeEventListener("tdsf:translate-miss", onTranslateMiss);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  return { askPopup, setAskPopup, onAskFromSelection };
}
