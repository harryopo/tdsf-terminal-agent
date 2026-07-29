/**
 * theme-importer.test.ts — Tabby 主题解析 / 验证测试
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. parseTabbyTheme 解析合法 JSON (colors 数组 + 命名字段)
 *   2. parseTabbyTheme 解析失败场景 (非法 JSON / 缺少 name / 缺少 foreground)
 *   3. parseTabbyTheme 兼容 cursorColor / selection 别名
 *   4. parseTabbyTheme 自动推断 category (light / dark)
 *   5. validateTheme 验证合法主题通过
 *   6. validateTheme 验证非法主题返回对应错误
 */
import { describe, it, expect } from 'vitest';
import { parseTabbyTheme, validateTheme } from './theme-importer';
import type { TerminalTheme } from './themes';

/** 合法 tabby 主题 (colors 数组形式) */
const VALID_TABBY_JSON = `{
  "name": "My Cool Theme",
  "foreground": "#ffffff",
  "background": "#1d1f21",
  "cursor": "#ffffff",
  "selection": "#ffffff33",
  "colors": [
    "#000000", "#cc0000", "#4e9a06", "#c4a000",
    "#3465a4", "#75507b", "#06989a", "#d3d7cf",
    "#555753", "#ef2929", "#8ae234", "#fce94f",
    "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"
  ]
}`;

/** 合法 tabby 主题 (命名字段形式, 缺少 colors 数组) */
const VALID_TABBY_NAMED_JSON = `{
  "name": "Named Theme",
  "foreground": "#abcdef",
  "background": "#000000",
  "cursorColor": "#abcdef",
  "selectionBackground": "#123456",
  "black": "#000000",
  "red": "#ff0000",
  "green": "#00ff00",
  "yellow": "#ffff00",
  "blue": "#0000ff",
  "magenta": "#ff00ff",
  "cyan": "#00ffff",
  "white": "#ffffff",
  "brightBlack": "#666666",
  "brightRed": "#ff6666",
  "brightGreen": "#66ff66",
  "brightYellow": "#ffff66",
  "brightBlue": "#6666ff",
  "brightMagenta": "#ff66ff",
  "brightCyan": "#66ffff",
  "brightWhite": "#ffffff"
}`;

describe('theme-importer — parseTabbyTheme 解析', () => {
  it('解析合法 tabby JSON (colors 数组形式), 字段正确映射', () => {
    const theme = parseTabbyTheme(VALID_TABBY_JSON);

    // name 与 displayName
    expect(theme.name).toBe('my-cool-theme');
    expect(theme.displayName).toBe('My Cool Theme');

    // 前景 / 背景
    expect(theme.foreground).toBe('#ffffff');
    expect(theme.background).toBe('#1d1f21');

    // cursor / selectionBackground
    expect(theme.cursor).toBe('#ffffff');
    expect(theme.selectionBackground).toBe('#ffffff33');

    // ANSI 16 色 (从 colors 数组读取)
    expect(theme.black).toBe('#000000');
    expect(theme.red).toBe('#cc0000');
    expect(theme.green).toBe('#4e9a06');
    expect(theme.brightWhite).toBe('#eeeeec');

    // category 自动推断 (#1d1f21 是暗色 → dark)
    expect(theme.category).toBe('dark');
  });

  it('解析合法 tabby JSON (命名字段形式), 兼容 cursorColor / selectionBackground 别名', () => {
    const theme = parseTabbyTheme(VALID_TABBY_NAMED_JSON);

    expect(theme.name).toBe('named-theme');
    expect(theme.displayName).toBe('Named Theme');
    expect(theme.foreground).toBe('#abcdef');
    expect(theme.background).toBe('#000000');

    // cursorColor 别名应映射到 cursor
    expect(theme.cursor).toBe('#abcdef');
    // selectionBackground 字段应被识别
    expect(theme.selectionBackground).toBe('#123456');

    // 命名字段优先级高于默认值
    expect(theme.red).toBe('#ff0000');
    expect(theme.brightCyan).toBe('#66ffff');

    // #000000 背景是暗色 → dark
    expect(theme.category).toBe('dark');
  });

  it('亮色背景自动推断为 light 类别', () => {
    const lightThemeJson = `{
      "name": "Light Theme",
      "foreground": "#000000",
      "background": "#ffffff",
      "colors": [
        "#000000", "#cc0000", "#4e9a06", "#c4a000",
        "#3465a4", "#75507b", "#06989a", "#d3d7cf",
        "#555753", "#ef2929", "#8ae234", "#fce94f",
        "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"
      ]
    }`;
    const theme = parseTabbyTheme(lightThemeJson);
    expect(theme.category).toBe('light');
  });
});

describe('theme-importer — parseTabbyTheme 错误处理', () => {
  it('非法 JSON 抛出错误', () => {
    expect(() => parseTabbyTheme('{ invalid json')).toThrow(/JSON 解析失败/);
  });

  it('非对象 JSON (数组) 抛出错误', () => {
    expect(() => parseTabbyTheme('[1, 2, 3]')).toThrow(/必须是 JSON 对象/);
  });

  it('缺少 name 字段抛出错误', () => {
    const noName = `{"foreground": "#fff", "background": "#000"}`;
    expect(() => parseTabbyTheme(noName)).toThrow(/缺少 name 字段/);
  });

  it('name 为空字符串抛出错误', () => {
    const emptyName = `{"name": "  ", "foreground": "#fff", "background": "#000"}`;
    expect(() => parseTabbyTheme(emptyName)).toThrow(/缺少 name 字段/);
  });

  it('缺少 foreground 抛出错误', () => {
    const noFg = `{"name": "Test", "background": "#000"}`;
    expect(() => parseTabbyTheme(noFg)).toThrow(/缺少 foreground/);
  });

  it('缺少 background 抛出错误', () => {
    const noBg = `{"name": "Test", "foreground": "#fff"}`;
    expect(() => parseTabbyTheme(noBg)).toThrow(/缺少 background/);
  });

  it('foreground 颜色格式无效抛出错误', () => {
    const badColor = `{"name": "Test", "foreground": "not-a-color", "background": "#000"}`;
    expect(() => parseTabbyTheme(badColor)).toThrow(/缺少 foreground/);
  });
});

describe('theme-importer — validateTheme 验证', () => {
  /** 合法主题样本 */
  const validTheme: TerminalTheme = {
    name: 'valid-theme',
    displayName: 'Valid Theme',
    category: 'dark',
    foreground: '#ffffff',
    background: '#000000',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: '#333333',
    black: '#000000',
    red: '#ff0000',
    green: '#00ff00',
    yellow: '#ffff00',
    blue: '#0000ff',
    magenta: '#ff00ff',
    cyan: '#00ffff',
    white: '#ffffff',
    brightBlack: '#666666',
    brightRed: '#ff6666',
    brightGreen: '#66ff66',
    brightYellow: '#ffff66',
    brightBlue: '#6666ff',
    brightMagenta: '#ff66ff',
    brightCyan: '#66ffff',
    brightWhite: '#ffffff',
  };

  it('合法主题验证通过, 返回空错误数组', () => {
    const errors = validateTheme(validTheme);
    expect(errors).toEqual([]);
  });

  it('name 非 kebab-case 报错', () => {
    const bad: TerminalTheme = { ...validTheme, name: 'Bad_Name' };
    const errors = validateTheme(bad);
    expect(errors.some((e) => e.includes('kebab-case'))).toBe(true);
  });

  it('name 为空字符串报错', () => {
    const bad: TerminalTheme = { ...validTheme, name: '' };
    const errors = validateTheme(bad);
    expect(errors.some((e) => e.includes('name 必须是非空字符串'))).toBe(true);
  });

  it('displayName 为空字符串报错', () => {
    const bad: TerminalTheme = { ...validTheme, displayName: '' };
    const errors = validateTheme(bad);
    expect(errors.some((e) => e.includes('displayName 必须是非空字符串'))).toBe(true);
  });

  it('category 非法值报错', () => {
    const bad = { ...validTheme, category: 'unknown' as const };
    const errors = validateTheme(bad);
    expect(errors.some((e) => e.includes('category 必须是'))).toBe(true);
  });

  it('颜色字段格式无效报错', () => {
    const bad: TerminalTheme = { ...validTheme, red: 'not-a-color' };
    const errors = validateTheme(bad);
    expect(errors.some((e) => e.includes('red 格式无效'))).toBe(true);
  });

  it('非对象输入返回 "主题必须是对象"', () => {
    const errors = validateTheme(null);
    expect(errors).toEqual(['主题必须是对象']);
  });

  it('rgba() 格式颜色合法', () => {
    const ok: TerminalTheme = {
      ...validTheme,
      selectionBackground: 'rgba(255, 255, 255, 0.3)',
    };
    const errors = validateTheme(ok);
    expect(errors).toEqual([]);
  });
});

describe('theme-importer — parseTabbyTheme + validateTheme 端到端', () => {
  it('解析后的主题能通过 validateTheme 验证', () => {
    const theme = parseTabbyTheme(VALID_TABBY_JSON);
    const errors = validateTheme(theme);
    expect(errors).toEqual([]);
  });

  it('解析后的主题字段完整 (21 个颜色字段全部填充)', () => {
    const theme = parseTabbyTheme(VALID_TABBY_JSON);
    const colorFields: Array<keyof TerminalTheme> = [
      'foreground', 'background', 'cursor', 'cursorAccent', 'selectionBackground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];
    for (const field of colorFields) {
      expect(typeof theme[field]).toBe('string');
      expect((theme[field] as string).length).toBeGreaterThan(0);
    }
  });
});
