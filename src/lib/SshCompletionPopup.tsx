/**
 * SshCompletionPopup.tsx — SSH 终端命令预测弹窗 (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 基于 fish autosuggest 三层引擎的预测面板：
 *   ┌──────────────────────────────────────────┐
 *   │ ● 命令预测   ↑↓ 选择 · → 接受 · Tab 原生   │
 *   ├──────────────────────────────────────────┤
 *   │ ⏱ systemctl status nginx    历史          │  ← 历史来源
 *   │ 📖 systemctl  ←  管理 systemd 服务        │  ← 字典来源（带翻译）
 *   │ ⚡ systemctl  管理 systemd 服务    0.85   │  ← fuzzy 来源（带分数）
 *   └──────────────────────────────────────────┘
 */
import type { SuggestionResult } from "@/lib/suggest-engine";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

interface Props {
  items: SuggestionResult[];
  visible: boolean;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

/** 来源标签 */
const SOURCE_LABELS: Record<SuggestionResult["source"], { icon: string; label: string; color: string }> = {
  history: { icon: "⏱", label: "历史", color: "text-blue-500" },
  dictionary: { icon: "📖", label: "", color: "text-muted-foreground" },
  fuzzy: { icon: "⚡", label: "", color: "text-amber-500" },
};

export function SshCompletionPopup({
  items,
  visible,
  selectedIndex,
  onSelect,
  onClose,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible || !listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, visible]);

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
      className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-96 overflow-auto rounded-md border border-border bg-popover shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      {/* 顶部提示栏 */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
        <span className="text-emerald-500">●</span>
        <span>命令预测</span>
        <span className="ml-auto">↑↓ 选择 · → 接受 · Tab 原生</span>
      </div>
      {/* 预测列表 */}
      {items.map((item, i) => {
        const src = SOURCE_LABELS[item.source];
        const isSelected = i === selectedIndex;
        return (
          <button
            key={`${item.command}-${i}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(i);
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left",
              isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
          >
            {/* 来源图标 */}
            <span className={cn("shrink-0 text-[10px]", src.color)} title={src.label || "模糊匹配"}>
              {src.icon}
            </span>
            {/* 命令名 */}
            <span
              className={cn(
                "shrink-0 font-mono text-[12px] font-medium",
                isSelected ? "text-foreground" : "text-foreground/80",
              )}
            >
              {item.command}
            </span>
            {/* 选中标记 */}
            {isSelected && (
              <span className="ml-0.5 shrink-0 text-[9px] text-emerald-500">←</span>
            )}
            {/* 中文翻译（弹性占位） */}
            {item.zh && (
              <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                {item.zh}
              </span>
            )}
            {/* 来源标签（历史/fuzzy） */}
            {!item.zh && item.source !== "dictionary" && (
              <span className={cn("ml-auto shrink-0 text-[9px]", src.color)}>
                {src.label || (item.score != null ? item.score.toFixed(0) : "")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
