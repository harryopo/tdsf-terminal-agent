import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMode } from "../agents/registry";
import type { AgentModeSource } from "./live-mode-sync";
import type { SidecarStreamOptions, SidecarStreamPart } from "./sidecar-adapter";

type InvokeArgs = {
  method: string;
  params?: {
    session_id?: string;
    stream_id?: string;
    mode?: AgentMode;
    revision?: number;
    reason?: string;
    state?: {
      session_id?: string;
      _rpc_stream_id?: string;
      live?: Record<string, unknown>;
    };
  };
  timeoutMs?: number;
};
type EventCallback = (event: unknown) => void;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, EventCallback[]>(),
  listenGates: new Map<
    string,
    { started: () => void; released: Promise<void> }
  >(),
  unlisteners: [] as ReturnType<typeof vi.fn>[],
  invokeCalls: [] as InvokeArgs[],
  invokeWaiters: new Map<string, Array<(args: InvokeArgs) => void>>(),
  invokeResults: new Map<string, Promise<unknown>[]>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((_command: string, args: InvokeArgs) => {
    harness.invokeCalls.push(args);
    harness.invokeWaiters.get(args.method)?.shift()?.(args);
    const result = harness.invokeResults.get(args.method)?.shift();
    if (result) return result;
    if (args.method === "agent.invoke") {
      return Promise.resolve({ observation: "fresh answer" });
    }
    if (args.method === "agent.set_mode") {
      return Promise.resolve({
        ok: true,
        mode: args.params?.mode,
        revision: args.params?.revision,
      });
    }
    if (args.method === "agent.cancel") return Promise.resolve({ cancelled: true });
    return Promise.resolve({});
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, callback: EventCallback) => {
    const callbacks = harness.listeners.get(event) ?? [];
    callbacks.push(callback);
    harness.listeners.set(event, callbacks);
    const unlisten = vi.fn(() => {
      harness.listeners.set(
        event,
        (harness.listeners.get(event) ?? []).filter((registered) => registered !== callback),
      );
    });
    harness.unlisteners.push(unlisten);
    const gate = harness.listenGates.get(event);
    gate?.started();
    return gate
      ? gate.released.then(() => unlisten)
      : Promise.resolve(unlisten);
  }),
}));

vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => true }));

import { invoke } from "@tauri-apps/api/core";
import { markSidecarConfigSynced } from "./sidecar-config-sync";
import { runSidecarStream } from "./sidecar-adapter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeModeSource(initialMode: AgentMode) {
  let mode = initialMode;
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
  };
}

function waitForMethod(method: string) {
  const started = deferred<InvokeArgs>();
  const waiters = harness.invokeWaiters.get(method) ?? [];
  waiters.push((args) => started.resolve(args));
  harness.invokeWaiters.set(method, waiters);
  return started.promise;
}

function queueResult(method: string, result: Promise<unknown>) {
  const results = harness.invokeResults.get(method) ?? [];
  results.push(result);
  harness.invokeResults.set(method, results);
}

function makeOptions(
  modeSource: AgentModeSource,
  abortSignal: AbortSignal,
): SidecarStreamOptions {
  return {
    agentId: "main",
    sessionId: "chat-live-mode",
    messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "fixture" }] }] as never,
    input: "fixture input",
    live: {
      cwd: "/snapshot/workspace",
      terminalPrivate: false,
      workspaceRoot: "/snapshot/workspace",
      activeFile: null,
      sshSessionId: 47,
      terminalSession: "ssh",
      agentMode: "confirm",
      teach: false,
    },
    modeSource,
    abortSignal,
  };
}

async function collect(stream: AsyncIterable<SidecarStreamPart>) {
  const parts: SidecarStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  harness.listeners.clear();
  harness.listenGates.clear();
  harness.unlisteners.length = 0;
  harness.invokeCalls.length = 0;
  harness.invokeWaiters.clear();
  harness.invokeResults.clear();
  vi.mocked(invoke).mockClear();
  markSidecarConfigSynced();
});

afterEach(() => {
  localStorage.removeItem("tdsf.sidecarTimeoutMs");
});

describe("sidecar live mode synchronization", () => {
  it("uses mode changes during listener preparation, syncs later changes, then disposes listeners", async () => {
    const source = makeModeSource("confirm");
    const listenStarted = deferred<void>();
    const listenReleased = deferred<void>();
    harness.listenGates.set("sidecar:ssh_command_output", {
      started: () => listenStarted.resolve(undefined),
      released: listenReleased.promise,
    });
    const invokeResult = deferred<unknown>();
    queueResult("agent.invoke", invokeResult.promise);
    const agentInvokeStarted = waitForMethod("agent.invoke");
    const partsPromise = collect(
      runSidecarStream(makeOptions(source.source, new AbortController().signal)),
    );

    try {
      await listenStarted.promise;
      source.set("auto");
      expect(harness.invokeCalls.some((call) => call.method === "agent.set_mode")).toBe(false);
      listenReleased.resolve(undefined);

      const invokeArgs = await agentInvokeStarted;
      const state = invokeArgs.params?.state;
      const live = state?.live;
      expect(state?.session_id).toBe("chat-live-mode");
      expect(state?._rpc_stream_id).toEqual(expect.any(String));
      expect(live).toMatchObject({
        agentMode: "auto",
        teach: false,
        sshSessionId: 47,
        cwd: "/snapshot/workspace",
        workspaceRoot: "/snapshot/workspace",
      });

      const setModeStarted = waitForMethod("agent.set_mode");
      source.set("confirm");
      const setModeArgs = await setModeStarted;
      expect(setModeArgs).toMatchObject({
        method: "agent.set_mode",
        params: {
          session_id: "chat-live-mode",
          stream_id: state?._rpc_stream_id,
          mode: "confirm",
          revision: 1,
        },
        timeoutMs: 3000,
      });

      invokeResult.resolve({ observation: "fresh answer" });
      const parts = await partsPromise;
      expect(parts.some((part) => part.type === "finish")).toBe(true);
      expect(harness.unlisteners.length).toBeGreaterThan(0);
      expect(harness.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
      expect([...harness.listeners.values()].every((callbacks) => callbacks.length === 0)).toBe(true);

      source.set("auto");
      await flushMicrotasks();
      expect(harness.invokeCalls.filter((call) => call.method === "agent.set_mode")).toHaveLength(1);
    } finally {
      listenReleased.resolve(undefined);
      invokeResult.resolve({ observation: "fixture cleanup" });
      await partsPromise.catch(() => []);
    }
  });

  it("reports failed mode control, sends agent.cancel, and never re-invokes the agent", async () => {
    const source = makeModeSource("confirm");
    const controller = new AbortController();
    const invokeResult = deferred<unknown>();
    const failedModeControl = deferred<unknown>();
    queueResult("agent.invoke", invokeResult.promise);
    queueResult("agent.set_mode", failedModeControl.promise);
    const agentInvokeStarted = waitForMethod("agent.invoke");
    const setModeStarted = waitForMethod("agent.set_mode");
    const cancelStarted = waitForMethod("agent.cancel");
    const partsPromise = collect(runSidecarStream(makeOptions(source.source, controller.signal)));

    try {
      const invokeArgs = await agentInvokeStarted;
      const streamId = invokeArgs.params?.state?._rpc_stream_id;
      source.set("auto");
      const setModeArgs = await setModeStarted;
      expect(setModeArgs.params?.stream_id).toBe(streamId);

      failedModeControl.resolve({ ok: false, reason: "control_rejected" });
      const cancelArgs = await cancelStarted;
      expect(cancelArgs).toMatchObject({
        method: "agent.cancel",
        params: { session_id: "chat-live-mode", reason: "运行模式同步失败" },
        timeoutMs: 10_000,
      });

      invokeResult.resolve({ observation: "completed after control failure" });
      const parts = await partsPromise;
      const errors = parts.filter((part) => part.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.type === "error" && errors[0].error).toContain("运行模式同步失败");
      expect(harness.invokeCalls.filter((call) => call.method === "agent.invoke")).toHaveLength(1);
      expect(harness.invokeCalls.filter((call) => call.method === "agent.cancel")).toHaveLength(1);

      source.set("confirm");
      await flushMicrotasks();
      expect(harness.invokeCalls.filter((call) => call.method === "agent.set_mode")).toHaveLength(1);
      expect(harness.unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
    } finally {
      invokeResult.resolve({ observation: "fixture cleanup" });
      failedModeControl.resolve({ ok: false, reason: "fixture cleanup" });
      await partsPromise.catch(() => []);
    }
  });
});
