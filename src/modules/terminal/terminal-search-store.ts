/**
 * terminal-search-store — 终端搜索浮层开关状态（B1-G4，TDSF 魔改 2026-08-28）
 *
 * App 全局快捷键（terminal.find）与 TerminalPane 渲染层解耦：
 * handler 写 openLeafId，TerminalPane 订阅并渲染 TerminalSearchBar。
 */
import { create } from "zustand";

type TerminalSearchState = {
  /** 打开搜索浮层的 leafId；null = 全部关闭 */
  openLeafId: number | null;
  open: (leafId: number) => void;
  close: (leafId: number) => void;
};

export const useTerminalSearchStore = create<TerminalSearchState>((set) => ({
  openLeafId: null,
  open: (leafId) => set({ openLeafId: leafId }),
  close: (leafId) =>
    set((s) => (s.openLeafId === leafId ? { openLeafId: null } : s)),
}));
