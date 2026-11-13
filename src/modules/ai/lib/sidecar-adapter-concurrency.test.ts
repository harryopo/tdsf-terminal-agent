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
import { useSshCommandOutputStore } from "../store/sshCommandOutputStore";

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

  it("registers and finishes a remote write without a command against its explicit SSH target", async () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, callback: (event: unknown) => void) => {
        listeners.set(event, callback);
        return Promise.resolve(() => listeners.delete(event));
      }) as never,
    );

    let resolveInvoke!: (value: unknown) => void;
    mockInvoke.mockImplementation(
      () => new Promise((resolve) => { resolveInvoke = resolve; }),
    );

    const live = { ...makeLive(), sshSessionId: 9 };
    const iterator = runSidecarStream({
      agentId: "main",
      sessionId: "chat-write",
      messages: makeMessages("write a remote file"),
      input: "write a remote file",
      live,
    })[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(listeners.has("sidecar:tool_call")).toBe(true));
    await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));

    live.sshSessionId = 88;
    const emit = listeners.get("sidecar:tool_call")!;
    const event = (payload: Record<string, unknown>) =>
      emit({ payload: { event_type: "tool_call", session_id: "chat-write", payload } });
    event({
      tool_name: "write_remote_file",
      tool_call_id: "backend-write-1",
      status: "started",
      params: {
        path: "/srv/app.conf",
        ssh_session_id: 42,
        size: 12,
        backup_path: "/srv/app.conf.bak",
      },
    });
    event({
      tool_name: "write_remote_file",
      tool_call_id: "backend-write-1",
      status: "completed",
      result: { status: "success", path: "/srv/app.conf" },
    });
    resolveInvoke({ observation: "done", mood: "done" });

    const parts: SidecarStreamPart[] = [
      (await first).value as SidecarStreamPart,
      ...(await collect(iterator)),
    ];
    const toolInput = parts.find(
      (part): part is Extract<SidecarStreamPart, { type: "tool-input" }> =>
        part.type === "tool-input" && part.toolName === "write_remote_file",
    );
    expect(toolInput).toBeDefined();
    const owner = useSshCommandOutputStore.getState().calls[toolInput!.toolCallId];
    expect(owner).toMatchObject({
      toolCallId: toolInput!.toolCallId,
      backendToolCallId: "backend-write-1",
      conversationSessionId: "chat-write",
      toolName: "write_remote_file",
      command: "",
      sshSessionId: 42,
      ended: true,
    });
  });
});
