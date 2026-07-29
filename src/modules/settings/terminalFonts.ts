// ---------------------------------------------------------------------------
// 终端字体预设（TDSF 魔改：上游是自由输入框，改成 Select dropdown）
// ---------------------------------------------------------------------------
//
// xterm 是 canvas 渲染，浏览器对 font-family 链的回退行为是"取链中第一个
// 系统上装着的字体，链首字体不存在就直接回退 monospace generic"——所以
// 这里列的预设都是 *用户机器上实际能命中* 的字体名（避免链首字体不存在
// 导致整个终端字形发虚回退到 sans-serif）。
//
// 列表按"跨平台优先 → 平台原生 → 经典字体"排序：
//   - ""            → Auto-detect（走 detectMonoFontFamily 扫 Nerd Font）
//   - JetBrains Mono → 上游首选，TDSF 默认（要装 Nerd Font 版本显示图标）
//   - Cascadia Code → Windows 11 自带，无需安装
//   - Fira Code    → 经典连字
//   - 其它         → 平台原生 / 经典
export type TerminalFontPreset = {
  /** 写入 store.terminalFontFamily 的值；空串 = Auto-detect */
  value: string;
  /** Select 中展示的标签 */
  label: string;
  /** 副标题提示（"Windows 11 built-in" 等），可选 */
  hint?: string;
};

export const TERMINAL_FONT_PRESETS: readonly TerminalFontPreset[] = [
  { value: "", label: "Auto-detect", hint: "Scans installed Nerd Fonts" },
  { value: "JetBrains Mono", label: "JetBrains Mono", hint: "Recommended" },
  {
    value: "JetBrainsMono Nerd Font",
    label: "JetBrains Mono Nerd Font",
    hint: "Nerd icons",
  },
  {
    value: "Cascadia Code",
    label: "Cascadia Code",
    hint: "Windows 11 built-in",
  },
  { value: "Fira Code", label: "Fira Code", hint: "Classic ligatures" },
  { value: "Source Code Pro", label: "Source Code Pro" },
  { value: "Consolas", label: "Consolas", hint: "Windows classic" },
  { value: "SF Mono", label: "SF Mono", hint: "macOS 11+" },
  { value: "Menlo", label: "Menlo", hint: "macOS classic" },
  {
    value: "DejaVu Sans Mono",
    label: "DejaVu Sans Mono",
    hint: "Linux default",
  },
];

/** 该值是否命中预设（含空串 Auto-detect）。 */
export function isPresetFont(value: string): boolean {
  return TERMINAL_FONT_PRESETS.some((p) => p.value === value);
}

/** 命中预设则返回对应条目；否则返回 undefined（视为"自定义字体"）。 */
export function getFontPresetByValue(
  value: string,
): TerminalFontPreset | undefined {
  return TERMINAL_FONT_PRESETS.find((p) => p.value === value);
}
