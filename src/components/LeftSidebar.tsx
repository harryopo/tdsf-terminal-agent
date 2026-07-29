/**
 * LeftSidebar.tsx — 左侧浮动侧栏 (设计稿 v4.0, 240px)
 * -----------------------------------------------------------------------------
 * 设计稿: view-expanded.html L182-305
 *
 * 布局 (4 段, 从上到下):
 *   ① HOSTS  — 主机列表 (host-01/02/03/04, 含状态指示)
 *   ② FILES  — 文件目录树 (linux-ops/ → nginx/ / scripts/ / logs/)
 *   ③ NEEDS YOU — 待处理收件箱 (审批/错误/问题)
 *   ④ Quick stats — 快速状态 (Mode/Perm/Provider/Tokens)
 *
 * P2-B T-P2-05/06 集成:
 *   - FILES 段添加"打开资源管理器"按钮 (弹出全屏 Explorer)
 *   - FILES 段显示当前 explorerPath + 已打开文件数
 *   - 渲染 <Explorer open={explorerOpen} onClose={...} /> 全屏覆盖
 */
import { useState } from 'react';
import { useRuntime } from '../store/runtime';
import type { SshSessionStateValue } from '../store/runtime';
import { Explorer } from './Explorer';

interface LeftSidebarProps {
  open: boolean;
}

/** SSH 会话状态 → LeftSidebar 显示状态映射 */
const sshStateToSidebarStatus = (
  state: SshSessionStateValue,
): 'active' | 'idle' | 'warning' | 'error' | 'disconnected' => {
  switch (state) {
    case 'connected':
    case 'authenticated':
      return 'active';
    case 'connecting':
    case 'handshaking':
    case 'authenticating':
    case 'host_verifying':
    case 'reconnecting':
      return 'warning';
    case 'failed':
      return 'error';
    case 'closed':
    case 'idle':
    default:
      return 'disconnected';
  }
};

const hostStatusStyle = (
  status: 'active' | 'idle' | 'warning' | 'error' | 'disconnected',
): React.CSSProperties => {
  switch (status) {
    case 'active':
      return { background: 'var(--color-primary)' };
    case 'idle':
      return { background: 'var(--color-text-faint)' };
    case 'warning':
      return { background: 'var(--color-warning)' };
    case 'error':
      return { background: 'var(--color-error)' };
    case 'disconnected':
      return { border: '1.5px solid var(--color-text-faint)', background: 'transparent' };
    default:
      return {};
  }
};

export function LeftSidebar({ open }: LeftSidebarProps) {
  const { state, dispatch } = useRuntime();
  const unresolvedNeeds = state.needsYou.filter((it) => !it.resolved);
  // P2-B T-P2-05/06: Explorer 打开状态 (由 FILES 段按钮触发)
  const [explorerOpen, setExplorerOpen] = useState(false);

  if (!open) return null;

  // 当前激活的 SSH 会话 (用于显示 FILES 段状态)
  const activeSession = state.activeSshFrontendKey === null
    ? null
    : state.sshSessions.find((s) => s.frontendKey === state.activeSshFrontendKey) ?? null;
  const isSshConnected = activeSession !== null && activeSession.id > 0;

  return (
    <>
    <aside
      className="fixed flex flex-col"
      style={{
        top: '44px',
        bottom: '44px',
        left: '12px',
        width: '240px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border-strong)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-panel)',
        zIndex: 30,
        overflow: 'hidden',
        animation: 'panelIn 0.2s ease-out',
      }}
      data-testid="tdsf-sidebar"
    >
      {/* ===== ① HOSTS（从 state.sshSessions 动态读取）===== */}
      <div className="shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          <span
            className="font-semibold tracking-wider uppercase"
            style={{ fontSize: '11px', color: 'var(--color-text-faint)', letterSpacing: '0.8px' }}
          >
            Hosts
          </span>
          <button
            className="transition-colors"
            style={{ color: 'var(--color-text-faint)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--color-primary)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--color-text-faint)')}
            title="新建 SSH 连接"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
        <div className="pb-1">
          {state.sshSessions.length === 0 ? (
            <div
              className="px-3 py-2 text-center"
              style={{
                color: 'var(--color-text-faint)',
                fontSize: '10px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              暂无 SSH 连接
            </div>
          ) : (
            state.sshSessions.map((h) => {
              const sidebarStatus = sshStateToSidebarStatus(h.state);
              const isActive = state.activeSshFrontendKey === h.frontendKey;
              return (
                <div
                  key={h.frontendKey}
                  className="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors"
                  style={{
                    background: isActive ? 'var(--color-primary-soft)' : 'transparent',
                    borderLeft: isActive
                      ? '2px solid var(--color-primary)'
                      : '2px solid transparent',
                  }}
                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'rgba(91,140,255,0.05)'; }}
                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                  onClick={() =>
                    dispatch({
                      type: 'set-active-ssh-session',
                      frontendKey: h.frontendKey,
                    })
                  }
                >
                  {/* 状态点（使用 SshStatusDot 显示 9 态细节）*/}
                  <span className="flex-shrink-0 relative flex items-center justify-center" style={{ width: '8px', height: '8px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', ...hostStatusStyle(sidebarStatus) }} />
                    {sidebarStatus === 'error' && (
                      <span style={{ position: 'absolute', fontSize: '7px', color: '#fff', fontWeight: 700, lineHeight: 1 }}>!</span>
                    )}
                  </span>
                  <span
                    className="font-mono flex-1 truncate"
                    style={{
                      color: isActive
                        ? 'var(--color-text)'
                        : sidebarStatus === 'disconnected'
                          ? 'var(--color-text-faint)'
                          : 'var(--color-text-muted)',
                      fontSize: '11px',
                      fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
                    }}
                  >
                    {h.host}
                  </span>
                  <span className="font-mono truncate flex-shrink-0" style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>
                    :{h.port}
                  </span>
                  {h.error && sidebarStatus === 'error' && (
                    <span className="font-mono truncate flex-shrink-0" style={{ color: 'var(--color-error)', fontSize: '10px' }} title={h.error}>
                      err
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ===== ② FILES (P2-B T-P2-05/06: 点击打开 Explorer 资源管理器) ===== */}
      <div className="shrink-0" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          <span
            className="font-semibold tracking-wider uppercase"
            style={{ fontSize: '11px', color: 'var(--color-text-faint)', letterSpacing: '0.8px' }}
          >
            Files
          </span>
          <button
            className="transition-colors"
            style={{
              color: isSshConnected ? 'var(--color-text-faint)' : 'var(--color-text-faint)',
              opacity: isSshConnected ? 1 : 0.4,
              cursor: isSshConnected ? 'pointer' : 'not-allowed',
            }}
            disabled={!isSshConnected}
            onMouseEnter={(e) => {
              if (isSshConnected) e.currentTarget.style.color = 'var(--color-primary)';
            }}
            onMouseLeave={(e) => {
              if (isSshConnected) e.currentTarget.style.color = 'var(--color-text-faint)';
            }}
            onClick={() => setExplorerOpen(true)}
            title={isSshConnected ? '打开资源管理器' : '请先连接 SSH'}
            aria-label="打开资源管理器"
            data-testid="tdsf-sidebar-open-explorer"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
        </div>
        <div className="pb-2 px-3" style={{ fontFamily: "var(--font-mono), 'JetBrains Mono', monospace", fontSize: '11px', lineHeight: 1.6 }}>
          {isSshConnected ? (
            <>
              {/* 当前路径 */}
              <div
                className="truncate mb-1"
                style={{ color: 'var(--color-primary)', fontSize: '10px' }}
                title={state.explorerPath}
              >
                {state.explorerPath}
              </div>
              {/* 已打开文件数 */}
              {state.openFiles.length > 0 && (
                <div
                  className="flex items-center gap-1"
                  style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}
                >
                  <span style={{ color: 'var(--color-warning)' }}>●</span>
                  <span>{state.openFiles.length} 个文件已打开</span>
                </div>
              )}
              {/* 提示 */}
              <div
                className="mt-1"
                style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}
              >
                点击右上角图标打开资源管理器
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}>
              {state.sshSessions.length === 0 ? '未连接 SSH' : '正在连接...'}
            </div>
          )}
        </div>
      </div>

      {/* ===== ③ NEEDS YOU ===== */}
      <div className="shrink-0 flex-1" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          <span
            className="font-semibold tracking-wider uppercase"
            style={{ fontSize: '11px', color: 'var(--color-text-faint)', letterSpacing: '0.8px' }}
          >
            Needs You
          </span>
          {unresolvedNeeds.length > 0 && (
            <span
              className="flex items-center justify-center rounded-full font-bold"
              style={{
                minWidth: '16px',
                height: '14px',
                padding: '0 4px',
                fontSize: '9px',
                background: 'var(--color-primary)',
                color: '#fff',
              }}
            >
              {unresolvedNeeds.length}
            </span>
          )}
        </div>
        <div className="px-2 pb-2">
          {unresolvedNeeds.slice(0, 3).map((item) => (
            <div
              key={item.id}
              className="rounded px-2 py-2 mb-1"
              style={{ background: 'var(--color-overlay-1, rgba(91,140,255,0.04))', border: '1px solid var(--color-border)' }}
            >
              <div className="flex items-start gap-1.5">
                <span
                  className="mt-0.5 flex-shrink-0"
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: item.type === 'error' ? 'var(--color-error)' : 'var(--color-warning)',
                  }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)', fontSize: '11px' }}>
                      {item.title}
                    </span>
                    <span className="text-[10px] tabular-nums flex-shrink-0" style={{ color: 'var(--color-text-faint)', fontSize: '10px' }}>
                      {new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-1.5">
                    <button
                      className="px-2 py-0.5 rounded font-medium transition-colors"
                      style={{
                        border: '1px solid var(--color-primary)',
                        color: 'var(--color-primary)',
                        fontSize: '10px',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-primary)'; e.currentTarget.style.color = 'var(--color-text-on-primary)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-primary)'; }}
                    >
                      审批
                    </button>
                    <button
                      className="px-2 py-0.5 rounded transition-colors"
                      style={{
                        color: 'var(--color-text-muted)',
                        fontSize: '10px',
                        border: '1px solid var(--color-border)',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ===== ④ Quick stats ===== */}
      <div className="shrink-0 px-3 py-2.5" style={{ borderTop: '1px solid var(--color-border)', background: 'var(--color-surface-active)' }}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1" style={{ fontSize: '11px' }}>
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--color-text-faint)' }}>Mode</span>
            <span style={{ color: 'var(--color-primary)', fontWeight: 500 }}>{state.mode}</span>
          </div>
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--color-text-faint)' }}>Perm</span>
            <span style={{ color: 'var(--color-success)', fontWeight: 500 }}>{state.permMode}</span>
          </div>
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--color-text-faint)' }}>Provider</span>
            <span style={{ color: 'var(--color-text-muted)' }}>Claude</span>
          </div>
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--color-text-faint)' }}>Tokens</span>
            <span className="tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              {state.tokens.toLocaleString()}
            </span>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes panelIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </aside>

      {/* === P2-B T-P2-05/06: Explorer 全屏覆盖 (fixed, zIndex: 60) === */}
      <Explorer open={explorerOpen} onClose={() => setExplorerOpen(false)} />
    </>
  );
}
