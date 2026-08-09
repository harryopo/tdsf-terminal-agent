import { describe, expect, it } from "vitest";
import { resolveFontFamily } from "./fonts";

// 上游 terax-ai v0.8.5 的 FALLBACK_CHAIN + TDSF 魔改（2026-08-09）：
// monospace 前插入无衬线中文字体链（微软雅黑/苹方/思源黑体），
// 避免 Windows 下 monospace 中文回退到宋体（衬线）。
const FALLBACK =
  '"JetBrains Mono", SFMono-Regular, Menlo, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

describe("resolveFontFamily", () => {
  it("quotes a bare family and appends the platform fallback", () => {
    expect(resolveFontFamily("JetBrainsMono Nerd Font")).toBe(
      `"JetBrainsMono Nerd Font", ${FALLBACK}`,
    );
  });

  it("does not double-quote an already-quoted family", () => {
    expect(resolveFontFamily('"Fira Code"')).toBe(`"Fira Code", ${FALLBACK}`);
  });

  it("passes a comma-separated stack through and still appends fallback", () => {
    expect(resolveFontFamily("Foo, Bar")).toBe(`Foo, Bar, ${FALLBACK}`);
  });

  it("strips stray internal quotes to avoid a malformed token", () => {
    expect(resolveFontFamily('Foo"Bar')).toBe(`"FooBar", ${FALLBACK}`);
  });

  it("trims surrounding whitespace before quoting", () => {
    expect(resolveFontFamily("  Hack Nerd Font  ")).toBe(
      `"Hack Nerd Font", ${FALLBACK}`,
    );
  });

  it("falls back to the platform mono chain for empty input", () => {
    // 与上游一致：空输入 → detectMonoFontFamily() → FALLBACK_CHAIN
    // （检测不到 Nerd Font 候选时直接返回 fallback）。
    expect(resolveFontFamily("")).toBe(FALLBACK);
    expect(resolveFontFamily("   ")).toBe(FALLBACK);
  });
});
