/**
 * 终端翻译卡片
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 显示选词翻译结果（离线词典释义）。
 *
 * P2 (2026-08-01) 重构：
 * - 触发方式从"选中自动弹"改为选中浮层点「翻译」按钮（SelectionAskAi），
 *   本地终端与 SSH 终端统一
 * - 卡片底部新增「Ask TDSF」操作：词典释义不够时把选中词/代码片段发给
 *   AI 深入解释（服务器终端代码片段 ask agent 的入口）
 * - UI 对齐 Terax：bg-card/95 + backdrop-blur + fade-in + 词典徽标
 */
import { BookOpen01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslateStore } from "./translateStore";

type Props = {
  /** 点击「Ask TDSF」：把选中文本 attach 到 AI 面板 */
  onAsk?: (text: string) => void;
};

export function TranslateTooltip({ onAsk }: Props) {
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
      left: Math.min(x + 8, window.innerWidth - 320),
    };
    setVisible(true);
  }, [result, missing, x, y]);

  if (!result && !missing) return null;

  const baseClass =
    "fixed z-[10000] max-w-[300px] rounded-lg border px-3 py-2.5 text-xs shadow-lg backdrop-blur-md duration-150 ease-out";
  const visibleClass = visible
    ? "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1"
    : "opacity-0";

  const sourceText = result?.source ?? missing ?? "";

  const askButton = (
    <button
      type="button"
      data-testid="translate-ask"
      onClick={(e) => {
        e.stopPropagation();
        onAsk?.(sourceText);
        useTranslateStore.getState().hideTooltip();
      }}
      className="mt-2 flex h-6 w-full items-center justify-center gap-1.5 rounded border border-border/50 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={SparklesIcon} size={11} strokeWidth={1.75} />
      Ask TDSF 解释这段
    </button>
  );

  if (missing) {
    return (
      <div
        className={`${baseClass} border-[var(--warning-border)] bg-[var(--warning-bg)] ${visibleClass}`}
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
          未在离线词典中找到释义（仅收录 Linux 命令 + 编程术语）——可让 AI 解释
        </div>
        {askButton}
      </div>
    );
  }

  return (
    <div
      className={`${baseClass} border-border/60 bg-card/95 ${visibleClass}`}
      style={{ left: pos.current.left, top: pos.current.top }}
      data-testid="translate-tooltip"
    >
      <div className="mb-1 flex items-center gap-1.5">
        <HugeiconsIcon icon={BookOpen01Icon} size={12} strokeWidth={1.75} />
        <span className="font-mono font-semibold text-foreground">
          {result!.source}
        </span>
        {result!.entries[0]?.tag && (
          <span className="rounded bg-muted px-1 py-px text-[9.5px] text-muted-foreground">
            {result!.entries[0].tag}
          </span>
        )}
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
      {askButton}
    </div>
  );
}
