/**
 * SshConnectDialog.tsx — SSH 连接配置弹窗 (P2-B T-P2-04)
 * -----------------------------------------------------------------------------
 * 职责：仅收集连接参数（host/port/user/auth），提交时调用 onConnect(params)。
 * 实际连接由 SshTerminal 组件发起，以便 onData 回调正确绑定到 xterm 实例。
 *
 * 设计风格（与 AgentPanel/LeftSidebar 一致）:
 *   - 暗色背景遮罩 (rgba(0,0,0,0.6))
 *   - surface 背景面板 + border-strong 边框
 *   - 等宽字体 + 11px 紧凑布局
 *   - 主按钮 primary 蓝，次按钮 outline
 */
import { useState, useEffect } from 'react';
import type { SshAuthMethod, SshConnectParams } from '../lib/ssh-bridge';

interface SshConnectDialogProps {
  /** 是否显示 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 提交连接参数回调（由父组件渲染 SshTerminal 发起实际连接） */
  onConnect: (params: SshConnectParams) => void;
}

/** 认证方法类型 */
type AuthType = 'password' | 'publickey';

/** 连接表单状态 */
interface ConnectForm {
  host: string;
  port: number;
  user: string;
  authType: AuthType;
  password: string;
  privateKeyPath: string;
  passphrase: string;
}

const DEFAULT_FORM: ConnectForm = {
  host: '192.168.1.100',
  port: 22,
  user: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
};

export function SshConnectDialog({
  open,
  onClose,
  onConnect,
}: SshConnectDialogProps) {
  const [form, setForm] = useState<ConnectForm>(DEFAULT_FORM);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ESC 键关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // === 表单字段更新 ===
  const updateField = <K extends keyof ConnectForm>(
    field: K,
    value: ConnectForm[K],
  ) => {
    setForm((f) => ({ ...f, [field]: value }));
  };

  // === 提交连接 ===
  const handleSubmit = () => {
    if (!form.host || !form.user) {
      setErrorMsg('Host 和 User 必填');
      return;
    }
    if (form.authType === 'password' && !form.password) {
      setErrorMsg('密码必填');
      return;
    }
    if (form.authType === 'publickey' && !form.privateKeyPath) {
      setErrorMsg('私钥路径必填');
      return;
    }

    // 构造认证方法
    const auth: SshAuthMethod =
      form.authType === 'password'
        ? { type: 'password', password: form.password }
        : {
            type: 'publickey',
            privateKeyPath: form.privateKeyPath,
            passphrase: form.passphrase || undefined,
          };

    // 构造连接参数，回调父组件
    const params: SshConnectParams = {
      host: form.host,
      port: form.port,
      user: form.user,
      auth,
    };

    onConnect(params);
    setForm(DEFAULT_FORM);
    setErrorMsg(null);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', zIndex: 100 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col"
        style={{
          width: '420px',
          maxHeight: '90vh',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-lg, 8px)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border)' }}
        >
          <span
            style={{
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--color-text)',
            }}
          >
            连接 SSH 主机
          </span>
          <button
            onClick={onClose}
            style={{
              color: 'var(--color-text-faint)',
              cursor: 'pointer',
              background: 'transparent',
              border: 'none',
              padding: '4px',
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.color = 'var(--color-text)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.color = 'var(--color-text-faint)')
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 表单内容 */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {/* Host + Port */}
          <div className="flex gap-3 mb-3">
            <div className="flex-1">
              <label
                style={{
                  display: 'block',
                  fontSize: '11px',
                  color: 'var(--color-text-faint)',
                  marginBottom: '4px',
                }}
              >
                Host
              </label>
              <input
                type="text"
                value={form.host}
                onChange={(e) => updateField('host', e.target.value)}
                placeholder="192.168.1.100"
                style={inputStyle}
                autoFocus
              />
            </div>
            <div style={{ width: '80px' }}>
              <label
                style={{
                  display: 'block',
                  fontSize: '11px',
                  color: 'var(--color-text-faint)',
                  marginBottom: '4px',
                }}
              >
                Port
              </label>
              <input
                type="number"
                value={form.port}
                onChange={(e) =>
                  updateField('port', parseInt(e.target.value) || 22)
                }
                style={inputStyle}
              />
            </div>
          </div>

          {/* User */}
          <div className="mb-3">
            <label
              style={{
                display: 'block',
                fontSize: '11px',
                color: 'var(--color-text-faint)',
                marginBottom: '4px',
              }}
            >
              User
            </label>
            <input
              type="text"
              value={form.user}
              onChange={(e) => updateField('user', e.target.value)}
              placeholder="root"
              style={inputStyle}
            />
          </div>

          {/* 认证方法切换 */}
          <div className="mb-3">
            <label
              style={{
                display: 'block',
                fontSize: '11px',
                color: 'var(--color-text-faint)',
                marginBottom: '4px',
              }}
            >
              认证方法
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => updateField('authType', 'password')}
                style={
                  form.authType === 'password'
                    ? authTabActiveStyle
                    : authTabStyle
                }
              >
                密码
              </button>
              <button
                onClick={() => updateField('authType', 'publickey')}
                style={
                  form.authType === 'publickey'
                    ? authTabActiveStyle
                    : authTabStyle
                }
              >
                公钥
              </button>
            </div>
          </div>

          {/* 密码输入 */}
          {form.authType === 'password' && (
            <div className="mb-3">
              <label
                style={{
                  display: 'block',
                  fontSize: '11px',
                  color: 'var(--color-text-faint)',
                  marginBottom: '4px',
                }}
              >
                Password
              </label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => updateField('password', e.target.value)}
                placeholder="••••••••"
                style={inputStyle}
              />
            </div>
          )}

          {/* 公钥输入 */}
          {form.authType === 'publickey' && (
            <>
              <div className="mb-3">
                <label
                  style={{
                    display: 'block',
                    fontSize: '11px',
                    color: 'var(--color-text-faint)',
                    marginBottom: '4px',
                  }}
                >
                  私钥路径
                </label>
                <input
                  type="text"
                  value={form.privateKeyPath}
                  onChange={(e) =>
                    updateField('privateKeyPath', e.target.value)
                  }
                  placeholder="~/.ssh/id_rsa"
                  style={inputStyle}
                />
              </div>
              <div className="mb-3">
                <label
                  style={{
                    display: 'block',
                    fontSize: '11px',
                    color: 'var(--color-text-faint)',
                    marginBottom: '4px',
                  }}
                >
                  Passphrase（可选）
                </label>
                <input
                  type="password"
                  value={form.passphrase}
                  onChange={(e) => updateField('passphrase', e.target.value)}
                  placeholder="••••••••"
                  style={inputStyle}
                />
              </div>
            </>
          )}

          {/* 错误信息 */}
          {errorMsg && (
            <div
              className="mb-3 px-3 py-2 rounded"
              style={{
                background: 'rgba(248,113,113,0.1)',
                border: '1px solid var(--color-error)',
                color: 'var(--color-error)',
                fontSize: '11px',
                fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
              }}
            >
              {errorMsg}
            </div>
          )}
        </div>

        {/* 底部按钮栏 */}
        <div
          className="flex justify-end gap-2 px-4 py-3 shrink-0"
          style={{
            borderTop: '1px solid var(--color-border)',
            background: 'var(--color-surface-active)',
          }}
        >
          <button
            onClick={onClose}
            style={cancelBtnStyle}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = 'transparent')
            }
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            style={connectBtnStyle}
            onMouseEnter={(e) =>
              (e.currentTarget.style.opacity = '0.9')
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.opacity = '1')
            }
          >
            连接
          </button>
        </div>
      </div>
    </div>
  );
}

// === 样式常量 ================================================================

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--color-bg)',
  border: '1px solid var(--color-border)',
  borderRadius: '4px',
  color: 'var(--color-text)',
  fontSize: '12px',
  fontFamily: "var(--font-mono), 'JetBrains Mono', monospace",
  outline: 'none',
  transition: 'border-color 0.15s',
};

const authTabStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: '4px',
  color: 'var(--color-text-muted)',
  fontSize: '11px',
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const authTabActiveStyle: React.CSSProperties = {
  ...authTabStyle,
  background: 'var(--color-primary-soft)',
  border: '1px solid var(--color-primary)',
  color: 'var(--color-primary)',
};

const cancelBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  background: 'transparent',
  border: '1px solid var(--color-border)',
  borderRadius: '4px',
  color: 'var(--color-text-muted)',
  fontSize: '11px',
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const connectBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  background: 'var(--color-primary)',
  border: '1px solid var(--color-primary)',
  borderRadius: '4px',
  color: 'var(--color-text-on-primary, #fff)',
  fontSize: '11px',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'opacity 0.15s',
};
