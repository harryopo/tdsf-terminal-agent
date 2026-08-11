/**
 * TerminalCompletionPopup.tsx — 终端命令预测弹窗（通用版，TDSF 2026-08-09）
 * -----------------------------------------------------------------------------
 * 订阅 completionInjection 的状态，渲染 fish-shell 风格的命令预测弹窗。
 * 同时适用于本地终端和 SSH 终端（因为拦截器统一注入到 rendererPool）。
 *
 * 定位：跟随当前活跃的终端面板，浮动在光标附近。
 * -----------------------------------------------------------------------------
 */
import type { SuggestionResult } from '@/lib/suggest-engine';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import {
  closeCompletion,
  selectCompletionByIndex,
  subscribeCompletion,
  type CompletionState,
} from '@/modules/terminal/lib/completionInjection';

/** 来源标签 */
const SOURCE_LABELS: Record<
  SuggestionResult['source'],
  { icon: string; label: string; color: string }
> = {
  history: { icon: '⏱', label: '历史', color: 'text-blue-500' },
  dictionary: { icon: '📖', label: '', color: 'text-muted-foreground' },
  fuzzy: { icon: '⚡', label: '', color: 'text-amber-500' },
};

export function TerminalCompletionPopup() {
  const [state, setState] = useState<CompletionState>({
    visible: false,
    items: [],
    selectedIndex: 0,
    prefix: '',
    leafId: null,
  });
  const listRef = useRef<HTMLDivElement>(null);
  // 弹窗相对终端面板的定位（null 时回退到屏幕底部居中）
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  // 订阅补全状态
  useEffect(() => {
    return subscribeCompletion(setState);
  }, []);

  // 跟随终端面板定位：按 leafId 找到对应终端容器（data-pane-leaf），
  // 弹窗浮动在该容器底部居中。监听 resize 以应对分栏/窗口缩放。
  useEffect(() => {
    if (!state.visible || state.leafId === null) {
      setPos(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector<HTMLElement>(
        `[data-pane-leaf="${state.leafId}"]`,
      );
      if (!el) {
        setPos(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setPos({
        left: rect.left + rect.width / 2,
        bottom: window.innerHeight - rect.bottom,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [state.visible, state.leafId]);

  // 选中项滚动到可视区域
  useEffect(() => {
    if (!state.visible || !listRef.current) return;
    const el = listRef.current.children[state.selectedIndex] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [state.selectedIndex, state.visible]);

  // 点击外部关闭
  useEffect(() => {
    if (!state.visible) return;
    const onClick = () => closeCompletion();
    const timer = setTimeout(() => {
      window.addEventListener('click', onClick, { once: true });
    }, 100);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', onClick);
    };
  }, [state.visible]);

  if (!state.visible || state.items.length === 0) return null;

  return (
    <div
      ref={listRef}
      data-no-drag
      style={pos ?? undefined}
      className={cn(
        'fixed bottom-12 left-1/2 z-50 mb-2 max-h-64 w-96 -translate-x-1/2',
        'overflow-auto rounded-lg border border-border bg-popover/95 shadow-2xl backdrop-blur-md',
        'animate-in fade-in-0 zoom-in-95 duration-150',
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 顶部提示栏 */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1 text-[10px] text-muted-foreground">
        <span className="text-emerald-500">●</span>
        <span>命令预测</span>
        <span className="ml-auto">↑↓ 选择 · → 接受 · Tab 原生 · Esc 关闭</span>
      </div>
      {/* 预测列表 */}
      {state.items.map((item, i) => {
        const src = SOURCE_LABELS[item.source];
        const isSelected = i === state.selectedIndex;
        return (
          <button
            key={`${item.command}-${i}`}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              selectCompletionByIndex(i);
            }}
            className={cn(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left',
              isSelected
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50',
            )}
          >
            {/* 来源图标 */}
            <span
              className={cn('shrink-0 text-[10px]', src.color)}
              title={src.label || '模糊匹配'}
            >
              {src.icon}
            </span>
            {/* 命令名 */}
            <span
              className={cn(
                'shrink-0 font-mono text-[12px] font-medium',
                isSelected ? 'text-foreground' : 'text-foreground/80',
              )}
            >
              {item.command}
            </span>
            {/* 选中标记 */}
            {isSelected && (
              <span className="ml-0.5 shrink-0 text-[9px] text-emerald-500">
                ←
              </span>
            )}
            {/* 中文翻译 */}
            {item.zh && (
              <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">
                {item.zh}
              </span>
            )}
            {/* 来源标签 */}
            {!item.zh && item.source !== 'dictionary' && (
              <span className={cn('ml-auto shrink-0 text-[9px]', src.color)}>
                {src.label ||
                  (item.score != null ? item.score.toFixed(0) : '')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
