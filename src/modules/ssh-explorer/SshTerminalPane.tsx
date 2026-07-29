/**
 * SshTerminalPane.tsx — TDSF 魔改: SSH 终端面板（右侧工作区接管）
 * -----------------------------------------------------------------------------
 * 2026-07-29 对齐本地终端外观（修"黑底黑字 / 字号大小与本地不一致"）：
 *   - 主题改用与本地终端**同一个** `@/styles/terminalTheme.buildTerminalTheme()`
 *     （读真实主题 token；旧的 `@/lib/terminal-theme` 读空 `--terminal-*` 会回退
 *     #000000 → 黑底黑字看不见）。
 *   - 字体/字号/字重/字间距/scrollback 改用 `useTerminalFont()` + 偏好设置，
 *     与本地 `useTerminalSession` 完全一致；不再硬编码 JetBrains Mono/13/lineHeight1.6。
 *   - 主题切换用 `useTheme()` 响应 + rAF 重新套用（与本地 TerminalPane 一致）。
 *
 * 数据流:
 *   PTY 输出: sshStore.connect 的 onData → emitTerminalData fan-out →
 *             subscribeTerminalData(sessionId) → xterm.write(Uint8Array)
 *   用户输入: xterm.onData → session.handle.write → invoke ssh_write
 *   Resize:  FitAddon.fit() → session.handle.resize → invoke ssh_resize
 *
 * 先到数据缓冲: sshStore 在无订阅者时缓冲首批 PTY 输出（256 KiB 上限），
 * 本组件挂载订阅时立即 flush，修复"连接就绪早于组件挂载导致黑屏"竞态。
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal as XTerm, type FontWeight } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { useTheme } from "@/modules/theme";
import { useTerminalFont } from "@/modules/terminal/lib/useTerminalFont";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore } from "./sshStore";

type Props = {
  /** 前端会话 id（sshStore.sessions[].id） */
  sessionId: string;
  className?: string;
};

export function SshTerminalPane({ sessionId, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const session = useSshStore((s) =>
    s.sessions.find((it) => it.id === sessionId),
  );
  const subscribeTerminalData = useSshStore((s) => s.subscribeTerminalData);

  // handle 用 ref 保存, 避免 xterm effect 因 handle 引用变化而重建终端
  const handleRef = useRef(session?.handle ?? null);
  handleRef.current = session?.handle ?? null;

  // 与本地终端同源的主题 / 字体 / 偏好
  const { resolvedMode, activeTheme } = useTheme();
  const { fontFamily, fontWeight, fontSize } = useTerminalFont();
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  const cursorBlink = usePreferencesStore((p) => p.terminalCursorBlink);
  const effectiveFontSize = Math.max(4, Math.round(fontSize * zoomLevel));

  // 让稳定的挂载 effect 能读到最新字体/scrollback 而不必重建 xterm
  const initRef = useRef({
    fontFamily,
    fontWeight,
    fontSize: effectiveFontSize,
    letterSpacing,
    scrollback,
    cursorBlink,
  });
  initRef.current = {
    fontFamily,
    fontWeight,
    fontSize: effectiveFontSize,
    letterSpacing,
    scrollback,
    cursorBlink,
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const init = initRef.current;
    const xterm = new XTerm({
      fontFamily: init.fontFamily,
      fontWeight: init.fontWeight as FontWeight,
      fontSize: init.fontSize,
      letterSpacing: init.letterSpacing,
      scrollback: init.scrollback,
      cursorBlink: init.cursorBlink,
      allowProposedApi: true,
      theme: buildTerminalTheme(),
    });
    xtermRef.current = xterm;

    const fit = new FitAddon();
    fitRef.current = fit;
    xterm.loadAddon(fit);
    try {
      xterm.loadAddon(new Unicode11Addon());
      xterm.unicode.activeVersion = "11";
    } catch {
      /* 不阻塞 */
    }
    xterm.loadAddon(new WebLinksAddon());

    xterm.open(container);

    // 订阅 PTY 输出（挂载即 flush 先到数据缓冲）
    const unsubscribe = subscribeTerminalData(sessionId, (bytes) => {
      xterm.write(bytes);
    });

    // 用户输入 → SSH stdin
    const dataDisp = xterm.onData((data) => {
      handleRef.current?.write(data).catch((e) => {
        console.error("[SshTerminalPane] write failed:", e);
      });
    });

    // 初始 fit + 上报窗口尺寸
    const doResize = () => {
      try {
        fit.fit();
        const cols = xterm.cols || 80;
        const rows = xterm.rows || 24;
        handleRef.current?.resize(cols, rows).catch(() => {
          /* ignore */
        });
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(doResize);

    const resizeObserver = new ResizeObserver(doResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", doResize);

    return () => {
      window.removeEventListener("resize", doResize);
      resizeObserver.disconnect();
      dataDisp.dispose();
      unsubscribe();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, subscribeTerminalData]);

  // 主题切换时重新套用（rAF defer 让 CSS token 解析到新值，与本地 TerminalPane 一致）
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    const id = requestAnimationFrame(() => {
      xterm.options.theme = buildTerminalTheme();
    });
    return () => cancelAnimationFrame(id);
  }, [resolvedMode, activeTheme]);

  // 字体/字号/字间距/scrollback 变化时更新并重新 fit（不重建 xterm）
  useLayoutEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.fontFamily = fontFamily;
    xterm.options.fontWeight = fontWeight as FontWeight;
    xterm.options.fontSize = effectiveFontSize;
    xterm.options.letterSpacing = letterSpacing;
    xterm.options.scrollback = scrollback;
    xterm.options.cursorBlink = cursorBlink;
    try {
      fitRef.current?.fit();
      const cols = xterm.cols || 80;
      const rows = xterm.rows || 24;
      handleRef.current?.resize(cols, rows).catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }, [
    fontFamily,
    fontWeight,
    effectiveFontSize,
    letterSpacing,
    scrollback,
    cursorBlink,
  ]);

  return (
    <div
      ref={containerRef}
      className={`bg-background ${className ?? "h-full w-full overflow-hidden"}`}
      data-testid="ssh-terminal-pane"
    />
  );
}
