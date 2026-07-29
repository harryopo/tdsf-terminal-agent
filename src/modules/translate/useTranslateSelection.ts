/**
 * 终端选词翻译 Hook
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 开启翻译后，鼠标松开时捕获终端选中文本，
 * 走离线词典 translateText，命中则在鼠标位置弹出释义悬浮框。
 */
import { useEffect } from "react";
import { translateText } from "./translateApi";
import { useTranslateStore } from "./translateStore";

interface UseTranslateSelectionOptions {
  /** 捕获当前激活终端/编辑器的选中文本（App 顶层提供） */
  captureActiveSelection: () => string | null;
  /** 翻译开关 */
  enabled: boolean;
}

/** 选中文本超过该长度不做词典翻译（避免整段选择触发） */
const MAX_SELECTION_LENGTH = 64;

export function useTranslateSelection({
  captureActiveSelection,
  enabled,
}: UseTranslateSelectionOptions): void {
  useEffect(() => {
    if (!enabled) {
      useTranslateStore.getState().hideTooltip();
      return;
    }

    const onMouseUp = (e: MouseEvent) => {
      // 延迟到 selection 更新之后再取
      window.setTimeout(() => {
        const text = captureActiveSelection()?.trim() ?? "";
        const store = useTranslateStore.getState();
        if (!text || text.length > MAX_SELECTION_LENGTH) {
          store.hideTooltip();
          return;
        }
        const result = translateText(text);
        if (result.success) {
          store.showTooltip(result, e.clientX, e.clientY);
        } else {
          store.hideTooltip();
        }
      }, 0);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") useTranslateStore.getState().hideTooltip();
    };

    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, captureActiveSelection]);
}
