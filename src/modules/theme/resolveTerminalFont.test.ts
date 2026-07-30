import { describe, expect, it } from "vitest";
import { resolveTerminalFont, type TerminalFont } from "./resolveTerminalFont";
import type { Theme } from "./types";

const preferences: TerminalFont = {
  fontFamily: "JetBrains Mono",
  fontWeight: "normal",
  fontSize: 14,
};

// TDSF 修复 2026-07-30 (Bug 1): 用户偏好优先, 主题 variant 作为兜底默认值
// 之前 ?? 让主题 variant 优先, 用户在 Settings 改的字体被静默覆盖
// 改用 || (falsy OR): 空字符串/0 是 falsy 走右侧
// 优先级: 用户偏好 > 主题 variant > 默认值
describe("resolveTerminalFont", () => {
  it("user preferences take priority over theme variant when set", () => {
    const theme: Theme = {
      id: "custom-theme",
      name: "Custom",
      variants: {
        dark: {
          terminal: {
            fontFamily: "Iosevka",
            fontSize: 16,
          },
        },
      },
    };

    // 用户设了 JetBrains Mono, 主题设了 Iosevka → 用用户的 JetBrains Mono
    expect(resolveTerminalFont(preferences, theme, "dark")).toEqual({
      fontFamily: "JetBrains Mono",
      fontWeight: "normal",
      fontSize: 14,
    });
  });

  it("falls back to theme variant when user preference is empty string", () => {
    const theme: Theme = {
      id: "custom-theme",
      name: "Custom",
      variants: {
        dark: {
          terminal: {
            fontFamily: "Iosevka",
            fontWeight: "bold",
            fontSize: 16,
          },
        },
      },
    };

    // 用户未设字体 (空字符串), 主题设了 Iosevka → 用主题的 Iosevka
    const emptyPreferences: TerminalFont = {
      fontFamily: "",
      fontWeight: "",
      fontSize: 0,
    };
    expect(resolveTerminalFont(emptyPreferences, theme, "dark")).toEqual({
      fontFamily: "Iosevka",
      fontWeight: "bold",
      fontSize: 16,
    });
  });

  it("restores global preferences when the theme has no font values", () => {
    const theme: Theme = {
      id: "colors-only",
      name: "Colors only",
      variants: { dark: { terminal: { foreground: "#ffffff" } } },
    };

    expect(resolveTerminalFont(preferences, theme, "dark")).toEqual(
      preferences,
    );
  });

  it("uses the same variant fallback order as theme colors", () => {
    const theme: Theme = {
      id: "dark-only",
      name: "Dark only",
      variants: {
        dark: { terminal: { fontWeight: "bold" } },
      },
    };

    // 用户 fontWeight="normal" 非空, 优先于主题的 bold
    expect(resolveTerminalFont(preferences, theme, "light").fontWeight).toBe(
      "normal",
    );
  });

  it("theme fontWeight applies when user preference is empty", () => {
    const theme: Theme = {
      id: "dark-only",
      name: "Dark only",
      variants: {
        dark: { terminal: { fontWeight: "bold" } },
      },
    };

    // 用户 fontWeight="" (空), 主题设了 bold → 用主题的 bold
    const emptyWeightPrefs: TerminalFont = {
      fontFamily: "JetBrains Mono",
      fontWeight: "",
      fontSize: 14,
    };
    expect(
      resolveTerminalFont(emptyWeightPrefs, theme, "dark").fontWeight,
    ).toBe("bold");
  });
});
