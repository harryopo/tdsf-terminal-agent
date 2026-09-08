import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockRejectedValue(new Error("not in tauri")),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  _setDevModeCheck,
  runSidecarStream,
  type SidecarStreamPart,
} from "./sidecar-adapter";
import { markSidecarConfigSynced } from "./sidecar-config-sync";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function makeLive() {
  return {
    cwd: null,
    terminalPrivate: false,
    activeFile: null,
    agentMode: "observe" as const,
    permissionLevel: 1,
    teach: true,
    sshSessionId: null,
    workspaceRoot: null,
  };
}

function makeMessages(text: string) {
  return [
    { id: "user-1", role: "user", parts: [{ type: "text", text }] },
  ] as never;
}

async function collect<T>(source: AsyncIterator<T>): Promise<T[]> {
  const values: T[] = [];
  while (true) {
    const next = await source.next();
    if (next.done) break;
    values.push(next.value);
  }
  return values;
}

describe("runSidecarStream — concurrent same-name tool calls", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    _setDevModeCheck(() => false);
    markSidecarConfigSynced();
  });

  it("uses backend call ids when completions arrive out of order", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, callback: (event: unknown) => void) => {
        listeners.set(event, callback);
        return Promise.resolve(() => listeners.delete(event));
      }) as never,
    );

    let resolveInvoke!: (value: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    const stream = runSidecarStream({
      agentId: "main",
      messages: makeMessages("查知识库"),
      input: "查知识库",
      live: makeLive(),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(listeners.has("sidecar:tool_call")).toBe(true));
    await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));
    const emit = listeners.get("sidecar:tool_call")!;
    const event = (payload: Record<string, unknown>) =>
      emit({ payload: { event_type: "tool_call", payload } });

    event({
      tool_name: "knowledge_search",
      tool_call_id: "a",
      status: "started",
      params: { query: "systemd" },
    });
    event({
      tool_name: "knowledge_search",
      tool_call_id: "b",
      status: "started",
      params: { query: "selinux" },
    });
    event({
      tool_name: "knowledge_search",
      tool_call_id: "b",
      status: "completed",
      result: { status: "success", query: "selinux" },
    });
    event({
      tool_name: "knowledge_search",
      tool_call_id: "a",
      status: "completed",
      result: { status: "success", query: "systemd" },
    });
    resolveInvoke({ observation: "done", mood: "done" });

    const parts: SidecarStreamPart[] = [];
    parts.push((await first).value as SidecarStreamPart);
    parts.push(...(await collect(iterator)));
    const outputs = parts.filter(
      (part): part is Extract<SidecarStreamPart, { type: "tool-output" }> =>
        part.type === "tool-output",
    );
    expect(outputs).toHaveLength(2);
    expect(outputs.map((part) => part.output)).toEqual([
      { status: "success", query: "selinux" },
      { status: "success", query: "systemd" },
    ]);
    expect(new Set(outputs.map((part) => part.toolCallId)).size).toBe(2);
  });

  it("ignores stream events from another conversation", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, callback: (event: unknown) => void) => {
        listeners.set(event, callback);
        return Promise.resolve(() => listeners.delete(event));
      }) as never,
    );

    let resolveInvoke!: (value: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve;
        }),
    );

    const iterator = runSidecarStream({
      agentId: "main",
      sessionId: "conversation-a",
      messages: makeMessages("检查服务"),
      input: "检查服务",
      live: makeLive(),
    })[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(listeners.has("sidecar:tool_call")).toBe(true));
    await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));

    const emit = listeners.get("sidecar:tool_call")!;
    const event = (sessionId: string, payload: Record<string, unknown>) =>
      emit({
        payload: { event_type: "tool_call", session_id: sessionId, payload },
      });
    event("conversation-b", {
      tool_name: "ssh_command",
      status: "started",
      params: { command: "hostname" },
    });
    event("conversation-b", {
      tool_name: "ssh_command",
      status: "completed",
      result: { status: "success", output: "wrong-host" },
    });
    event("conversation-a", {
      tool_name: "ssh_command",
      status: "started",
      params: { command: "uptime" },
    });
    event("conversation-a", {
      tool_name: "ssh_command",
      status: "completed",
      result: { status: "success", output: "right-host" },
    });
    resolveInvoke({ observation: "done", mood: "done" });

    const parts: SidecarStreamPart[] = [];
    parts.push((await first).value as SidecarStreamPart);
    parts.push(...(await collect(iterator)));
    expect(parts.filter((part) => part.type === "tool-input")).toHaveLength(1);
    const outputs = parts.filter(
      (part): part is Extract<SidecarStreamPart, { type: "tool-output" }> =>
        part.type === "tool-output",
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0].output).toEqual({
      status: "success",
      output: "right-host",
    });
    expect(mockInvoke.mock.calls[0][1].params.state.session_id).toBe(
      "conversation-a",
    );
  });
});
