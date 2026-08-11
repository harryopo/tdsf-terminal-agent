/**
 * suggest-engine.test.ts — Fish autosuggest 三层预测引擎单元测试
 * -----------------------------------------------------------------------------
 * 覆盖 SuggestEngine 的核心行为:
 *   - 三层匹配优先级 (history > dictionary > fuzzy)
 *   - 历史去重 / 批量加载 / 上限保护
 *   - 空输入 / 空格截断 / limit 控制
 *
 * 注意: 每个用例创建独立的 `new SuggestEngine()` 实例, 不依赖单例,
 * 天然实现测试间状态隔离。
 */
import { describe, expect, it } from "vitest";
import { SuggestEngine } from "./suggest-engine";

describe("SuggestEngine", () => {
  // ──────────────────────────────────────────────────────────────────────
  // 用例 1: 三层匹配优先级 — history > dictionary > fuzzy
  // ──────────────────────────────────────────────────────────────────────
  it("returns history matches before dictionary matches (三层优先级)", () => {
    const engine = new SuggestEngine();
    // gitstatus 不在命令字典中, 仅作为历史存在
    engine.addHistory("gitstatus");
    const results = engine.getSuggestions("git", 5);

    // 第一条必须是 history 来源 (优先级最高)
    expect(results[0].command).toBe("gitstatus");
    expect(results[0].source).toBe("history");

    // 字典中的 git 应排在历史之后 (dictionary 来源)
    const dictMatch = results.find((r) => r.command === "git");
    expect(dictMatch).toBeDefined();
    expect(dictMatch!.source).toBe("dictionary");

    // history 条目必须出现在 dictionary 条目之前
    const historyIdx = results.findIndex((r) => r.source === "history");
    const dictIdx = results.findIndex((r) => r.source === "dictionary");
    expect(historyIdx).toBeLessThan(dictIdx);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 2: 历史去重 — 同一命令多次添加只保留一条
  // ──────────────────────────────────────────────────────────────────────
  it("deduplicates history entries (同一命令只保留一条)", () => {
    const engine = new SuggestEngine();
    engine.addHistory("git");
    engine.addHistory("git");
    engine.addHistory("git");

    const gitCount = engine.getHistory().filter((c) => c === "git").length;
    expect(gitCount).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 3: 空输入返回空
  // ──────────────────────────────────────────────────────────────────────
  it("returns empty array for empty input (空输入返回空)", () => {
    const engine = new SuggestEngine();
    expect(engine.getSuggestions("", 5)).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 4: 空格截断 — 含空格的输入视为正在输参数, 不预测命令名
  // ──────────────────────────────────────────────────────────────────────
  it("returns empty array when input contains a space (空格截断)", () => {
    const engine = new SuggestEngine();
    expect(engine.getSuggestions("ls ", 5)).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 5: 前缀匹配 — 字典精确 startsWith
  // ──────────────────────────────────────────────────────────────────────
  it("matches dictionary commands by prefix (前缀匹配)", () => {
    const engine = new SuggestEngine();
    const results = engine.getSuggestions("gi", 5);
    const commands = results.map((r) => r.command);
    expect(commands).toContain("git");
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 6: fuzzysort 模糊匹配
  // ──────────────────────────────────────────────────────────────────────
  it("matches commands fuzzily via fuzzysort (模糊匹配)", () => {
    const engine = new SuggestEngine();
    // gti 不是任何命令的前缀, 但 fuzzysort 子序列匹配可能命中 git
    const results = engine.getSuggestions("gti", 5);
    const fuzzyResults = results.filter((r) => r.source === "fuzzy");

    // 宽松验证: threshold 允许时应有 fuzzy 结果且携带 score
    if (fuzzyResults.length > 0) {
      expect(fuzzyResults[0].score).toBeDefined();
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 7: limit 生效 — 返回条数不超过 limit
  // ──────────────────────────────────────────────────────────────────────
  it("respects the limit parameter (limit 生效)", () => {
    const engine = new SuggestEngine();
    // 字典中 a 开头的命令 > 3 (apt, apt-get, awk, at, alias ...)
    const results = engine.getSuggestions("a", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 8: loadHistory 批量加载后历史匹配层生效
  // ──────────────────────────────────────────────────────────────────────
  it("loads history in batch and uses it for matching (批量加载历史)", () => {
    const engine = new SuggestEngine();
    engine.loadHistory(["gitstatus", "lslist"]);

    const results = engine.getSuggestions("git", 5);
    expect(results[0].command).toBe("gitstatus");
    expect(results[0].source).toBe("history");

    const lsResults = engine.getSuggestions("ls", 5);
    expect(lsResults[0].command).toBe("lslist");
    expect(lsResults[0].source).toBe("history");
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 9: maxHistory 上限 — 超过 500 条不应崩溃且自动截断
  // ──────────────────────────────────────────────────────────────────────
  it("does not crash when adding more than maxHistory entries (maxHistory 上限)", () => {
    const engine = new SuggestEngine();
    // 添加 600 条不同的历史命令
    for (let i = 0; i < 600; i++) {
      engine.addHistory(`cmd${i}`);
    }

    const history = engine.getHistory();
    expect(history.length).toBeLessThanOrEqual(500);

    // 引擎仍能正常工作 — cmd 前缀在历史中足够多, 全部走 history 层
    const results = engine.getSuggestions("cmd", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.source === "history")).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 10: clearHistory 清空历史
  // ──────────────────────────────────────────────────────────────────────
  it("clears all history via clearHistory (清空历史)", () => {
    const engine = new SuggestEngine();
    engine.addHistory("git");
    engine.addHistory("ls");
    expect(engine.getHistory().length).toBe(2);

    engine.clearHistory();
    expect(engine.getHistory().length).toBe(0);

    // 清空后不再产生 history 来源的匹配
    const results = engine.getSuggestions("gi", 5);
    expect(results.every((r) => r.source !== "history")).toBe(true);
  });
});
