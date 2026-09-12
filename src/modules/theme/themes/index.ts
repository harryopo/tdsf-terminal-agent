/* themes/index.ts — TDSF 内置主题注册表 (源自上游开源主题, Apache-2.0)
 * -----------------------------------------------------------------------------
 * 复用自: 上游开源项目的主题注册表
 * License: Apache-2.0, Copyright 2026 Crynta
 *
 * TDSF: 补齐 kanagawa / kanagawa-dragon / gruvbox / rose-pine / everforest /
 * solarized / sage / tide / claude / caffeine 等主题注册，
 * 让 resolveEditorThemeId("auto", ...) 能正确按 app 主题配对 editor 主题。
 */

import { DEFAULT_THEME_ID, type Theme } from "../types";
import { caffeine } from "./caffeine";
import { catppuccin } from "./catppuccin";
import { claude } from "./claude";
import { dracula } from "./dracula";
import { everforest } from "./everforest";
import { gruvbox } from "./gruvbox";
import { kanagawa } from "./kanagawa";
import { kanagawaDragon } from "./kanagawa-dragon";
import { nord } from "./nord";
import { rosePine } from "./rose-pine";
import { sage } from "./sage";
import { solarized } from "./solarized";
import { tdsfDefault } from "./tdsf-default";
import { tide } from "./tide";
import { tokyoNight } from "./tokyo-night";

/** 内置主题列表 */
const BUILTIN: Theme[] = [
  tdsfDefault,
  tokyoNight,
  catppuccin,
  dracula,
  nord,
  kanagawa,
  kanagawaDragon,
  gruvbox,
  rosePine,
  everforest,
  solarized,
  sage,
  tide,
  claude,
  caffeine,
];

const BY_ID = new Map<string, Theme>(BUILTIN.map((t) => [t.id, t]));

export function listBuiltinThemes(): Theme[] {
  return BUILTIN;
}

export function getBuiltinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function getDefaultTheme(): Theme {
  return BY_ID.get(DEFAULT_THEME_ID) ?? BUILTIN[0];
}
