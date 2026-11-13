import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@ai-sdk/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: vi.fn(() => true) }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { markSidecarConfigSynced } from "./sidecar-config-sync";
import { runSidecarStream } from "./sidecar-adapter";
import { useNeedsYouWait } from "../store/needsYouWaitStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockIsTauri = isTauriRuntime as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;
const mockUnlisten = vi.fn();
let usesFakeTimers = false;

function useFakeTimers() {
  usesFakeTimers = true;
  vi.useFakeTimers();
}

function messages(): UIMessage[] {
  return [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }];
}

type TestPart = { type: string; error?: string; delta?: string };

async function collect(stream: AsyncIterable<TestPart>): Promise<TestPart[]> {
  const parts: TestPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

beforeEach(() => {
  usesFakeTimers = false;
  mockInvoke.mockReset();
  mockIsTauri.mockReset().mockReturnValue(true);
  mockListen.mockReset().mockResolvedValue(mockUnlisten);
  mockUnlisten.mockReset();
  markSidecarConfigSynced();
  useNeedsYouWait.getState().reset();
  localStorage.setItem("tdsf.sidecarTimeoutMs", "10000");
});

afterEach(() => {
  try {
    expect(mockUnlisten).toHaveBeenCalledTimes(mockListen.mock.calls.length);
    if (usesFakeTimers) expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
    useNeedsYouWait.getState().reset();
  }
});

describe("runSidecarStream timeout retirement", () => {
  it("requests same-session cancellation and waits for its acknowledgement before yielding an error", async () => {
    useFakeTimers();
    let acknowledgeCancel!: () => void;
    let cancelStarted!: () => void;
    let resolveLateInvoke!: (value: { output: string }) => void;
    const started = new Promise<void>((resolve) => (cancelStarted = resolve));
    const cancellation = new Promise<void>((resolve) => (acknowledgeCancel = resolve));
    mockInvoke.mockImplementation((_command: string, args: { method: string }) => {
      if (args.method === "agent.invoke") return new Promise((resolve) => (resolveLateInvoke = resolve));
      if (args.method === "agent.cancel") {
        cancelStarted();
        return cancellation;
      }
      throw new Error(`unexpected method ${args.method}`);
    });

    let settled = false;
    const result = collect(runSidecarStream({
      agentId: "main",
      sessionId: "session-timeout",
      messages: messages(),
      input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
    })).finally(() => { settled = true; });

    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", expect.objectContaining({ method: "agent.invoke" })));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.cancel",
      params: { session_id: "session-timeout", reason: "AI 任务超时，停止后续工具调用" },
      timeoutMs: 10_000,
    });
    await started;
    expect(settled).toBe(false);

    acknowledgeCancel();
    const parts = await result;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("error");
    expect(parts[0].error).not.toContain("命令没有被执行");
    expect(parts[0].error).not.toContain("回答它即可继续");
    expect(parts[0].error).toContain("已请求停止后续工具调用");
    expect(parts[0].error).not.toContain("命令未执行");

    resolveLateInvoke({ output: "late result must be ignored" });
    await Promise.resolve();
    expect(parts).toHaveLength(1);
    expect(parts[0].error).not.toContain("late result");
  });

  it("reports an unconfirmed cancellation when the cancel RPC fails", async () => {
    useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockInvoke.mockImplementation((_command: string, args: { method: string }) => {
      if (args.method === "agent.invoke") return new Promise(() => {});
      return Promise.reject(new Error("cancel IPC failed"));
    });

    const result = collect(runSidecarStream({
      agentId: "main", sessionId: "session-cancel-fails", messages: messages(), input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
    }));
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", expect.objectContaining({ method: "agent.invoke" })));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(100);
    const parts = await result;
    expect(mockInvoke.mock.calls.some(([, args]) => args?.method === "agent.cancel")).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("cancel IPC failed");
    expect(parts[0].error).toContain("取消请求未获确认");
    expect(parts[0].error).not.toContain("已停止");
    errorSpy.mockRestore();
  });

  it("cancels a hard IPC timeout during an awaiting-user pause without claiming the command did not run", async () => {
    useFakeTimers();
    useNeedsYouWait.getState().markPending("approval-1", "session-awaiting");
    mockInvoke.mockImplementation((_command: string, args: { method: string }) => {
      if (args.method === "agent.invoke") {
        return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("IPC timeout")), 600_000));
      }
      return Promise.resolve({ cancelled: true });
    });

    const result = collect(runSidecarStream({
      agentId: "main", sessionId: "session-awaiting", messages: messages(), input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
    }));
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", expect.objectContaining({ method: "agent.invoke" })));
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(100);
    const parts = await result;
    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", expect.objectContaining({
      method: "agent.cancel",
      params: { session_id: "session-awaiting", reason: "AI 任务超时，停止后续工具调用" },
    }));
    expect(parts[0].type).toBe("error");
    expect(parts[0].error).not.toContain("命令没有被执行");
    expect(parts[0].error).not.toContain("回答它即可继续");
    expect(parts[0].error).not.toMatch(/命令未执行|旧审批.*继续/);
  });

  it("does not claim cancellation on a browser-side timeout", async () => {
    useFakeTimers();
    mockIsTauri.mockReturnValue(false);
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    const result = collect(runSidecarStream({
      agentId: "main", sessionId: "browser-timeout", messages: messages(), input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
    }));
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_100);
    const parts = await result;
    expect(parts[0].type).toBe("error");
    expect(parts[0].error).not.toContain("已请求停止后续工具调用");
    expect(mockInvoke.mock.calls.some(([, args]) => args?.method === "agent.cancel")).toBe(false);
  });

  it("does not yield the timeout error when aborted during cancellation", async () => {
    useFakeTimers();
    let acknowledgeCancel!: () => void;
    let cancelStarted!: () => void;
    const started = new Promise<void>((resolve) => (cancelStarted = resolve));
    const cancellation = new Promise<void>((resolve) => (acknowledgeCancel = resolve));
    mockInvoke.mockImplementation((_command: string, args: { method: string }) => {
      if (args.method === "agent.invoke") return new Promise(() => {});
      cancelStarted();
      return cancellation;
    });
    const controller = new AbortController();
    const result = collect(runSidecarStream({
      agentId: "main", sessionId: "aborted-timeout", messages: messages(), input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
      abortSignal: controller.signal,
    }));
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", expect.objectContaining({ method: "agent.invoke" })));
    await vi.advanceTimersByTimeAsync(10_100);
    await started;
    controller.abort();
    acknowledgeCancel();
    expect(await result).toEqual([]);
  });

  it("does not cancel a normal result or a non-timeout IPC failure", async () => {
    mockInvoke.mockResolvedValueOnce({ output: "done" });
    const successParts = await collect(runSidecarStream({
      agentId: "main", sessionId: "session-ok", messages: messages(), input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
    }));
    expect(successParts.some((part) => part.type === "text-delta" && part.delta?.includes("done"))).toBe(true);
    expect(successParts.some((part) => part.type === "finish")).toBe(true);
    expect(mockInvoke.mock.calls.some(([, args]) => args?.method === "agent.cancel")).toBe(false);

    mockInvoke.mockReset().mockRejectedValueOnce(new Error("connection refused"));
    markSidecarConfigSynced();
    const errorParts = await collect(runSidecarStream({
      agentId: "main", sessionId: "session-error", messages: messages(), input: "hello",
      live: { cwd: null, terminalPrivate: false, workspaceRoot: null, activeFile: null, sshSessionId: null },
    }));
    expect(errorParts.some((part) => part.type === "error" && part.error?.includes("connection refused"))).toBe(true);
    expect(mockInvoke.mock.calls.some(([, args]) => args?.method === "agent.cancel")).toBe(false);
  });
});
