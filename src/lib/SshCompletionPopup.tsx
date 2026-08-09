/**
 * SshCompletionPopup.tsx — SSH 终端命令补全弹窗 (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 在 SSH 终端里弹出命令候选列表（Frecency 排序）。
 * 鼠标点击或键盘选择后写入终端。
 */
import type { CompletionItem } from "@/lib/completion";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef } from "react";

interface Props {
  items: CompletionItem[];
  visible: boolean;
  onSelect: (item: CompletionItem) => void;
  onClose: () => void;
}

export function SshCompletionPopup({ items, visible, onSelect, onClose }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const hoverIdx = useRef(0);

  // 键盘导航
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!visible || items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        hoverIdx.current = (hoverIdx.current + 1) % items.length;
        listRef.current?.children[hoverIdx.current]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        hoverIdx.current = (hoverIdx.current - 1 + items.length) % items.length;
        listRef.current?.children[hoverIdx.current]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && hoverIdx.current < items.length) {
        e.preventDefault();
        onSelect(items[hoverIdx.current]);
      }
    },
    [visible, items, onSelect],
  );

  useEffect(() => {
    if (visible) {
      window.addEventListener("keydown", handleKey);
      hoverIdx.current = 0;
    }
    return () => window.removeEventListener("keydown", handleKey);
  }, [visible, handleKey]);

  // 点击外部关闭
  useEffect(() => {
    if (!visible) return;
    const onClick = () => onClose();
    const timer = setTimeout(() => {
      window.addEventListener("click", onClick, { once: true });
    }, 100);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", onClick);
    };
  }, [visible, onClose]);

  if (!visible || items.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute z-50 max-h-60 w-72 overflow-auto rounded-md border border-border bg-popover shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, i) => (
        <button
          key={item.command}
          type="button"
          onMouseEnter={() => { hoverIdx.current = i; }}
          onClick={() => onSelect(item)}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[11px]",
            i === hoverIdx.current
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          <span className="text-foreground">{item.command}</span>
          {item.useCount > 1 && (
            <span className="ml-auto text-[9px] text-muted-foreground/60">
              ×{item.useCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
