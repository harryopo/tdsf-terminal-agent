/**
 * SshStatusDot.tsx — SSH 会话状态点 (P2-B T-P2-04)
 * -----------------------------------------------------------------------------
 * 9 态有限状态机的可视化指示器，与 Rust SshSessionState 枚举对齐。
 *
 * 状态颜色编码（与 LeftSidebar hostStatusStyle 风格一致）:
 *   idle            灰色边框透明底   未连接
 *   connecting      黄色脉冲         TCP 连接中
 *   handshaking     黄色脉冲         SSH 握手中
 *   host_verifying  黄色 + "?"      TOFU 待用户确认
 *   authenticating  黄色             认证中
 *   authenticated   蓝色             已认证
 *   connected       绿色             已连接（活动）
 *   reconnecting    黄色脉冲         重连中
 *   failed          红色 + "!"      错误
 *   closed          灰色             已关闭
 *
 * 用途:
 *   - SshTabs 每 tab 状态点
 *   - LeftSidebar HOSTS 列表状态点
 *   - StatusBar 全局 SSH 状态指示
 */
import { useState } from 'react';
import type { SshSessionStateValue } from '../store/runtime';

interface SshStatusDotProps {
  /** SSH 会话状态 */
  state: SshSessionStateValue;
  /** 错误信息（state=failed 时显示在 hover 详情中） */
  error?: string;
  /** 主机名（hover 详情显示） */
  host?: string;
  /** 端口（hover 详情显示） */
  port?: number;
  /** 用户名（hover 详情显示） */
  user?: string;
  /** 尺寸（默认 8px） */
  size?: number;
  /** 是否显示脉冲动画（连接中状态） */
  animated?: boolean;
}

/** 状态元数据：颜色、标签、是否脉冲 */
interface StateMeta {
  /** 圆点背景色（CSS 变量或具体颜色） */
  bg: string;
  /** 圆点边框（可选） */
  border?: string;
  /** 中心图标（可选，如 ! 或 ?） */
  icon?: string;
  /** 图标颜色 */
  iconColor?: string;
  /** 是否脉冲动画 */
  pulse?: boolean;
  /** 中文标签（hover 详情） */
  label: string;
  /** 英文标签 */
  labelEn: string;
}

/** 9 态状态元数据表 */
const STATE_META: Record<SshSessionStateValue, StateMeta> = {
  idle: {
    bg: 'transparent',
    border: '1.5px solid var(--color-text-faint)',
    label: '未连接',
    labelEn: 'Idle',
  },
  connecting: {
    bg: 'var(--color-warning)',
    pulse: true,
    label: 'TCP 连接中',
    labelEn: 'Connecting',
  },
  handshaking: {
    bg: 'var(--color-warning)',
    pulse: true,
    label: 'SSH 握手中',
    labelEn: 'Handshaking',
  },
  host_verifying: {
    bg: 'var(--color-warning)',
    icon: '?',
    iconColor: '#fff',
    label: '等待主机确认',
    labelEn: 'Host Verifying',
  },
  authenticating: {
    bg: 'var(--color-warning)',
    pulse: true,
    label: '认证中',
    labelEn: 'Authenticating',
  },
  authenticated: {
    bg: 'var(--color-primary)',
    label: '已认证',
    labelEn: 'Authenticated',
  },
  connected: {
    bg: 'var(--color-success)',
    label: '已连接',
    labelEn: 'Connected',
  },
  reconnecting: {
    bg: 'var(--color-warning)',
    pulse: true,
    label: '重连中',
    labelEn: 'Reconnecting',
  },
  failed: {
    bg: 'var(--color-error)',
    icon: '!',
    iconColor: '#fff',
    label: '连接失败',
    labelEn: 'Failed',
  },
  closed: {
    bg: 'var(--color-text-faint)',
    label: '已关闭',
    labelEn: 'Closed',
  },
};

export function SshStatusDot({
  state,
  error,
  host,
  port,
  user,
  size = 8,
  animated = true,
}: SshStatusDotProps) {
  const [hovered, setHovered] = useState(false);
  const meta = STATE_META[state];

  // 构建 hover 详情内容
  const detailLines: string[] = [`${meta.label} (${meta.labelEn})`];
  if (host) detailLines.push(`Host: ${host}${port ? `:${port}` : ''}`);
  if (user) detailLines.push(`User: ${user}`);
  if (error && state === 'failed') detailLines.push(`Error: ${error}`);

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: `${size}px`, height: `${size}px` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-testid={`ssh-status-dot-${state}`}
    >
      {/* 主圆点 */}
      <span
        style={{
          width: `${size - 2}px`,
          height: `${size - 2}px`,
          borderRadius: '50%',
          background: meta.bg,
          border: meta.border || 'none',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {/* 脉冲动画层 */}
        {animated && meta.pulse && (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: meta.bg,
              animation: 'sshPulse 1.4s ease-out infinite',
            }}
          />
        )}
        {/* 中心图标（! 或 ?） */}
        {meta.icon && (
          <span
            style={{
              fontSize: `${size * 0.7}px`,
              color: meta.iconColor || '#fff',
              fontWeight: 700,
              lineHeight: 1,
              position: 'relative',
              zIndex: 1,
            }}
          >
            {meta.icon}
          </span>
        )}
      </span>

      {/* Hover 详情气泡 */}
      {hovered && (
        <span
          className="absolute z-50 whitespace-nowrap pointer-events-none"
          style={{
            top: '100%',
            left: '50%',
            transform: 'translateX(-50%) translateY(4px)',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: '4px',
            padding: '4px 8px',
            fontSize: '10px',
            fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
            color: 'var(--color-text)',
            boxShadow: 'var(--shadow-panel, 0 4px 12px rgba(0,0,0,0.3))',
            lineHeight: 1.5,
          }}
        >
          {detailLines.map((line, i) => (
            <span
              key={i}
              style={{
                display: 'block',
                color:
                  i === 0
                    ? state === 'failed'
                      ? 'var(--color-error)'
                      : state === 'connected'
                        ? 'var(--color-success)'
                        : 'var(--color-text)'
                    : 'var(--color-text-muted)',
              }}
            >
              {line}
            </span>
          ))}
        </span>
      )}

      {/* 脉冲动画 keyframes */}
      <style>{`
        @keyframes sshPulse {
          0% {
            transform: scale(1);
            opacity: 0.7;
          }
          100% {
            transform: scale(2.2);
            opacity: 0;
          }
        }
      `}</style>
    </span>
  );
}
