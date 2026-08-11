/**
 * snippets/lib/snippetStore.ts — 代码片段 store（Zustand + LazyStore 持久化）
 *
 * 存储：复用 @tauri-apps/plugin-store（LazyStore），与 settings 同模式。
 * dev 模式（无 Tauri 运行时）降级到 localStorage，保证面板可预览。
 *
 * 纯函数（collectPlaceholders / interpolate / sortSnippets）与 store 分离，
 * 便于单测（react-refresh 规范：组件/函数分离）。
 */
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { Snippet, SnippetVar } from "../types";

const STORE_PATH = "tdsf-snippets.json";
const LS_FALLBACK_KEY = "tdsf.snippets.cache";
const SNIPPETS_KEY = "snippets";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** 提取命令中所有 {{name}} 占位符（去重，保持出现顺序） */
export function collectPlaceholders(command: string): string[] {
  const found: string[] = [];
  const re = /\{\{\s*(\w+)\s*\}\}/g;
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
  return command.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, key: string) => {
    const v = values[key];
    return v !== undefined && v !== "" ? v : raw;
  });
}

/** Frecency 排序：使用次数降序 → 最近使用降序 → 创建时间降序 */
export function sortSnippets(list: Snippet[]): Snippet[] {
  return [...list].sort((a, b) => {
    if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
    const la = a.lastUsedAt ?? 0;
    const lb = b.lastUsedAt ?? 0;
    if (lb !== la) return lb - la;
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
    patch: Partial<Omit<Snippet, "id" | "createdAt" | "usageCount">>,
  ) => void;
  removeSnippet: (id: string) => void;
  /** 记录一次使用（Frecency 排序依据），返回新 usageCount */
  recordUsage: (id: string) => number;
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
      usageCount: 0,
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
  },

  recordUsage: (id) => {
    const now = Date.now();
    let next = 0;
    set((s) => ({
      snippets: s.snippets.map((sn) => {
        if (sn.id !== id) return sn;
        next = sn.usageCount + 1;
        return { ...sn, usageCount: next, lastUsedAt: now };
      }),
    }));
    void persist(get().snippets);
    return next;
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
