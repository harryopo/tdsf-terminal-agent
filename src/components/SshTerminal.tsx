/**
 * SshTerminal.tsx — SSH 终端组件 (P2-B T-P2-04)
 * -----------------------------------------------------------------------------
 * 职责：
 *   1. 挂载时调用 sshConnect(params, handlers) 建立 SSH 连接
 *   2. handlers.onData 直接绑定到 xterm 实例（原始字节写入）
 *   3. handlers.onStatus 实时更新 store 中的 sshSessions 状态
 *   4. 内部管理 TOFU 主机指纹确认弹窗（订阅 ssh:approve-host 事件）
 *   5. 卸载时调用 sshDisconnect 清理连接
 *
 * 与 Terminal.tsx（本地 PTY）的对应关系：
 *   - pty-bridge.openPty → ssh-bridge.sshConnect
 *   - PtySession → SshSession
 *   - xterm + FitAddon + WebglAddon 复用
 *   - CommandTrackerAddon 暂不复用（SSH 远端 shell 集成需额外处理）
 *
 * 多 tab 切换：
 *   - 父组件通过 active prop 控制显隐（display:none 保留 xterm 实例和连接）
 *   - 切换回来时调用 fit.fit() 重新适配尺寸
 *
 * T-P2-10.4 集成: Tab 键触发补全弹窗 (远端 SSH 历史从本地 shell history 加载)
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { buildTerminalTheme, watchThemeChange } from '../lib/terminal-theme';
import {
  sshConnect,
  sshApproveHost,
  subscribeHostApproval,
  type SshConnectParams,
  type SshSession,
  type HostApprovalRequest,
} from '../lib/ssh-bridge';
import { useRuntime } from '../store/runtime';
import { useCompletion } from '../lib/use-completion';
import { CompletionPopup } from './CompletionPopup';

interface SshTerminalProps {
  /** 连接参数（从 SshConnectDialog 传入） */
  params: SshConnectParams;
  /** 是否当前激活显示（控制 display:none） */
  active: boolean;
  /** 前端生成的持久 key（用于 dispatch update-ssh-session 匹配） */
  frontendKey: string;
  /** 连接成功回调（父组件用于记录 sessionId 到 store） */
  onConnected: (sessionId: number) => void;
  /** 连接失败或断开回调（父组件用于清理 tab） */
  onDisconnected: (reason: string) => void;
}

export function SshTerminal({
  params,
  active,
  frontendKey,
  onConnected,
  onDisconnected,
}: SshTerminalProps) {
  const { dispatch } = useRuntime();
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SshSession | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [approvalReq, setApprovalReq] = useState<HostApprovalRequest | null>(
    null,
  );
  const [approvalPending, setApprovalPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // === T-P2-10.4: 补全引擎集成 ===
  // 注: sessionRef 在 useEffect 内赋值, 用 ref 包装保证 selectCompletion 闭包稳定
  const writeRef = useRef<(data: string) => void>(() => {});
  const { popup, closePopup, selectCompletion, handleKeyEventHandler } =
    useCompletion({
      xtermRef,
      containerRef,
      onWrite: (data) => writeRef.current(data),
    });

  // === 主挂载 effect：创建 xterm + 建立 SSH 连接 ===
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // === 1. 创建 xterm 实例 ===
    const xterm = new XTerm({
      fontFamily:
        "'JetBrains Mono', 'Maple Mono NF', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.6,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      allowTransparency: true,
      theme: buildTerminalTheme(),
    });
    xtermRef.current = xterm;

    // === 2. 加载 Addon ===
    const fit = new FitAddon();
    fitRef.current = fit;
    xterm.loadAddon(fit);

    try {
      xterm.loadAddon(new Unicode11Addon());
      xterm.unicode.activeVersion = '11';
    } catch {
      /* 不阻塞 */
    }
    xterm.loadAddon(new WebLinksAddon());
    try {
      xterm.loadAddon(new WebglAddon());
    } catch {
      console.warn('[SshTerminal] WebGL 不可用, 回退 Canvas 渲染');
    }

    xterm.open(container);
    // === T-P2-10.4: 注册 Tab 键补全 handler ===
    xterm.attachCustomKeyEventHandler(handleKeyEventHandler);
    xterm.write(
      `\x1b[38;5;111m[正在连接 ${params.user}@${params.host}:${params.port}…]\x1b[0m\r\n`,
    );

    // === 3. 建立 SSH 连接 ===
    let cancelled = false;
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      const cols = xterm.cols || 80;
      const rows = xterm.rows || 24;

      sshConnect(
        { ...params, cols, rows },
        {
          onData: (bytes: Uint8Array) => {
            // 原始字节直接写入 xterm
            xterm.write(bytes);
          },
          onStatus: (event) => {
            // 实时更新 store 中的 sshSessions 状态
            // 使用 frontendKey 匹配（连接成功前 id=-1，无法用 id 匹配）
            dispatch({
              type: 'update-ssh-session',
              frontendKey,
              updates: {
                state: event.state,
                error: event.error,
                user: event.user,
              },
            });
          },
          onExit: () => {
            dispatch({
              type: 'update-ssh-session',
              frontendKey,
              updates: { state: 'closed' },
            });
            xterm.write(
              `\r\n\x1b[38;5;131m[SSH 连接已断开]\x1b[0m\r\n`,
            );
            onDisconnected('remote closed');
          },
        },
      )
        .then((session) => {
          if (cancelled) {
            // 组件已卸载，立即清理
            session.close().catch(() => {});
            return;
          }
          sessionRef.current = session;
          console.info(
            '[SshTerminal] SSH connected id=',
            session.id,
            'host=',
            params.host,
          );
          xterm.write(
            `\x1b[38;5;114m[连接已建立, session=${session.id}]\x1b[0m\r\n\r\n`,
          );
          // 更新 store：写入 Rust 分配的 sessionId，清除 params（避免密码泄露）
          dispatch({
            type: 'update-ssh-session',
            frontendKey,
            updates: {
              id: session.id,
              state: 'connected',
              params: undefined,
            },
          });
          onConnected(session.id);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[SshTerminal] SSH connect failed:', msg);
          xterm.write(
            `\r\n\x1b[38;5;203m[SSH 连接失败: ${msg}]\x1b[0m\r\n`,
          );
          setErrorMsg(msg);
          onDisconnected(msg);
        });
    });

    // === 4. 用户输入 → SSH stdin ===
    const dataDisp = xterm.onData((data) => {
      sessionRef.current?.write(data).catch((e) =>
        console.error('[SshTerminal] write failed:', e),
      );
    });

    // 同步 writeRef 指向最新 sessionRef (供 useCompletion 写入补全字符)
    writeRef.current = (data: string) => {
      sessionRef.current?.write(data).catch((e) =>
        console.error('[SshTerminal] completion write failed:', e),
      );
    };

    // === 5. Resize ===
    const onResize = () => {
      try {
        fit.fit();
        if (sessionRef.current && xtermRef.current) {
          const c = xtermRef.current.cols || 80;
          const r = xtermRef.current.rows || 24;
          sessionRef.current.resize(c, r).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);

    // === 6. 主题热切换 ===
    const unwatchTheme = watchThemeChange(() => {
      xterm.options.theme = buildTerminalTheme();
    });

    // === 7. 清理 ===
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      unwatchTheme();
      dataDisp.dispose();
      // 主动断开 SSH 连接
      sessionRef.current?.close().catch(() => {});
      sessionRef.current = null;
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleKeyEventHandler]);

  // === active 切换时重新 fit ===
  useEffect(() => {
    if (active && fitRef.current && xtermRef.current) {
      // 延迟一帧等 display 切换生效
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          if (sessionRef.current && xtermRef.current) {
            const c = xtermRef.current.cols || 80;
            const r = xtermRef.current.rows || 24;
            sessionRef.current.resize(c, r).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      });
    }
  }, [active]);

  // === TOFU 主机确认：订阅 ssh:approve-host 事件 ===
  useEffect(() => {
    const unsubscribe = subscribeHostApproval((req) => {
      // 仅处理当前 session 的 approval（通过 host:port 匹配，因为 sessionId 可能还没分配）
      if (
        req.host === params.host &&
        req.port === (params.port ?? 22)
      ) {
        setApprovalReq(req);
        setApprovalPending(false);
      }
    });
    return unsubscribe;
  }, [params.host, params.port]);

  // === TOFU 确认/拒绝 ===
  const handleApprove = async (approved: boolean) => {
    if (!approvalReq) return;
    setApprovalPending(true);
    try {
      await sshApproveHost(approvalReq.approvalId, approved);
      if (!approved) {
        onDisconnected('user rejected host');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(`主机确认失败: ${msg}`);
    } finally {
      setApprovalReq(null);
      setApprovalPending(false);
    }
  };

  return (
    <div
      className="h-full w-full overflow-hidden relative"
      style={{
        background: 'var(--terminal-bg)',
        display: active ? 'block' : 'none',
      }}
      data-testid="tdsf-ssh-terminal"
    >
      <div ref={containerRef} className="h-full w-full" />

      {/* ===== T-P2-10.3: 补全弹窗 ===== */}
      {popup.visible && popup.items.length > 0 && (
        <CompletionPopup
          items={popup.items}
          prefix={popup.prefix}
          position={popup.position}
          onSelect={selectCompletion}
          onClose={closePopup}
        />
      )}

      {/* ===== TOFU 主机指纹确认弹窗 ===== */}
      {approvalReq && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', zIndex: 50 }}
        >
          <div
            className="flex flex-col"
            style={{
              width: '460px',
              background: 'var(--color-surface)',
              border:
                approvalReq.isMismatch
                  ? '1px solid var(--color-error)'
                  : '1px solid var(--color-warning)',
              borderRadius: 'var(--radius-lg, 8px)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
              overflow: 'hidden',
            }}
          >
            {/* 警告标题 */}
            <div
              className="px-4 py-3 flex items-center gap-2"
              style={{
                background:
                  approvalReq.isMismatch
                    ? 'rgba(248,113,113,0.1)'
                    : 'rgba(251,191,36,0.1)',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <span
                style={{
                  fontSize: '16px',
                  color:
                    approvalReq.isMismatch
                      ? 'var(--color-error)'
                      : 'var(--color-warning)',
                }}
              >
                {approvalReq.isMismatch ? '⚠' : '?'}
              </span>
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--color-text)',
                }}
              >
                {approvalReq.isMismatch
                  ? '主机密钥变化警告'
                  : '首次连接未知主机'}
              </span>
            </div>

            {/* 内容 */}
            <div className="px-4 py-4 flex-1">
              <p
                style={{
                  fontSize: '12px',
                  color: 'var(--color-text-muted)',
                  marginBottom: '12px',
                  lineHeight: 1.6,
                }}
              >
                {approvalReq.isMismatch
                  ? `检测到 ${approvalReq.host}:${approvalReq.port} 的主机密钥与 known_hosts 记录不一致。这可能表示中间人攻击，也可能是服务器重装系统导致密钥变化。请仔细核对指纹后再决定是否信任。`
                  : `首次连接到 ${approvalReq.host}:${approvalReq.port}，无法验证主机身份。请核对下方指纹，确认无误后点击"信任并连接"。`}
              </p>

              {/* 指纹显示 */}
              <div
                className="px-3 py-2 rounded"
                style={{
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  fontFamily:
                    "var(--font-mono), 'JetBrains Mono', monospace",
                  fontSize: '11px',
                  color: 'var(--color-text)',
                  wordBreak: 'break-all',
                  lineHeight: 1.6,
                }}
              >
                <div
                  style={{
                    color: 'var(--color-text-faint)',
                    marginBottom: '4px',
                  }}
                >
                  SHA256 指纹:
                </div>
                <div>{approvalReq.fingerprint}</div>
              </div>

              {errorMsg && (
                <div
                  className="mt-3 px-3 py-2 rounded"
                  style={{
                    background: 'rgba(248,113,113,0.1)',
                    border: '1px solid var(--color-error)',
                    color: 'var(--color-error)',
                    fontSize: '11px',
                  }}
                >
                  {errorMsg}
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div
              className="flex justify-end gap-2 px-4 py-3 shrink-0"
              style={{
                borderTop: '1px solid var(--color-border)',
                background: 'var(--color-surface-active)',
              }}
            >
              <button
                onClick={() => handleApprove(false)}
                disabled={approvalPending}
                style={cancelBtnStyle}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background =
                    'rgba(248,113,113,0.1)')
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = 'transparent')
                }
              >
                拒绝
              </button>
              <button
                onClick={() => handleApprove(true)}
                disabled={approvalPending}
                style={connectBtnStyle}
              >
                {approvalPending ? '处理中…' : '信任并连接'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// === 样式常量 ================================================================

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
