/**
 * 终端翻译开关 + 悬浮框状态
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 选词翻译（离线词典）
 *
 * 2026-07-31 修复：
 * - 新增 missing 状态：词典未命中时显示简洁提示，避免用户以为开关坏了
 * - tooltip 类型由 result 是否为 null + missing 标志联合判断
 */
import { create } from "zustand";
import type { TranslationResult } from "./translateApi";

// 2026-07-31 修复：翻译总开关持久化 + 默认开启。
// 此前 enabled 默认 false 且不落盘，每次重启都要重新点「译」，用户以为坏了。
const ENABLED_KEY = "tdsf.translate.enabled";

function readEnabled(): boolean {
  try {
    if (typeof window === "undefined") return true;
    const raw = window.localStorage.getItem(ENABLED_KEY);
    if (raw === null) return true; // 首次使用默认开启
    return raw === "1";
  } catch {
    return true;
  }
}

function persistEnabled(value: boolean): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
    }
  } catch {
    // 忽略（隐私模式 / storage 被禁用），不影响运行时开关
  }
}

interface TranslateTooltipState {
  /** 翻译结果（null = 不显示翻译命中） */
  result: TranslationResult | null;
  /** 词典未命中的原文（null = 不显示未找到提示） */
  missing: string | null;
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
  /** 显示"未找到"提示（词典未命中时使用） */
  showMissing: (text: string, x: number, y: number) => void;
  hideTooltip: () => void;
}

export const useTranslateStore = create<TranslateState>((set, get) => ({
  enabled: readEnabled(),
  result: null,
  missing: null,
  x: 0,
  y: 0,
  toggleEnabled: () => {
    const next = !get().enabled;
    persistEnabled(next);
    set((s) => ({
      enabled: next,
      result: next ? s.result : null,
      missing: next ? s.missing : null,
    }));
  },
  setEnabled: (enabled) => {
    persistEnabled(enabled);
    set({
      enabled,
      ...(enabled ? {} : { result: null, missing: null }),
    });
  },
  showTooltip: (result, x, y) => set({ result, missing: null, x, y }),
  showMissing: (text, x, y) => set({ result: null, missing: text, x, y }),
  hideTooltip: () => set({ result: null, missing: null }),
}));

// DEV 调试: 暴露 store 到 window，供 CDP 验证脚本使用 (参考 useTerminalSession __tdsfTerm)
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __tdsfTranslateStore?: typeof useTranslateStore }).__tdsfTranslateStore =
    useTranslateStore;
}

