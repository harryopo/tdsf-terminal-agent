/**
 * translateApi.test.ts — 翻译 API 命中/未命中/拆分测试
 *
 * 2026-07-31 新增：验证 translateText 在 Linux 命令、编程术语、复合词拆分、
 * 未命中场景下的行为，确保翻译模块核心逻辑正确。
 */
import { describe, it, expect } from "vitest";
import { translateText, translateBatch, TOTAL_DICT_SIZE } from "./translateApi";

describe("translateApi.translateText", () => {
  it("Linux 命令精确匹配命中", () => {
    const r = translateText("ls");
    expect(r.success).toBe(true);
    expect(r.source).toBe("ls");
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries[0].zh).toContain("列出");
  });

  it("Linux 命令大小写降级匹配", () => {
    const r = translateText("LS");
    expect(r.success).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0);
  });

  it("编程术语命中", () => {
    // 选一个编程词典里一定有的词
    const r = translateText("function");
    expect(r.success).toBe(true);
    expect(r.entries.length).toBeGreaterThan(0);
  });

  it("复合词 snake_case 拆分命中", () => {
    // try_except 这种复合词应拆分后命中 try 和 except（都在 Python 词典里）
    const r = translateText("try_except");
    expect(r.entries.length).toBeGreaterThan(0);
  });

  it("未命中文本返回 success=false", () => {
    const r = translateText("zzznotaword");
    expect(r.success).toBe(false);
    expect(r.entries.length).toBe(0);
  });

  it("空文本返回 success=true 但 entries 为空", () => {
    const r = translateText("");
    expect(r.success).toBe(true);
    expect(r.entries.length).toBe(0);
  });

  it("纯空白文本安全处理", () => {
    const r = translateText("   ");
    expect(r.success).toBe(true);
    expect(r.entries.length).toBe(0);
  });
});

describe("translateApi.translateBatch", () => {
  it("批量翻译保持顺序", () => {
    const results = translateBatch(["ls", "cd", "zzznotaword"]);
    expect(results.length).toBe(3);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(results[2].success).toBe(false);
  });
});

describe("translateApi.TOTAL_DICT_SIZE", () => {
  it("词典总条目大于 0", () => {
    expect(TOTAL_DICT_SIZE).toBeGreaterThan(0);
  });
});
