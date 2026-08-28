/**
 * TerminalSearchBar — 终端内搜索浮层（B1-G4，TDSF 魔改 2026-08-28）
 * -----------------------------------------------------------------------------
 * 由 terminal.find 快捷键（Ctrl/Cmd+Shift+F）触发；持有当前 leaf 的 SearchAddon
 * （useTerminalSession.getSearchAddon）直调 findNext/findPrevious，不重挂 slot。
 * Esc 关闭（清高亮 clearDecorations）；无匹配时显示提示。
 */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { getSearchAddon } from "./lib/useTerminalSession";

type Props = {
  leafId: number;
  open: boolean;
  onClose: () => void;
};

export function TerminalSearchBar({ leafId, open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时聚焦输入框并预填选区文本（后续实现）；关闭时清高亮
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.select());
  }, [open, leafId]);

  if (!open) return null;

  const search = (direction: 1 | -1) => {
    const addon = getSearchAddon(leafId);
    if (!addon || !query) return;
    const opts = { caseSensitive };
    const ok =
      direction === 1
        ? addon.findNext(query, opts)
        : addon.findPrevious(query, opts);
    setNoMatch(!ok);
  };

  const close = () => {
    getSearchAddon(leafId)?.clearDecorations();
    setNoMatch(false);
    onClose();
  };

  return (
    <div
      className="absolute top-2 right-3 z-20 flex items-center gap-1 rounded-md border bg-popover/95 px-1.5 py-1 shadow-md backdrop-blur"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setNoMatch(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            search(e.shiftKey ? -1 : 1);
          }
        }}
        placeholder="在终端中查找…"
        className={cn(
          "h-6 w-44 bg-transparent px-1.5 text-xs outline-none",
          "placeholder:text-muted-foreground/60",
        )}
        // 拦截 keydown 冒泡：避免全局快捷键（如 Ctrl+F）在搜索框内再触发
        onKeyDownCapture={(e) => {
          const k = e.key.toLowerCase();
          if ((e.ctrlKey || e.metaKey) && k === "f") {
            e.preventDefault();
            e.stopPropagation();
            search(1);
          }
        }}
      />
      <Button
        variant="ghost"
        size="icon"
        title="区分大小写"
        className={cn("size-6 text-[11px] font-semibold")}
        onClick={() => {
          setCaseSensitive((v) => !v);
          setNoMatch(false);
        }}
      >
        <span className={cn(caseSensitive ? "opacity-100" : "opacity-50")}>
          Aa
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="上一个（Shift+Enter）"
        className="size-6"
        onClick={() => search(-1)}
      >
        <span className="text-xs">↑</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="下一个（Enter）"
        className="size-6"
        onClick={() => search(1)}
      >
        <span className="text-xs">↓</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="关闭（Esc）"
        className="size-6"
        onClick={close}
      >
        <span className="text-xs leading-none">×</span>
      </Button>
      {noMatch && (
        <span className="pr-1 text-[11px] text-muted-foreground">无匹配</span>
      )}
    </div>
  );
}
