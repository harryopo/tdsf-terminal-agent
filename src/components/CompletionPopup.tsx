/**
 * CompletionPopup.tsx — 终端补全弹窗 (T-P2-10.3)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 显示 Frecency 排序后的补全候选 (5-10 项)
 *   2. 上下箭头选择, Tab/Enter 确认, Esc 关闭
 *   3. 显示命令使用次数 + 最近使用相对时间 (如 "5m ago")
 *   4. 跟随光标定位, 不超过视窗边界
 *
 * 样式约束:
 *   - 颜色全部用 var(--color-*) CSS 变量
 *   - 字体用 var(--font-mono) / JetBrains Mono 回退
 *   - 间距用 var(--space-*) 4px 栅格
 *
 * 集成方式 (T-P2-10.4):
 *   - Terminal.tsx / SshTerminal.tsx 通过 xterm.attachCustomKeyEventHandler 拦截 Tab
 *   - 解析当前光标行输入, 调用 CompletionEngine.complete()
 *   - 渲染 <CompletionPopup> 到终端容器上方 (绝对定位)
 * -----------------------------------------------------------------------------
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { type CompletionItem, formatRelativeTime } from '../lib/completion';

// ============================================================================
// Props 类型
// ============================================================================

export interface CompletionPopupProps {
  /** 候选命令列表 (已 Frecency 排序) */
  readonly items: ReadonlyArray<CompletionItem>;
  /** 用户输入的前缀 (用于高亮匹配部分) */
  readonly prefix: string;
  /** 弹窗定位 (相对父容器的 px 坐标, 通常对齐光标位置) */
  readonly position: { x: number; y: number };
  /** 选中命令 (Tab/Enter 触发) */
  readonly onSelect: (command: string) => void;
  /** 关闭弹窗 (Esc 触发) */
  readonly onClose: () => void;
}

// ============================================================================
// CompletionPopup 组件
// ============================================================================

export function CompletionPopup({
  items,
  prefix,
  position,
  onSelect,
  onClose,
}: CompletionPopupProps): React.ReactElement | null {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 候选变化时重置选中项到第一个 (Frecency 最高分)
  useEffect(() => {
    setSelectedIdx(0);
  }, [items]);

  // 滚动到选中项 (键盘上下移动时)
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIdx] as HTMLElement | undefined;
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIdx]);

  // 键盘事件监听 (在弹窗挂载期间拦截文档级键盘事件)
  // 注: xterm.attachCustomKeyEventHandler 会在弹窗显示前拦截,
  //     这里监听文档是为了处理弹窗已显示后的 Tab/Arrow/Esc
  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIdx((idx) => Math.min(idx + 1, items.length - 1));
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          e.stopPropagation();
          setSelectedIdx((idx) => Math.max(idx - 1, 0));
          break;
        }
        case 'Tab':
        case 'Enter': {
          e.preventDefault();
          e.stopPropagation();
          const item = items[selectedIdx];
          if (item) {
            onSelect(item.command);
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        }
        default:
          // 其他键不处理 (交给 xterm 输入)
          break;
      }
    };

    // capture 阶段拦截, 优先于 xterm 的 keydown
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [items, selectedIdx, onSelect, onClose]);

  // 高亮匹配前缀部分 (useCallback 必须在 early return 之前调用, 否则违反 hooks 规则)
  const renderCommand = useCallback(
    (cmd: string): React.ReactNode => {
      if (prefix.length === 0 || !cmd.startsWith(prefix)) {
        return cmd;
      }
      return (
        <>
          <span style={{ color: 'var(--color-primary-bright)' }}>{prefix}</span>
          <span style={{ color: 'var(--color-text)' }}>
            {cmd.slice(prefix.length)}
          </span>
        </>
      );
    },
    [prefix],
  );

  // 空候选列表不渲染
  if (items.length === 0) return null;

  return (
    <div
      data-testid="completion-popup"
      style={{
        position: 'absolute',
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 1500,
        minWidth: '260px',
        maxWidth: '460px',
        maxHeight: '280px',
        overflow: 'hidden',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-high)',
        fontFamily: "var(--font-mono), 'JetBrains Mono', 'Maple Mono NF', monospace",
        fontSize: '12px',
      }}
    >
      {/* 候选列表 */}
      <div
        ref={listRef}
        style={{
          maxHeight: '280px',
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {items.map((item, idx) => {
          const isSelected = idx === selectedIdx;
          return (
            <div
              key={`${item.command}-${idx}`}
              role="option"
              aria-selected={isSelected}
              data-selected={isSelected}
              data-testid={`completion-item-${idx}`}
              onMouseEnter={() => setSelectedIdx(idx)}
              onMouseDown={(e) => {
                // 阻止 xterm 抢焦点
                e.preventDefault();
                e.stopPropagation();
                onSelect(item.command);
              }}
              style={{
                padding: '4px 12px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                background: isSelected
                  ? 'var(--color-primary-soft)'
                  : 'transparent',
                color: 'var(--color-text)',
                lineHeight: '1.4',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {/* 命令文本 */}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flex: '1 1 auto',
                }}
              >
                {renderCommand(item.command)}
              </span>

              {/* 元数据: 使用次数 + 最近时间 */}
              <span
                style={{
                  flex: '0 0 auto',
                  fontSize: '10px',
                  color: 'var(--color-text-faint)',
                  fontFamily:
                    "var(--font-mono), 'JetBrains Mono', monospace",
                  userSelect: 'none',
                }}
              >
                {item.useCount > 0 ? `×${item.useCount}` : ''}
                {item.useCount > 0 && item.lastUsedMs > 0 ? ' · ' : ''}
                {item.lastUsedMs > 0
                  ? formatRelativeTime(item.lastUsedMs)
                  : ''}
              </span>
            </div>
          );
        })}
      </div>

      {/* 底部快捷键提示 */}
      <div
        style={{
          padding: '4px 12px',
          borderTop: '1px solid var(--color-border)',
          background: 'var(--color-surface-active)',
          color: 'var(--color-text-faint)',
          fontSize: '10px',
          fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
          display: 'flex',
          justifyContent: 'space-between',
          gap: '12px',
          userSelect: 'none',
        }}
      >
        <span>↑↓ 选择</span>
        <span>Tab 确认</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  );
}
