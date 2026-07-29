/**
 * 终端翻译悬浮框
 * -----------------------------------------------------------------------------
 * TDSF 魔改 2026-07-29: 显示选词翻译结果（离线词典释义）。
 */
import { useTranslateStore } from "./translateStore";

export function TranslateTooltip() {
  const result = useTranslateStore((s) => s.result);
  const x = useTranslateStore((s) => s.x);
  const y = useTranslateStore((s) => s.y);

  if (!result) return null;

  return (
    <div
      className="fixed z-[9999] max-w-xs rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg"
      style={{ left: Math.min(x + 8, window.innerWidth - 280), top: y + 12 }}
      data-testid="translate-tooltip"
    >
      <div className="mb-1 font-mono font-semibold text-foreground">
        {result.source}
      </div>
      <ul className="space-y-0.5">
        {result.entries.map((entry, i) => (
          <li key={`${entry.word}-${i}`} className="text-muted-foreground">
            {entry.word !== result.source && (
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
