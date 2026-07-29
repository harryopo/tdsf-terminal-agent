/**
 * App.tsx — TDSF Terminal Agent v4.1 (设计稿 1:1 对齐版 + SSH 多标签)
 * -----------------------------------------------------------------------------
 * 设计稿布局 (view-expanded.html):
 *   ① Titlebar    fixed top-0 z-50     — logo + mood/mode + 按钮 + 时间
 *   ② Terminal    fixed inset-0 pt-8 z-10  — 全屏背景层 (local PTY + N 个 SSH Terminal)
 *   ③ Sidebar     fixed z-30           — 浮动在终端之上 (Hosts/Files/NeedsYou)
 *   ④ AgentPanel  fixed z-40           — 浮动在终端之上 (对话+工具调用+知识卡)
 *
 * 关键: 终端是 fixed 全屏 (非 flex-1), 侧栏和Agent面板浮动在上面
 *
 * P2-B T-P2-04 改造:
 *   - TabBar 区域替换为 SshTabs（local + N 个 SSH tab + 新建按钮）
 *   - 终端主区根据 activeSshFrontendKey 切换显示 local Terminal 或 SshTerminal
 *   - SshConnectDialog 由 + 按钮触发，提交后 dispatch add-ssh-session
 *   - SshTerminal 用 frontendKey 作为 React key，跨 id 变化保持挂载
 */
import { useEffect, useState, useCallback } from 'react';
import { RuntimeProvider, useRuntime } from './store/runtime';
import { Terminal } from './components/Terminal';
import { Titlebar } from './components/Titlebar';
import { LeftSidebar } from './components/LeftSidebar';
import { AgentPanel } from './components/AgentPanel';
import { StatusBar } from './components/StatusBar';
import { SshTabs } from './components/SshTabs';
import { SshConnectDialog } from './components/SshConnectDialog';
import { SshTerminal } from './components/SshTerminal';
import { Settings } from './components/Settings';
import { TerminalMultiplexer } from './components/TerminalMultiplexer';
import { restoreTheme } from './lib/terminal-theme';
import { isTauriRuntime } from './lib/tauriRuntime';
import type { Mode, SshSessionItem } from './store/runtime';
import type { SshConnectParams } from './lib/ssh-bridge';

const MODE_LIST: Mode[] = ['plan', 'agent', 'yolo'];

/** 生成前端持久 key（作为 React key） */
function genFrontendKey(): string {
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function App() {
  return (
    <RuntimeProvider>
      <AppShell />
    </RuntimeProvider>
  );
}

function AppShell() {
  const { state, dispatch } = useRuntime();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentPanelOpen, setAgentPanelOpen] = useState(true);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // P2-C T-P2-11: 分屏模式开关 (单 terminal ↔ multiplex)
  // 切换 key: Ctrl+B, m (与 tmux 切换 multiplex 模式一致)
  const [multiplexMode, setMultiplexMode] = useState(false);

  // 启动时恢复上次应用的终端主题
  useEffect(() => {
    restoreTheme();
  }, []);

  // 首帧后显示主窗口。Rust 侧 window-state 插件跳过 VISIBLE 恢复
  // (StateFlags::all() & !VISIBLE)，约定由前端 paint 后调用 show()，
  // 缺少此调用会导致窗口一直隐藏（进程在跑但用户看不见）。
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      } catch (e) {
        console.warn('[App] window.show() failed:', e);
      }
    })();
  }, []);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => !v);
        return;
      }
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault();
        setAgentPanelOpen((v) => !v);
        return;
      }
      // P2-C T-P2-11: Ctrl+M 切换分屏模式 (单 terminal ↔ multiplex)
      if (e.ctrlKey && e.key === 'm') {
        e.preventDefault();
        setMultiplexMode((v) => !v);
        return;
      }
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        const idx = MODE_LIST.indexOf(state.mode);
        dispatch({ type: 'set-mode', mode: MODE_LIST[(idx + 1) % MODE_LIST.length] });
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.mode, dispatch]);

  // === SSH 连接回调：从 SshConnectDialog 接收 params ===
  const handleSshConnect = useCallback(
    (params: SshConnectParams) => {
      const frontendKey = genFrontendKey();
      const sessionItem: SshSessionItem = {
        frontendKey,
        id: -1, // 未连接，SshTerminal 连接成功后更新
        host: params.host,
        port: params.port ?? 22,
        user: params.user,
        state: 'idle',
        connectedAt: Date.now(),
        params, // 连接参数（连接成功后清除）
      };
      dispatch({ type: 'add-ssh-session', session: sessionItem });
      dispatch({ type: 'set-active-ssh-session', frontendKey });
    },
    [dispatch],
  );

  // === SshTerminal 连接成功回调（仅日志，store 已在 SshTerminal 内更新）===
  const handleSshConnected = useCallback((sessionId: number) => {
    console.info('[App] SSH session connected:', sessionId);
  }, []);

  // === SshTerminal 断开回调（从 store 移除）===
  const handleSshDisconnected = useCallback(
    (frontendKey: string, reason: string) => {
      console.info('[App] SSH session disconnected:', frontendKey, reason);
      // 连接失败/断开时移除 tab（但正常关闭由 SshTabs 的关闭按钮处理）
      // 这里仅在异常断开时清理
      if (reason !== 'user rejected host' && reason !== 'remote closed') {
        // 仅在异常情况下移除，正常关闭由用户点击关闭按钮触发
      }
    },
    [],
  );

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: 'var(--color-bg)', color: 'var(--color-text)' }}>
      {/* ===== ① Titlebar: fixed top z-50 ===== */}
      <Titlebar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        agentPanelOpen={agentPanelOpen}
        onToggleAgentPanel={() => setAgentPanelOpen((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* ===== ② Terminal 全屏背景层: fixed inset-0 pt-8 z-10 ===== */}
      <div
        className="flex flex-col"
        style={{
          position: 'fixed',
          inset: 0,
          paddingTop: '32px',
          background: 'var(--terminal-bg)',
          zIndex: 10,
        }}
      >
        {/* TabBar 28px — SshTabs 替换原静态 tab */}
        <div
          className="flex items-center shrink-0"
          style={{
            height: '28px',
            background: 'var(--terminal-bg)',
            borderBottom: '1px solid rgba(91,140,255,0.08)',
          }}
        >
          {/* SshTabs: local + N 个 SSH tab + 新建按钮 */}
          <SshTabs onOpenConnectDialog={() => setConnectDialogOpen(true)} />

          <div className="flex-1" />
          <div className="flex items-center h-full pr-2 gap-0.5">
            {/* P2-C T-P2-11: 分屏模式切换按钮 (Ctrl+M 快捷键) */}
            <button
              className="w-7 h-6 flex items-center justify-center rounded"
              style={{
                color: multiplexMode
                  ? 'var(--color-primary)'
                  : 'var(--color-text-faint)',
                background: multiplexMode
                  ? 'var(--color-primary-soft)'
                  : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (!multiplexMode) {
                  e.currentTarget.style.background = 'rgba(91,140,255,0.08)';
                }
              }}
              onMouseLeave={(e) => {
                if (!multiplexMode) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
              onClick={() => setMultiplexMode((v) => !v)}
              title="分屏模式 (Ctrl+M)"
              aria-label="切换分屏模式"
              aria-pressed={multiplexMode}
              data-testid="tdsf-multiplex-toggle"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Terminal 主区 (flex-1, 多 tab 切换) */}
        <main className="flex-1 min-h-0 overflow-hidden relative">
          {/* P2-C T-P2-11: 分屏模式 — 当 multiplexMode 开启且当前是 local tab 时,
              使用 TerminalMultiplexer (多 pane + tmux 风格分屏);
              否则保持原有单 Terminal / SshTerminal 逻辑 */}
          {multiplexMode && state.activeSshFrontendKey === null ? (
            <TerminalMultiplexer active={true} />
          ) : (
            <>
              {/* Local PTY（activeSshFrontendKey === null 时显示）*/}
              <div
                className="h-full w-full"
                style={{ display: state.activeSshFrontendKey === null ? 'block' : 'none' }}
              >
                <Terminal />
              </div>

              {/* SSH Terminals（每个 session 一个 SshTerminal，用 frontendKey 作为 key）*/}
              {state.sshSessions.map((session) => (
                <SshTerminal
                  key={session.frontendKey}
                  params={session.params ?? ({} as SshConnectParams)}
                  active={state.activeSshFrontendKey === session.frontendKey}
                  frontendKey={session.frontendKey}
                  onConnected={handleSshConnected}
                  onDisconnected={(reason) =>
                    handleSshDisconnected(session.frontendKey, reason)
                  }
                />
              ))}
            </>
          )}
        </main>

        {/* StatusBar 24px */}
        <StatusBar />
      </div>

      {/* ===== ③ LeftSidebar: fixed z-30 ===== */}
      <LeftSidebar open={sidebarOpen} />

      {/* ===== ④ AgentPanel: fixed z-40 ===== */}
      <AgentPanel
        open={agentPanelOpen}
        onClose={() => setAgentPanelOpen(false)}
      />

      {/* ===== ⑤ SshConnectDialog: fixed z-100 ===== */}
      <SshConnectDialog
        open={connectDialogOpen}
        onClose={() => setConnectDialogOpen(false)}
        onConnect={handleSshConnect}
      />

      {/* ===== ⑥ Settings: fixed z-150 ===== */}
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

export default App;
