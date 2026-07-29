/* terax-default.ts — TDSF 默认主题 (源自 terax-ai, Apache-2.0)
 * -----------------------------------------------------------------------------
 * 复用自: terax-ai/src/modules/theme/themes/terax-default.ts
 * License: Apache-2.0, Copyright 2026 Crynta
 *
 * 默认主题走 globals.css 原生 CSS 变量, 不注入自定义颜色.
 * dark 模式用原生 dark 色系, light 模式用原生 light 色系.
 */

import type { Theme } from "../types";

export const teraxDefault: Theme = {
  id: "terax-default",
  name: "TDSF Default",
  description: "原生暗色/亮色主题 — 干净简洁的默认外观",
  variants: {
    light: {},
    dark: {},
  },
};
