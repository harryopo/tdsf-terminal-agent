/**
 * pty-bridge.ts — TDSF PTY 桥接层 (基于 terax-ai pty-bridge.ts 搬运)
 * -----------------------------------------------------------------------------
 * 核心改进 (相对于旧 tauri.ts):
 *   - 原始字节 Channel (Channel<ArrayBuffer>), 无 JSON 序列化开销
 *   - pty_write 通过 HTTP Header x-pty-id 传递会话 ID, 请求体为原始字节
 *   - 零基 JSON 往返 (每次按键不再序列化/反序列化)
 *
 * 搬运来源: opensource-reference/terax-ai/src/modules/terminal/lib/pty-bridge.ts
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { currentWorkspaceEnv } from './workspace-env';

const textEncoder = new TextEncoder();

export interface PtyHandlers {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
}

export interface PtySession {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 打开 PTY 会话
 *
 * Rust 侧: pty_open 命令
 * - 参数: cols, rows, cwd, workspace, blocks, shell, onData, onExit
 * - 返回: u32 (会话 ID)
 * - onData: Channel<ArrayBuffer> → Rust Channel<Response> (Tauri 2 自动映射)
 * - onExit: Channel<number> → Rust Channel<i32>
 */
export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
  blocks?: boolean,
  shell?: string,
): Promise<PtySession> {
  // 原始字节 Channel — 无 base64/JSON 往返
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

  const id = await invoke<number>('pty_open', {
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
  const headers = { 'x-pty-id': String(id) };

  return {
    id,
    // 原始字节 + id header: 每次按键无 JSON 往返
    write: (data) => invoke('pty_write', textEncoder.encode(data), { headers }),
    resize: (c, r) => invoke('pty_resize', { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke('pty_close', { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
