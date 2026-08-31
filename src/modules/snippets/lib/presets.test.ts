/**
 * presets.test.ts — 内置预置片段数据与补种逻辑测试
 *
 * 覆盖：
 *   1. 数据完整性：id 前缀、必填字段、中文解释、tags 非空
 *   2. computePresetsToSeed：首启全量种入 / 已存在不覆盖 / 已删除不复活 / 混合场景
 */
import { describe, expect, it } from "vitest";
import type { Snippet } from "../types";
import {
  computePresetsToSeed,
  PRESET_ID_PREFIX,
  PRESET_SNIPPETS,
} from "./presets";

describe("PRESET_SNIPPETS — 数据完整性", () => {
  it("每条内置片段都有 preset- 前缀 id 与必填字段", () => {
    for (const p of PRESET_SNIPPETS) {
      expect(p.id.startsWith(PRESET_ID_PREFIX)).toBe(true);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.command.length).toBeGreaterThan(0);
      expect(p.description).toBeTruthy();
      expect(p.tags.length).toBeGreaterThan(0);
    }
  });

  it("id 无重复（补种按 id 去重的前提）", () => {
    const ids = PRESET_SNIPPETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("变量片段的 variables 与命令占位符一一对应", () => {
    for (const p of PRESET_SNIPPETS) {
      const placeholders = [
        ...p.command.matchAll(/\{\{\s*([\w\u4e00-\u9fa5]+)\s*\}\}/g),
      ].map((m) => m[1]);
      expect(p.variables.map((v) => v.name)).toEqual(placeholders);
    }
  });

  it("覆盖用户点名的三类：环境感知 / 状态监控 / 定时任务", () => {
    const tags = new Set(PRESET_SNIPPETS.flatMap((p) => p.tags));
    expect(tags.has("环境感知")).toBe(true);
    expect(tags.has("状态监控")).toBe(true);
    expect(tags.has("定时任务")).toBe(true);
  });
});

describe("computePresetsToSeed — 补种逻辑", () => {
  it("空列表 → 全量种入", () => {
    expect(computePresetsToSeed([], [])).toEqual(PRESET_SNIPPETS);
  });

  it("已存在的内置片段不重复种入（用户编辑过也不覆盖）", () => {
    const edited: Snippet = {
      ...PRESET_SNIPPETS[0],
      command: "用户改过的命令",
    };
    const seeded = computePresetsToSeed([edited], []);
    expect(seeded.some((p) => p.id === edited.id)).toBe(false);
    expect(seeded.length).toBe(PRESET_SNIPPETS.length - 1);
  });

  it("用户删除过的内置片段不再种入（不复活）", () => {
    const deletedId = PRESET_SNIPPETS[1].id;
    const seeded = computePresetsToSeed([], [deletedId]);
    expect(seeded.some((p) => p.id === deletedId)).toBe(false);
    expect(seeded.length).toBe(PRESET_SNIPPETS.length - 1);
  });

  it("混合场景：部分已存在 + 部分已删除，只补缺失且未删除的", () => {
    const kept = PRESET_SNIPPETS[0];
    const deleted = PRESET_SNIPPETS[1];
    const seeded = computePresetsToSeed([kept], [deleted.id]);
    expect(seeded.every((p) => p.id !== kept.id && p.id !== deleted.id)).toBe(
      true,
    );
    expect(seeded.length).toBe(PRESET_SNIPPETS.length - 2);
  });
});
