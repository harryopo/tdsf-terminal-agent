/* tdsf-default.ts — TDSF 默认主题 (源自上游开源主题, Apache-2.0)
 * -----------------------------------------------------------------------------
 * 复用自: 上游开源项目的默认主题实现
 * License: Apache-2.0, Copyright 2026 Crynta
 *
 * 默认主题走 globals.css 原生 CSS 变量, 不注入自定义颜色.
 * dark 模式用原生 dark 色系, light 模式用原生 light 色系.
 */

import type { Theme } from "../types";

export const tdsfDefault: Theme = {
  id: "tdsf-default",
  name: "TDSF Default",
  description: "原生暗色/亮色主题 — 干净简洁的默认外观",
  variants: {
    light: {},
    dark: {},
  },
};
