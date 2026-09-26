import { IS_WINDOWS } from "@/lib/platform";
import type { IMarker, Terminal } from "@xterm/xterm";

const MAX_OSC52_CLIPBOARD_BYTES = 1024 * 1024;

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside a running
 * command (between OSC 133 B and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by command output. Only OSC 7 issued by
 * the local shell between commands should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Command stdout/stderr can contain attacker-controlled OSC 7 bytes.
    if (state?.inCommand) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
  // Fires on C (process executing) and A/D (back at prompt). Distinct from
  // inCommand, which is already true from B while the user merely types.
  onCommandState?: (running: boolean) => void,
): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A: start of a new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      onCommandState?.(false);
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // Command begins. Output is untrusted until D or the next A.
      if (state) state.inCommand = true;
    } else if (data.startsWith("C")) {
      // Command pre-execution marker; still inside the command.
      if (state) state.inCommand = true;
      onCommandState?.(true);
    } else if (data.startsWith("D")) {
      // Command ends.
      if (state) state.inCommand = false;
      onCommandState?.(false);
    }
    // 必须放行：xterm 的 OSC handler 是"后注册的先调用，谁先返回 true 就到此为止"，
    // 拦下来会让先注册的块收集器收不到 133 ⇒ 本地终端一条块都产不出来（#130 真机）。
    return false;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
}

export type ClipboardWriter = (text: string) => void | Promise<void>;

export function registerOsc52ClipboardHandler(
  term: Terminal,
  writeClipboard: ClipboardWriter = writeSystemClipboard,
): () => void {
  const d = term.parser.registerOscHandler(52, (data) => {
    const text = parseOsc52Clipboard(data);
    if (text === null) return true;
    queueMicrotask(() => {
      try {
        void Promise.resolve(writeClipboard(text)).catch(() => {});
      } catch {}
    });
    return true;
  });
  return () => d.dispose();
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it is a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1);
  }
  if (IS_WINDOWS) {
    if (/^[a-z]:/.test(path)) {
      path = path[0].toUpperCase() + path.slice(1);
    }
    // git-bash (MSYS) reports cwd as /c/Users/foo; map it to C:/Users/foo.
    const drive = path.match(/^\/([A-Za-z])(\/.*)?$/);
    if (drive) path = `${drive[1].toUpperCase()}:${drive[2] ?? "/"}`;
  }
  return path;
}

function parseOsc52Clipboard(data: string): string | null {
  const parts = data.split(";");
  if (parts.length < 2) return null;
  const selection = parts[0] || "c";
  if (!selection.includes("c")) return null;
  const encoded = parts.slice(1).join(";");
  if (!encoded || encoded === "?") return null;
  if (encoded.length > Math.ceil((MAX_OSC52_CLIPBOARD_BYTES * 4) / 3) + 4) {
    return null;
  }
  const compact = encoded.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;

  try {
    const bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0));
    if (bytes.byteLength > MAX_OSC52_CLIPBOARD_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function writeSystemClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
