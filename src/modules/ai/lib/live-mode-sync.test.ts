import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMode } from "../agents/registry";
import {
  canSwitchRunningMode,
  syncRunningMode,
  type AgentModeSource,
} from "./live-mode-sync";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

function makeSource(initial: AgentMode) {
  let mode = initial;
  const listeners = new Set<() => void>();
  const source: AgentModeSource = {
    get: () => mode,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    source,
    set(next: AgentMode) {
      mode = next;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe("running agent mode synchronization", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends mode changes with the owning session and stream identity", async () => {
    const state = makeSource("confirm");
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError: vi.fn(),
    });
    invokeMock.mockResolvedValueOnce({
      ok: true,
      mode: "auto",
      revision: 1,
    });

    state.set("auto");
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.set_mode",
      params: {
        session_id: "chat-a",
        stream_id: "stream-a",
        mode: "auto",
        revision: 1,
      },
      timeoutMs: 3000,
    });
    dispose();
  });

  it("serializes changes and coalesces rapid updates to the final mode", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const state = makeSource("confirm");
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError: vi.fn(),
    });

    state.set("auto");
    await flushMicrotasks();
    state.set("confirm");
    state.set("auto");
    state.set("confirm");
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({
      params: { session_id: "chat-a", stream_id: "stream-a", mode: "auto", revision: 1 },
    });

    first.resolve({ ok: true, mode: "auto", revision: 1 });
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1]?.[1]).toMatchObject({
      params: { session_id: "chat-a", stream_id: "stream-a", mode: "confirm", revision: 4 },
    });
    second.resolve({ ok: true, mode: "confirm", revision: 4 });
    await flushMicrotasks();
    dispose();
  });

  it("retries not_active replies at 100ms intervals, then accepts the acknowledgement", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({ ok: false, reason: "not_active" })
      .mockResolvedValueOnce({ ok: false, reason: "not_active" })
      .mockResolvedValueOnce({ ok: true, mode: "auto", revision: 1 });
    const state = makeSource("confirm");
    const onError = vi.fn();
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError,
    });

    state.set("auto");
    await flushMicrotasks();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("replaces a not_active request immediately with the latest pending mode", async () => {
    vi.useFakeTimers();
    const oldReply = deferred<unknown>();
    const latestReply = deferred<unknown>();
    invokeMock.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(latestReply.promise);
    const state = makeSource("confirm");
    const onError = vi.fn();
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError,
    });

    state.set("auto");
    await flushMicrotasks();
    state.set("confirm");
    state.set("auto");
    state.set("confirm");
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    oldReply.resolve({ ok: false, reason: "not_active" });
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock.mock.calls[1]?.[0]).toBe("ipc_invoke");
    expect(invokeMock.mock.calls[1]?.[1]).toEqual({
      method: "agent.set_mode",
      params: {
        session_id: "chat-a",
        stream_id: "stream-a",
        mode: "confirm",
        revision: 4,
      },
      timeoutMs: 3000,
    });

    latestReply.resolve({ ok: true, mode: "confirm", revision: 4 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("uses the latest mode when a not_active backoff expires", async () => {
    vi.useFakeTimers();
    const oldReply = deferred<unknown>();
    const latestReply = deferred<unknown>();
    invokeMock.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(latestReply.promise);
    const state = makeSource("confirm");
    const onError = vi.fn();
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError,
    });

    state.set("auto");
    await flushMicrotasks();
    oldReply.resolve({ ok: false, reason: "not_active" });
    await flushMicrotasks();
    state.set("confirm");
    await vi.advanceTimersByTimeAsync(100);

    try {
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(invokeMock.mock.calls[1]?.[0]).toBe("ipc_invoke");
      expect(invokeMock.mock.calls[1]?.[1]).toEqual({
        method: "agent.set_mode",
        params: {
          session_id: "chat-a",
          stream_id: "stream-a",
          mode: "confirm",
          revision: 2,
        },
        timeoutMs: 3000,
      });

      latestReply.resolve({ ok: true, mode: "confirm", revision: 2 });
      await flushMicrotasks();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("stops after a transport failure without sending a pending mode", async () => {
    vi.useFakeTimers();
    const first = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise);
    const state = makeSource("confirm");
    const onError = vi.fn();
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError,
    });

    state.set("auto");
    await flushMicrotasks();
    state.set("confirm");
    state.set("auto");
    state.set("confirm");
    first.reject(new Error("offline"));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(String));
    dispose();
  });

  it("reports an RPC failure through onError", async () => {
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    const state = makeSource("confirm");
    const onError = vi.fn();
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError,
    });

    state.set("auto");
    await flushMicrotasks();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(String));
    dispose();
  });

  it("dispose removes the listener and ignores a late failed acknowledgement", async () => {
    const pending = deferred<unknown>();
    invokeMock.mockReturnValueOnce(pending.promise);
    const state = makeSource("confirm");
    const onError = vi.fn();
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError,
    });
    state.set("auto");
    await flushMicrotasks();
    expect(state.listenerCount).toBe(1);

    dispose();
    expect(state.listenerCount).toBe(0);
    state.set("confirm");
    pending.resolve({ ok: false, reason: "not_active" });
    await flushMicrotasks();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("allows only confirm/auto changes for the registered session", () => {
    const state = makeSource("confirm");
    const dispose = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-a",
      initialMode: "confirm",
      source: state.source,
      onError: vi.fn(),
    });

    expect(canSwitchRunningMode("chat-a", "auto")).toBe(true);
    expect(canSwitchRunningMode("chat-a", "confirm")).toBe(true);
    expect(canSwitchRunningMode("chat-a", "observe")).toBe(false);
    expect(canSwitchRunningMode("chat-a", "teach")).toBe(false);
    expect(canSwitchRunningMode("chat-b", "observe")).toBe(true);
    expect(canSwitchRunningMode(null, "auto")).toBe(true);

    dispose();
    expect(canSwitchRunningMode("chat-a", "observe")).toBe(true);
  });

  it("does not allow an observe run to switch into auto or teach", () => {
    const state = makeSource("observe");
    const dispose = syncRunningMode({
      sessionId: "chat-observe",
      streamId: "stream-observe",
      initialMode: "observe",
      source: state.source,
      onError: vi.fn(),
    });

    expect(canSwitchRunningMode("chat-observe", "observe")).toBe(true);
    expect(canSwitchRunningMode("chat-observe", "auto")).toBe(false);
    expect(canSwitchRunningMode("chat-observe", "teach")).toBe(false);
    dispose();
  });

  it("an older disposer cannot remove a newer owner for the same session", () => {
    const older = makeSource("confirm");
    const newer = makeSource("observe");
    const disposeOlder = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-old",
      initialMode: "confirm",
      source: older.source,
      onError: vi.fn(),
    });
    const disposeNewer = syncRunningMode({
      sessionId: "chat-a",
      streamId: "stream-new",
      initialMode: "observe",
      source: newer.source,
      onError: vi.fn(),
    });

    disposeOlder();
    expect(canSwitchRunningMode("chat-a", "auto")).toBe(false);
    expect(canSwitchRunningMode("chat-a", "observe")).toBe(true);
    disposeNewer();
    expect(canSwitchRunningMode("chat-a", "auto")).toBe(true);
  });
});
