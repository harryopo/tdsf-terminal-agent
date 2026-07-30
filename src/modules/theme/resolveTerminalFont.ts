import type { Theme, ThemeMode } from "./types";

export type TerminalFont = {
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
};

export function resolveTerminalFont(
  preferences: TerminalFont,
  theme: Theme,
  mode: ThemeMode,
): TerminalFont {
  const variant =
    theme.variants[mode] ?? theme.variants.dark ?? theme.variants.light;
  const terminal = variant?.terminal;
  // TDSF 修复 2026-07-30: 用户偏好优先, 主题 variant 作为兜底默认值
  // 之前用 ?? (nullish coalescing) 让主题 variant 优先, 但 preferences.fontFamily
  // 默认是空字符串 "" (非 null/undefined), ?? 不会走右侧, 导致用户在 Settings
  // 改的字体被主题 variant 静默覆盖。改用 || (falsy OR): 空字符串/0 是 falsy 走右侧。
  // 优先级: 用户偏好 > 主题 variant > 默认值
  return {
    fontFamily: preferences.fontFamily || terminal?.fontFamily || "",
    fontWeight: preferences.fontWeight || terminal?.fontWeight || "normal",
    fontSize: preferences.fontSize || terminal?.fontSize || 14,
  };
}
