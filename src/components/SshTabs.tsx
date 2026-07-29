/**
 * SshTabs.tsx — SSH 多标签管理 (P2-B T-P2-04)
 * -----------------------------------------------------------------------------
 * Tab 栏 UI 组件，管理 local + N 个 SSH 会话的切换。
 *
 * 设计（与 App.tsx TabBar 风格一致）:
 *   - 高度 28px，等宽字体 11px
 *   - active tab: surface-active 背景 + primary 底边框
 *   - inactive tab: 透明背景，hover 时浅蓝高亮
 *   - 每 tab 含状态点（SshStatusDot）+ host 名 + 关闭按钮（仅 SSH）
 *   - 末尾 + 按钮打开 SshConnectDialog
 *
 * 状态管理（基于 frontendKey 持久标识）:
 *   - local tab: activeSshFrontendKey === null
 *   - ssh tab: activeSshFrontendKey === session.frontendKey
 *   - 关闭 ssh tab: 调用 sshDisconnect（id>=0 时）+ dispatch remove-ssh-session
 *   - 关闭后自动切到最后一个 tab（或 local）
 */
import { useState } from 'react';
import { useRuntime } from '../store/runtime';
import { SshStatusDot } from './SshStatusDot';
import { sshDisconnect } from '../lib/ssh-bridge';

interface SshTabsProps {
  /** 打开连接弹窗回调 */
  onOpenConnectDialog: () => void;
}

export function SshTabs({ onOpenConnectDialog }: SshTabsProps) {
  const { state, dispatch } = useRuntime();
  const [hoveredTab, setHoveredTab] = useState<string | null>(null);

  const activeKey = state.activeSshFrontendKey;

  // === 切换 tab ===
  const switchTo = (frontendKey: string | null) => {
    dispatch({ type: 'set-active-ssh-session', frontendKey });
  };

  // === 关闭 SSH tab ===
  const closeSshTab = async (
    e: React.MouseEvent,
    frontendKey: string,
    sessionId: number,
  ) => {
    e.stopPropagation();
    // 先从 state 移除（立即响应 UI）
    dispatch({ type: 'remove-ssh-session', frontendKey });
    // 异步断开 Rust 端连接（仅当 sessionId 有效时调用，id=-1 表示连接未建立）
    if (sessionId >= 0) {
      try {
        await sshDisconnect(sessionId);
      } catch (err) {
        console.warn('[SshTabs] disconnect failed:', err);
      }
    }
  };

  return (
    <div
      className="flex items-center h-full"
      data-testid="tdsf-ssh-tabs"
    >
      {/* ===== Local tab（永远在最前）===== */}
      <TabButton
        label="local"
        active={activeKey === null}
        hovered={hoveredTab === 'local'}
        onClick={() => switchTo(null)}
        onMouseEnter={() => setHoveredTab('local')}
        onMouseLeave={() => setHoveredTab(null)}
        dotColor="var(--color-primary)"
      />

      {/* ===== SSH tabs ===== */}
      {state.sshSessions.map((session) => (
        <TabButton
          key={session.frontendKey}
          label={session.host}
          active={activeKey === session.frontendKey}
          hovered={hoveredTab === session.frontendKey}
          onClick={() => switchTo(session.frontendKey)}
          onMouseEnter={() => setHoveredTab(session.frontendKey)}
          onMouseLeave={() => setHoveredTab(null)}
          onClose={
            activeKey === session.frontendKey ||
            hoveredTab === session.frontendKey
              ? (e) => closeSshTab(e, session.frontendKey, session.id)
              : undefined
          }
          statusDot={
            <SshStatusDot
              state={session.state}
              error={session.error}
              host={session.host}
              port={session.port}
              user={session.user}
              size={8}
            />
          }
        />
      ))}

      {/* ===== + 新建 SSH 连接按钮 ===== */}
      <button
        className="flex items-center justify-center w-8 h-full"
        onClick={onOpenConnectDialog}
        title="新建 SSH 连接"
        style={{ color: 'var(--color-text-faint)' }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = 'rgba(91,140,255,0.05)')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = 'transparent')
        }
        data-testid="tdsf-ssh-new-tab"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

// === 内部 TabButton 组件 =====================================================

interface TabButtonProps {
  label: string;
  active: boolean;
  hovered: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** 状态点颜色（local tab 用）或 SshStatusDot 组件（SSH tab 用） */
  dotColor?: string;
  statusDot?: React.ReactNode;
  /** 关闭按钮回调（仅 SSH tab 提供） */
  onClose?: (e: React.MouseEvent) => void;
}

function TabButton({
  label,
  active,
  hovered,
  onClick,
  onMouseEnter,
  onMouseLeave,
  dotColor,
  statusDot,
  onClose,
}: TabButtonProps) {
  return (
    <div
      className="relative flex items-center h-full px-3 gap-1.5 cursor-pointer transition-colors"
      style={{
        background: active
          ? 'var(--color-surface-active)'
          : hovered
            ? 'rgba(91,140,255,0.05)'
            : 'transparent',
        borderBottom: active
          ? '2px solid var(--color-primary)'
          : '2px solid transparent',
      }}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid={`tdsf-ssh-tab-${label}`}
    >
      {/* 状态点（local 用 dotColor，SSH 用 statusDot） */}
      {statusDot ? (
        statusDot
      ) : (
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: dotColor || 'var(--color-primary)',
            flexShrink: 0,
          }}
        />
      )}

      {/* 标签文字 */}
      <span
        className="text-xs font-mono truncate"
        style={{
          color: active
            ? 'var(--color-text)'
            : 'var(--color-text-muted)',
          fontSize: '11px',
          fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
          maxWidth: '120px',
        }}
      >
        {label}
      </span>

      {/* 关闭按钮（仅 SSH tab，hover 或 active 时显示） */}
      {onClose && (
        <button
          className="flex items-center justify-center ml-1 rounded transition-colors"
          style={{
            width: '14px',
            height: '14px',
            color: 'var(--color-text-faint)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
          onClick={onClose}
          onMouseEnter={(e) => {
            e.stopPropagation();
            e.currentTarget.style.color = 'var(--color-error)';
            e.currentTarget.style.background = 'rgba(248,113,113,0.1)';
          }}
          onMouseLeave={(e) => {
            e.stopPropagation();
            e.currentTarget.style.color = 'var(--color-text-faint)';
            e.currentTarget.style.background = 'transparent';
          }}
          title="关闭连接"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
