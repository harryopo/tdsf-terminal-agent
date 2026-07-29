/**
 * StatusBar.tsx — TDSF 底部状态栏 (设计稿 v4.0, 24px 3 段式)
 * -----------------------------------------------------------------------------
 * 设计稿: view-expanded.html L169-178
 *
 * 布局:
 *   左: ⬡‿⬡ mood 状态文字 + StatusBar 4 状态徽章
 *   中: SSH: 3 connected │ Mode: Agent │ Perm: L1 │ Active: N agents │ Latency: 42ms
 *   右: tokens │ CPU 12% │ MEM 340MB │ 时间
 *
 * P4 T-P4-05 扩展:
 *   - 新增 StatusBar 4 状态徽章（idle/herd/solo/review）
 *   - 显示活跃 Agent 数量
 *   - 状态颜色与图标区分
 */
import { useEffect, useState } from 'react';
import { useRuntime, type StatusBarState } from '../store/runtime';

// === StatusBar 4 状态配置 ====================================================
const STATUSBAR_STATE_CONFIG: Record<
  StatusBarState,
  { label: string; icon: string; color: string; bg: string }
> = {
  idle: {
    label: 'idle',
    icon: '○',
    color: 'var(--color-text-muted)',
    bg: 'rgba(148,163,184,0.1)',
  },
  herd: {
    label: 'herd',
    icon: '⬡⬡⬡',
    color: 'var(--color-primary)',
    bg: 'rgba(91,140,255,0.15)',
  },
  solo: {
    label: 'solo',
    icon: '⬡',
    color: 'var(--color-success)',
    bg: 'rgba(52,211,153,0.15)',
  },
  review: {
    label: 'review',
    icon: '!',
    color: 'var(--color-warning)',
    bg: 'rgba(251,191,36,0.15)',
  },
};

export function StatusBar() {
  const { state } = useRuntime();
  const [time, setTime] = useState('');
  const [cpu, setCpu] = useState(12);
  const [mem, setMem] = useState(340);

  // 实时时钟
  useEffect(() => {
    const update = () => {
      const d = new Date();
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      setTime(`${h}:${m}`);
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  // 模拟系统指标更新 (P2 换真数据)
  useEffect(() => {
    const id = setInterval(() => {
      setCpu((c) => Math.max(1, Math.min(99, c + Math.round((Math.random() - 0.5) * 10))));
      setMem((m) => Math.max(200, Math.min(800, m + Math.round((Math.random() - 0.5) * 20))));
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  const moodColor = `var(--color-mood-${state.mood})`;
  const needsCount = state.needsYou.filter((it) => !it.resolved).length;

  // === T-P4-05: StatusBar 4 状态自动计算 ===
  // 优先级：review > herd > solo > idle
  // - review: 有 pending needs-you（等待用户审批）
  // - herd:   活跃 Agent 数 > 1（多 Agent 并行）
  // - solo:   活跃 Agent 数 = 1（单 Agent 执行）
  // - idle:   无 Agent 活动
  const computedStatusBarState: StatusBarState =
    needsCount > 0
      ? 'review'
      : state.activeAgentCount > 1
        ? 'herd'
        : state.activeAgentCount === 1
          ? 'solo'
          : 'idle';

  // 使用 computed 值（如果 dispatch 未及时更新）
  const currentState = state.statusBarState || computedStatusBarState;
  const stateConfig = STATUSBAR_STATE_CONFIG[currentState];

  return (
    <footer
      className="flex items-center px-3 gap-3 shrink-0 select-none"
      style={{
        height: '24px',
        background: 'var(--color-surface)',
        borderTop: '1px solid var(--color-border)',
        fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
        fontSize: '11px',
      }}
      data-testid="tdsf-statusbar"
    >
      {/* 左: mood + StatusBar 状态徽章 */}
      <span style={{ color: moodColor, letterSpacing: '0.3px' }}>
        ⬡‿⬡ {state.mood}
      </span>
      <span
        className="flex items-center gap-1 px-1.5 py-0.5 rounded font-medium"
        style={{
          color: stateConfig.color,
          background: stateConfig.bg,
          fontSize: '10px',
          border: `1px solid ${stateConfig.color}33`,
        }}
        data-testid="tdsf-statusbar-state"
        title={`StatusBar 状态: ${stateConfig.label}`}
      >
        <span style={{ fontFamily: 'inherit' }}>{stateConfig.icon}</span>
        <span>{stateConfig.label}</span>
      </span>

      {/* 中: 系统指标 */}
      <div
        className="flex-1 text-center"
        style={{ color: 'var(--color-text-muted)' }}
      >
        SSH: {needsCount > 0 ? `${needsCount} pending` : 'connected'} │ Mode:{' '}
        <span style={{ color: 'var(--color-primary)' }}>{state.mode}</span> │
        Perm: <span style={{ color: 'var(--color-success)' }}>{state.permMode}</span>{' '}
        │ Active:{' '}
        <span
          style={{
            color:
              state.activeAgentCount > 0
                ? 'var(--color-primary)'
                : 'var(--color-text-muted)',
          }}
          data-testid="tdsf-statusbar-active-count"
        >
          {state.activeAgentCount} agents
        </span>{' '}
        │ Latency: 42ms
      </div>

      {/* 右: tokens + 系统 + 时间 */}
      <div
        className="tabular-nums flex items-center gap-3"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <span>{state.tokens.toLocaleString()}/200K tokens</span>
        <span>CPU {cpu}%</span>
        <span>MEM {mem}MB</span>
        <span style={{ minWidth: '32px', textAlign: 'right' as const }}>
          {time}
        </span>
      </div>
    </footer>
  );
}
