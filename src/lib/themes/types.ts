/**
 * types.ts — 终端主题类型定义
 * -----------------------------------------------------------------------------
 * 职责: 定义 TerminalTheme 接口, 与 xterm.js ITheme 16 色对齐
 * 设计: 主题颜色直接用 hex 值 (主题本身就是颜色定义, 不走 CSS 变量)
 */

/** 主题分类 */
export type ThemeCategory = 'dark' | 'light' | 'colorful' | 'minimal';

/**
 * 终端主题接口 — 与 xterm.js ITheme 16 色对齐
 * 每个主题文件默认导出一个此接口的实现
 */
export interface TerminalTheme {
  /** 主题唯一标识 (kebab-case, 如 'dracula') */
  readonly name: string;
  /** 展示名称 (如 'Dracula') */
  readonly displayName: string;
  /** 分类 (dark/light/colorful/minimal) */
  readonly category: ThemeCategory;
  /** 前景色 */
  readonly foreground: string;
  /** 背景色 */
  readonly background: string;
  /** 光标颜色 */
  readonly cursor: string;
  /** 光标强调色 (光标内文字色) */
  readonly cursorAccent: string;
  /** 选区背景色 */
  readonly selectionBackground: string;
  /** ANSI 黑 */
  readonly black: string;
  /** ANSI 红 */
  readonly red: string;
  /** ANSI 绿 */
  readonly green: string;
  /** ANSI 黄 */
  readonly yellow: string;
  /** ANSI 蓝 */
  readonly blue: string;
  /** ANSI 品红 */
  readonly magenta: string;
  /** ANSI 青 */
  readonly cyan: string;
  /** ANSI 白 */
  readonly white: string;
  /** ANSI 亮黑 */
  readonly brightBlack: string;
  /** ANSI 亮红 */
  readonly brightRed: string;
  /** ANSI 亮绿 */
  readonly brightGreen: string;
  /** ANSI 亮黄 */
  readonly brightYellow: string;
  /** ANSI 亮蓝 */
  readonly brightBlue: string;
  /** ANSI 亮品红 */
  readonly brightMagenta: string;
  /** ANSI 亮青 */
  readonly brightCyan: string;
  /** ANSI 亮白 */
  readonly brightWhite: string;
}

/** 主题元数据 (listThemes 返回的轻量描述) */
export interface ThemeMeta {
  readonly name: string;
  readonly displayName: string;
  readonly category: ThemeCategory;
  /** 主色预览 (用于缩略图色块, 取 background) */
  readonly background: string;
  /** 前景色预览 */
  readonly foreground: string;
  /** 是否为自定义主题 (用户导入) */
  readonly custom?: boolean;
}
