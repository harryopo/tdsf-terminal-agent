import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  tauriRuntime: true,
  configSynced: true,
  syncPromise: undefined as Promise<{ ok: boolean; detail?: string }> | undefined,
  syncStarted: undefined as (() => void) | undefined,
  cancelResponses: [] as Promise<unknown>[],
  cancelStarted: [] as (() => void)[],
  invokeStarted: [] as (() => void)[],
  listenStarted: new Map<string, () => void>(),
  listenPromises: new Map<string, Promise<() => void>>(),
  order: [] as string[],
  invokeInputs: [] as string[],
  unlisteners: [] as ReturnType<typeof vi.fn>[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((_command: string, args: unknown) => {
    const payload = args as {
      method?: string;
      params?: { state?: { input?: string } };
    };
    if (payload.method === "agent.cancel") {
      harness.order.push("cancel");
      harness.cancelStarted.shift()?.();
      return harness.cancelResponses.shift() ?? Promise.resolve({ cancelled: false });
    }
    if (payload.method === "agent.invoke") {
      const input = payload.params?.state?.input ?? "";
      harness.order.push(`invoke:${input}`);
      harness.invokeInputs.push(input);
      harness.invokeStarted.shift()?.();
      return Promise.resolve({ output: "fresh answer" });
    }
    return Promise.resolve({});
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string) => {
    harness.order.push(`listen:${event}`);
    harness.listenStarted.get(event)?.();
    const unlisten = vi.fn();
    harness.unlisteners.push(unlisten);
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
    harness.order.push("sync");
    harness.syncStarted?.();
    return harness.syncPromise ?? Promise.resolve({ ok: true });
  }),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cancelSidecarTurn, runSidecarStream } from "./sidecar-adapter";
import type { SidecarStreamOptions, SidecarStreamPart } from "./sidecar-adapter";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockListen = listen as unknown as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function collect(stream: AsyncIterable<SidecarStreamPart>) {
  const parts: SidecarStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

async function flushGeneratorMicrotasks() {
  // Let the async-generator request and its immediate listener awaits advance;
  // this is a fixed microtask drain, not a sleep or polling loop.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function gateListener(event: string) {
  const started = deferred<void>();
  const registration = deferred<() => void>();
  const unlisten = vi.fn();
  harness.listenStarted.set(event, () => started.resolve(undefined));
  harness.listenPromises.set(event, registration.promise);
  return { started, registration, unlisten };
}

function options(
  sessionId: string | undefined,
  abortSignal: AbortSignal,
  input: string,
): SidecarStreamOptions {
  return {
    agentId: "main",
    sessionId,
    messages: [],
    input,
    live: {
      cwd: null,
      terminalPrivate: false,
      workspaceRoot: null,
      activeFile: null,
      sshSessionId: null,
    },
    abortSignal,
  };
}

function expectFresh(parts: SidecarStreamPart[]) {
  expect(parts).toContainEqual(
    expect.objectContaining({ type: "text-delta", delta: "fresh answer" }),
  );
  expect(parts.some((part) => part.type === "finish")).toBe(true);
}

function abortListenerWasRemoved(
  addSpy: ReturnType<typeof vi.spyOn>,
  removeSpy: ReturnType<typeof vi.spyOn>,
) {
  const added = addSpy.mock.calls.find(([type]) => type === "abort")?.[1];
  return (
    added !== undefined &&
    removeSpy.mock.calls.some(([type, listener]) => type === "abort" && listener === added)
  );
}

beforeEach(() => {
  harness.tauriRuntime = true;
  harness.configSynced = true;
  harness.syncPromise = undefined;
  harness.syncStarted = undefined;
  harness.cancelResponses.length = 0;
  harness.cancelStarted.length = 0;
  harness.invokeStarted.length = 0;
  harness.listenStarted.clear();
  harness.listenPromises.clear();
  harness.order.length = 0;
  harness.invokeInputs.length = 0;
  harness.unlisteners.length = 0;
  mockInvoke.mockClear();
  mockListen.mockClear();
});

afterEach(() => {
  // Every test settles its deferred RPC/config promise before reaching here.
  harness.syncPromise = undefined;
  harness.syncStarted = undefined;
  harness.cancelResponses.length = 0;
  harness.cancelStarted.length = 0;
  harness.invokeStarted.length = 0;
  harness.listenStarted.clear();
  harness.listenPromises.clear();
  vi.restoreAllMocks();
});

describe("sidecar cancel acknowledgement ordering", () => {
  it("holds a same-chat request until cancel acknowledgement, then streams and clears the wait", async () => {
    harness.configSynced = false;
    const acknowledgement = deferred<{ cancelled: boolean }>();
    const cancelStarted = deferred<void>();
    harness.cancelResponses.push(acknowledgement.promise);
    harness.cancelStarted.push(() => cancelStarted.resolve(undefined));
    const cancelOutcome = cancelSidecarTurn("chat-a", "stop").then(
      () => "resolved",
      () => "rejected",
    );
    await cancelStarted.promise;

    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const nextPartsPromise = collect(
      runSidecarStream(options("chat-a", controller.signal, "next turn")),
    );
    try {
      await flushGeneratorMicrotasks();
      const orderBeforeAcknowledgement = [...harness.order];

      acknowledgement.resolve({ cancelled: false });
      const [nextParts, outcome] = await Promise.all([nextPartsPromise, cancelOutcome]);
      const followupParts = await collect(
        runSidecarStream(options("chat-a", new AbortController().signal, "later turn")),
      );

      expect(orderBeforeAcknowledgement).toEqual(["cancel"]);
      expect(outcome).toBe("resolved");
      expectFresh(nextParts);
      expectFresh(followupParts);
      expect(abortListenerWasRemoved(addListener, removeListener)).toBe(true);
      expect(harness.unlisteners).toHaveLength(6);
      expect(harness.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
    } finally {
      acknowledgement.resolve({ cancelled: false });
      await Promise.allSettled([nextPartsPromise, cancelOutcome]);
    }
  });

  it("does not block a different chat behind a pending cancel", async () => {
    const acknowledgement = deferred<{ cancelled: boolean }>();
    const cancelStarted = deferred<void>();
    harness.cancelResponses.push(acknowledgement.promise);
    harness.cancelStarted.push(() => cancelStarted.resolve(undefined));
    let cancelSettled = false;
    const cancelOutcome = cancelSidecarTurn("chat-a", "stop").then(() => {
      cancelSettled = true;
    });
    await cancelStarted.promise;

    const invokeStarted = deferred<void>();
    harness.invokeStarted.push(() => invokeStarted.resolve(undefined));
    const otherPartsPromise = collect(
      runSidecarStream(options("chat-b", new AbortController().signal, "other chat")),
    );
    try {
      await invokeStarted.promise;
      const dispatchedBeforeAcknowledgement = !cancelSettled;
      acknowledgement.resolve({ cancelled: false });
      const [otherParts] = await Promise.all([otherPartsPromise, cancelOutcome]);

      expect(dispatchedBeforeAcknowledgement).toBe(true);
      expectFresh(otherParts);
      expect(harness.invokeInputs).toEqual(["other chat"]);
    } finally {
      acknowledgement.resolve({ cancelled: false });
      await Promise.allSettled([otherPartsPromise, cancelOutcome]);
    }
  });

  it("preserves a failed cancel for its caller, then serializes a second explicit cancel before release", async () => {
    const firstAck = deferred<never>();
    const firstError = new Error("first cancel stays with its caller");
    const secondAck = deferred<{ cancelled: boolean }>();
    const firstStarted = deferred<void>();
    let secondWasStarted = false;
    harness.cancelResponses.push(firstAck.promise, secondAck.promise);
    harness.cancelStarted.push(
      () => firstStarted.resolve(undefined),
      () => {
        secondWasStarted = true;
      },
    );
    const firstCancel = cancelSidecarTurn("chat-a", "stop one").then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await firstStarted.promise;
    const secondCancel = cancelSidecarTurn("chat-a", "stop two");
    const beforeFirstAck = [...harness.order];
    const nextPartsPromise = collect(
      runSidecarStream(options("chat-a", new AbortController().signal, "next turn")),
    );
    try {
      await flushGeneratorMicrotasks();
      firstAck.reject(firstError);
      const firstOutcome = await firstCancel;
      await flushGeneratorMicrotasks();
      const afterFirstFailure = [...harness.order];

      secondAck.resolve({ cancelled: false });
      const [nextParts] = await Promise.all([nextPartsPromise, secondCancel]);

      expect(beforeFirstAck).toEqual(["cancel"]);
      expect(firstOutcome.status).toBe("rejected");
      expect("error" in firstOutcome && firstOutcome.error).toBe(firstError);
      expect(secondWasStarted).toBe(true);
      expect(afterFirstFailure).toEqual(["cancel", "cancel"]);
      expect(harness.order.filter((entry) => entry === "cancel")).toHaveLength(2);
      expectFresh(nextParts);
    } finally {
      firstAck.reject(firstError);
      secondAck.resolve({ cancelled: false });
      await Promise.allSettled([firstCancel, secondCancel, nextPartsPromise]);
    }
  });

  it("waits for a cancel that arrives while the next request is syncing", async () => {
    harness.configSynced = false;
    const sync = deferred<{ ok: boolean }>();
    const syncStarted = deferred<void>();
    harness.syncPromise = sync.promise;
    harness.syncStarted = () => syncStarted.resolve(undefined);
    const nextPartsPromise = collect(
      runSidecarStream(options("chat-a", new AbortController().signal, "syncing turn")),
    );
    await syncStarted.promise;

    const acknowledgement = deferred<{ cancelled: boolean }>();
    const cancelStarted = deferred<void>();
    harness.cancelResponses.push(acknowledgement.promise);
    harness.cancelStarted.push(() => cancelStarted.resolve(undefined));
    const cancelOutcome = cancelSidecarTurn("chat-a", "stop");
    await cancelStarted.promise;
    try {
      sync.resolve({ ok: true });
      await flushGeneratorMicrotasks();
      const orderBeforeAcknowledgement = [...harness.order];

      acknowledgement.resolve({ cancelled: false });
      const [nextParts] = await Promise.all([nextPartsPromise, cancelOutcome]);

      expect(orderBeforeAcknowledgement).not.toContain("invoke:syncing turn");
      expectFresh(nextParts);
    } finally {
      sync.resolve({ ok: true });
      acknowledgement.resolve({ cancelled: false });
      await Promise.allSettled([nextPartsPromise, cancelOutcome]);
    }
  });

  it("waits for a cancel that arrives during listener registration before final dispatch", async () => {
    const messageListener = gateListener("sidecar:agent_message");
    const sshListener = gateListener("sidecar:ssh_command_output");
    const nextPartsPromise = collect(
      runSidecarStream(options("chat-a", new AbortController().signal, "listener turn")),
    );
    await messageListener.started.promise;

    const acknowledgement = deferred<{ cancelled: boolean }>();
    const cancelStarted = deferred<void>();
    harness.cancelResponses.push(acknowledgement.promise);
    harness.cancelStarted.push(() => cancelStarted.resolve(undefined));
    const cancelOutcome = cancelSidecarTurn("chat-a", "stop");
    await cancelStarted.promise;
    try {
      messageListener.registration.resolve(messageListener.unlisten);
      await sshListener.started.promise;
      sshListener.registration.resolve(sshListener.unlisten);
      await Promise.resolve();
      const orderBeforeAcknowledgement = [...harness.order];

      acknowledgement.resolve({ cancelled: false });
      const [nextParts] = await Promise.all([nextPartsPromise, cancelOutcome]);

      expect(orderBeforeAcknowledgement).not.toContain("invoke:listener turn");
      expectFresh(nextParts);
      expect(messageListener.unlisten).toHaveBeenCalledTimes(1);
      expect(sshListener.unlisten).toHaveBeenCalledTimes(1);
    } finally {
      messageListener.registration.resolve(messageListener.unlisten);
      sshListener.registration.resolve(sshListener.unlisten);
      acknowledgement.resolve({ cancelled: false });
      await Promise.allSettled([nextPartsPromise, cancelOutcome]);
    }
  });

  it("surfaces a sanitized Chinese error to the waiting request and preserves the cancel owner's rejection", async () => {
    const acknowledgement = deferred<never>();
    const cancelStarted = deferred<void>();
    harness.cancelResponses.push(acknowledgement.promise);
    harness.cancelStarted.push(() => cancelStarted.resolve(undefined));
    const cancelOutcome = cancelSidecarTurn("chat-a", "stop").then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await cancelStarted.promise;

    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitingPartsPromise = collect(
      runSidecarStream(options("chat-a", controller.signal, "must not run")),
    );
    try {
      await flushGeneratorMicrotasks();
      const orderBeforeFailure = [...harness.order];
      acknowledgement.reject(new Error("private cancel transport diagnostic"));
      const [waitingParts, owner] = await Promise.all([waitingPartsPromise, cancelOutcome]);
      const followupParts = await collect(
        runSidecarStream(options("chat-a", new AbortController().signal, "later turn")),
      );

      const errorText = waitingParts
        .filter((part): part is Extract<SidecarStreamPart, { type: "error" }> => part.type === "error")
        .map((part) => part.error)
        .join(" ");
      expect(orderBeforeFailure).toEqual(["cancel"]);
      expect(owner.status).toBe("rejected");
      expect("error" in owner && owner.error).toBeInstanceOf(Error);
      expect(waitingParts.some((part) => part.type === "error")).toBe(true);
      expect(errorText).toContain("上一轮停止请求未获确认");
      expect(errorText).toContain("请先查看终端和运行日志");
      expect(errorText).not.toContain("private cancel transport diagnostic");
      expect(harness.invokeInputs).toEqual(["later turn"]);
      expectFresh(followupParts);
      expect(abortListenerWasRemoved(addListener, removeListener)).toBe(true);
    } finally {
      acknowledgement.reject(new Error("private cancel transport diagnostic"));
      await Promise.allSettled([waitingPartsPromise, cancelOutcome]);
    }
  });

  it("lets an aborted request leave a pending cancel wait immediately and removes its abort listener", async () => {
    const acknowledgement = deferred<{ cancelled: boolean }>();
    const cancelStarted = deferred<void>();
    harness.cancelResponses.push(acknowledgement.promise);
    harness.cancelStarted.push(() => cancelStarted.resolve(undefined));
    let cancelSettled = false;
    const cancelOutcome = cancelSidecarTurn("chat-a", "stop").then(
      () => {
        cancelSettled = true;
      },
      () => {
        cancelSettled = true;
      },
    );
    await cancelStarted.promise;

    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const waitingPartsPromise = collect(
      runSidecarStream(options("chat-a", controller.signal, "aborted while waiting")),
    );
    try {
      await flushGeneratorMicrotasks();
      controller.abort();
      const waitingParts = await waitingPartsPromise;
      const completedBeforeAcknowledgement = !cancelSettled;

      acknowledgement.resolve({ cancelled: false });
      await cancelOutcome;

      expect(completedBeforeAcknowledgement).toBe(true);
      expect(waitingParts).toEqual([]);
      expect(harness.invokeInputs).toEqual([]);
      expect(addListener.mock.calls.some(([type]) => type === "abort")).toBe(true);
      expect(abortListenerWasRemoved(addListener, removeListener)).toBe(true);
    } finally {
      controller.abort();
      acknowledgement.resolve({ cancelled: false });
      await Promise.allSettled([waitingPartsPromise, cancelOutcome]);
    }
  });

  it("keeps the no-session cancel skip behavior", async () => {
    await cancelSidecarTurn("", "no session");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
  });

  it("keeps the non-Tauri cancel skip behavior", async () => {
    harness.tauriRuntime = false;
    await cancelSidecarTurn("chat-a", "browser mode");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockListen).not.toHaveBeenCalled();
  });
});
