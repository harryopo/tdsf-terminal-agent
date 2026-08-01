import { describe, expect, it } from "vitest";
import { translateText } from "./translateApi";

describe("P2-5 七级策略链", () => {
  it("路径 /etc 命中", () => {
    const r = translateText("/etc");
    expect(r.success).toBe(true);
    expect(r.entries[0].word).toContain("/etc");
  });
  it("选项 -l 命中", () => {
    const r = translateText("-l");
    expect(r.success).toBe(true);
  });
  it("命令 grep 命中并带 example", () => {
    const r = translateText("grep");
    expect(r.success).toBe(true);
    expect(r.entries[0].zh.length).toBeGreaterThan(0);
  });
  it("纯斜杠 / 不翻译", () => {
    const r = translateText("/");
    expect(r.success).toBe(false);
  });
  it("编程术语仍命中", () => {
    const r = translateText("array");
    expect(r.success).toBe(true);
  });
});
