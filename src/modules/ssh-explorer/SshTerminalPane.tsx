/**
 * SshTerminalPane.tsx — TDSF 魔改: SSH 终端面板（右侧工作区接管）
 * -----------------------------------------------------------------------------
 * 数据流:
 *   PTY 输出: sshStore.connect 的 onData → emitTerminalData fan-out →
 *             subscribeTerminalData(sessionId) → xterm.write(Uint8Array)
 *   用户输入: xterm.onData → session.handle.write → invoke ssh_write
 *   Resize:  FitAddon.fit() → session.handle.resize → invoke ssh_resize
 *
 * 先到数据缓冲: sshStore 在无订阅者时缓冲首批 PTY 输出（256 KiB 上限），
 * 本组件挂载订阅时立即 flush，修复"连接就绪早于组件挂载导致黑屏"竞态。
 */
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { buildTerminalTheme, watchThemeChange } from "@/lib/terminal-theme";
import { useSshStore } from "./sshStore";

type Props = {
  /** 前端会话 id（sshStore.sessions[].id） */
  sessionId: string;
  className?: string;
};

export function SshTerminalPane({ sessionId, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const session = useSshStore((s) =>
    s.sessions.find((it) => it.id === sessionId),
  );
  const subscribeTerminalData = useSshStore((s) => s.subscribeTerminalData);

  // handle 用 ref 保存, 避免 xterm effect 因 handle 引用变化而重建终端
  const handleRef = useRef(session?.handle ?? null);
  handleRef.current = session?.handle ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const xterm = new XTerm({
      fontFamily:
        "'JetBrains Mono', 'Maple Mono NF', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.6,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
      allowProposedApi: true,
      allowTransparency: true,
      theme: buildTerminalTheme(),
    });

    const fit = new FitAddon();
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

    const unwatchTheme = watchThemeChange(() => {
      xterm.options.theme = buildTerminalTheme();
    });

    return () => {
      window.removeEventListener("resize", doResize);
      resizeObserver.disconnect();
      unwatchTheme();
      dataDisp.dispose();
      unsubscribe();
      xterm.dispose();
    };
  }, [sessionId, subscribeTerminalData]);

  return (
    <div
      ref={containerRef}
      className={`bg-background ${className ?? "h-full w-full overflow-hidden"}`}
      data-testid="ssh-terminal-pane"
    />
  );
}
