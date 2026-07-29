/**
 * Titlebar.tsx — TDSF 顶栏 (设计稿 v4.0, 32px)
 * -----------------------------------------------------------------------------
 * 设计稿: view-expanded.html L38-84
 *
 * 布局 (3 段):
 *   左 280px:  [&gt;_]  TDSF  |  ▾ project  (logo + 项目名)
 *   中 flex-1:  ⬡‿⬡ mood  [plan|agent|yolo]  (状态 + 模式切换)
 *   右 280px:  ⎘ ▦ ⏱ 🔔 1  12:34  (侧栏/日志/设置/通知/时间)
 */
import { useState, useEffect } from 'react';
import { useRuntime, MODE_LIST } from '../store/runtime';

interface TitlebarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  agentPanelOpen: boolean;
  onToggleAgentPanel: () => void;
  onOpenSettings: () => void;
}

export function Titlebar({
  sidebarOpen,
  onToggleSidebar,
  agentPanelOpen: _agentPanelOpen,
  onToggleAgentPanel: _onToggleAgentPanel,
  onOpenSettings,
}: TitlebarProps) {
  const { state, dispatch } = useRuntime();
  const [time, setTime] = useState('');

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

  const moodColor = `var(--color-mood-${state.mood})`;
  const needsCount = state.needsYou.filter((it) => !it.resolved).length;

  const toggleTheme = () => {
    const html = document.documentElement;
    const cur = html.getAttribute('data-theme') || 'dark';
    html.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  };

  return (
    <header
      className="fixed top-0 left-0 right-0 flex items-center px-3 shrink-0 select-none"
      style={{
        height: '32px',
        background: 'var(--color-bg)',
        borderBottom: '1px solid var(--color-border)',
        zIndex: 50,
        ...({ WebkitAppRegion: 'drag' } as React.CSSProperties),
      }}
    >
      {/* ===== 左: logo + 项目名 (280px) ===== */}
      <div className="flex items-center gap-2" style={{ minWidth: '280px' }}>
        <span
          className="font-bold"
          style={{
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            color: 'var(--color-primary)',
            fontSize: '12px',
          }}
        >
          [&gt;_]
        </span>
        <span
          className="font-bold tracking-wide"
          style={{ color: 'var(--color-text)', fontSize: '12px' }}
        >
          TDSF
        </span>
        <span style={{ color: 'var(--color-text-faint)', margin: '0 4px' }}>|</span>
        <button
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs transition-colors"
          style={{
            color: 'var(--color-text-muted)',
            fontSize: '12px',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span>local</span>
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ color: 'var(--color-text-faint)' }}>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* ===== 中: mood + mode switcher ===== */}
      <div className="flex items-center justify-center flex-1 gap-3">
        <span
          className="text-xs tracking-wide"
          style={{
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            color: moodColor,
            fontSize: '12px',
            letterSpacing: '0.5px',
          }}
        >
          ⬡‿⬡ {state.mood}
        </span>

        {/* mode 三态切换 (Segmented Control) */}
        <div
          className="flex p-0.5 rounded-full"
          style={{ background: 'var(--color-surface)', height: '24px' }}
        >
          {MODE_LIST.map((m) => (
            <button
              key={m.value}
              onClick={() => dispatch({ type: 'set-mode', mode: m.value })}
              className="px-3 rounded-full transition-colors"
              style={{
                height: '20px',
                fontSize: '11px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                background: state.mode === m.value ? 'var(--color-primary)' : 'transparent',
                color: state.mode === m.value ? 'var(--color-text-on-primary)' : 'var(--color-text-muted)',
                fontWeight: state.mode === m.value ? 600 : 400,
              }}
              title={m.desc}
            >
              {m.value}
            </button>
          ))}
        </div>
      </div>

      {/* ===== 右: 窗口控制 (280px) ===== */}
      <div className="flex items-center gap-0.5 justify-end" style={{ minWidth: '280px' }}>
        {/* 侧栏开关 */}
        <button
          onClick={onToggleSidebar}
          className="w-7 h-7 flex items-center justify-center rounded transition-colors"
          style={{
            color: sidebarOpen ? 'var(--color-primary)' : 'var(--color-text-muted)',
            background: sidebarOpen ? 'rgba(91,140,255,0.1)' : 'transparent',
          }}
          title="侧边栏 (Ctrl+B)"
          onMouseEnter={(e) => { if (!sidebarOpen) e.currentTarget.style.background = 'rgba(91,140,255,0.1)'; }}
          onMouseLeave={(e) => { if (!sidebarOpen) e.currentTarget.style.background = 'transparent'; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="9" y1="3" x2="9" y2="21"/>
          </svg>
        </button>

        {/* 主题切换 */}
        <button
          onClick={toggleTheme}
          className="w-7 h-7 flex items-center justify-center rounded transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          title="主题"
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
        </button>

        {/* 命令日志 */}
        <button
          className="w-7 h-7 flex items-center justify-center rounded transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          title="命令日志"
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>

        {/* 设置 */}
        <button
          onClick={onOpenSettings}
          className="w-7 h-7 flex items-center justify-center rounded transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          title="设置"
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>

        {/* 通知铃铛 + badge */}
        <button
          className="w-7 h-7 flex items-center justify-center rounded transition-colors relative"
          style={{ color: 'var(--color-text-muted)' }}
          title="通知"
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(91,140,255,0.1)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
          {needsCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 flex items-center justify-center rounded-full font-bold"
              style={{
                width: '14px',
                height: '14px',
                fontSize: '9px',
                background: 'var(--color-error)',
                color: '#fff',
              }}
            >
              {needsCount}
            </span>
          )}
        </button>

        {/* 时间 */}
        <span
          className="ml-1 tabular-nums"
          style={{
            color: 'var(--color-text-muted)',
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            fontSize: '12px',
            minWidth: '40px',
            textAlign: 'right' as const,
          }}
        >
          {time}
        </span>
      </div>
    </header>
  );
}
