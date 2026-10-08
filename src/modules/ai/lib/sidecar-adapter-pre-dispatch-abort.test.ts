import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  configSynced: true,
  syncPromise: undefined as Promise<{ ok: boolean; detail?: string }> | undefined,
  syncStarted: undefined as (() => void) | undefined,
  listenStarted: new Map<string, () => void>(),
  listenPromises: new Map<string, Promise<() => void>>(),
  unlisteners: new Map<string, ReturnType<typeof vi.fn>>(),
  tauriRuntime: false,
  cancelPromise: undefined as Promise<unknown> | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string) => {
    harness.listenStarted.get(event)?.();
    let unlisten = harness.unlisteners.get(event);
    if (!unlisten) {
      unlisten = vi.fn();
      harness.unlisteners.set(event, unlisten);
    }
    return harness.listenPromises.get(event) ?? Promise.resolve(unlisten);
  }),
}));

vi.mock("@/lib/tauriRuntime", () => ({
  isTauriRuntime: () => harness.tauriRuntime,
}));

vi.mock("./sidecar-config-sync", () => ({
  isSidecarConfigSynced: () => harness.configSynced,
  markSidecarConfigSynced: vi.fn(() => {
    harness.configSynced = true;
  }),
  syncSidecarLlmConfig: vi.fn(() => {
    harness.syncStarted?.();
    return harness.syncPromise ?? Promise.resolve({ ok: true });
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  markSidecarConfigSynced,
  syncSidecarLlmConfig,
} from "./sidecar-config-sync";
import {
  cancelSidecarTurn,
  runSidecarStream,
  type SidecarStreamOptions,
  type SidecarStreamPart,
} from "./sidecar-adapter";

const TOOL_CALL_EVENT = "sidecar:tool_call";
const MOOD_EVENT = "sidecar:mood_change";
const SSH_OUTPUT_EVENT = "sidecar:ssh_command_output";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

function mockRpc(_command: string, args: unknown) {
  const payload = args as {
    method?: string;
    params?: { state?: { input?: string } };
  };
  if (payload.method === "agent.cancel") {
    return harness.cancelPromise ?? Promise.resolve({ cancelled: false });
  }
  if (payload.method === "agent.invoke") {
    return Promise.resolve({ output: "fresh result" });
  }
  return Promise.resolve({});
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

async function collect(
  stream: AsyncIterable<SidecarStreamPart>,
): Promise<SidecarStreamPart[]> {
  const parts: SidecarStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function options(
  abortSignal: AbortSignal,
  extra: Partial<SidecarStreamOptions> = {},
) {
  return {
    agentId: "main" as const,
    sessionId: "same-chat",
    messages: [],
    input: "hello",
    live: {
      cwd: null,
      terminalPrivate: false,
      workspaceRoot: null,
      activeFile: null,
      sshSessionId: null,
    },
    abortSignal,
    ...extra,
  };
}

function gateListen(event: string) {
  const started = deferred<void>();
  const registration = deferred<() => void>();
  const unlisten = vi.fn();
  harness.listenStarted.set(event, () => started.resolve(undefined));
  harness.listenPromises.set(event, registration.promise);
  harness.unlisteners.set(event, unlisten);
  return { started, registration, unlisten };
}

beforeEach(() => {
  harness.configSynced = true;
  harness.syncPromise = undefined;
  harness.syncStarted = undefined;
  harness.listenStarted.clear();
  harness.listenPromises.clear();
  harness.unlisteners.clear();
  harness.tauriRuntime = false;
  harness.cancelPromise = undefined;
  mockInvoke.mockReset().mockImplementation(mockRpc);
  mockListen.mockClear();
  vi.mocked(markSidecarConfigSynced).mockClear();
  vi.mocked(syncSidecarLlmConfig).mockClear();
});

afterEach(() => {
  harness.syncPromise = undefined;
  harness.syncStarted = undefined;
  harness.listenStarted.clear();
  harness.listenPromises.clear();
  harness.cancelPromise = undefined;
  harness.tauriRuntime = false;
  vi.clearAllMocks();
});

describe("runSidecarStream pre-dispatch abort", () => {
  it("does no configuration sync, listener registration, or invoke when already aborted", async () => {
    harness.configSynced = false;
    const controller = new AbortController();
    controller.abort();

    const parts = await collect(runSidecarStream(options(controller.signal)));

    expect(parts).toEqual([]);
    expect(markSidecarConfigSynced).not.toHaveBeenCalled();
    expect(syncSidecarLlmConfig).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does not dispatch after abort while configuration sync is pending", async () => {
    harness.configSynced = false;
    const sync = deferred<{ ok: boolean }>();
    const syncStarted = deferred<void>();
    harness.syncPromise = sync.promise;
    harness.syncStarted = () => syncStarted.resolve(undefined);
    const controller = new AbortController();
    const completion = collect(runSidecarStream(options(controller.signal, { onMood: vi.fn() })));

    await syncStarted.promise;
    controller.abort();
    sync.resolve({ ok: true });
    const parts = await completion;

    expect(parts).toEqual([]);
    expect(syncSidecarLlmConfig).toHaveBeenCalledTimes(1);
    expect(mockListen).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cleans up the successful ordinary listener and does not dispatch after abort", async () => {
    const registration = gateListen(MOOD_EVENT);
    const controller = new AbortController();
    const completion = collect(runSidecarStream(options(controller.signal, { onMood: vi.fn() })));

    await registration.started.promise;
    controller.abort();
    registration.registration.resolve(registration.unlisten);
    const parts = await completion;

    expect(parts).toEqual([]);
    expect(registration.unlisten).toHaveBeenCalledTimes(1);
    expect(harness.unlisteners.get(SSH_OUTPUT_EVENT)).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cleans up the SSH output listener and does not dispatch after abort", async () => {
    const registration = gateListen(SSH_OUTPUT_EVENT);
    const controller = new AbortController();
    const completion = collect(runSidecarStream(options(controller.signal)));

    await registration.started.promise;
    controller.abort();
    registration.registration.resolve(registration.unlisten);
    const parts = await completion;

    expect(parts).toEqual([]);
    expect(registration.unlisten).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cleans successful listener registrations when a later listener rejects", async () => {
    const failedUnlisten = vi.fn();
    harness.unlisteners.set(TOOL_CALL_EVENT, failedUnlisten);
    harness.listenPromises.set(TOOL_CALL_EVENT, Promise.reject(new Error("listener unavailable")));
    const controller = new AbortController();

    await collect(
      runSidecarStream(
        options(controller.signal, { onMood: vi.fn(), onStep: vi.fn() }),
      ),
    );

    expect(harness.unlisteners.get(MOOD_EVENT)).toHaveBeenCalledTimes(1);
    expect(failedUnlisten).not.toHaveBeenCalled();
    expect(harness.unlisteners.get(SSH_OUTPUT_EVENT)).toHaveBeenCalledTimes(1);
  });

  it("cleans earlier successful listeners when a pending ordinary listener rejects after abort", async () => {
    const pendingListener = deferred<() => void>();
    const pendingStarted = deferred<void>();
    const failedUnlisten = vi.fn();
    harness.unlisteners.set(TOOL_CALL_EVENT, failedUnlisten);
    harness.listenStarted.set(TOOL_CALL_EVENT, () => pendingStarted.resolve(undefined));
    harness.listenPromises.set(TOOL_CALL_EVENT, pendingListener.promise);
    const controller = new AbortController();
    const completion = collect(
      runSidecarStream(
        options(controller.signal, { onMood: vi.fn(), onStep: vi.fn() }),
      ),
    );

    await pendingStarted.promise;
    controller.abort();
    pendingListener.reject(new Error("listener registration failed"));
    const parts = await completion;

    expect(parts).toEqual([]);
    expect(harness.unlisteners.get(MOOD_EVENT)).toHaveBeenCalledTimes(1);
    expect(failedUnlisten).not.toHaveBeenCalled();
    expect(harness.unlisteners.get(SSH_OUTPUT_EVENT)).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("lets an aborted dispatched request retire without claiming backend work was killed, then accepts a fresh controller", async () => {
    const firstInvoke = deferred<{ output: string }>();
    const firstInvokeStarted = deferred<void>();
    mockInvoke.mockImplementationOnce(() => {
      firstInvokeStarted.resolve(undefined);
      return firstInvoke.promise;
    });

    const firstController = new AbortController();
    const firstCompletion = collect(runSidecarStream(options(firstController.signal)));
    await firstInvokeStarted.promise;
    firstController.abort();
    const firstParts = await firstCompletion;

    firstInvoke.resolve({ output: "late backend result" });
    await Promise.resolve();

    const nextController = new AbortController();
    const nextParts = await collect(runSidecarStream(options(nextController.signal)));

    expect(firstParts).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(nextParts).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "fresh result" }),
    );
    expect(nextParts.some((part) => part.type === "finish")).toBe(true);
    expect(mockInvoke.mock.calls.map(([, args]) => args.method)).toEqual([
      "agent.invoke",
      "agent.invoke",
    ]);
  });

  it("finishes the real cancel RPC before releasing sync, skips the stopped invoke, then runs the next same-chat request", async () => {
    harness.configSynced = false;
    const sync = deferred<{ ok: boolean }>();
    const syncStarted = deferred<void>();
    harness.syncPromise = sync.promise;
    harness.syncStarted = () => syncStarted.resolve(undefined);
    harness.tauriRuntime = true;
    const cancelResponse = deferred<{ cancelled: boolean }>();
    harness.cancelPromise = cancelResponse.promise;

    const stoppedController = new AbortController();
    const stoppedCompletion = collect(
      runSidecarStream(options(stoppedController.signal, { input: "stopped request" })),
    );
    await syncStarted.promise;
    stoppedController.abort();

    let cancelCompleted = false;
    const cancelCompletion = cancelSidecarTurn("same-chat", "test stop").then(() => {
      cancelCompleted = true;
    });
    cancelResponse.resolve({ cancelled: false });
    await cancelCompletion;
    sync.resolve({ ok: true });
    const stoppedParts = await stoppedCompletion;

    harness.cancelPromise = undefined;
    harness.configSynced = true;
    const freshController = new AbortController();
    const freshParts = await collect(
      runSidecarStream(options(freshController.signal, { input: "fresh request" })),
    );

    expect(cancelCompleted).toBe(true);
    expect(stoppedParts).toEqual([]);
    expect(freshParts).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "fresh result" }),
    );
    expect(freshParts.some((part) => part.type === "finish")).toBe(true);
    expect(mockInvoke.mock.calls.map(([, args]) => {
      const payload = args as {
        method?: string;
        params?: { state?: { input?: string } };
      };
      return { method: payload.method, input: payload.params?.state?.input };
    })).toEqual([
      { method: "agent.cancel", input: undefined },
      { method: "agent.invoke", input: "fresh request" },
    ]);
  });
});
