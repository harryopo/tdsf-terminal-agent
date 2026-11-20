import { render, screen } from "@testing-library/react";
import { readUIMessageStream } from "ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SshCommandOutputEvent } from "@/lib/sidecar-bridge";
import { useSshCommandOutputStore } from "@/modules/ai/store/sshCommandOutputStore";
import {
  markSidecarConfigSynced,
} from "@/modules/ai/lib/sidecar-config-sync";
import {
  _setDevModeCheck,
  runSidecarStream,
  sidecarStreamToUIMessageStream,
} from "@/modules/ai/lib/sidecar-adapter";
import { Tool } from "./tool";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const conversationSessionId = "chat-1";
const command = "hostname";
const backendToolCallId = "backend-call-1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(listen).mockReset();
  useSshCommandOutputStore.setState({ calls: {} });
  _setDevModeCheck(() => false);
  markSidecarConfigSynced();
});

afterEach(() => {
  _setDevModeCheck(() => import.meta.env.DEV);
});

async function beginCall(options: {
  nativeExitCode?: number;
  signal?: AbortSignal;
  backendId?: string;
} = {}) {
  const backendId = options.backendId ?? backendToolCallId;
  const listeners = new Map<string, (event: unknown) => void>();
  vi.mocked(listen).mockImplementation(((event: string, callback: (event: unknown) => void) => {
    listeners.set(event, callback);
    return Promise.resolve(() => listeners.delete(event));
  }) as never);

  const result = deferred<Record<string, unknown>>();
  vi.mocked(invoke).mockReturnValue(result.promise as never);
  const source = runSidecarStream({
    agentId: "main",
    sessionId: conversationSessionId,
    messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: command }] }] as never,
    input: command,
    abortSignal: options.signal,
    live: {
      cwd: null,
      terminalPrivate: false,
      activeFile: null,
      agentMode: "observe",
      teach: false,
      sshSessionId: 7,
      workspaceRoot: null,
    },
  });
  const errors: string[] = [];
  const stream = sidecarStreamToUIMessageStream(source, {
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      return message;
    },
  });
  let toolPart: Record<string, unknown> | undefined;
  const consumed = (async () => {
    for await (const message of readUIMessageStream({ stream })) {
      toolPart = message.parts.find(
        (part) => "toolCallId" in part && part.toolCallId,
      ) as Record<string, unknown> | undefined;
    }
  })();

  await vi.waitFor(() => {
    expect(listeners.has("sidecar:tool_call")).toBe(true);
    expect(listeners.has("sidecar:ssh_command_output")).toBe(true);
  });
  const emitTool = (payload: Record<string, unknown>) =>
    listeners.get("sidecar:tool_call")!({
      payload: {
        session_id: conversationSessionId,
        event_type: "tool_call",
        payload,
      },
    });
  const outputEvent = (fields: Partial<SshCommandOutputEvent>) => ({
      payload: {
        toolCallId: backendId,
        operationId: "operation-1",
        conversationSessionId,
        sshSessionId: 7,
        toolName: "ssh_command",
        command,
        stream: "status",
        chunk: "",
        status: "running",
        ...fields,
      },
  });
  const originalOutputListener = listeners.get("sidecar:ssh_command_output")!;
  const emitOutput = (fields: Partial<SshCommandOutputEvent>) =>
    listeners.get("sidecar:ssh_command_output")!(outputEvent(fields));
  const emitLateOutput = (fields: Partial<SshCommandOutputEvent>) =>
    originalOutputListener(outputEvent(fields));

  emitTool({
    tool_name: "ssh_command",
    tool_call_id: backendId,
    status: "started",
    params: { command },
  });
  emitOutput({});
  emitOutput({ stream: "stdout", chunk: "partial stdout" });
  emitOutput({ stream: "stderr", chunk: "partial stderr" });
  if (options.nativeExitCode !== undefined) {
    emitOutput({
      status: options.nativeExitCode === 0 ? "completed" : "failed",
      exitCode: options.nativeExitCode,
    });
  }

  // These cases retire an already visible card, not an event still in transit.
  await vi.waitFor(() => {
    expect(toolPart?.state).toBe("input-available");
  });

  const settle = async () => {
    await consumed;
    expect(listeners.size).toBe(0);
    if (!toolPart) throw new Error("SDK did not produce the SSH tool part");
    return toolPart;
  };
  return {
    errors,
    emitTool,
    emitOutput,
    emitLateOutput,
    finish: async (invokeResult: Record<string, unknown>) => {
      result.resolve(invokeResult);
      return settle();
    },
    fail: async (error: Error) => {
      result.reject(error);
      return settle();
    },
  };
}

function renderTool(part: Record<string, unknown>) {
  render(
    <Tool
      toolName={String(part.toolName)}
      toolCallId={String(part.toolCallId)}
      state={part.state as "input-available" | "output-available"}
      input={part.input}
      output={part.output}
      defaultOpen
    />,
  );
}

it("marks a finished invoke without a tool result as unconfirmed, retaining partial streams", async () => {
  const call = await beginCall();
  const part = await call.finish({ observation: "turn complete" });

  expect(part.state).toBe("input-available");
  const stored = useSshCommandOutputStore.getState().calls[String(part.toolCallId)];
  expect(stored).toMatchObject({ stdout: "partial stdout", stderr: "partial stderr", ended: true });
  renderTool(part);
  expect(screen.getByText("partial stdout")).toBeTruthy();
  expect(screen.getByText("partial stderr")).toBeTruthy();
  expect(screen.getByText("结果未确认")).toBeTruthy();
  expect(screen.queryByText("实时回显")).toBeNull();
  expect(screen.getByLabelText("indeterminate").className).not.toContain("animate-pulse");
  expect(call.errors).toEqual([]);
});

it("does not treat an early native exit zero as a received business result", async () => {
  const call = await beginCall({ nativeExitCode: 0 });
  const part = await call.finish({ observation: "turn complete" });

  expect(part.state).toBe("input-available");
  const stored = useSshCommandOutputStore.getState().calls[String(part.toolCallId)];
  expect(stored).toMatchObject({ stdout: "partial stdout", stderr: "partial stderr", ended: true, exitCode: 0 });
  renderTool(part);
  expect(screen.getByText("结果未确认")).toBeTruthy();
  expect(screen.queryByText("输出已返回")).toBeNull();
  expect(screen.getByText("退出码 0")).toBeTruthy();
  expect(screen.getByLabelText("indeterminate").className).not.toContain("animate-pulse");
  expect(call.errors).toEqual([]);
});

it.each([
  {
    label: "successful business result with a nonzero diagnostic exit",
    result: { status: "success", output: "diagnostic returned", exit_code: 7 },
  },
  {
    label: "indeterminate business result",
    result: { status: "indeterminate", output: "may have run", exit_code: -1 },
  },
])("keeps the $label payload as a real SDK result", async ({ result }) => {
  const call = await beginCall({ nativeExitCode: result.exit_code });
  call.emitTool({
    tool_name: "ssh_command",
    tool_call_id: backendToolCallId,
    status: "completed",
    result,
  });
  const part = await call.finish({ observation: "turn complete" });

  expect(part.state).toBe("output-available");
  expect(part.output).toEqual(result);
  expect(
    useSshCommandOutputStore.getState().calls[String(part.toolCallId)]?.resultMissing,
  ).toBeFalsy();
  expect(call.errors).toEqual([]);
  renderTool(part);
  if (result.status === "success") {
    expect(screen.queryByText("结果未确认")).toBeNull();
  } else {
    expect(screen.getByLabelText("indeterminate")).toBeTruthy();
  }
});

it("marks a failed invoke as unconfirmed while retaining partial output and cleaning listeners", async () => {
  const call = await beginCall();
  const part = await call.fail(new Error("invoke failed"));

  expect(part.state).toBe("input-available");
  renderTool(part);
  expect(screen.getByText("partial stdout")).toBeTruthy();
  expect(screen.getByText("partial stderr")).toBeTruthy();
  expect(screen.getByText("结果未确认")).toBeTruthy();
  expect(call.errors).toHaveLength(1);
  expect(call.errors[0]).toBeTruthy();
});

it("retires on abort without claiming the remote command stopped", async () => {
  const controller = new AbortController();
  const call = await beginCall({ signal: controller.signal });
  controller.abort();
  const part = await call.finish({ observation: "late invoke completion" });

  expect(part.state).toBe("input-available");
  const stored = useSshCommandOutputStore.getState().calls[String(part.toolCallId)];
  expect(stored).toMatchObject({ stdout: "partial stdout", stderr: "partial stderr", ended: true, resultMissing: true });
  renderTool(part);
  expect(screen.getByText("结果未确认")).toBeTruthy();
  expect(screen.getByText(/不代表远端命令已经停止/)).toBeTruthy();
  expect(screen.queryByText("远端命令已停止")).toBeNull();
  expect(call.errors).toEqual([]);
});

it.each([
  { status: "completed", result: { status: "success", output: "diagnostic", exit_code: 7 } },
  { status: "completed", result: { status: "indeterminate", output: "may have run", exit_code: -1 } },
  { status: "error", result: { status: "failed", output: "write failed", exit_code: 2 } },
])("keeps a $result.status tool result arriving just after invoke completion", async ({ status, result }) => {
  vi.useFakeTimers();
  let completion: Promise<Record<string, unknown>> | undefined;
  try {
    const call = await beginCall();
    completion = call.finish({ observation: "" });
    await vi.advanceTimersByTimeAsync(0);
    call.emitTool({
      tool_name: "ssh_command",
      tool_call_id: backendToolCallId,
      status,
      result,
    });
    await vi.advanceTimersByTimeAsync(30);
    const part = await completion;

    expect(part.state).toBe("output-available");
    expect(part.output).toEqual(result);
    expect(part.input).toEqual({ command });
    expect(call.errors).toEqual([]);
  } finally {
    await vi.runOnlyPendingTimersAsync();
    await completion;
    vi.useRealTimers();
  }
});

it("rejects an old output callback after finish while a new call still receives output", async () => {
  const oldCall = await beginCall({ backendId: "backend-old" });
  const oldPart = await oldCall.finish({ observation: "old turn complete" });
  const oldId = String(oldPart.toolCallId);
  const oldOutput = useSshCommandOutputStore.getState().calls[oldId]?.stdout;

  oldCall.emitLateOutput({ stream: "stdout", chunk: "late old output" });
  expect(useSshCommandOutputStore.getState().calls[oldId]?.stdout).toBe(oldOutput);

  const newCall = await beginCall({ backendId: "backend-new" });
  newCall.emitOutput({ stream: "stdout", chunk: "fresh new output" });
  const newPart = await newCall.finish({ observation: "new turn complete" });
  const newId = String(newPart.toolCallId);
  expect(newId).not.toBe(oldId);
  expect(useSshCommandOutputStore.getState().calls[newId]?.stdout).toContain("fresh new output");
  expect(useSshCommandOutputStore.getState().calls[oldId]?.stdout).toBe(oldOutput);
  renderTool(newPart);
  expect(screen.getByText(/partial stdoutfresh new output/)).toBeTruthy();
});
