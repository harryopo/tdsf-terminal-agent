import { currentWorkspaceEnv } from "@/modules/workspace";
import { Channel, invoke } from "@tauri-apps/api/core";

const textEncoder = new TextEncoder();

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

/**
 * TDSF 魔改 (#15): 传输层抽象 seam —— 让本地 PTY 与远程 SSH 共用同一接口。
 *
 * 本地 `PtySession` 天然满足此接口（结构子类型，无需显式 implements）。
 * SSH 终端通过实现此接口，可注入 `useTerminalSession.openTransport`，
 * 复用 rendererPool 的渲染/主题/字体/保活，与本地终端一模一样。
 *
 * 设计约束：
 * - `id` 用于日志与诊断（SSH 用 sessionId 字符串，PTY 用数字 ptyId）。
 * - `write/resize/close` 返回 Promise<void> | void，兼容同步与异步传输。
 * - `close` 对 SSH 仅 unsubscribe 前端订阅，不断底层连接（SFTP 共用）。
 */
export interface TerminalTransport {
  id: number | string;
  write(data: string): Promise<void> | void;
  resize(cols: number, rows: number): Promise<void> | void;
  close(): Promise<void> | void;
}

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    blocks: blocks ?? false,
    shell: shell ?? null,
    onData,
    onExit,
  });

  let closed = false;
  const headers = { "x-pty-id": String(id) };

  return {
    id,
    // Raw bytes + id header: no JSON round-trip on the per-keystroke path.
    write: (data) => invoke("pty_write", textEncoder.encode(data), { headers }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
