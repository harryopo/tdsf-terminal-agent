// TDSF 魔改 (P4-T4.4): Skill 系统 Zustand store
// -----------------------------------------------------------------------------
// 管理 skill 列表 + 加载状态 + 启用状态切换 + 调用历史。
//
// 设计要点:
//   - skills 列表由 loadSkills() 异步加载（IPC 失败时降级到 builtin）
//   - enabled 状态持久化到 localStorage（通过 registry.writeEnabledState）
//   - 调用历史保留最近 20 条，避免无限增长
//   - 错误状态用 error 字段，配合 retry 按钮展示

import { create } from "zustand";
import { invokeSkill } from "./executor";
import { loadSkills } from "./loader";
import { writeEnabledState } from "./registry";
import type { SkillCategory, SkillHistoryEntry, SkillMetadata } from "./types";

/** 调用历史最大保留条数 */
const MAX_HISTORY = 20;

/** 筛选分类 tab（"all" 表示全部） */
export type SkillFilterTab = "all" | SkillCategory;

interface SkillsState {
  // === 数据 ===
  /** 所有已加载的 skill */
  skills: SkillMetadata[];
  /** 加载中 */
  loading: boolean;
  /** 加载错误（IPC 失败时设置，配合 retry 按钮） */
  error: string | null;
  /** 是否已加载过（避免重复加载） */
  loaded: boolean;

  // === 筛选 ===
  /** 当前分类筛选 tab */
  filterTab: SkillFilterTab;
  /** 搜索关键词 */
  searchQuery: string;

  // === 调用 ===
  /** 调用历史（最近 20 条，新调用插入头部） */
  history: SkillHistoryEntry[];
  /** 当前正在调用的 skill 名（null 表示无） */
  invokingSkill: string | null;

  // === Actions ===
  /** 加载 skill 列表（强制刷新） */
  loadAll: () => Promise<void>;
  /** 切换分类筛选 tab */
  setFilterTab: (tab: SkillFilterTab) => void;
  /** 设置搜索关键词 */
  setSearchQuery: (q: string) => void;
  /** 切换 skill 启用状态（持久化到 localStorage） */
  toggleEnabled: (name: string) => void;
  /** 调用 skill（返回执行结果，同时写入历史） */
  invoke: (
    name: string,
    args: string,
  ) => Promise<{ success: boolean; output: string; durationMs: number }>;
}

/**
 * 获取筛选后的 skill 列表（按 filterTab + searchQuery）
 *
 * 纯函数，不修改 store，由组件 selector 调用。
 *
 * @param skills 全部 skill
 * @param tab 分类筛选
 * @param query 搜索关键词（匹配 name / description / tags）
 * @returns 筛选后的列表
 */
export function filterSkills(
  skills: SkillMetadata[],
  tab: SkillFilterTab,
  query: string,
): SkillMetadata[] {
  const q = query.trim().toLowerCase();
  return skills.filter((s) => {
    if (tab !== "all" && s.category !== tab) return false;
    if (!q) return true;
    if (s.name.toLowerCase().includes(q)) return true;
    if (s.description.toLowerCase().includes(q)) return true;
    if (s.tags?.some((t) => t.toLowerCase().includes(q))) return true;
    return false;
  });
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  // === 数据 ===
  skills: [],
  loading: false,
  error: null,
  loaded: false,

  // === 筛选 ===
  filterTab: "all",
  searchQuery: "",

  // === 调用 ===
  history: [],
  invokingSkill: null,

  // === Actions ===
  loadAll: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const skills = await loadSkills();
      set({ skills, loading: false, loaded: true, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({
        loading: false,
        loaded: true,
        error: `加载 Skill 列表失败: ${msg}`,
      });
    }
  },

  setFilterTab: (tab) => set({ filterTab: tab }),

  setSearchQuery: (q) => set({ searchQuery: q }),

  toggleEnabled: (name) => {
    const skills = get().skills;
    const updated = skills.map((s) => {
      if (s.name !== name) return s;
      const next = !s.enabled;
      writeEnabledState(name, next);
      return { ...s, enabled: next };
    });
    set({ skills: updated });
  },

  invoke: async (name, args) => {
    set({ invokingSkill: name });
    try {
      const result = await invokeSkill(name, args);
      const entry: SkillHistoryEntry = {
        timestamp: Date.now(),
        skillName: name,
        args,
        success: result.success,
        durationMs: result.durationMs,
        outputPreview: result.output.slice(0, 200),
      };
      const history = [entry, ...get().history].slice(0, MAX_HISTORY);
      set({ history });
      return result;
    } finally {
      set({ invokingSkill: null });
    }
  },
}));
