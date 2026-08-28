/**
 * preferences.test.ts — settings store 读取迁移测试（TDSF 魔改 2026-08-28）
 * -----------------------------------------------------------------------------
 * 覆盖 spec add-domestic-first-ai-config 的迁移语义：
 *   1. 无存储（全新用户）→ defaultModelId/sttProvider 用新默认（国产/本地优先）
 *   2. 已存合法值（如 gpt-5.4-mini）→ 原样保留，不被新默认覆盖
 *   3. 已存值不在模型目录（历史脏数据）→ isKnownModelId 白名单回退新默认
 *
 * loadPreferences 依赖 Tauri LazyStore；参照 tunnelStore.test.ts 模式
 * mock @tauri-apps/plugin-store + @tauri-apps/api/event，并用
 * __TAURI_INTERNALS__ 绕过 dev 降级分支（否则直接返回 DEFAULT_PREFERENCES）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 会提升到 import 之前——store.ts 顶层的 new LazyStore(...) 拿到的
// 就是这里的 fake 类，entries() 读取本 map。
const storage = vi.hoisted(() => ({ map: new Map<string, unknown>() }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries(): Promise<[string, unknown][]> {
      return [...storage.map.entries()];
    }
    async get(key: string): Promise<unknown> {
      return storage.map.get(key);
    }
    async set(key: string, value: unknown): Promise<void> {
      storage.map.set(key, value);
    }
    async save(): Promise<void> {}
    async onChange(): Promise<() => void> {
      return () => {};
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import { DEFAULT_MODEL_ID, DEFAULT_STT_PROVIDER } from "@/modules/ai/config";
import { loadPreferences } from "./store";

/** 模拟 Tauri 运行时存在/不存在（同 tunnelStore.test.ts） */
function setTauriRuntime(present: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (present) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

describe("loadPreferences — defaultModelId 迁移", () => {
  beforeEach(() => {
    storage.map.clear();
    setTauriRuntime(true);
  });

  it("全新用户（无存储）拿到国产新默认 deepseek-v4-flash", async () => {
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe("deepseek-v4-flash");
    expect(prefs.defaultModelId).toBe(DEFAULT_MODEL_ID);
  });

  it("老用户已选 gpt-5.4-mini → 原样保留（legacy 条目仍在目录）", async () => {
    storage.map.set("defaultModelId", "gpt-5.4-mini");
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe("gpt-5.4-mini");
  });

  it("已存值不在模型目录（脏数据）→ 回退新默认（isKnownModelId 防御）", async () => {
    storage.map.set("defaultModelId", "model-deleted-long-ago");
    const prefs = await loadPreferences();
    expect(prefs.defaultModelId).toBe(DEFAULT_MODEL_ID);
  });
});

describe("loadPreferences — sttProvider 迁移", () => {
  beforeEach(() => {
    storage.map.clear();
    setTauriRuntime(true);
  });

  it("全新用户默认 whispercpp（本地优先）", async () => {
    const prefs = await loadPreferences();
    expect(prefs.sttProvider).toBe("whispercpp");
    expect(prefs.sttProvider).toBe(DEFAULT_STT_PROVIDER);
  });

  it("老用户已选 openai 云端 STT → 原样保留", async () => {
    storage.map.set("sttProvider", "openai");
    const prefs = await loadPreferences();
    expect(prefs.sttProvider).toBe("openai");
  });
});
