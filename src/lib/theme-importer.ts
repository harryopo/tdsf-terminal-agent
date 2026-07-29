/**
 * theme-importer.ts — Tabby 主题导入器
 * -----------------------------------------------------------------------------
 * 职责:
 *   - parseTabbyTheme(json): 解析 tabby 主题 JSON, 转为 TerminalTheme
 *   - validateTheme(theme): 验证主题合法性, 返回错误列表
 *   - saveCustomTheme(theme): 持久化自定义主题 (委托 terminal-theme.ts)
 *
 * Tabby 主题 JSON 格式 (参考 https://github.com/Eugeny/tabby/wiki/Themes):
 *   {
 *     "name": "My Theme",
 *     "foreground": "#ffffff",
 *     "background": "#000000",
 *     "cursor": "#ffffff",
 *     "cursorColor": "#ffffff",      // 别名 (tabby 旧版)
 *     "selection": "#ffffff33",
 *     "colors": [                     // 16 色 ANSI 数组 (8 normal + 8 bright)
 *       "#000000", "#ff0000", "#00ff00", "#ffff00",
 *       "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
 *       "#666666", "#ff6666", "#66ff66", "#ffff66",
 *       "#6666ff", "#ff66ff", "#66ffff", "#ffffff"
 *     ]
 *   }
 *
 * 兼容性:
 *   - 同时支持 colors 数组 (16 色) 和 black/red/green/... 命名字段
 *   - cursorColor 作为 cursor 的别名
 *   - selectionBackground 作为 selection 的别名
 */
import type { TerminalTheme, ThemeCategory } from './themes';

/** Hex 颜色正则 (#rgb / #rrggbb / #rrggbbaa) */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** rgba 颜色正则 */
const RGBA_COLOR_RE = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+/;

/** Tabby JSON 原始结构 (宽松, 字段都可选) */
interface TabbyThemeJson {
  readonly name?: unknown;
  readonly foreground?: unknown;
  readonly background?: unknown;
  readonly cursor?: unknown;
  readonly cursorColor?: unknown;
  readonly cursorAccent?: unknown;
  readonly selection?: unknown;
  readonly selectionBackground?: unknown;
  readonly colors?: unknown;
  readonly black?: unknown;
  readonly red?: unknown;
  readonly green?: unknown;
  readonly yellow?: unknown;
  readonly blue?: unknown;
  readonly magenta?: unknown;
  readonly cyan?: unknown;
  readonly white?: unknown;
  readonly brightBlack?: unknown;
  readonly brightRed?: unknown;
  readonly brightGreen?: unknown;
  readonly brightYellow?: unknown;
  readonly brightBlue?: unknown;
  readonly brightMagenta?: unknown;
  readonly brightCyan?: unknown;
  readonly brightWhite?: unknown;
}

/**
 * 解析 tabby 主题 JSON 字符串, 转为 TerminalTheme
 * @param json - tabby 主题 JSON 字符串
 * @returns 解析后的 TerminalTheme
 * @throws Error 当 JSON 格式错误或缺少必要字段时
 */
export function parseTabbyTheme(json: string): TerminalTheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('主题必须是 JSON 对象');
  }

  const raw = parsed as TabbyThemeJson;

  // === name (必须) =========================================================
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error('主题缺少 name 字段或为空');
  }
  const displayName = raw.name.trim();
  const name = sanitizeThemeName(displayName);

  // === foreground / background (必须) ======================================
  const foreground = pickColor(raw.foreground);
  if (!foreground) throw new Error('主题缺少 foreground 字段或格式无效');
  const background = pickColor(raw.background);
  if (!background) throw new Error('主题缺少 background 字段或格式无效');

  // === cursor (可选, 默认 = foreground) ====================================
  const cursor = pickColor(raw.cursor) ?? pickColor(raw.cursorColor) ?? foreground;
  // === cursorAccent (可选, 默认 = background) ==============================
  const cursorAccent = pickColor(raw.cursorAccent) ?? background;
  // === selectionBackground (可选, 默认 = foreground 半透明) =================
  const selectionBackground =
    pickColor(raw.selectionBackground) ?? pickColor(raw.selection) ?? `${foreground}55`;

  // === 16 色 ANSI ===========================================================
  // 优先用 colors 数组, 其次用命名字段, 最后用合理默认
  const ansi = parseAnsiColors(raw);
  const {
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite,
  } = ansi;

  // === category 自动推断 ====================================================
  const category = inferCategory(background, foreground);

  return {
    name,
    displayName,
    category,
    foreground,
    background,
    cursor,
    cursorAccent,
    selectionBackground,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite,
  };
}

/**
 * 验证主题合法性
 * @param theme - 待验证的主题对象
 * @returns 错误消息数组 (空数组表示验证通过)
 */
export function validateTheme(theme: unknown): string[] {
  const errors: string[] = [];

  if (typeof theme !== 'object' || theme === null) {
    return ['主题必须是对象'];
  }

  const t = theme as Partial<TerminalTheme>;

  // === 必填字段检查 =========================================================
  if (typeof t.name !== 'string' || t.name.trim() === '') {
    errors.push('name 必须是非空字符串');
  } else if (!/^[a-z0-9-]+$/.test(t.name)) {
    errors.push('name 只能包含小写字母、数字和连字符 (kebab-case)');
  }

  if (typeof t.displayName !== 'string' || t.displayName.trim() === '') {
    errors.push('displayName 必须是非空字符串');
  }

  if (
    t.category !== 'dark' &&
    t.category !== 'light' &&
    t.category !== 'colorful' &&
    t.category !== 'minimal'
  ) {
    errors.push('category 必须是 dark/light/colorful/minimal 之一');
  }

  // === 颜色字段检查 =========================================================
  const colorFields: ReadonlyArray<keyof TerminalTheme> = [
    'foreground', 'background', 'cursor', 'cursorAccent', 'selectionBackground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ];
  for (const field of colorFields) {
    const val = t[field];
    if (typeof val !== 'string' || val.trim() === '') {
      errors.push(`${field} 必须是非空字符串`);
    } else if (!isValidColor(val)) {
      errors.push(`${field} 格式无效 (${val}), 需为 #hex 或 rgba()`);
    }
  }

  return errors;
}

// ============================================================================
// 内部工具函数
// ============================================================================

/**
 * 从未知值中提取颜色字符串 (hex 或 rgba)
 * @returns 颜色字符串, 无效返回 undefined
 */
function pickColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  if (HEX_COLOR_RE.test(trimmed) || RGBA_COLOR_RE.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * 检查颜色是否合法 (hex 或 rgba)
 */
function isValidColor(v: string): boolean {
  return HEX_COLOR_RE.test(v) || RGBA_COLOR_RE.test(v);
}

/**
 * 解析 16 色 ANSI — 优先 colors 数组, 其次命名字段, 最后默认
 */
function parseAnsiColors(raw: TabbyThemeJson): {
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
} {
  // 默认 ANSI (xterm 标准)
  const defaults = [
    '#000000', '#cc0000', '#4e9a06', '#c4a000',
    '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f',
    '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
  ];

  // 尝试从 colors 数组读取
  const colorsArr: string[] = [];
  if (Array.isArray(raw.colors)) {
    for (let i = 0; i < 16 && i < raw.colors.length; i++) {
      const c = pickColor(raw.colors[i]);
      colorsArr.push(c ?? defaults[i]);
    }
  }
  // 补齐到 16 个
  while (colorsArr.length < 16) {
    colorsArr.push(defaults[colorsArr.length]);
  }

  // 命名字段覆盖 (优先级高于 colors 数组)
  const named = [
    raw.black, raw.red, raw.green, raw.yellow,
    raw.blue, raw.magenta, raw.cyan, raw.white,
    raw.brightBlack, raw.brightRed, raw.brightGreen, raw.brightYellow,
    raw.brightBlue, raw.brightMagenta, raw.brightCyan, raw.brightWhite,
  ];

  const final: string[] = [];
  for (let i = 0; i < 16; i++) {
    const namedColor = pickColor(named[i]);
    final.push(namedColor ?? colorsArr[i] ?? defaults[i]);
  }

  return {
    black: final[0], red: final[1], green: final[2], yellow: final[3],
    blue: final[4], magenta: final[5], cyan: final[6], white: final[7],
    brightBlack: final[8], brightRed: final[9], brightGreen: final[10], brightYellow: final[11],
    brightBlue: final[12], brightMagenta: final[13], brightCyan: final[14], brightWhite: final[15],
  };
}

/**
 * 将 displayName 转为 kebab-case name
 * 例: "My Cool Theme" → "my-cool-theme"
 */
function sanitizeThemeName(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 根据 background/foreground 亮度推断分类
 * 亮背景 → light, 暗背景 → dark
 */
function inferCategory(background: string, _foreground: string): ThemeCategory {
  // 简单启发式: 解析 background 的亮度
  const hex = background.match(/^#([0-9a-fA-F]{6})/);
  if (!hex) return 'dark';
  const r = parseInt(hex[1].slice(0, 2), 16);
  const g = parseInt(hex[1].slice(2, 4), 16);
  const b = parseInt(hex[1].slice(4, 6), 16);
  // 相对亮度 (Rec. 709)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? 'light' : 'dark';
}
