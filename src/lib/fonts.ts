// 基于上游 terax-ai v0.8.5 的 fonts.ts，TDSF 魔改 2026-08-09（用户要求）：
// 原 fallback 链以 `monospace` 收尾，Windows 的 monospace 中文映射是宋体
// （SimSun，衬线），导致终端/编辑器中文显示衬线。改为在 monospace 前插入
// 无衬线中文字体链（微软雅黑 → 苹方 → 思源黑体），英文仍走 JetBrains Mono
// 等宽（代码对齐），中文走无衬线（与 UI 全局字体 globals.css 一致）。
// 终端用 JetBrains Mono（首选），没装就 SFMono-Regular → Menlo → 系统 monospace。
const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

// 英文等宽在前（保证代码对齐），无衬线中文字体在后（中文用它们，避免宋体），
// monospace 兜底。CSS font 回退按字形逐字符匹配，中文会跳过无中文字形的字体。
const FALLBACK_CHAIN =
  '"JetBrains Mono", SFMono-Regular, Menlo, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

let detected: string | null = null;
let monoReady: Promise<void> | null = null;

export function ensureMonoFontsLoaded(): Promise<void> {
  if (monoReady) return monoReady;
  if (typeof document === "undefined" || !document.fonts?.load) {
    monoReady = Promise.resolve();
    return monoReady;
  }
  monoReady = Promise.allSettled([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('700 14px "JetBrains Mono"'),
  ]).then(() => undefined);
  return monoReady;
}

export function resolveFontFamily(userInput: string): string {
  const name = userInput.trim();
  if (!name) return detectMonoFontFamily();
  // A comma means the user gave a full stack; otherwise quote the single family.
  // Strip any quotes first so a stray quote can't produce a malformed token.
  const head = name.includes(",") ? name : `"${name.replace(/['"]/g, "")}"`;
  return `${head}, ${FALLBACK_CHAIN}`;
}

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  if (typeof document === "undefined" || !document.fonts) {
    detected = FALLBACK_CHAIN;
    return detected;
  }
  for (const f of NERD_FONT_CANDIDATES) {
    try {
      if (document.fonts.check(`12px "${f}"`)) {
        detected = `"${f}", ${FALLBACK_CHAIN}`;
        return detected;
      }
    } catch {
      // Some browsers throw on invalid font shorthand; ignore.
    }
  }
  detected = FALLBACK_CHAIN;
  return detected;
}
