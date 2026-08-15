/**
 * TerminalCompletionPopup.tsx — 终端命令预测弹窗（通用版，TDSF 2026-08-09）
 * -----------------------------------------------------------------------------
 * 订阅 completionInjection 的状态，渲染 fish-shell 风格的命令预测弹窗。
 * 同时适用于本地终端和 SSH 终端（因为拦截器统一注入到 rendererPool）。
 *
 * 定位（P2 #13，2026-08-11）：优先跟随终端光标（state.cursor 像素坐标），
 * 弹窗出现在光标附近（computePopupPosition 处理视口边界/上下翻转）；
 * 无 xterm 实例（cursor 为 null）时回退到跟随活跃终端面板底部居中。
 * -----------------------------------------------------------------------------
 */
import type { CSSProperties } from 'react';
import type { SuggestionResult } from '@/lib/suggest-engine';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';
import {
  closeCompletion,
  computePopupPosition,
  selectCompletionByIndex,
  subscribeCompletion,
  type CompletionState,
} from '@/modules/terminal/lib/completionInjection';

/** 来源标签（TDSF 2026-08-15: 去除 emoji 图标，仅保留文字标签） */
const SOURCE_LABELS: Record<
  SuggestionResult['source'],
  { label: string; color: string }
> = {
  history: { label: '历史', color: 'text-blue-500' },
  dictionary: { label: '', color: 'text-muted-foreground' },
  fuzzy: { label: '模糊', color: 'text-amber-500' },
};

export function TerminalCompletionPopup() {
  const [state, setState] = useState<CompletionState>({
    visible: false,
    items: [],
    selectedIndex: 0,
    prefix: '',
    leafId: null,
    cursor: null,
  });
  const listRef = useRef<HTMLDivElement>(null);
  // 弹窗定位：null = 不渲染定位样式（回退默认）。mode: 'cursor' 用 left/top，
  // 'panel' 用 left/bottom（跟随面板底部居中）。
  const [anchor, setAnchor] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    mode: 'cursor' | 'panel';
  } | null>(null);

  // 订阅补全状态
  useEffect(() => {
    return subscribeCompletion(setState);
  }, []);

  // 定位：优先跟随光标（P2 #13），无光标坐标时跟随终端面板底部居中。
  // 监听 resize 以应对分栏/窗口缩放。
  useEffect(() => {
    if (!state.visible || state.leafId === null) {
      setAnchor(null);
      return;
    }
    const measure = () => {
      if (state.cursor) {
        const pos = computePopupPosition(
          state.cursor,
          { width: window.innerWidth, height: window.innerHeight },
          state.items.length,
        );
        setAnchor({ left: pos.left, top: pos.top, mode: 'cursor' });
        return;
      }
      const el = document.querySelector<HTMLElement>(
        `[data-pane-leaf="${state.leafId}"]`,
      );
      if (!el) {
        setAnchor(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setAnchor({
        left: rect.left + rect.width / 2,
        bottom: window.innerHeight - rect.bottom,
        mode: 'panel',
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [state.visible, state.leafId, state.cursor, state.items.length]);

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

  // 定位样式：光标模式用 left/top（已由 computePopupPosition 处理边界），
  // 面板模式用 left/bottom + 水平居中（translate 抵消）
  const style: CSSProperties | undefined = anchor
    ? anchor.mode === 'cursor'
      ? { left: anchor.left, top: anchor.top }
      : { left: anchor.left, bottom: anchor.bottom }
    : undefined;

  return (
    <div
      ref={listRef}
      data-no-drag
      style={style}
      className={cn(
        'fixed z-50 mb-2 max-h-64 w-96 overflow-auto rounded-lg border border-border bg-popover/95 shadow-2xl backdrop-blur-md',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        // 面板模式水平居中；光标模式完全由 style 控制
        anchor?.mode === 'panel' && 'bottom-12 left-1/2 -translate-x-1/2',
        !anchor && 'bottom-12 left-1/2 -translate-x-1/2',
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
            {/* 命令名 */}
            <span
              className={cn(
                'shrink-0 font-mono text-[12px] font-medium',
                isSelected ? 'text-foreground' : 'text-foreground/80',
              )}
            >
              {item.command}
            </span>
            {/* 中文翻译：紧跟命令，中间可收缩截断，避免右侧来源标签被挤出 */}
            {item.zh && (
              <span
                className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground"
                title={item.zh}
              >
                {item.zh}
              </span>
            )}
            {/* 来源标签（固定最右） */}
            <span className={cn('ml-auto shrink-0 text-[9px]', src.color)}>
              {src.label || (item.score != null ? item.score.toFixed(0) : '')}
            </span>
          </button>
        );
      })}
    </div>
  );
}
