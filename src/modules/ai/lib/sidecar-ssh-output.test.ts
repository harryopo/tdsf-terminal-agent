import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SshCommandOutputEvent } from "@/lib/sidecar-bridge";
import { useSshCommandOutputStore } from "../store/sshCommandOutputStore";
import { markSidecarConfigSynced } from "./sidecar-config-sync";
import {
  _setDevModeCheck,
  runSidecarStream,
  type SidecarStreamPart,
} from "./sidecar-adapter";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  useSshCommandOutputStore.setState({ calls: {} });
  _setDevModeCheck(() => false);
  markSidecarConfigSynced();
});

async function start() {
  const listeners = new Map<string, (event: unknown) => void>();
  vi.mocked(listen).mockImplementation(((
    event: string,
    callback: (event: unknown) => void,
  ) => {
    listeners.set(event, callback);
    return Promise.resolve(() => listeners.delete(event));
  }) as never);
  let resolveInvoke!: (result: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
  );
  const iterator = runSidecarStream({
    agentId: "main",
    sessionId: "conversation-a",
    messages: [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "检查服务" }],
      },
    ] as never,
    input: "检查服务",
    live: {
      cwd: null,
      terminalPrivate: false,
      activeFile: null,
      agentMode: "observe",
      teach: false,
      sshSessionId: 7,
      workspaceRoot: null,
    },
  })[Symbol.asyncIterator]();
  const first = iterator.next();
  await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));
  expect(listeners.has("sidecar:ssh_command_output")).toBe(true);
  const tool = (payload: Record<string, unknown>) =>
    listeners.get("sidecar:tool_call")!({
      payload: {
        session_id: "conversation-a",
        event_type: "tool_call",
        payload,
      },
    });
  const output = (
    toolCallId: string,
    operationId: string,
    overrides: Partial<SshCommandOutputEvent> = {},
  ) => {
    listeners.get("sidecar:ssh_command_output")!({
      payload: {
        toolCallId,
        operationId,
        conversationSessionId: "conversation-a",
        sshSessionId: 7,
        toolName: "ssh_command",
        command: "hostname",
        stream: "status",
        chunk: "",
        status: "running",
        ...overrides,
      },
    });
  };
  const finish = async () => {
    resolveInvoke({ observation: "", mood: "done" });
    const parts: SidecarStreamPart[] = [];
    const firstPart = await first;
    if (!firstPart.done) parts.push(firstPart.value);
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      parts.push(next.value);
    }
    expect(listeners.size).toBe(0);
    return parts;
  };
  return { tool, output, finish };
}

it("collects native output before UI mount and pairs repeated commands by backend id", async () => {
  const stream = await start();
  for (const id of ["backend-a", "backend-b"]) {
    stream.tool({
      tool_name: "ssh_command",
      tool_call_id: id,
      status: "started",
      params: { command: "hostname" },
    });
  }
  stream.output("backend-a", "operation-a");
  stream.output("backend-a", "operation-a", {
    stream: "stdout",
    chunk: "host-a",
  });
  stream.output("backend-a", "operation-a", {
    stream: "stderr",
    chunk: "warning-a",
  });
  stream.output("backend-b", "operation-b");
  stream.output("backend-b", "operation-b", {
    stream: "stdout",
    chunk: "host-b",
  });
  stream.output("backend-a", "operation-b", {
    stream: "stdout",
    chunk: "wrong-operation",
  });
  stream.output("backend-a", "operation-a", {
    stream: "stdout",
    chunk: "wrong-target",
    sshSessionId: 8,
  });
  stream.tool({
    tool_name: "ssh_command",
    tool_call_id: "backend-b",
    status: "completed",
    result: { status: "success", output: "host-b" },
  });
  stream.output("backend-b", "operation-b", {
    stream: "stdout",
    chunk: "late-output",
  });
  stream.tool({
    tool_name: "ssh_command",
    tool_call_id: "backend-a",
    status: "completed",
    result: { status: "success", output: "host-a", stderr: "warning-a" },
  });
  const parts = await stream.finish();
  const inputs = parts.filter((part) => part.type === "tool-input");
  expect(inputs).toHaveLength(2);
  const calls = useSshCommandOutputStore.getState().calls;
  expect(calls[inputs[0].toolCallId]).toMatchObject({
    backendToolCallId: "backend-a",
    stdout: "host-a",
    stderr: "warning-a",
    ended: true,
  });
  expect(calls[inputs[1].toolCallId]).toMatchObject({
    backendToolCallId: "backend-b",
    stdout: "host-b",
    stderr: "",
    ended: true,
  });
  const results = parts.filter((part) => part.type === "tool-output");
  expect(results.map((part) => part.toolCallId)).toEqual([
    inputs[1].toolCallId,
    inputs[0].toolCallId,
  ]);
});

it("keeps legacy final results but never guesses live ownership without a call id", async () => {
  const stream = await start();
  stream.tool({
    tool_name: "ssh_command",
    status: "started",
    params: { command: "hostname" },
  });
  stream.output("", "operation-legacy", { toolCallId: undefined });
  stream.output("", "operation-legacy", {
    toolCallId: undefined,
    stream: "stdout",
    chunk: "not-associated",
  });
  stream.tool({
    tool_name: "ssh_command",
    status: "completed",
    result: { status: "success", output: "legacy-final" },
  });
  const parts = await stream.finish();
  expect(useSshCommandOutputStore.getState().calls).toEqual({});
  expect(parts.filter((part) => part.type === "tool-output")).toEqual([
    expect.objectContaining({
      output: { status: "success", output: "legacy-final" },
    }),
  ]);
});

it("closes unfinished live bindings when the invoke ends without a terminal tool event", async () => {
  const stream = await start();
  stream.tool({
    tool_name: "ssh_command",
    tool_call_id: "backend-a",
    status: "started",
    params: { command: "hostname" },
  });
  stream.output("backend-a", "operation-a");
  stream.output("backend-a", "operation-a", {
    stream: "stdout",
    chunk: "partial",
  });
  await stream.finish();
  expect(Object.values(useSshCommandOutputStore.getState().calls)).toEqual([
    expect.objectContaining({ stdout: "partial", ended: true }),
  ]);
});

it("does not double-append a native event seen by another invoke listener", async () => {
  const first = await start();
  const second = await start();
  first.tool({
    tool_name: "ssh_command",
    tool_call_id: "backend-a",
    status: "started",
    params: { command: "hostname" },
  });
  second.tool({
    tool_name: "ssh_command",
    tool_call_id: "backend-b",
    status: "started",
    params: { command: "hostname" },
  });
  for (const listener of [first, second]) {
    listener.output("backend-a", "operation-a");
    listener.output("backend-a", "operation-a", {
      stream: "stdout",
      chunk: "one-chunk",
    });
  }
  expect(
    Object.values(useSshCommandOutputStore.getState().calls).find(
      (call) => call.backendToolCallId === "backend-a",
    )?.stdout,
  ).toBe("one-chunk");
  await first.finish();
  await second.finish();
});

it("keeps front call keys distinct for invokes started in the same millisecond", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    const first = await start();
    const second = await start();
    first.tool({
      tool_name: "ssh_command",
      tool_call_id: "backend-a",
      status: "started",
      params: { command: "hostname" },
    });
    second.tool({
      tool_name: "ssh_command",
      tool_call_id: "backend-b",
      status: "started",
      params: { command: "hostname" },
    });
    const calls = Object.values(useSshCommandOutputStore.getState().calls);
    // Close both iterators even when the regression assertion below fails.
    await first.finish();
    await second.finish();
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(2);
    expect(calls.map((call) => call.backendToolCallId)).toEqual([
      "backend-a",
      "backend-b",
    ]);
  } finally {
    clock.mockRestore();
  }
});
