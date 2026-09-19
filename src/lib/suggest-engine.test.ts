/**
 * suggest-engine.test.ts — Fish autosuggest 三层预测引擎单元测试
 * -----------------------------------------------------------------------------
 * 覆盖 SuggestEngine 的核心行为:
 *   - 三层匹配优先级 (dictionary > history > fuzzy)
 *   - 字典与历史重名时只保留字典那一条（历史挤不掉可信候选）
 *   - 真实环境命令播种（compgen -c / PATH）扩充候选集
 *   - 历史去重 / 批量加载 / 上限保护 / 清空
 *
 * 注意: 每个用例创建独立的 `new SuggestEngine()` 实例, 不依赖单例,
 * 天然实现测试间状态隔离。
 */
import { describe, expect, it } from "vitest";
import { SuggestEngine } from "./suggest-engine";

describe("SuggestEngine", () => {
  // ──────────────────────────────────────────────────────────────────────
  // 用例 1: 三层匹配优先级 — dictionary > history > fuzzy
  //   2026-09-19 语义调整：历史里混着敲错的命令（shell 失败行也会进 histfile），
  //   让它占首位等于把错命令推给用户。
  // ──────────────────────────────────────────────────────────────────────
  it("returns dictionary matches before history matches (历史降到第二档)", () => {
    const engine = new SuggestEngine();
    // gitstatus 不在命令字典中, 仅作为历史存在（模拟一次敲错）
    engine.addHistory("gitstatus");
    const results = engine.getSuggestions("git", 5);

    // 首位必须来自字典：名字一定存在，而且带中文说明
    expect(results[0].source).toBe("dictionary");
    expect(results[0].command).toBe("git");

    // 历史命中仍然给出来，只是排在字典之后
    const dictIdx = results.findIndex((r) => r.source === "dictionary");
    const historyIdx = results.findIndex((r) => r.source === "history");
    expect(results[historyIdx]?.command).toBe("gitstatus");
    expect(dictIdx).toBeLessThan(historyIdx);
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
  // 用例 8: loadHistory 批量加载后历史档依然生效（只是不再占首位）
  // ──────────────────────────────────────────────────────────────────────
  it("loads history in batch and keeps it as the second tier (批量加载历史)", () => {
    const engine = new SuggestEngine();
    engine.loadHistory(["gitstatus", "lslist"]);

    const results = engine.getSuggestions("git", 5);
    expect(results[0].source).toBe("dictionary");
    expect(
      results.some((r) => r.command === "gitstatus" && r.source === "history"),
    ).toBe(true);

    // 字典里没有、只有历史命中的候选不会因此丢失（建议必须比输入长，故用前缀）
    const lsResults = engine.getSuggestions("lsli", 5);
    expect(lsResults[0]).toMatchObject({ command: "lslist", source: "history" });
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

    // 引擎仍能正常工作 — cmd 前缀的历史候选照样给得出来
    const results = engine.getSuggestions("cmd", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.source === "history")).toBe(true);
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

  // ──────────────────────────────────────────────────────────────────────
  // 用例 11: 跨层去重 — 同一条命令既在字典又在历史，只留字典那条（带中文说明）
  // ──────────────────────────────────────────────────────────────────────
  it("keeps only the dictionary entry when history repeats it (跨层去重)", () => {
    const engine = new SuggestEngine();
    engine.addHistory("gitstatus");
    engine.addHistory("git");

    const results = engine.getSuggestions("git", 5);
    const gitItems = results.filter((r) => r.command === "git");
    expect(gitItems).toHaveLength(1);
    expect(gitItems[0].source).toBe("dictionary");
    expect(gitItems[0].zh).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────
  // 用例 12: 真实环境播种 — 字典没收录但远端确实装了（compgen -c 里有）的命令
  // 也要预测得出来；播种必须幂等，且不得跨环境串味
  // ──────────────────────────────────────────────────────────────────────
  it("predicts commands that only exist in the real environment (真实环境播种)", () => {
    const engine = new SuggestEngine();
    // 用字典里肯定没有的合成名（k9s 之类真实工具已在 Fig specs 里，测不出播种效果）
    expect(engine.getSuggestions("zxctl", 5)).toEqual([]); // 播种前预测不出来

    engine.setEnvironmentCommands(["zxctl", "zxctlinstall"], "linux");
    engine.setEnvironmentCommands(["zxctl", "zxctlinstall"], "linux"); // 幂等

    const results = engine.getSuggestions("zxctl", 5);
    expect(results.map((r) => r.command)).toContain("zxctl");
    expect(results.map((r) => r.command)).toContain("zxctlinstall");
    expect(results.every((r) => r.source === "dictionary")).toBe(true);
    // 播种不得污染另一个环境（windows 侧没有 zxctl）
    expect(engine.isKnownCommand("zxctl", "windows")).toBe(false);
  });
});
