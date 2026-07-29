import { describe, expect, it } from "vitest";
import {
  getFontPresetByValue,
  isPresetFont,
  TERMINAL_FONT_PRESETS,
} from "./terminalFonts";

describe("TERMINAL_FONT_PRESETS", () => {
  it("starts with Auto-detect (empty value)", () => {
    expect(TERMINAL_FONT_PRESETS[0]?.value).toBe("");
    expect(TERMINAL_FONT_PRESETS[0]?.label).toBe("Auto-detect");
  });

  it("includes JetBrains Mono (upstream default) as the first non-auto preset", () => {
    // 上游 fallback 链首位是 "JetBrains Mono"；预设里必须排在最前，
    // 这样用户打开 Settings 默认就看到 JBM 选中。
    expect(TERMINAL_FONT_PRESETS[1]?.value).toBe("JetBrains Mono");
  });

  it("includes Windows 11 built-in Cascadia Code as a preset", () => {
    // Win11 内置无需安装，避免没装 JBM 时回退到 sans-serif。
    const found = TERMINAL_FONT_PRESETS.find(
      (p) => p.value === "Cascadia Code",
    );
    expect(found).toBeDefined();
  });

  it("has no duplicate value entries", () => {
    const values = TERMINAL_FONT_PRESETS.map((p) => p.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("has no duplicate label entries", () => {
    const labels = TERMINAL_FONT_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("isPresetFont", () => {
  it("returns true for empty string (Auto-detect)", () => {
    expect(isPresetFont("")).toBe(true);
  });

  it("returns true for known preset values", () => {
    expect(isPresetFont("JetBrains Mono")).toBe(true);
    expect(isPresetFont("Cascadia Code")).toBe(true);
    expect(isPresetFont("Consolas")).toBe(true);
  });

  it("returns false for unknown fonts (custom mode)", () => {
    expect(isPresetFont("My Hand-Picked Font")).toBe(false);
    expect(isPresetFont("CaskaydiaCove Nerd Font Mono")).toBe(false);
  });
});

describe("getFontPresetByValue", () => {
  it("resolves a known preset to its full record", () => {
    const hit = getFontPresetByValue("JetBrains Mono");
    expect(hit?.label).toBe("JetBrains Mono");
    expect(hit?.hint).toBe("Recommended");
  });

  it("resolves the Auto-detect entry (empty value)", () => {
    const hit = getFontPresetByValue("");
    expect(hit?.label).toBe("Auto-detect");
  });

  it("returns undefined for unknown fonts (signals custom mode to UI)", () => {
    expect(getFontPresetByValue("Comic Sans MS")).toBeUndefined();
  });
});
