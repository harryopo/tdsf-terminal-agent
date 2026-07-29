/**
 * TerminalMultiplexer.tsx — cmux 多路终端管理器 (T-P2-11.3)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 为每个 pane 创建独立的 xterm.js Terminal 实例 + PTY session
 *   2. 监听 xterm.onData, 检测 `:` 前缀的 cmux 命令 (如 `:split-v\n`)
 *   3. 提供 tmux 风格快捷键 (Ctrl+B 前缀 + 后续键)
 *   4. 通过 store actions 同步 pane 状态
 *
 * 命令行模式 (用户输入):
 *   :split-v <Enter>     → 垂直分屏
 *   :split-h <Enter>     → 水平分屏
 *   :focus-next <Enter>  → 切换到下一个 pane
 *   :focus-prev <Enter>  → 切换到上一个 pane
 *   :close <Enter>       → 关闭当前 pane
 *   :rename <name> <Enter> → 重命名当前 pane
 *   :new-tab <Enter>     → 新建 tab (退化为 tab 布局)
 *
 * 快捷键 (tmux 兼容):
 *   Ctrl+B, %   → split-v
 *   Ctrl+B, "   → split-h
 *   Ctrl+B, n   → focus-next
 *   Ctrl+B, p   → focus-prev
 *   Ctrl+B, x   → close
 *
 * 不修改 Rust 代码 / SSH 模块 — 仅前端状态管理.
 */
import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { buildTerminalTheme, watchThemeChange } from '../lib/terminal-theme';
import { getShellIntegrationCommand } from '../lib/shell-integration';
import { openPty, type PtySession } from '../lib/pty-bridge';
import { useRuntime } from '../store/runtime';
import { MultiPlex, type Pane } from './MultiPlex';
import { parseCmuxLine, type CmuxMessage } from '../lib/cmux-protocol';

interface TerminalMultiplexerProps {
  /** 是否激活 (false 时不渲染, 不占用 PTY) */
  active: boolean;
}

/** pane 资源 bundle: xterm + fit + pty + dispose 函数 */
interface PaneResources {
  xterm: XTerm;
  fit: FitAddon;
  pty: PtySession | null;
  disposables: Array<() => void>;
  shellIntegInjected: boolean;
}

/**
 * 解析 `:cmd args` 格式的用户输入为 CmuxMessage
 * - ":split-v"           → { cmd: 'split-v', args: {} }
 * - ":close"             → { cmd: 'close', args: {} }
 * - ":rename logs"       → { cmd: 'rename', args: { name: 'logs' } }
 * - ":select-tab 2"      → { cmd: 'select-tab', args: { index: 2 } }
 *
 * 不合法返回 null (不触发任何动作, 让原始输入传给 PTY)
 */
function parseColonCommand(input: string): CmuxMessage | null {
  // 必须以 : 开头
  if (!input.startsWith(':')) return null;
  const body = input.slice(1).trim();
  if (body.length === 0) return null;

  // 拆分 "cmd args..."
  const spaceIdx = body.search(/\s/);
  const cmd = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();

  // 构造 JSON-line 走 cmux 协议解析 (复用校验逻辑)
  let args: Record<string, unknown> = {};
  if (cmd === 'rename' && rest.length > 0) {
    args = { name: rest };
  } else if (cmd === 'close' && rest.length > 0) {
    args = { target: rest };
  } else if (cmd === 'select-tab') {
    const idx = parseInt(rest, 10);
    if (!Number.isNaN(idx)) {
      args = { index: idx };
    }
  }

  const line = JSON.stringify({ cmd, args });
  return parseCmuxLine(line);
}

export function TerminalMultiplexer({ active }: TerminalMultiplexerProps) {
  const { state, dispatch } = useRuntime();

  // === refs: 持久化资源 (跨 re-render 保持, 不触发渲染) ===
  /** pane id → RefObject<HTMLDivElement | null> (terminal 容器) */
  const refsMapRef = useRef<Map<string, React.RefObject<HTMLDivElement | null>>>(
    new Map(),
  );
  /** pane id → PaneResources (xterm/fit/pty/disposables) */
  const resourcesMapRef = useRef<Map<string, PaneResources>>(new Map());
  /** pane id → 当前输入缓冲 (用于检测 `:` 命令) */
  const inputBuffersRef = useRef<Map<string, string>>(new Map());
  /** Ctrl+B 前缀状态 (按一次后等待下一个键) */
  const ctrlBPrefixRef = useRef<boolean>(false);
  /** pane id 计数器 (生成 pane-2, pane-3, ...) */
  const paneIdCounterRef = useRef<number>(1);

  // === 1. 获取或创建 terminal ref (按 pane id) ===
  const getOrCreateRef = useCallback((paneId: string) => {
    let ref = refsMapRef.current.get(paneId);
    if (!ref) {
      ref = { current: null };
      refsMapRef.current.set(paneId, ref);
    }
    return ref;
  }, []);

  // === 2. state ref (用于回调闭包读取最新 state, 避免 stale closure) ===
  const stateRef = useRef(state);
  stateRef.current = state;

  // === 3. cmux 命令执行回调 (定义在前, 供 initPaneResources 引用) ===
  const handleSplitV = useCallback(() => {
    const s = stateRef.current;
    const newId = `pane-${paneIdCounterRef.current + 1}`;
    paneIdCounterRef.current += 1;
    dispatch({
      type: 'add-pane',
      pane: { id: newId, title: `pane-${newId}`, isFocused: false },
    });
    // 自动切换布局: 单 pane → split-v, 已有 → grid
    const newCount = s.panes.length + 1;
    dispatch({
      type: 'set-multiplex-layout',
      layout: newCount === 2 ? 'split-v' : 'grid',
    });
  }, [dispatch]);

  const handleSplitH = useCallback(() => {
    const s = stateRef.current;
    const newId = `pane-${paneIdCounterRef.current + 1}`;
    paneIdCounterRef.current += 1;
    dispatch({
      type: 'add-pane',
      pane: { id: newId, title: `pane-${newId}`, isFocused: false },
    });
    const newCount = s.panes.length + 1;
    dispatch({
      type: 'set-multiplex-layout',
      layout: newCount === 2 ? 'split-h' : 'grid',
    });
  }, [dispatch]);

  const handleFocusNext = useCallback(() => {
    const s = stateRef.current;
    if (s.panes.length < 2) return;
    const idx = s.panes.findIndex((p) => p.id === s.activePaneId);
    const nextIdx = (idx + 1) % s.panes.length;
    const nextId = s.panes[nextIdx]?.id;
    if (nextId) {
      dispatch({ type: 'set-active-pane', id: nextId });
    }
  }, [dispatch]);

  const handleFocusPrev = useCallback(() => {
    const s = stateRef.current;
    if (s.panes.length < 2) return;
    const idx = s.panes.findIndex((p) => p.id === s.activePaneId);
    const prevIdx = (idx - 1 + s.panes.length) % s.panes.length;
    const prevId = s.panes[prevIdx]?.id;
    if (prevId) {
      dispatch({ type: 'set-active-pane', id: prevId });
    }
  }, [dispatch]);

  const handleCloseCurrent = useCallback(() => {
    const s = stateRef.current;
    dispatch({ type: 'remove-pane', id: s.activePaneId });
  }, [dispatch]);

  const executeCmuxCommand = useCallback(
    (msg: CmuxMessage, currentPaneId: string) => {
      const s = stateRef.current;
      switch (msg.cmd) {
        case 'split-v':
          handleSplitV();
          break;
        case 'split-h':
          handleSplitH();
          break;
        case 'focus-next':
          handleFocusNext();
          break;
        case 'focus-prev':
          handleFocusPrev();
          break;
        case 'close': {
          const target = msg.args.target ?? currentPaneId;
          dispatch({ type: 'remove-pane', id: target });
          break;
        }
        case 'rename': {
          const target = msg.args.target ?? currentPaneId;
          const name = msg.args.name ?? '';
          if (name.length > 0) {
            dispatch({ type: 'update-pane', id: target, updates: { title: name } });
          }
          break;
        }
        case 'scroll-up': {
          const res = resourcesMapRef.current.get(currentPaneId);
          res?.xterm.scrollLines(-5);
          break;
        }
        case 'scroll-down': {
          const res = resourcesMapRef.current.get(currentPaneId);
          res?.xterm.scrollLines(5);
          break;
        }
        case 'select-tab':
          // tab 切换: 退化为 tab 布局 + 切换 active pane
          dispatch({ type: 'set-multiplex-layout', layout: 'tab' });
          if (typeof msg.args.index === 'number') {
            const target = s.panes[msg.args.index];
            if (target) {
              dispatch({ type: 'set-active-pane', id: target.id });
            }
          }
          break;
        case 'new-tab': {
          // 新建 tab: 创建 pane + 退化为 tab 布局
          const newId = `pane-${paneIdCounterRef.current + 1}`;
          paneIdCounterRef.current += 1;
          dispatch({
            type: 'add-pane',
            pane: { id: newId, title: `tab-${newId}`, isFocused: false },
          });
          dispatch({ type: 'set-multiplex-layout', layout: 'tab' });
          break;
        }
        default:
          // 穷举检查 (TypeScript 编译时保证)
          break;
      }
    },
    [dispatch, handleSplitV, handleSplitH, handleFocusNext, handleFocusPrev],
  );

  // === 4. 创建 xterm + PTY (为新 pane) ===
  const initPaneResources = useCallback(
    async (paneId: string) => {
      const ref = refsMapRef.current.get(paneId);
      if (!ref?.current) return;
      if (resourcesMapRef.current.has(paneId)) return; // 已存在, 跳过

      const container = ref.current;

      // 创建 xterm
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

      const fit = new FitAddon();
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
        console.warn('[TerminalMultiplexer] WebGL 不可用, 回退 Canvas');
      }

      xterm.open(container);

      // 写入欢迎语
      xterm.write(`\x1b[38;5;111m[cmux pane ${paneId}]\x1b[0m\r\n`);

      // 启动 PTY
      let pty: PtySession | null = null;
      const disposables: Array<() => void> = [];

      try {
        const cols = xterm.cols || 80;
        const rows = xterm.rows || 24;
        pty = await openPty(cols, rows, {
          onData: (bytes: Uint8Array) => {
            xterm.write(bytes);
          },
          onExit: (code: number) => {
            xterm.write(
              `\r\n\x1b[38;5;131m[pane ${paneId} 进程退出, code=${code}]\x1b[0m\r\n`,
            );
          },
        });

        // Shell Integration 注入
        setTimeout(() => {
          try {
            const cmd = getShellIntegrationCommand('bash');
            pty?.write(cmd).catch(() => { /* ignore */ });
          } catch { /* ignore */ }
        }, 300);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[TerminalMultiplexer] PTY spawn failed:', msg);
        xterm.write(`\x1b[38;5;203m[PTY 启动失败: ${msg}]\x1b[0m\r\n`);
      }

      // === 用户输入处理 ===
      // 1. Ctrl+B 前缀快捷键 (tmux 风格)
      // 2. 命令行模式: `:` 开头的输入缓冲, 遇 Enter 触发 cmux 命令
      //    - 进入命令模式后, 后续字符仅本地缓冲, 不传 PTY
      //    - Enter 时解析, 合法则 dispatch, 否则丢弃, 都不传 PTY
      //    - 退格更新缓冲 (本地处理, 不传 PTY)
      // 3. 普通输入: 直接传 PTY (不走缓冲)
      const onDataDisp = xterm.onData((data) => {
        // === Ctrl+B 前缀 (0x02 = Ctrl+B) ===
        if (data === '\x02') {
          ctrlBPrefixRef.current = true;
          xterm.write('\x1b[38;5;111m^B\x1b[0m'); // 视觉反馈
          return;
        }
        if (ctrlBPrefixRef.current) {
          ctrlBPrefixRef.current = false;
          switch (data) {
            case '%':
              handleSplitV();
              return;
            case '"':
              handleSplitH();
              return;
            case 'n':
              handleFocusNext();
              return;
            case 'p':
              handleFocusPrev();
              return;
            case 'x':
              handleCloseCurrent();
              return;
            default:
              return; // 未知快捷键, 不传 PTY
          }
        }

        const buf = inputBuffersRef.current.get(paneId) ?? '';
        const inCommandMode = buf.startsWith(':');

        // === Enter: 提交缓冲 ===
        if (data === '\r' || data === '\n') {
          inputBuffersRef.current.set(paneId, ''); // reset

          if (inCommandMode) {
            // 命令行模式: 解析为 cmux 命令
            const trimmed = buf.replace(/[\r\n]/g, '').trim();
            xterm.write('\r\n'); // 换行
            const msg = parseColonCommand(trimmed);
            if (msg) {
              executeCmuxCommand(msg, paneId);
            } else {
              xterm.write(
                `\x1b[38;5;203m[未知 cmux 命令: ${trimmed}]\x1b[0m\r\n`,
              );
            }
            return; // 不传 PTY
          }

          // 普通模式: 把缓冲内容 + Enter 一起传 PTY
          if (buf.length > 0) {
            pty?.write(buf + data).catch(() => { /* ignore */ });
          } else {
            pty?.write(data).catch(() => { /* ignore */ });
          }
          return;
        }

        // === 退格 (0x7f = DEL, 0x08 = BS) ===
        if (data === '\x7f' || data === '\b') {
          if (inCommandMode) {
            // 命令模式: 本地删除最后一个字符, 让 xterm 自行回显
            inputBuffersRef.current.set(paneId, buf.slice(0, -1));
            return; // 不传 PTY
          }
          // 普通模式: 直接传 PTY
          pty?.write(data).catch(() => { /* ignore */ });
          return;
        }

        // === 普通字符 ===
        if (inCommandMode) {
          // 命令模式: 仅本地累积, 不传 PTY (xterm 默认回显)
          inputBuffersRef.current.set(paneId, buf + data);
          return;
        }

        // 普通模式: 检测 `:` 进入命令模式 (不传 PTY)
        if (data === ':' && buf.length === 0) {
          inputBuffersRef.current.set(paneId, ':');
          return; // 不传 PTY, xterm 默认回显 ':'
        }

        // 其他普通字符: 直接传 PTY
        pty?.write(data).catch(() => { /* ignore */ });
      });
      disposables.push(() => onDataDisp.dispose());

      // resize 监听
      const onResize = () => {
        try {
          fit.fit();
          if (pty) {
            const c = xterm.cols || 80;
            const r = xterm.rows || 24;
            pty.resize(c, r).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      };
      window.addEventListener('resize', onResize);
      disposables.push(() => window.removeEventListener('resize', onResize));

      // 主题热切换
      const unwatchTheme = watchThemeChange(() => {
        xterm.options.theme = buildTerminalTheme();
      });
      disposables.push(unwatchTheme);

      resourcesMapRef.current.set(paneId, {
        xterm,
        fit,
        pty,
        disposables,
        shellIntegInjected: true,
      });

      // 初次 fit
      requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* ignore */ }
      });
    },
    [handleSplitV, handleSplitH, handleFocusNext, handleFocusPrev, handleCloseCurrent, executeCmuxCommand],
  );

  // === 5. 同步 pane 资源 (新建/销毁) ===
  useEffect(() => {
    if (!active) return;

    const currentIds = new Set(state.panes.map((p) => p.id));

    // 清理已移除 pane 的资源
    for (const [id, res] of resourcesMapRef.current.entries()) {
      if (!currentIds.has(id)) {
        for (const dispose of res.disposables) {
          try { dispose(); } catch { /* ignore */ }
        }
        try { res.xterm.dispose(); } catch { /* ignore */ }
        resourcesMapRef.current.delete(id);
        refsMapRef.current.delete(id);
        inputBuffersRef.current.delete(id);
      }
    }

    // 为新 pane 创建资源 (异步)
    for (const pane of state.panes) {
      if (!resourcesMapRef.current.has(pane.id)) {
        // 确保 ref 存在
        getOrCreateRef(pane.id);
        // 异步初始化 (等待 DOM 更新后 ref.current 才有值)
        requestAnimationFrame(() => {
          initPaneResources(pane.id).catch((e) =>
            console.error('[TerminalMultiplexer] init pane failed:', e),
          );
        });
      }
    }

    // 调整所有现有 pane 的 fit (布局变化时)
    for (const pane of state.panes) {
      const res = resourcesMapRef.current.get(pane.id);
      if (res) {
        try { res.fit.fit(); } catch { /* ignore */ }
      }
    }
  }, [active, state.panes, state.multiplexLayout, getOrCreateRef, initPaneResources]);

  // === 6. 聚焦 active pane 的 xterm ===
  useEffect(() => {
    if (!active) return;
    const res = resourcesMapRef.current.get(state.activePaneId);
    if (res) {
      try { res.xterm.focus(); } catch { /* ignore */ }
    }
  }, [active, state.activePaneId]);

  // === 7. 组件卸载: 清理所有资源 ===
  useEffect(() => {
    const resourcesMap = resourcesMapRef.current;
    const refsMap = refsMapRef.current;
    const inputBuffersMap = inputBuffersRef.current;
    return () => {
      for (const [, res] of resourcesMap.entries()) {
        for (const dispose of res.disposables) {
          try { dispose(); } catch { /* ignore */ }
        }
        try { res.xterm.dispose(); } catch { /* ignore */ }
      }
      resourcesMap.clear();
      refsMap.clear();
      inputBuffersMap.clear();
    };
  }, []);

  // === 8. 构建 Pane[] (store 元数据 + ref) ===
  const panesWithRefs: Pane[] = state.panes.map((p) => ({
    id: p.id,
    title: p.title,
    isFocused: p.isFocused,
    terminalRef: getOrCreateRef(p.id),
  }));

  if (!active) return null;

  return (
    <div
      className="h-full w-full"
      style={{ background: 'var(--terminal-bg)' }}
      data-testid="tdsf-terminal-multiplexer"
    >
      <MultiPlex
        panes={panesWithRefs}
        layout={state.multiplexLayout}
        activePaneId={state.activePaneId}
        onPaneFocus={(id) => dispatch({ type: 'set-active-pane', id })}
        onPaneClose={(id) => dispatch({ type: 'remove-pane', id })}
        onSplitV={handleSplitV}
        onSplitH={handleSplitH}
      />
    </div>
  );
}
