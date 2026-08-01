import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { PresenceState } from "@/lib/usePresence";
import { BookOpen01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";

export type SelectionAskAiProps = {
  state: PresenceState;
  x: number;
  y: number;
  onAsk: () => void;
  onDismiss: () => void;
  /** P2 翻译：翻译开关开启时显示「翻译」按钮（本地/SSH 终端选词通用） */
  showTranslate?: boolean;
  onTranslate?: (x: number, y: number) => void;
};

const W = 172;
const OFFSET = 32;

/**
 * 选中浮层：终端/编辑器选中文本后弹出，提供「翻译」与「Ask TDSF」两个动作。
 *
 * P2 (2026-08-01) 重构：原实现只提供 Ask TDSF，且与翻译模块互相"退让"
 * （翻译开关开启时 Ask 不弹、命中/未命中事件兜底清除），协调逻辑复杂且
 * 服务器终端选词体验割裂。现在统一为一个浮层两个选项：
 *   - 翻译（showTranslate 时显示）：点击后由 onTranslate 触发离线词典
 *     翻译卡片（命中释义 / 未命中提示，卡片内可再 Ask）
 *   - Ask TDSF：把选中文本 attach 到 AI 面板
 * 本地终端与 SSH 终端共用（选中文本由 captureActiveSelection 统一提供）。
 */
export function SelectionAskAi({
  state,
  x,
  y,
  onAsk,
  onDismiss,
  showTranslate = false,
  onTranslate,
}: SelectionAskAiProps) {
  const pos = useRef({ top: 0, left: 0 });
  const open = state === "open";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (open) {
    pos.current = {
      top: Math.max(8, y - OFFSET),
      left: Math.max(8, Math.min(x - W / 2, window.innerWidth - W - 8)),
    };
  }

  return (
    <div
      data-selection-ask-ai
      data-state={state}
      style={{ top: pos.current.top, left: pos.current.left, width: W }}
      className="fixed z-50 duration-150 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-bottom-1"
    >
      <div className="flex items-stretch gap-1 rounded-md border border-border/60 bg-card/95 p-1 shadow-lg backdrop-blur-md">
        {showTranslate && onTranslate && (
          <button
            type="button"
            data-testid="selection-translate"
            onClick={(e) => {
              e.stopPropagation();
              onTranslate(x, y);
            }}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded px-2 text-xs",
              "border border-border/40 text-muted-foreground",
              "transition-colors hover:border-border hover:bg-accent hover:text-foreground",
            )}
            title="翻译选中文本（离线词典）"
          >
            <HugeiconsIcon icon={BookOpen01Icon} size={13} strokeWidth={1.75} />
            <span>翻译</span>
          </button>
        )}
        <button
          type="button"
          data-testid="selection-ask-ai"
          onClick={(e) => {
            e.stopPropagation();
            onAsk();
          }}
          className={cn(
            "flex h-7 flex-1 items-center justify-between gap-1.5 rounded px-2 text-xs",
            "text-foreground transition-colors hover:bg-accent",
          )}
        >
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={1.75} />
            <span>Ask TDSF</span>
          </span>
          <KbdGroup>
            <Kbd className="h-4 min-w-4 px-1 text-[10px]">
              {fmtShortcut(MOD_KEY, "L")}
            </Kbd>
          </KbdGroup>
        </button>
      </div>
    </div>
  );
}
