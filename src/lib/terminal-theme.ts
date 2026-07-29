/**
 * terminal-theme.ts — xterm.js 主题适配器 + 主题注册表
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 从 CSS 变量 (`--terminal-*`) 读取 ANSI 16 色, 转换为 xterm.js ITheme 格式
 *   2. 维护 THEME_REGISTRY (内置 + 自定义终端主题)
 *   3. 提供 listThemes / getTheme / applyTheme / registerTheme / unregisterTheme API
 *   4. 主题切换实时同步 (MutationObserver 监听 data-terminal-theme)
 *
 * 设计原则:
 *   - buildTerminalTheme() 仍从 CSS 变量读取, 兼容现有 UI 主题系统
 *   - applyTheme(name) 将 TerminalTheme 写入 CSS 变量, 触发 watchThemeChange
 *   - 内置主题颜色直接用 hex (主题本身就是颜色定义, 不走 CSS 变量约束)
 *   - 自定义主题持久化到 localStorage (与内置主题同 API)
 */
import type { ITheme } from '@xterm/xterm';
import { BUILTIN_THEMES, DEFAULT_TERMINAL_THEME } from './themes';
import type { TerminalTheme, ThemeMeta } from './themes';

/** CSS 变量名 → xterm ITheme 字段映射 */
const VAR_NAMES = [
  '--terminal-bg',
  '--terminal-fg',
  '--terminal-cursor',
  '--terminal-selection',
  '--terminal-black',
  '--terminal-red',
  '--terminal-green',
  '--terminal-yellow',
  '--terminal-blue',
  '--terminal-magenta',
  '--terminal-cyan',
  '--terminal-white',
  '--terminal-bright-black',
  '--terminal-bright-red',
  '--terminal-bright-green',
  '--terminal-bright-yellow',
  '--terminal-bright-blue',
  '--terminal-bright-magenta',
  '--terminal-bright-cyan',
  '--terminal-bright-white',
] as const;

/** localStorage 键名 */
const LS_KEY_TERMINAL_THEME = 'tdsf-terminal-theme';
const LS_KEY_CUSTOM_THEMES = 'tdsf-terminal-custom-themes';

/** 当前应用的终端主题名 (用于调试与回退) */
let currentThemeName: string = DEFAULT_TERMINAL_THEME;

// ============================================================================
// 主题注册表
// ============================================================================

/**
 * 主题注册表 — 内置主题 + 自定义主题统一管理
 * 用 Map 而非 Object, 因为 name 是 kebab-case 需保持原样
 */
export const THEME_REGISTRY: Map<string, TerminalTheme> = new Map<string, TerminalTheme>();

/**
 * 初始化注册表 (立即执行, 模块加载时注册内置主题)
 */
function initRegistry(): void {
  for (const theme of BUILTIN_THEMES) {
    THEME_REGISTRY.set(theme.name, theme);
  }
  // 加载 localStorage 中的自定义主题
  loadCustomThemesFromStorage();
}

/** 已初始化标记 (避免重复加载自定义主题) */
let registryInitialized = false;

/** 确保注册表已初始化 (幂等) */
function ensureRegistry(): void {
  if (registryInitialized) return;
  registryInitialized = true;
  initRegistry();
}

// ============================================================================
// 主题元数据 / 查询 API
// ============================================================================

/**
 * 列出所有主题元数据 (用于 UI 展示)
 * @returns 主题元数据数组 (按注册顺序)
 */
export function listThemes(): ThemeMeta[] {
  ensureRegistry();
  const metas: ThemeMeta[] = [];
  for (const theme of THEME_REGISTRY.values()) {
    metas.push({
      name: theme.name,
      displayName: theme.displayName,
      category: theme.category,
      background: theme.background,
      foreground: theme.foreground,
      custom: isCustomTheme(theme.name),
    });
  }
  return metas;
}

/**
 * 按名获取主题完整定义
 * @param name - 主题名 (如 'dracula')
 * @returns 主题对象, 不存在返回 undefined
 */
export function getTheme(name: string): TerminalTheme | undefined {
  ensureRegistry();
  return THEME_REGISTRY.get(name);
}

/**
 * 获取当前应用的终端主题名
 */
export function getCurrentThemeName(): string {
  return currentThemeName;
}

/**
 * 注册新主题 (用于自定义主题导入)
 * @param theme - 主题对象
 * @returns true 注册成功, false 名字已存在
 */
export function registerTheme(theme: TerminalTheme): boolean {
  ensureRegistry();
  if (THEME_REGISTRY.has(theme.name)) return false;
  THEME_REGISTRY.set(theme.name, theme);
  return true;
}

/**
 * 注销主题 (仅允许自定义主题)
 * @param name - 主题名
 * @returns true 注销成功, false 不存在或为内置主题
 */
export function unregisterTheme(name: string): boolean {
  ensureRegistry();
  // 内置主题不可注销
  if (BUILTIN_THEMES.some((t) => t.name === name)) return false;
  return THEME_REGISTRY.delete(name);
}

// ============================================================================
// 主题应用 (写入 CSS 变量 + 持久化)
// ============================================================================

/**
 * 应用终端主题 — 将颜色写入 CSS 变量, 触发 watchThemeChange
 * @param name - 主题名 (如 'dracula')
 * @returns true 应用成功, false 主题不存在
 */
export function applyTheme(name: string): boolean {
  ensureRegistry();
  const theme = THEME_REGISTRY.get(name);
  if (!theme) return false;

  const root = document.documentElement;
  // 写入终端 CSS 变量 (与现有 buildTerminalTheme 共用读取链路)
  root.style.setProperty('--terminal-bg', theme.background);
  root.style.setProperty('--terminal-fg', theme.foreground);
  root.style.setProperty('--terminal-cursor', theme.cursor);
  root.style.setProperty('--terminal-selection', theme.selectionBackground);
  root.style.setProperty('--terminal-black', theme.black);
  root.style.setProperty('--terminal-red', theme.red);
  root.style.setProperty('--terminal-green', theme.green);
  root.style.setProperty('--terminal-yellow', theme.yellow);
  root.style.setProperty('--terminal-blue', theme.blue);
  root.style.setProperty('--terminal-magenta', theme.magenta);
  root.style.setProperty('--terminal-cyan', theme.cyan);
  root.style.setProperty('--terminal-white', theme.white);
  root.style.setProperty('--terminal-bright-black', theme.brightBlack);
  root.style.setProperty('--terminal-bright-red', theme.brightRed);
  root.style.setProperty('--terminal-bright-green', theme.brightGreen);
  root.style.setProperty('--terminal-bright-yellow', theme.brightYellow);
  root.style.setProperty('--terminal-bright-blue', theme.brightBlue);
  root.style.setProperty('--terminal-bright-magenta', theme.brightMagenta);
  root.style.setProperty('--terminal-bright-cyan', theme.brightCyan);
  root.style.setProperty('--terminal-bright-white', theme.brightWhite);

  // 触发 watchThemeChange (通过 data-terminal-theme 属性变化)
  root.setAttribute('data-terminal-theme', name);

  currentThemeName = name;
  // 持久化到 localStorage
  try {
    localStorage.setItem(LS_KEY_TERMINAL_THEME, name);
  } catch {
    /* localStorage 不可用时静默 */
  }
  return true;
}

/**
 * 从 localStorage 恢复上次应用的主题
 * @returns 恢复的主题名, 无记录返回 null
 */
export function restoreTheme(): string | null {
  ensureRegistry();
  try {
    const saved = localStorage.getItem(LS_KEY_TERMINAL_THEME);
    if (saved && THEME_REGISTRY.has(saved)) {
      applyTheme(saved);
      return saved;
    }
  } catch {
    /* localStorage 不可用时静默 */
  }
  return null;
}

// ============================================================================
// 自定义主题持久化
// ============================================================================

/**
 * 持久化自定义主题到 localStorage
 * @param theme - 主题对象
 */
export function saveCustomTheme(theme: TerminalTheme): void {
  ensureRegistry();
  // 注册到内存注册表
  THEME_REGISTRY.set(theme.name, theme);
  // 持久化到 localStorage
  try {
    const customs = loadCustomThemeList();
    const idx = customs.findIndex((t) => t.name === theme.name);
    if (idx >= 0) {
      customs[idx] = theme;
    } else {
      customs.push(theme);
    }
    localStorage.setItem(LS_KEY_CUSTOM_THEMES, JSON.stringify(customs));
  } catch {
    /* localStorage 不可用时静默 */
  }
}

/**
 * 从 localStorage 加载自定义主题到注册表
 */
function loadCustomThemesFromStorage(): void {
  try {
    const customs = loadCustomThemeList();
    for (const theme of customs) {
      THEME_REGISTRY.set(theme.name, theme);
    }
  } catch {
    /* localStorage 不可用时静默 */
  }
}

/**
 * 读取 localStorage 中的自定义主题列表 (JSON 反序列化)
 */
function loadCustomThemeList(): TerminalTheme[] {
  try {
    const raw = localStorage.getItem(LS_KEY_CUSTOM_THEMES);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as TerminalTheme[];
  } catch {
    return [];
  }
}

/**
 * 判断主题是否为自定义主题 (在 localStorage 中)
 */
function isCustomTheme(name: string): boolean {
  try {
    const customs = loadCustomThemeList();
    return customs.some((t) => t.name === name);
  } catch {
    return false;
  }
}

// ============================================================================
// xterm.js ITheme 适配 (兼容现有 buildTerminalTheme)
// ============================================================================

/**
 * 从当前文档根元素读取 CSS 变量值, 转 hex 字符串
 * 透明色 (rgba) → 转 hex (#rrggbb)
 */
function readVar(name: string, fallback = '#000000'): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!v) return fallback;
  // 转换 rgba(r,g,b,a) → #rrggbb (a 丢弃, xterm 不支持 alpha)
  const m = v.match(/rgba?\(([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (m) {
    const r = Math.round(parseFloat(m[1]));
    const g = Math.round(parseFloat(m[2]));
    const b = Math.round(parseFloat(m[3]));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  }
  return v;
}

/**
 * 构建 xterm.js ITheme 对象 (从 CSS 变量读取, 兼容现有逻辑)
 * applyTheme(name) 写入 CSS 变量后, 调用此函数即可获得 xterm ITheme
 */
export function buildTerminalTheme(): ITheme {
  const theme: ITheme = {
    background: readVar('--terminal-bg'),
    foreground: readVar('--terminal-fg'),
    cursor: readVar('--terminal-cursor'),
    selectionBackground: readVar('--terminal-selection'),
    selectionForeground: undefined,
    black: readVar('--terminal-black'),
    red: readVar('--terminal-red'),
    green: readVar('--terminal-green'),
    yellow: readVar('--terminal-yellow'),
    blue: readVar('--terminal-blue'),
    magenta: readVar('--terminal-magenta'),
    cyan: readVar('--terminal-cyan'),
    white: readVar('--terminal-white'),
    brightBlack: readVar('--terminal-bright-black'),
    brightRed: readVar('--terminal-bright-red'),
    brightGreen: readVar('--terminal-bright-green'),
    brightYellow: readVar('--terminal-bright-yellow'),
    brightBlue: readVar('--terminal-bright-blue'),
    brightMagenta: readVar('--terminal-bright-magenta'),
    brightCyan: readVar('--terminal-bright-cyan'),
    brightWhite: readVar('--terminal-bright-white'),
  };
  return theme;
}

// ============================================================================
// 主题切换监听 (兼容现有 watchThemeChange)
// ============================================================================

/**
 * 监听主题切换, 触发回调
 * 监听 data-terminal-theme 属性变化 (applyTheme 设置此属性)
 * @param onChange - 主题变化回调
 * @returns 清理函数 (组件卸载时调用)
 */
export function watchThemeChange(onChange: () => void): () => void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (
        m.type === 'attributes' &&
        (m.attributeName === 'data-theme' || m.attributeName === 'data-terminal-theme')
      ) {
        onChange();
        return;
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-terminal-theme'],
  });
  return () => observer.disconnect();
}

/**
 * 调试: 打印当前所有终端 CSS 变量 (仅 dev 环境)
 * 配合 `if (import.meta.env.DEV) debugDumpTerminalVars();` 使用
 */
export function debugDumpTerminalVars(): void {
  console.info('[terminal-theme] 当前 CSS 变量:');
  for (const name of VAR_NAMES) {
    console.info(`  ${name} = ${readVar(name)}`);
  }
}

// === 模块加载时初始化注册表 ================================================
// 注: 在浏览器环境自动初始化; 测试环境按需 ensureRegistry()
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  ensureRegistry();
}
