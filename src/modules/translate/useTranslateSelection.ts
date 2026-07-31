/**
 * 终端选词翻译 Hook
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 开启翻译后，鼠标松开时捕获终端选中文本，
 * 走离线词典 translateText，命中则在鼠标位置弹出释义悬浮框。
 *
 * 2026-07-31 修复：
 * - 增加 .xterm / .cm-editor 区域限制（与 SelectionAskAi 一致）
 * - 未命中词典时弹"未找到"提示，避免用户以为开关坏了
 * - 命中词典时派发 tdsf:translate-hit 事件，让 SelectionAskAi 退让
 * - 通过 tdsf:translate-disabled 事件协调：translate 开启时禁用 AskTDSF 自动弹
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
      // 通知 AskTDSF：翻译已关闭，恢复自动弹
      window.dispatchEvent(new CustomEvent("tdsf:translate-disabled"));
      return;
    }

    // 通知 AskTDSF：翻译已开启，由翻译接管选中行为
    window.dispatchEvent(new CustomEvent("tdsf:translate-enabled"));

    const isInContentArea = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return !!el.closest?.(".xterm, .cm-editor");
    };

    const onMouseUp = (e: MouseEvent) => {
      // 区域限制：只在终端/编辑器内触发
      if (!isInContentArea(e.target)) {
        useTranslateStore.getState().hideTooltip();
        return;
      }
      // 延迟到 selection 更新之后再取
      window.setTimeout(() => {
        const text = captureActiveSelection()?.trim() ?? "";
        const store = useTranslateStore.getState();
        if (!text || text.length > MAX_SELECTION_LENGTH) {
          store.hideTooltip();
          return;
        }
        const result = translateText(text);
        if (result.success && result.entries.length > 0) {
          // 命中词典：显示翻译，通知 AskTDSF 退让
          store.showTooltip(result, e.clientX, e.clientY);
          window.dispatchEvent(
            new CustomEvent("tdsf:translate-hit", {
              detail: { x: e.clientX, y: e.clientY },
            }),
          );
        } else {
          // 未命中词典：显示"未找到"提示（让用户知道翻译模块在工作）
          store.showMissing(text, e.clientX, e.clientY);
          window.dispatchEvent(
            new CustomEvent("tdsf:translate-miss", {
              detail: { x: e.clientX, y: e.clientY },
            }),
          );
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
