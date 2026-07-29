/* types.ts — TDSF 主题类型定义 (源自 terax-ai, Apache-2.0)
 * -----------------------------------------------------------------------------
 * 复用自: terax-ai/src/modules/theme/types.ts
 * License: Apache-2.0, Copyright 2026 Crynta
 * 适配: 移除编辑器主题部分(TDSF不集成CodeMirror),保留终端+UI主题
 */

export type ThemeMode = "light" | "dark";

export type ThemeColors = Partial<{
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarPrimary: string;
  sidebarPrimaryForeground: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  sidebarBorder: string;
  sidebarRing: string;
  radius: string;
}>;

export type TerminalPalette = Partial<{
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  ansi: readonly [
    string, string, string, string, string, string, string, string,
    string, string, string, string, string, string, string, string,
  ];
}>;

export type ThemeVariant = {
  colors?: ThemeColors;
  terminal?: TerminalPalette;
};

export type Theme = {
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** 编辑器 (CodeMirror) 主题映射: 按亮/暗模式指定编辑器主题 id */
  editorTheme?: {
    light?: string;
    dark?: string;
  };
  variants: {
    light?: ThemeVariant;
    dark?: ThemeVariant;
  };
};

export const DEFAULT_THEME_ID = "terax-default";
