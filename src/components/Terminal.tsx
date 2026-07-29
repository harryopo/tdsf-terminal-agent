/**
 * Terminal.tsx — TDSF Terminal Agent 终端核心 (v4.1 PTY 桥接版)
 * -----------------------------------------------------------------------------
 * PTY 桥接: 基于 terax-ai pty-bridge.ts (原始字节 Channel, 零 JSON 往返)
 * Shell 集成: 基于 electerm CommandTrackerAddon + shell-integration
 *
 * 数据流:
 *   xterm.onData → ptySession.write → invoke pty_write (raw bytes + x-pty-id header)
 *   PTY stdout → Channel<ArrayBuffer> → onData → xterm.write(Uint8Array)
 *
 * 搬运来源:
 *   pty-bridge.ts      — terax-ai/src/modules/terminal/lib/pty-bridge.ts
 *   CommandTrackerAddon — electerm command-tracker-addon.js
 *   shell-integration   — electerm shell.js
 *
 * T-P2-10.4 集成: Tab 键触发补全弹窗 (Trie + Frecency)
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { buildTerminalTheme, watchThemeChange } from '../lib/terminal-theme';
import { CommandTrackerAddon } from '../lib/command-tracker-addon';
import { getShellIntegrationCommand } from '../lib/shell-integration';
import {
  openPty,
  type PtySession,
} from '../lib/pty-bridge';
import { useCompletion } from '../lib/use-completion';
import { CompletionPopup } from './CompletionPopup';

interface TerminalProps {
  className?: string;
  onCommandExecuted?: (command: string) => void;
  onCwdChanged?: (cwd: string) => void;
}

export function Terminal({
  className = '',
  onCommandExecuted,
  onCwdChanged,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyRef = useRef<PtySession | null>(null);
  const xtermRef = useRef<XTerm | null>(null);

  // === T-P2-10.4: 补全引擎集成 ============================================
  // 注: ptyRef 在 useEffect 内赋值, 此处用 ref 包装保证 selectCompletion 闭包稳定
  const writeRef = useRef<(data: string) => void>(() => {});
  const { popup, closePopup, selectCompletion, handleKeyEventHandler } =
    useCompletion({
      xtermRef,
      containerRef,
      onWrite: (data) => writeRef.current(data),
    });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // === 1. 创建 xterm 实例 ==================================================
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

    // === 2. 加载 Addon ======================================================
    const fit = new FitAddon();
    xterm.loadAddon(fit);

    try {
      xterm.loadAddon(new Unicode11Addon());
      xterm.unicode.activeVersion = '11';
    } catch { /* 不阻塞 */ }

    xterm.loadAddon(new WebLinksAddon());

    try {
      xterm.loadAddon(new WebglAddon());
    } catch {
      console.warn('[Terminal] WebGL 不可用, 回退 Canvas 渲染');
    }

    // 命令追踪 (electerm)
    const cmdTracker = new CommandTrackerAddon();
    xterm.loadAddon(cmdTracker);
    if (onCommandExecuted) cmdTracker.onCommandExecuted(onCommandExecuted);
    if (onCwdChanged) cmdTracker.onCwdChanged(onCwdChanged);

    // === T-P2-10.4: 注册 Tab 键补全 handler ===
    xterm.attachCustomKeyEventHandler(handleKeyEventHandler);

    // 挂载到 DOM
    xterm.open(container);

    // === 3. 启动 PTY =========================================================
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* ignore */ }

      const cols = xterm.cols || 80;
      const rows = xterm.rows || 24;

      openPty(cols, rows, {
        onData: (bytes: Uint8Array) => {
          // 原始字节直接写入 xterm — 无 UTF-8 编解码开销
          xterm.write(bytes);
        },
        onExit: (code: number) => {
          xterm.write(
            `\r\n\x1b[38;5;131m[进程已退出, 退出码 ${code}]\x1b[0m\r\n`
          );
          ptyRef.current = null;
        },
      })
        .then((pty) => {
          ptyRef.current = pty;
          console.info('[Terminal] PTY spawned id=', pty.id);

          // Shell Integration 注入 (electerm)
          setTimeout(() => {
            const shellType = 'bash'; // Windows 默认
            const cmd = getShellIntegrationCommand(shellType);
            pty.write(cmd).catch((e) =>
              console.warn('[Terminal] shell integration inject failed', e)
            );
          }, 300);
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[Terminal] PTY spawn failed:', msg);
          xterm.write(`\x1b[38;5;203m[PTY 启动失败: ${msg}]\x1b[0m\r\n`);
        });
    });

    // === 4. 用户输入 → PTY stdin =============================================
    const dataDisp = xterm.onData((data) => {
      ptyRef.current?.write(data).catch((e) =>
        console.error('[Terminal] write failed:', e)
      );
    });

    // 同步 writeRef 指向最新 ptyRef (供 useCompletion 写入补全字符)
    writeRef.current = (data: string) => {
      ptyRef.current?.write(data).catch((e) =>
        console.error('[Terminal] completion write failed:', e),
      );
    };

    // === 5. Resize ============================================================
    const onResize = () => {
      try {
        fit.fit();
        if (ptyRef.current) {
          const c = xterm.cols || 80;
          const r = xterm.rows || 24;
          ptyRef.current.resize(c, r).catch(() => { /* ignore */ });
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('resize', onResize);

    // === 6. 主题热切换 =======================================================
    const unwatchTheme = watchThemeChange(() => {
      xterm.options.theme = buildTerminalTheme();
    });

    // === 7. 清理 =============================================================
    return () => {
      window.removeEventListener('resize', onResize);
      unwatchTheme();
      dataDisp.dispose();
      cmdTracker.dispose();
      ptyRef.current?.close().catch(() => { /* ignore */ });
      ptyRef.current = null;
      xterm.dispose();
      xtermRef.current = null;
    };
  }, [onCommandExecuted, onCwdChanged, handleKeyEventHandler]);

  return (
    <div
      className={`h-full w-full overflow-hidden relative ${className}`}
      style={{ background: 'var(--terminal-bg)' }}
      data-testid="tdsf-terminal"
    >
      <div ref={containerRef} className="h-full w-full" />

      {/* T-P2-10.3: 补全弹窗 */}
      {popup.visible && popup.items.length > 0 && (
        <CompletionPopup
          items={popup.items}
          prefix={popup.prefix}
          position={popup.position}
          onSelect={selectCompletion}
          onClose={closePopup}
        />
      )}
    </div>
  );
}
