/**
 * 终端翻译开关 + 悬浮框状态
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 选词翻译（离线词典）
 */
import { create } from "zustand";
import type { TranslationResult } from "./translateApi";

interface TranslateTooltipState {
  /** 翻译结果（null = 不显示） */
  result: TranslationResult | null;
  /** 悬浮框位置（视口坐标） */
  x: number;
  y: number;
}

interface TranslateState extends TranslateTooltipState {
  /** 终端翻译总开关（Ctrl+Shift+T / Header "译" 按钮） */
  enabled: boolean;
  toggleEnabled: () => void;
  setEnabled: (enabled: boolean) => void;
  showTooltip: (result: TranslationResult, x: number, y: number) => void;
  hideTooltip: () => void;
}

export const useTranslateStore = create<TranslateState>((set) => ({
  enabled: false,
  result: null,
  x: 0,
  y: 0,
  toggleEnabled: () =>
    set((s) => ({ enabled: !s.enabled, result: s.enabled ? null : s.result })),
  setEnabled: (enabled) => set({ enabled, ...(enabled ? {} : { result: null }) }),
  showTooltip: (result, x, y) => set({ result, x, y }),
  hideTooltip: () => set({ result: null }),
}));
