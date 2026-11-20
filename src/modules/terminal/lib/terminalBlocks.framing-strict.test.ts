/**
 * CAP-02（ROOT 2026-11-20 独立反例）：633;F 字段必须严格解析。
 *
 * 反例：`1junk` / `1.5` / `01x` 被 `parseInt` 接受为 1，导致畸形证据
 * 被当成“完整单一简单命令”，进入失败纠错与成功学习。
 * 本测试先于修复落库（RED），修复后保持 GREEN。
 */
import { describe, expect, it } from "vitest";

import { TerminalBlockCollector, type TerminalBlock } from "./terminalBlocks";

function settle(events: string[]): TerminalBlock[] {
  const blocks: TerminalBlock[] = [];
  const collector = new TerminalBlockCollector({
    sessionId: 7,
    onBlock: (b) => blocks.push(b),
  });
  for (const event of events) collector.handle633(event);
  collector.handle133("D;0");
  return blocks;
}

const E = "E;printf ROOT;nonce";

describe("633;F 严格字段解析（CAP-02）", () => {
  it.each(["1junk", "1.5", "01x", " 1", "+1", "1e3", "", "0", "-1"])(
    "畸形/越界段数 %j 不得认证为完整",
    (seg) => {
      const blocks = settle([E, `F;${seg};1;nonce`]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].commandComplete).not.toBe(true);
      // 畸形“新证据”必须显式拒绝，不能悄悄退回旧 shell 的 undefined 学习路径。
      expect(blocks[0].commandComplete).toBe(false);
    },
  );

  it.each(["01", "true", "yes", "", "2", " 1"])(
    "非严格 valid=%j 不得认证为完整",
    (valid) => {
      const blocks = settle([E, `F;1;${valid};nonce`]);
      expect(blocks[0].commandComplete).toBe(false);
    },
  );

  it("nonce 不一致或缺失时拒绝", () => {
    expect(settle([E, "F;1;1;other"]).at(0)?.commandComplete).toBe(false);
    expect(settle([E, "F;1;1"]).at(0)?.commandComplete).toBe(false);
  });

  it("E 未携带 nonce 时，F 自带 nonce 也不得认证", () => {
    const blocks = settle(["E;printf ROOT", "F;1;1;nonce"]);
    expect(blocks.at(0)?.commandComplete).toBe(false);
  });

  it("额外字段不得认证", () => {
    expect(settle([E, "F;1;1;nonce;extra"]).at(0)?.commandComplete).toBe(false);
  });

  it("合法 F 正向控制：单命令仍为 true", () => {
    expect(settle([E, "F;1;1;nonce"]).at(0)?.commandComplete).toBe(true);
    // 复合：段数 2 / valid 0 → false
    expect(settle([E, "F;2;0;nonce"]).at(0)?.commandComplete).toBe(false);
  });

  it("第一份标记为准：后续冲突标记不覆盖", () => {
    expect(settle([E, "F;1;1;nonce", "F;1;0;nonce"]).at(0)?.commandComplete).toBe(true);
    expect(settle([E, "F;1;0;nonce", "F;1;1;nonce"]).at(0)?.commandComplete).toBe(false);
  });

  it("旧 shell（没有 F）保持 undefined，不误判为不可信", () => {
    const blocks = settle([E]);
    expect(blocks.at(0)?.commandComplete).toBeUndefined();
  });

  it("迟到 F（命令已结算）不影响任何 block", () => {
    const blocks: TerminalBlock[] = [];
    const collector = new TerminalBlockCollector({
      sessionId: 7,
      onBlock: (b) => blocks.push(b),
    });
    collector.handle633(E);
    collector.handle133("D;0");
    collector.handle633("F;1;1;nonce");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].commandComplete).toBeUndefined();
  });
});
