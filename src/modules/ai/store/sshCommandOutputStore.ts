import { create } from "zustand";
import type { SshCommandOutputEvent } from "@/lib/sidecar-bridge";

const MAX_CALLS = 32;
const MAX_STREAM_CHARS = 65_536;

type CallOwner = {
  toolCallId: string;
  backendToolCallId: string;
  conversationSessionId: string | null;
  toolName: string;
  command: string;
  sshSessionId?: number;
};

export type SshOutputRecord = CallOwner & {
  operationId?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ended: boolean;
  exitCode?: number | null;
};

type SshCommandOutputState = {
  calls: Record<string, SshOutputRecord>;
  begin: (owner: CallOwner) => void;
  record: (event: SshCommandOutputEvent) => void;
  finish: (toolCallId: string) => void;
};

function tail(text: string): string {
  if (text.length <= MAX_STREAM_CHARS) return text;
  const clipped = text.slice(-MAX_STREAM_CHARS);
  const first = clipped.charCodeAt(0);
  // A UTF-16 cut must not leave the second half of a surrogate pair alone.
  return first >= 0xdc00 && first <= 0xdfff ? clipped.slice(1) : clipped;
}

// Collect before agent.invoke, not when a collapsible card happens to mount.
// Unknown/legacy ids never fall back to the active conversation or command text.
export const useSshCommandOutputStore = create<SshCommandOutputState>(
  (set) => ({
    calls: {},
    begin: (owner) =>
      set((state) => {
        if (state.calls[owner.toolCallId]) return state;
        const calls = Object.fromEntries(
          Object.entries(state.calls).slice(-(MAX_CALLS - 1)),
        );
        calls[owner.toolCallId] = {
          ...owner,
          stdout: "",
          stderr: "",
          truncated: false,
          ended: false,
        };
        return { calls };
      }),
    record: (event) =>
      set((state) => {
        const call = Object.values(state.calls).find(
          (row) =>
            event.toolCallId && row.backendToolCallId === event.toolCallId,
        );
        if (
          !call ||
          call.ended ||
          (event.conversationSessionId ?? null) !==
            call.conversationSessionId ||
          event.toolName !== call.toolName ||
          event.command !== call.command ||
          (call.sshSessionId !== undefined &&
            event.sshSessionId !== call.sshSessionId) ||
          !Number.isInteger(event.sshSessionId) ||
          event.sshSessionId <= 0 ||
          typeof event.chunk !== "string"
        )
          return state;

        let bound = call;
        if (!call.operationId) {
          if (
            event.stream !== "status" ||
            event.status !== "running" ||
            typeof event.operationId !== "string" ||
            !event.operationId
          )
            return state;
          bound = {
            ...call,
            operationId: event.operationId,
            sshSessionId: event.sshSessionId,
          };
        } else if (event.operationId !== call.operationId) {
          return state;
        }

        const stdout =
          bound.stdout + (event.stream === "stdout" ? event.chunk : "");
        const stderr =
          bound.stderr + (event.stream === "stderr" ? event.chunk : "");
        return {
          calls: {
            ...state.calls,
            [call.toolCallId]: {
              ...bound,
              stdout: tail(stdout),
              stderr: tail(stderr),
              truncated:
                bound.truncated ||
                stdout.length > MAX_STREAM_CHARS ||
                stderr.length > MAX_STREAM_CHARS,
              ended: event.status !== "running",
              exitCode: event.exitCode ?? bound.exitCode,
            },
          },
        };
      }),
    finish: (toolCallId) =>
      set((state) => {
        const call = state.calls[toolCallId];
        if (!call || call.ended) return state;
        return {
          calls: { ...state.calls, [toolCallId]: { ...call, ended: true } },
        };
      }),
  }),
);
