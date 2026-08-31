/**
 * snippets/lib/snippetStore.ts — 代码片段 store（Zustand + LazyStore 持久化）
 *
 * 存储：复用 @tauri-apps/plugin-store（LazyStore），与 settings 同模式。
 * dev 模式（无 Tauri 运行时）降级到 localStorage，保证面板可预览。
 *
 * 纯函数（collectPlaceholders / interpolate / sortSnippets）与 store 分离，
 * 便于单测（react-refresh 规范：组件/函数分离）。
 * 排序规则：置顶优先（最后置顶最靠上）→ 创建时间降序；点击插入不改变位置。
 */
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { Snippet, SnippetVar } from "../types";
import { computePresetsToSeed, PRESET_ID_PREFIX } from "./presets";

const STORE_PATH = "tdsf-snippets.json";
const LS_FALLBACK_KEY = "tdsf.snippets.cache";
const LS_PRESET_DELETED_KEY = "tdsf.snippets.presetsDeleted";
const SNIPPETS_KEY = "snippets";
/** 内置片段删除名单（LazyStore key）：删过就不复活 */
const PRESET_DELETED_KEY = "presetDeleted";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/**
 * 占位符变量名模式：英文/数字/下划线 + 中文（教学场景变量名用中文更友好，
 * JS 的 \w 不匹配中文，需显式加 \u4e00-\u9fa5）。
 */
const PLACEHOLDER_RE = /\{\{\s*([\w\u4e00-\u9fa5]+)\s*\}\}/g;

/** 提取命令中所有 {{name}} 占位符（去重，保持出现顺序） */
export function collectPlaceholders(command: string): string[] {
  const found: string[] = [];
  const re = new RegExp(PLACEHOLDER_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const name = m[1];
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** 变量插值：替换 {{name}} 占位符；缺失值保留原文 */
export function interpolate(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(
    new RegExp(PLACEHOLDER_RE.source, "g"),
    (raw, key: string) => {
      const v = values[key];
      return v !== undefined && v !== "" ? v : raw;
    },
  );
}

/**
 * 列表排序（稳定，不随使用跳动）：
 *   置顶优先，最后置顶的最靠上（pinnedAt 降序）→ 非置顶按创建时间降序（新建在前）。
 * 点击插入不改变任何片段的位置。
 */
export function sortSnippets(list: Snippet[]): Snippet[] {
  return [...list].sort((a, b) => {
    const pa = a.pinnedAt;
    const pb = b.pinnedAt;
    if (pa !== undefined && pb !== undefined) return pb - pa;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    return b.createdAt - a.createdAt;
  });
}

/** 读取已保存的片段列表（未持久化时为 null，用于首次初始化提示） */
function readPersisted(): Snippet[] | null {
  if (isTauriRuntime()) return null; // Tauri 路径由 hydrate() 异步加载
  try {
    const raw = window.localStorage.getItem(LS_FALLBACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Snippet[]) : null;
  } catch {
    return null;
  }
}

/** 读取内置片段删除名单（dev 降级走 localStorage） */
async function readPresetDeleted(): Promise<string[]> {
  try {
    if (isTauriRuntime()) {
      const raw = await store.get<string[]>(PRESET_DELETED_KEY);
      return Array.isArray(raw) ? raw : [];
    }
    const raw = window.localStorage.getItem(LS_PRESET_DELETED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** 追加内置片段删除名单并持久化（删过的内置片段重启后不复活） */
async function addPresetDeleted(id: string): Promise<void> {
  try {
    const list = await readPresetDeleted();
    if (list.includes(id)) return;
    const next = [...list, id];
    if (isTauriRuntime()) {
      await store.set(PRESET_DELETED_KEY, next);
      await store.save();
    } else {
      window.localStorage.setItem(LS_PRESET_DELETED_KEY, JSON.stringify(next));
    }
  } catch (e) {
    console.warn("[snippets] record preset deletion failed:", e);
  }
}

type SnippetsState = {
  snippets: Snippet[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addSnippet: (data: {
    name: string;
    command: string;
    description?: string;
    tags: string[];
    variables?: SnippetVar[];
  }) => Snippet;
  updateSnippet: (
    id: string,
    patch: Partial<Omit<Snippet, "id" | "createdAt">>,
  ) => void;
  removeSnippet: (id: string) => void;
  /** 置顶 / 取消置顶（列表按置顶先后排列，最后置顶的最靠上） */
  togglePin: (id: string) => void;
};

export const useSnippetsStore = create<SnippetsState>((set, get) => ({
  snippets: readPersisted() ?? [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    let list: Snippet[] = [];
    try {
      if (isTauriRuntime()) {
        const raw = await store.get<Snippet[]>(SNIPPETS_KEY);
        list = Array.isArray(raw) ? raw : [];
      } else {
        list = readPersisted() ?? [];
      }
    } catch (e) {
      console.warn("[snippets] hydrate failed, start empty:", e);
      list = [];
    }
    // 内置片段补种：首次使用时种入工具箱；用户删除过/已存在的不再动
    try {
      const deletedIds = await readPresetDeleted();
      const toSeed = computePresetsToSeed(list, deletedIds);
      if (toSeed.length > 0) {
        list = [...toSeed, ...list];
        void persist(list);
      }
    } catch (e) {
      console.warn("[snippets] preset seed failed:", e);
    }
    set({ snippets: list, hydrated: true });
  },

  addSnippet: (data) => {
    const now = Date.now();
    const snippet: Snippet = {
      id: crypto.randomUUID(),
      name: data.name.trim(),
      command: data.command,
      description: data.description?.trim() || undefined,
      tags: [...new Set(data.tags.map((t) => t.trim()).filter(Boolean))],
      variables: data.variables ?? [],
      createdAt: now,
      updatedAt: now,
    };
    set((s) => ({ snippets: [snippet, ...s.snippets] }));
    void persist(get().snippets);
    return snippet;
  },

  updateSnippet: (id, patch) => {
    set((s) => ({
      snippets: s.snippets.map((sn) =>
        sn.id === id
          ? {
              ...sn,
              ...patch,
              updatedAt: Date.now(),
              tags: patch.tags ? [...new Set(patch.tags)] : sn.tags,
            }
          : sn,
      ),
    }));
    void persist(get().snippets);
  },

  removeSnippet: (id) => {
    set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) }));
    void persist(get().snippets);
    // 内置片段被删除 → 记入名单，下次 hydrate 不再补种（不复活）
    if (id.startsWith(PRESET_ID_PREFIX)) void addPresetDeleted(id);
  },

  /** 置顶 / 取消置顶（列表按置顶先后排列，最后置顶的最靠上） */
  togglePin: (id) => {
    set((s) => ({
      snippets: s.snippets.map((sn) =>
        sn.id === id
          ? {
              ...sn,
              pinnedAt: sn.pinnedAt === undefined ? Date.now() : undefined,
            }
          : sn,
      ),
    }));
    void persist(get().snippets);
  },
}));

/** 持久化（Tauri → LazyStore；dev → localStorage 兜底） */
async function persist(list: Snippet[]): Promise<void> {
  try {
    if (isTauriRuntime()) {
      await store.set(SNIPPETS_KEY, list);
      await store.save();
    } else {
      window.localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(list));
    }
  } catch (e) {
    console.warn("[snippets] persist failed:", e);
  }
}
