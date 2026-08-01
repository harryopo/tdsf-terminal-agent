import { describe, expect, it } from "vitest";
import { translateText } from "./translateApi";

describe("T3 ECDICT 词库增强", () => {
  it("高频常用词 give 命中", () => {
    const r = translateText("give");
    expect(r.success).toBe(true);
    expect(r.entries[0].zh).toContain("给");
  });
  it("计算机词 database 命中", () => {
    const r = translateText("database");
    expect(r.success).toBe(true);
    expect(r.entries[0].zh).toContain("数据");
  });
  it("变形词 gave → give（lemma 还原）", () => {
    const r = translateText("gave");
    expect(r.success).toBe(true);
    expect(r.entries[0].word).toContain("give");
  });
  it("不规则复数 teeth 精确命中（teeth 本身是词条，优先于 lemma）", () => {
    const r = translateText("teeth");
    expect(r.success).toBe(true);
    expect(r.entries[0].zh).toContain("牙");
  });

  it("gave 无独立词条时走 lemma → give", () => {
    const r = translateText("gave");
    expect(r.entries[0].word).toContain("give");
  });
  it("长词模糊提示（compilatio → compilation 近似）", () => {
    const r = translateText("compilatio");
    expect(r.success).toBe(true);
    expect(r.entries[0].tag).toBe("近似");
  });
  it("纯符号仍不翻译", () => {
    expect(translateText("/").success).toBe(false);
    expect(translateText(".").success).toBe(false);
  });
});
