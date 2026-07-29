/**
 * MultiPlex.tsx — tmux 风格分屏组件 (T-P2-11.2)
 * -----------------------------------------------------------------------------
 * 布局算法 (CSS Grid, 严格用 grid 不用 flexbox):
 *   - tab:     1 col × 1 row (单 pane 占满)
 *   - split-v: 2 cols × 1 row (左右二分, 垂直分屏线)
 *   - split-h: 1 col × 2 rows (上下二分, 水平分屏线)
 *   - grid:    N x M 自动 (cols = ceil(sqrt(N)), rows = ceil(N/cols))
 *
 * 视觉规则 (基于 design tokens):
 *   - pane 边框: var(--color-border) 默认 / var(--color-primary) 聚焦
 *   - pane 标题栏: var(--color-surface) 背景, 24px 高, 等宽字体 11px
 *   - pane 序号: var(--color-primary) 圆形 badge
 *   - 关闭按钮: hover 显示 var(--color-error)
 *   - pane 内容区: 父组件注入 terminalRef 指向的 div
 *
 * 交互:
 *   - 鼠标点击 pane 任意区域 → onPaneFocus(id)
 *   - 点击关闭按钮 → onPaneClose(id) (停止冒泡, 不触发 focus)
 *   - 拖动边界调整大小: P3 实现, 当前版本固定均分
 */
import type { RefObject } from 'react';

// === 1. 类型定义 =============================================================

/**
 * 分屏 pane 视图模型 (含 terminalRef, 由 TerminalMultiplexer 注入)
 *
 * 注意: 此接口与 store 中的 PaneItem 不同 — store 只保存持久元数据 (id/title/isFocused),
 * 而 MultiPlex 接收的 Pane 包含由组件层管理的 terminalRef (xterm 容器 div).
 * 这样分离是为了让 store 保持可序列化 (ref 不可序列化).
 */
export interface Pane {
  /** 持久 ID (pane-1, pane-2, ...) */
  id: string;
  /** 标题栏显示文字 */
  title: string;
  /** xterm 容器 div 的 ref (由 TerminalMultiplexer 创建并管理) */
  terminalRef: RefObject<HTMLDivElement | null>;
  /** 是否聚焦 (仅 1 个 pane 为 true) */
  isFocused: boolean;
}

/**
 * MultiPlex 组件 props
 */
export interface MultiPlexProps {
  /** pane 列表 (1 ~ N 个) */
  panes: Pane[];
  /** 布局类型 */
  layout: 'tab' | 'split-v' | 'split-h' | 'grid';
  /** 当前激活的 pane ID */
  activePaneId: string;
  /** 点击 pane 切换聚焦 */
  onPaneFocus: (id: string) => void;
  /** 关闭 pane */
  onPaneClose: (id: string) => void;
  /** 触发垂直分屏 (左右二分) */
  onSplitV: () => void;
  /** 触发水平分屏 (上下二分) */
  onSplitH: () => void;
}

// === 2. 布局算法 =============================================================

/**
 * 根据 layout + pane 数量计算 grid 模板的 cols/rows
 *
 * @param layout 布局类型
 * @param paneCount pane 数量
 * @returns { cols, rows } 用于 grid-template-columns/rows
 */
function computeGridDims(
  layout: MultiPlexProps['layout'],
  paneCount: number,
): { cols: number; rows: number } {
  const n = Math.max(1, paneCount);
  switch (layout) {
    case 'tab':
      // 单 pane 占满 (即使有多个 pane, 也只显示第 1 个)
      return { cols: 1, rows: 1 };
    case 'split-v':
      // 左右二分: 2 列 × 1 行 (仅适用于 paneCount >= 2, 否则退化为 1×1)
      return n >= 2 ? { cols: 2, rows: 1 } : { cols: 1, rows: 1 };
    case 'split-h':
      // 上下二分: 1 列 × 2 行
      return n >= 2 ? { cols: 1, rows: 2 } : { cols: 1, rows: 1 };
    case 'grid': {
      // N x M 自动网格: cols = ceil(sqrt(N)), rows = ceil(N/cols)
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
    }
    default:
      return { cols: 1, rows: 1 };
  }
}

/**
 * 根据 layout 决定哪些 pane 应该可见
 * - tab: 仅第 1 个 pane 可见 (其余隐藏, 由父组件控制 activePaneId)
 * - 其他: 全部可见
 */
function getVisiblePanes(
  panes: Pane[],
  layout: MultiPlexProps['layout'],
  activePaneId: string,
): Pane[] {
  if (layout === 'tab') {
    // tab 模式: 显示 activePaneId 对应的 pane, 否则显示第 1 个
    const active = panes.find((p) => p.id === activePaneId);
    return active ? [active] : panes.slice(0, 1);
  }
  return panes;
}

// === 3. 组件 =================================================================

export function MultiPlex({
  panes,
  layout,
  activePaneId,
  onPaneFocus,
  onPaneClose,
  onSplitV,
  onSplitH,
}: MultiPlexProps) {
  const visiblePanes = getVisiblePanes(panes, layout, activePaneId);
  const { cols, rows } = computeGridDims(layout, visiblePanes.length);

  // grid 模板: 均分 cols × rows
  const gridTemplateColumns = `repeat(${cols}, 1fr)`;
  const gridTemplateRows = `repeat(${rows}, 1fr)`;

  return (
    <div
      className="w-full h-full"
      style={{
        display: 'grid',
        gridTemplateColumns,
        gridTemplateRows,
        gap: '1px',
        background: 'var(--color-border)', // gap 显示为分隔线
        overflow: 'hidden',
      }}
      data-testid="tdsf-multiplex"
      data-layout={layout}
      data-pane-count={visiblePanes.length}
    >
      {visiblePanes.map((pane, idx) => (
        <PaneView
          key={pane.id}
          pane={pane}
          index={idx + 1}
          onPaneFocus={onPaneFocus}
          onPaneClose={onPaneClose}
          onSplitV={onSplitV}
          onSplitH={onSplitH}
        />
      ))}
    </div>
  );
}

// === 4. 单个 Pane 子组件 =====================================================

interface PaneViewProps {
  pane: Pane;
  /** 序号 (1-based) */
  index: number;
  onPaneFocus: (id: string) => void;
  onPaneClose: (id: string) => void;
  onSplitV: () => void;
  onSplitH: () => void;
}

function PaneView({
  pane,
  index,
  onPaneFocus,
  onPaneClose,
  onSplitV,
  onSplitH,
}: PaneViewProps) {
  const isFocused = pane.isFocused;

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        background: 'var(--terminal-bg)',
        borderTop: isFocused
          ? '2px solid var(--color-primary)'
          : '2px solid transparent',
        cursor: 'default',
      }}
      onMouseDown={() => onPaneFocus(pane.id)}
      data-testid={`tdsf-pane-${pane.id}`}
      data-focused={isFocused ? 'true' : 'false'}
    >
      {/* === 标题栏 (24px) === */}
      <div
        className="flex items-center px-2 shrink-0 select-none"
        style={{
          height: '24px',
          background: isFocused
            ? 'var(--color-surface-active)'
            : 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
          fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
          fontSize: '11px',
          color: isFocused ? 'var(--color-text)' : 'var(--color-text-muted)',
        }}
      >
        {/* 序号 badge */}
        <span
          className="flex items-center justify-center shrink-0"
          style={{
            width: '16px',
            height: '16px',
            borderRadius: 'var(--radius-sm)',
            background: isFocused
              ? 'var(--color-primary)'
              : 'var(--color-text-faint)',
            color: 'var(--color-text-on-primary)',
            fontSize: '10px',
            fontWeight: 600,
            marginRight: '8px',
          }}
        >
          {index}
        </span>

        {/* 标题文字 */}
        <span
          className="flex-1 truncate"
          style={{ minWidth: 0 }}
          title={pane.title}
        >
          {pane.title}
        </span>

        {/* 分屏按钮 (split-v) */}
        <button
          className="flex items-center justify-center shrink-0"
          style={{
            width: '18px',
            height: '18px',
            color: 'var(--color-text-faint)',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            marginRight: '2px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--color-primary)';
            e.currentTarget.style.background = 'var(--color-primary-soft)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--color-text-faint)';
            e.currentTarget.style.background = 'transparent';
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSplitV();
          }}
          title="垂直分屏 (左右)"
          aria-label="垂直分屏"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="1" />
            <line x1="12" y1="3" x2="12" y2="21" />
          </svg>
        </button>

        {/* 分屏按钮 (split-h) */}
        <button
          className="flex items-center justify-center shrink-0"
          style={{
            width: '18px',
            height: '18px',
            color: 'var(--color-text-faint)',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            marginRight: '2px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--color-primary)';
            e.currentTarget.style.background = 'var(--color-primary-soft)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--color-text-faint)';
            e.currentTarget.style.background = 'transparent';
          }}
          onClick={(e) => {
            e.stopPropagation();
            onSplitH();
          }}
          title="水平分屏 (上下)"
          aria-label="水平分屏"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="1" />
            <line x1="3" y1="12" x2="21" y2="12" />
          </svg>
        </button>

        {/* 关闭按钮 */}
        <button
          className="flex items-center justify-center shrink-0"
          style={{
            width: '18px',
            height: '18px',
            color: 'var(--color-text-faint)',
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = 'var(--color-error)';
            e.currentTarget.style.background = 'var(--color-error-soft)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--color-text-faint)';
            e.currentTarget.style.background = 'transparent';
          }}
          onClick={(e) => {
            e.stopPropagation();
            onPaneClose(pane.id);
          }}
          title="关闭 pane"
          aria-label="关闭 pane"
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>

      {/* === 终端容器 (flex-1, 由 terminalRef 挂载 xterm) === */}
      <div
        ref={pane.terminalRef}
        className="flex-1 min-h-0 overflow-hidden"
        style={{
          background: 'var(--terminal-bg)',
          width: '100%',
        }}
        data-testid={`tdsf-pane-terminal-${pane.id}`}
      />
    </div>
  );
}
