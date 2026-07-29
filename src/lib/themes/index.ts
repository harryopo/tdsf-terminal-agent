/**
 * index.ts — 终端主题注册表 (barrel export)
 * -----------------------------------------------------------------------------
 * 职责: 统一导出所有内置终端主题 + 类型定义
 * 设计: 每个 theme 一个文件, 此处做聚合, 避免循环依赖
 */

export type { TerminalTheme, ThemeCategory, ThemeMeta } from './types';

import { dracula } from './dracula';
import { monokai } from './monokai';
import { oneDark } from './one-dark';
import { solarizedLight } from './solarized-light';
import { solarizedDark } from './solarized-dark';
import { nord } from './nord';
import { gruvboxDark } from './gruvbox-dark';
import { gruvboxLight } from './gruvbox-light';
import { material } from './material';
import { ayuLight } from './ayu-light';
import { ayuDark } from './ayu-dark';
import { ayuMirage } from './ayu-mirage';
import { tokyoNight } from './tokyo-night';
import { catppuccinFrappe } from './catppuccin-frappe';
import { catppuccinMacchiato } from './catppuccin-macchiato';
import { catppuccinMocha } from './catppuccin-mocha';
import { snazzy } from './snazzy';
import { ubuntu } from './ubuntu';
import { atomOneLight } from './atom-one-light';
import { cobalt2 } from './cobalt2';
import { challengerDeep } from './challenger-deep';
import { fairyForest } from './fairy-forest';
import { galaxy } from './galaxy';
import { hipsterGreen } from './hipster-green';
import { homebrew } from './homebrew';
import { manPage } from './man-page';
import { pastelPowerline } from './pastel-powerline';
import { vibrantInk } from './vibrant-ink';
import { afterglow } from './afterglow';
import { blueberrySea } from './blueberry-sea';
import { blulocoLight } from './bluloco-light';
import { blulocoDark } from './bluloco-dark';
import { borland } from './borland';
import { c64 } from './c64';
import { campbell } from './campbell';
import { campbellPowershell } from './campbell-powershell';
import { cga } from './cga';
import { crtAmber } from './crt-amber';
import { crtGreen } from './crt-green';
import { choco } from './choco';
import type { TerminalTheme } from './types';

/**
 * 内置终端主题列表 (40 个精选主题)
 * 涵盖 dark/light/colorful/minimal 四大分类
 */
export const BUILTIN_THEMES: readonly TerminalTheme[] = [
  // === Dark ===
  dracula,
  monokai,
  oneDark,
  solarizedDark,
  nord,
  gruvboxDark,
  material,
  ayuDark,
  ayuMirage,
  tokyoNight,
  catppuccinFrappe,
  catppuccinMacchiato,
  catppuccinMocha,
  ubuntu,
  afterglow,
  blueberrySea,
  blulocoDark,
  campbell,
  campbellPowershell,
  choco,
  // === Light ===
  solarizedLight,
  gruvboxLight,
  ayuLight,
  atomOneLight,
  blulocoLight,
  manPage,
  // === Colorful ===
  snazzy,
  cobalt2,
  challengerDeep,
  fairyForest,
  galaxy,
  pastelPowerline,
  // === Minimal ===
  hipsterGreen,
  homebrew,
  vibrantInk,
  borland,
  c64,
  cga,
  crtAmber,
  crtGreen,
];

/** 按分类分组 (用于 UI 筛选) */
export const THEMES_BY_CATEGORY: Readonly<Record<string, readonly TerminalTheme[]>> = {
  dark: BUILTIN_THEMES.filter((t) => t.category === 'dark'),
  light: BUILTIN_THEMES.filter((t) => t.category === 'light'),
  colorful: BUILTIN_THEMES.filter((t) => t.category === 'colorful'),
  minimal: BUILTIN_THEMES.filter((t) => t.category === 'minimal'),
};

/** 默认主题名 (首次启动时使用) */
export const DEFAULT_TERMINAL_THEME = 'dracula';
