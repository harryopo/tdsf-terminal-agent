import { invoke } from "@tauri-apps/api/core";
import type { AgentMode } from "../agents/registry";

export type AgentModeSource = {
  get: () => AgentMode;
  subscribe: (listener: () => void) => () => void;
};

const runningModes = new Map<string, { mode: AgentMode }>();
const canUpdate = (mode: AgentMode) => mode === "confirm" || mode === "auto";

export function canSwitchRunningMode(
  sessionId: string | null,
  mode: AgentMode,
): boolean {
  const running = sessionId ? runningModes.get(sessionId)?.mode : undefined;
  return running === undefined || running === mode || (canUpdate(running) && canUpdate(mode));
}

/** One invocation owns this subscription; neither a tab switch nor a late ACK owns it. */
export function syncRunningMode(opts: {
  sessionId: string;
  streamId: string;
  initialMode: AgentMode;
  source: AgentModeSource;
  onError: (message: string) => void;
}): () => void {
  let active = true;
  let sending = false;
  let revision = 0;
  let observed = opts.initialMode;
  let pending: { mode: AgentMode; revision: number } | undefined;
  const owner = { mode: observed };
  runningModes.set(opts.sessionId, owner);

  const send = async () => {
    if (sending || !active) return;
    sending = true;
    try {
      while (active && pending) {
        const update = pending;
        pending = undefined;
        for (let attempt = 0; active; attempt++) {
          const ack = await invoke<{
            ok: boolean;
            reason?: string;
            mode?: AgentMode;
            revision?: number;
          }>("ipc_invoke", {
            method: "agent.set_mode",
            params: {
              session_id: opts.sessionId,
              stream_id: opts.streamId,
              ...update,
            },
            timeoutMs: 3000,
          });
          if (!active) return;
          if (ack.ok && ack.mode === update.mode && ack.revision === update.revision) break;
          // Rust dispatches IPC calls asynchronously; the control may arrive
          // just before agent.invoke has registered its queued invocation.
          if (ack.reason === "not_active" && attempt < 19) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          throw new Error(ack.reason || "invalid mode acknowledgement");
        }
      }
    } catch {
      if (active) {
        active = false;
        opts.onError("运行模式同步失败，已请求停止本轮任务。请确认任务停止后再继续。");
      }
    } finally {
      sending = false;
    }
  };

  const unsubscribe = opts.source.subscribe(() => {
    if (!active) return;
    const mode = opts.source.get();
    if (mode === observed) return;
    observed = mode;
    owner.mode = mode;
    pending = { mode, revision: ++revision };
    void send();
  });
  return () => {
    active = false;
    pending = undefined;
    unsubscribe();
    if (runningModes.get(opts.sessionId) === owner) runningModes.delete(opts.sessionId);
  };
}
