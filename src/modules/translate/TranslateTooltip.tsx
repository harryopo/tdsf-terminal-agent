/**
 * 终端翻译悬浮框
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 显示选词翻译结果（离线词典释义）。
 *
 * 2026-07-31 修复：
 * - 增加词典未命中的"未找到"提示渲染（避免翻译模块隐形失效）
 * - z-index 提到 z-[10000]（高于 SelectionAskAi 的 z-50，确保翻译在上层）
 * - 限制最大宽度，避免长文本撑爆视口
 * - UI 风格对齐上游 Terax: bg-card/95 + backdrop-blur-md + fade-in 动画
 *   （参考 SelectionAskAi.tsx 的视觉语言，保持开源项目整体风格一致）
 *
 * 2026-07-31 P3 修复（深浅色适配）：
 * - 未命中提示从硬编码 amber 改为 CSS 变量 --warning-* 系列
 * - 在 globals.css 中定义 --warning-border / --warning-bg / --warning-fg
 *   分别对应浅色/暗色两套值，确保两种模式下都有足够对比度
 * - 命中提示继续用 bg-card/95 + text-foreground（已通过 CSS 变量自动适配）
 */
import { useEffect, useRef, useState } from "react";
import { useTranslateStore } from "./translateStore";

export function TranslateTooltip() {
  const result = useTranslateStore((s) => s.result);
  const missing = useTranslateStore((s) => s.missing);
  const x = useTranslateStore((s) => s.x);
  const y = useTranslateStore((s) => s.y);

  // 视觉位置缓存（参考 SelectionAskAi 的 pos.current 模式，避免每次渲染跳动）
  const pos = useRef({ top: 0, left: 0 });
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!result && !missing) {
      setVisible(false);
      return;
    }
    // 有内容时计算位置并触发进入动画
    pos.current = {
      top: y + 12,
      left: Math.min(x + 8, window.innerWidth - 300),
    };
    setVisible(true);
  }, [result, missing, x, y]);

  if (!result && !missing) return null;

  const baseClass =
    "fixed z-[10000] max-w-[280px] rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur-md duration-150 ease-out";

  if (missing) {
    return (
      <div
        className={`${baseClass} border-[var(--warning-border)] bg-[var(--warning-bg)] ${
          visible
            ? "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1"
            : "opacity-0"
        }`}
        style={{ left: pos.current.left, top: pos.current.top }}
        data-testid="translate-tooltip-missing"
      >
        <div
          className="mb-0.5 font-mono font-semibold"
          style={{ color: "var(--warning-fg)" }}
        >
          {missing}
        </div>
        <div className="text-muted-foreground">
          未在离线词典中找到释义（仅收录 Linux 命令 + 编程术语）
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${baseClass} border-border/60 bg-card/95 ${
        visible
          ? "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1"
          : "opacity-0"
      }`}
      style={{ left: pos.current.left, top: pos.current.top }}
      data-testid="translate-tooltip"
    >
      <div className="mb-1 font-mono font-semibold text-foreground">
        {result!.source}
      </div>
      <ul className="space-y-0.5">
        {result!.entries.map((entry, i) => (
          <li key={`${entry.word}-${i}`} className="text-muted-foreground">
            {entry.word !== result!.source && (
              <span className="mr-1 font-mono text-foreground/70">
                {entry.word}
              </span>
            )}
            {entry.pos && (
              <span className="mr-1 text-[10px] text-foreground/50">
                [{entry.pos}]
              </span>
            )}
            <span className="text-foreground">{entry.zh}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
