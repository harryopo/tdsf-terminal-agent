/**
 * terminal-theme.test.ts — 主题注册表 / 应用 / 持久化测试
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 内置主题注册 (40 个)
 *   2. listThemes / getTheme / getCurrentThemeName 查询 API
 *   3. applyTheme 写入 CSS 变量 + 持久化 + 切换 currentThemeName
 *   4. registerTheme / unregisterTheme 自定义主题管理 (内置主题不可注销)
 *   5. saveCustomTheme 持久化到 localStorage
 *   6. restoreTheme 从 localStorage 恢复
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listThemes,
  getTheme,
  getCurrentThemeName,
  applyTheme,
  registerTheme,
  unregisterTheme,
  saveCustomTheme,
  restoreTheme,
  THEME_REGISTRY,
} from './terminal-theme';
import { BUILTIN_THEMES, DEFAULT_TERMINAL_THEME } from './themes';
import type { TerminalTheme } from './themes';

/** 测试用自定义主题样本 */
const SAMPLE_CUSTOM_THEME: TerminalTheme = {
  name: 'test-custom-theme',
  displayName: 'Test Custom Theme',
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

const LS_KEY_TERMINAL_THEME = 'tdsf-terminal-theme';
const LS_KEY_CUSTOM_THEMES = 'tdsf-terminal-custom-themes';

describe('terminal-theme — 主题注册表', () => {
  beforeEach(() => {
    // 每个测试前清空 localStorage 与注册表自定义主题
    localStorage.clear();
    // 移除测试自定义主题 (若存在)
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    // 重置 data-terminal-theme 属性
    document.documentElement.removeAttribute('data-terminal-theme');
  });

  afterEach(() => {
    // 清理测试期间注入的自定义主题
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    localStorage.clear();
  });

  it('内置主题已全部注册到 THEME_REGISTRY', () => {
    const registeredCount = listThemes().length;
    expect(registeredCount).toBeGreaterThanOrEqual(BUILTIN_THEMES.length);
    // 抽样验证: dracula / nord / monokai 都在注册表
    expect(getTheme('dracula')).toBeDefined();
    expect(getTheme('nord')).toBeDefined();
    expect(getTheme('monokai')).toBeDefined();
  });

  it('getTheme 按名获取主题, 不存在返回 undefined', () => {
    const dracula = getTheme('dracula');
    expect(dracula).toBeDefined();
    expect(dracula?.displayName).toBe('Dracula');
    expect(dracula?.category).toBe('dark');

    const unknown = getTheme('this-theme-does-not-exist');
    expect(unknown).toBeUndefined();
  });

  it('listThemes 返回元数据, 包含 name/displayName/category/background/foreground', () => {
    const metas = listThemes();
    expect(metas.length).toBeGreaterThan(0);
    const first = metas[0]!;
    expect(typeof first.name).toBe('string');
    expect(typeof first.displayName).toBe('string');
    expect(first.category).toMatch(/^(dark|light|colorful|minimal)$/);
    expect(typeof first.background).toBe('string');
    expect(typeof first.foreground).toBe('string');
  });
});

describe('terminal-theme — 主题应用 (applyTheme)', () => {
  beforeEach(() => {
    localStorage.clear();
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    document.documentElement.removeAttribute('data-terminal-theme');
  });

  afterEach(() => {
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    localStorage.clear();
  });

  it('applyTheme 写入 CSS 变量 + 设置 data-terminal-theme + 持久化到 localStorage', () => {
    const ok = applyTheme('nord');
    expect(ok).toBe(true);

    // 1. CSS 变量已写入
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--terminal-bg')).toBe('#2e3440');
    expect(root.style.getPropertyValue('--terminal-fg')).toBe('#d8dee9');

    // 2. data-terminal-theme 属性已设置
    expect(root.getAttribute('data-terminal-theme')).toBe('nord');

    // 3. currentThemeName 已更新
    expect(getCurrentThemeName()).toBe('nord');

    // 4. 已持久化到 localStorage
    expect(localStorage.getItem(LS_KEY_TERMINAL_THEME)).toBe('nord');
  });

  it('applyTheme 对不存在的主题返回 false, 不修改 currentThemeName', () => {
    const before = getCurrentThemeName();
    const ok = applyTheme('non-existent-theme-xyz');
    expect(ok).toBe(false);
    expect(getCurrentThemeName()).toBe(before);
  });

  it('applyTheme 切换不同主题时, CSS 变量同步更新', () => {
    applyTheme('dracula');
    expect(document.documentElement.style.getPropertyValue('--terminal-bg'))
      .toBe('#282a36');

    applyTheme('nord');
    expect(document.documentElement.style.getPropertyValue('--terminal-bg'))
      .toBe('#2e3440');
  });
});

describe('terminal-theme — 自定义主题管理', () => {
  beforeEach(() => {
    localStorage.clear();
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    document.documentElement.removeAttribute('data-terminal-theme');
  });

  afterEach(() => {
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    localStorage.clear();
  });

  it('registerTheme 注册新主题, 重复注册返回 false', () => {
    const ok = registerTheme(SAMPLE_CUSTOM_THEME);
    expect(ok).toBe(true);
    expect(getTheme(SAMPLE_CUSTOM_THEME.name)).toBeDefined();

    // 重复注册同名主题失败
    const dup = registerTheme(SAMPLE_CUSTOM_THEME);
    expect(dup).toBe(false);
  });

  it('unregisterTheme 注销自定义主题, 但不可注销内置主题', () => {
    registerTheme(SAMPLE_CUSTOM_THEME);
    const ok = unregisterTheme(SAMPLE_CUSTOM_THEME.name);
    expect(ok).toBe(true);
    expect(getTheme(SAMPLE_CUSTOM_THEME.name)).toBeUndefined();

    // 内置主题不可注销
    const builtinOk = unregisterTheme('dracula');
    expect(builtinOk).toBe(false);
    expect(getTheme('dracula')).toBeDefined();
  });

  it('saveCustomTheme 写入注册表 + 持久化到 localStorage', () => {
    saveCustomTheme(SAMPLE_CUSTOM_THEME);

    // 注册表可查询
    expect(getTheme(SAMPLE_CUSTOM_THEME.name)).toBeDefined();

    // localStorage 已持久化
    const raw = localStorage.getItem(LS_KEY_CUSTOM_THEMES);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as TerminalTheme[];
    const found = parsed.find((t) => t.name === SAMPLE_CUSTOM_THEME.name);
    expect(found).toBeDefined();
    expect(found?.displayName).toBe(SAMPLE_CUSTOM_THEME.displayName);
  });
});

describe('terminal-theme — 主题恢复 (restoreTheme)', () => {
  beforeEach(() => {
    localStorage.clear();
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    document.documentElement.removeAttribute('data-terminal-theme');
  });

  afterEach(() => {
    THEME_REGISTRY.delete(SAMPLE_CUSTOM_THEME.name);
    localStorage.clear();
  });

  it('restoreTheme 从 localStorage 恢复上次应用的主题', () => {
    // 模拟上次保存的主题是 nord
    localStorage.setItem(LS_KEY_TERMINAL_THEME, 'nord');

    const restored = restoreTheme();
    expect(restored).toBe('nord');
    expect(getCurrentThemeName()).toBe('nord');
    expect(document.documentElement.getAttribute('data-terminal-theme'))
      .toBe('nord');
  });

  it('restoreTheme 无保存记录时返回 null, 不修改 currentThemeName', () => {
    // 清空 localStorage
    localStorage.removeItem(LS_KEY_TERMINAL_THEME);

    const before = getCurrentThemeName();
    const restored = restoreTheme();
    expect(restored).toBeNull();
    expect(getCurrentThemeName()).toBe(before);
  });

  it('restoreTheme 保存的主题名不存在时返回 null (回退保护)', () => {
    localStorage.setItem(LS_KEY_TERMINAL_THEME, 'ghost-theme-not-registered');
    const restored = restoreTheme();
    expect(restored).toBeNull();
  });
});

describe('terminal-theme — 默认主题', () => {
  it('DEFAULT_TERMINAL_THEME 为 dracula', () => {
    expect(DEFAULT_TERMINAL_THEME).toBe('dracula');
  });
});
