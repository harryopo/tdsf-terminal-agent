/**
 * SshCompletionPopup.tsx — SSH 终端命令预测弹窗 (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 类似 fish shell / VS Code 的实时预测面板：
 *   ┌──────────────────────────────┐
 *   │ systemctl  管理 systemd 服务  │  ← 高亮项
 *   │ systemctl  管理 systemd 服务  │
 *   │ ...                           │
 *   └──────────────────────────────┘
 *
 * 命令在左（等宽字体），中文翻译在右（灰色）。
 * 当前选中项高亮，上下键可切换。
 */
import type { CommandDictEntry } from "@/lib/command-dictionary";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

interface Props {
  items: CommandDictEntry[];
  visible: boolean;
  selectedIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}

export function SshCompletionPopup({
  items,
  visible,
  selectedIndex,
  onSelect,
  onClose,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // 选中项滚动到可视区
  useEffect(() => {
    if (!visible || !listRef.current) return;
    const el = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, visible]);

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
      className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-80 overflow-auto rounded-md border border-border bg-popover shadow-xl"
      onClick={(e) => e.stopPropagation()}
    >
      {/* 顶部标题栏 */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
        <span className="text-emerald-500">●</span>
        <span>命令预测</span>
        <span className="ml-auto">↑↓ 选择 · → 接受 · Tab 原生</span>
      </div>
      {/* 预测列表 */}
      {items.map((item, i) => (
        <button
          key={item.command}
          type="button"
          onMouseEnter={() => {
            // 鼠标 hover 不直接选中（避免与键盘冲突），只在 click 时选
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(i);
          }}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left",
            i === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/50",
          )}
        >
          <span
            className={cn(
              "shrink-0 font-mono text-[12px] font-medium",
              i === selectedIndex ? "text-foreground" : "text-foreground/80",
            )}
          >
            {item.command}
          </span>
          {/* 高亮匹配的前缀 */}
          {i === selectedIndex && (
            <span className="ml-0.5 shrink-0 text-[9px] text-emerald-500">
              ←
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
            {item.zh}
          </span>
        </button>
      ))}
    </div>
  );
}
