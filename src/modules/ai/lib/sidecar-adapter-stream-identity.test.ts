import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InvokeArgs = {
  method: string;
  params?: { state?: Record<string, unknown> };
};
type EventCallback = (event: unknown) => void;

const harness = vi.hoisted(() => ({
  listeners: new Map<string, EventCallback[]>(),
  listenStarted: new Map<string, () => void>(),
  listenResults: new Map<string, Promise<() => void>>(),
  invokeCalls: [] as InvokeArgs[],
  invokeStarted: [] as ((args: InvokeArgs) => void)[],
  invokeResults: [] as Promise<unknown>[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((_command: string, args: InvokeArgs) => {
    harness.invokeCalls.push(args);
    harness.invokeStarted.shift()?.(args);
    return harness.invokeResults.shift() ?? Promise.resolve({ observation: "fallback" });
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, callback: EventCallback) => {
    const callbacks = harness.listeners.get(event) ?? [];
    callbacks.push(callback);
    harness.listeners.set(event, callbacks);
    harness.listenStarted.get(event)?.();
    const unlisten = () => {
      harness.listeners.set(
        event,
        (harness.listeners.get(event) ?? []).filter((registered) => registered !== callback),
      );
    };
    return harness.listenResults.get(event) ?? Promise.resolve(unlisten);
  }),
}));

vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => true }));

import { invoke } from "@tauri-apps/api/core";
import { runSidecarStream, type SidecarStreamPart } from "./sidecar-adapter";
import { markSidecarConfigSynced } from "./sidecar-config-sync";
import { useSshCommandOutputStore } from "../store/sshCommandOutputStore";

const currentStreamFixture = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const oldStreamFixture = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "main" as const,
    sessionId: "chat-identity",
    messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "fixture" }] }] as never,
    input: "fixture",
    live: {
      cwd: null,
      terminalPrivate: false,
      workspaceRoot: null,
      activeFile: null,
      sshSessionId: 17,
    },
    ...overrides,
  } as never;
}

function nextInvoke() {
  const started = deferred<InvokeArgs>();
  harness.invokeStarted.push((args) => started.resolve(args));
  const result = deferred<unknown>();
  harness.invokeResults.push(result.promise);
  return { started: started.promise, result };
}

function streamTag(args: InvokeArgs) {
  const tag = args.params?.state?._rpc_stream_id;
  return typeof tag === "string" ? tag : currentStreamFixture;
}

function emit(
  eventName: string,
  sessionId: string,
  rpcRequestId: unknown,
  rpcStreamId: unknown,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const eventPayload = {
    event_type: eventType,
    session_id: sessionId,
    ...(rpcRequestId !== undefined ? { rpc_request_id: rpcRequestId } : {}),
    ...(rpcStreamId !== undefined ? { rpc_stream_id: rpcStreamId } : {}),
    payload,
  };
  for (const callback of harness.listeners.get(eventName) ?? []) {
    callback({ payload: eventPayload });
  }
}

function emitSsh(payload: Record<string, unknown>) {
  for (const callback of harness.listeners.get("sidecar:ssh_command_output") ?? []) {
    callback({ payload });
  }
}

async function collect(stream: AsyncIterable<SidecarStreamPart>) {
  const parts: SidecarStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

beforeEach(() => {
  harness.listeners.clear();
  harness.listenStarted.clear();
  harness.listenResults.clear();
  harness.invokeCalls.length = 0;
  harness.invokeStarted.length = 0;
  harness.invokeResults.length = 0;
  vi.mocked(invoke).mockClear();
  useSshCommandOutputStore.setState({ calls: {} });
  markSidecarConfigSynced();
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem("tdsf.sidecarTimeoutMs");
});

describe("sidecar event stream identity", () => {
  it.each(["thinking", "output"])("logs only metadata for returned %s while preserving its real stream delta", async (type) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const next = nextInvoke();
    const content = "returned body must stay out of global debug logs";
    const partsPromise = collect(runSidecarStream(makeOptions()));
    try {
      const args = await next.started;
      emit("sidecar:agent_message", "chat-identity", 1101, streamTag(args), "agent_message", { type, content });
      next.result.resolve({ observation: "fallback" });
      const parts = await partsPromise;
      expect(parts).toContainEqual(expect.objectContaining({ type: type === "thinking" ? "reasoning-delta" : "text-delta", delta: content }));
      expect(JSON.stringify(info.mock.calls)).not.toContain(content);
      expect(info).toHaveBeenCalledWith("[sidecar-adapter] agent_message", type, { contentChars: content.length });
    } finally {
      next.result.resolve({ observation: "fixture cleanup" });
      await partsPromise.catch(() => []);
      info.mockRestore();
    }
  });

  it("drops a previous stream event arriving while current listeners are still preparing", async () => {
    const next = nextInvoke();
    const sshListenStarted = deferred<void>();
    const sshListenResult = deferred<() => void>();
    harness.listenStarted.set("sidecar:ssh_command_output", () => sshListenStarted.resolve());
    harness.listenResults.set("sidecar:ssh_command_output", sshListenResult.promise);
    const partsPromise = collect(runSidecarStream(makeOptions({
      onMood: () => {},
      onStep: () => {},
      onLoopProgress: () => {},
    })));

    try {
      await sshListenStarted.promise;
      emit("sidecar:agent_message", "chat-identity", 100, oldStreamFixture, "agent_message", {
        type: "output", content: "prepared stale output",
      });
      sshListenResult.resolve(() => {});
      const args = await next.started;
      emit("sidecar:agent_message", "chat-identity", 1101, streamTag(args), "agent_message", {
        type: "output", content: "current output",
      });
      next.result.resolve({ observation: "fallback" });
      const parts = await partsPromise;

      expect.soft(parts.filter((part) => part.type === "text-delta").map((part) => part.delta))
        .toEqual(["current output"]);
      expect.soft(parts.some((part) => part.type === "finish")).toBe(true);
    } finally {
      sshListenResult.resolve(() => {});
      next.result.resolve({ observation: "fixture cleanup" });
      await partsPromise.catch(() => []);
    }
  });

  it("drops old thinking, output, mood, loop, and tool events while preserving the current stream", async () => {
    const next = nextInvoke();
    const moods: string[] = [];
    const steps: (string | null)[] = [];
    const loops: { round: number; toolCount: number }[] = [];
    const partsPromise = collect(runSidecarStream(makeOptions({
      onMood: (mood: string) => moods.push(mood),
      onStep: (step: string | null) => steps.push(step),
      onLoopProgress: (progress: { round: number; toolCount: number }) => loops.push(progress),
    })));
    const args = await next.started;
    const tag = streamTag(args);

    emit("sidecar:agent_message", "chat-identity", 101, oldStreamFixture, "agent_message", {
      type: "thinking", content: "stale reasoning",
    });
    emit("sidecar:agent_message", "chat-identity", 101, oldStreamFixture, "agent_message", {
      type: "output", content: "stale answer",
    });
    emit("sidecar:mood_change", "chat-identity", 101, oldStreamFixture, "mood_change", {
      mood: "stale mood",
    });
    emit("sidecar:loop_progress", "chat-identity", 101, oldStreamFixture, "loop_progress", {
      round: 91, tool_count: 91,
    });
    emit("sidecar:tool_call", "chat-identity", 101, oldStreamFixture, "tool_call", {
      tool_name: "stale_tool", status: "started", params: { command: "fixture" },
    });
    emit("sidecar:tool_call", "chat-identity", 101, oldStreamFixture, "tool_call", {
      tool_name: "stale_tool", status: "completed", result: "stale result",
    });

    emit("sidecar:agent_message", "chat-identity", 701, tag, "agent_message", {
      type: "thinking", content: "current reasoning",
    });
    emit("sidecar:agent_message", "chat-identity", 701, tag, "agent_message", {
      type: "output", content: "current answer",
    });
    emit("sidecar:mood_change", "chat-identity", 701, tag, "mood_change", {
      mood: "current mood",
    });
    emit("sidecar:loop_progress", "chat-identity", 701, tag, "loop_progress", {
      round: 2, tool_count: 3,
    });
    emit("sidecar:tool_call", "chat-identity", 701, tag, "tool_call", {
      tool_name: "current_tool", status: "started", params: { query: "safe fixture" },
    });
    emit("sidecar:tool_call", "chat-identity", 701, tag, "tool_call", {
      tool_name: "current_tool", status: "completed", result: "current result",
    });
    // Reusing the tag with another real RPC id must not transfer the stream owner.
    emit("sidecar:agent_message", "chat-identity", 702, tag, "agent_message", {
      type: "output", content: "wrong rpc owner",
    });
    next.result.resolve({ observation: "fallback must not duplicate streamed text" });
    const parts = await partsPromise;

    const text = parts.filter((part) => part.type === "text-delta");
    const reasoning = parts.filter((part) => part.type === "reasoning-delta");
    const toolInputs = parts.filter((part) => part.type === "tool-input");
    const toolOutputs = parts.filter((part) => part.type === "tool-output");
    expect.soft(text.map((part) => part.delta)).toEqual(["current answer"]);
    expect.soft(reasoning.map((part) => part.delta)).toEqual(["current reasoning"]);
    expect.soft(toolInputs).toHaveLength(1);
    expect.soft(toolOutputs).toHaveLength(1);
    expect.soft(moods).toEqual(["current mood"]);
    expect.soft(loops).toEqual([{ round: 2, toolCount: 3 }]);
    expect.soft(steps).toContain("调用 current_tool");
    expect.soft(parts.some((part) => part.type === "finish")).toBe(true);
    expect.soft(parts.some((part) => "error" in part)).toBe(false);
  });

  it("rejects missing, malformed, cross-session, wrong-tag, and unbound RPC events", async () => {
    const next = nextInvoke();
    const partsPromise = collect(runSidecarStream(makeOptions()));
    const args = await next.started;
    const tag = streamTag(args);
    emit("sidecar:agent_message", "another-chat", 801, tag, "agent_message", {
      type: "output", content: "cross session",
    });
    emit("sidecar:agent_message", "chat-identity", 801, undefined, "agent_message", {
      type: "output", content: "missing tag",
    });
    emit("sidecar:agent_message", "chat-identity", 801, "not-a-uuid", "agent_message", {
      type: "output", content: "malformed tag",
    });
    emit("sidecar:agent_message", "chat-identity", undefined, tag, "agent_message", {
      type: "output", content: "missing rpc id",
    });
    emit("sidecar:agent_message", "chat-identity", -1, tag, "agent_message", {
      type: "output", content: "invalid rpc id",
    });
    emit("sidecar:agent_message", "chat-identity", 801, oldStreamFixture, "agent_message", {
      type: "output", content: "wrong tag",
    });
    emit("sidecar:agent_message", "chat-identity", 801, tag, "agent_message", {
      type: "output", content: "accepted current",
    });
    next.result.resolve({ observation: "fallback" });
    const parts = await partsPromise;

    expect.soft(parts.filter((part) => part.type === "text-delta").map((part) => part.delta))
      .toEqual(["accepted current"]);
    expect.soft(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("keeps two overlapping same-chat generators bound to their own stream tag", async () => {
    const firstNext = nextInvoke();
    const firstParts = collect(runSidecarStream(makeOptions({ input: "first" })));
    const firstArgs = await firstNext.started;
    const secondNext = nextInvoke();
    const secondParts = collect(runSidecarStream(makeOptions({ input: "second" })));
    const secondArgs = await secondNext.started;
    const firstTag = streamTag(firstArgs);
    const secondTag = streamTag(secondArgs);

    emit("sidecar:agent_message", "chat-identity", 901, firstTag, "agent_message", {
      type: "output", content: "first only",
    });
    emit("sidecar:agent_message", "chat-identity", 902, secondTag, "agent_message", {
      type: "output", content: "second only",
    });
    firstNext.result.resolve({ observation: "first fallback" });
    secondNext.result.resolve({ observation: "second fallback" });
    const [first, second] = await Promise.all([firstParts, secondParts]);

    expect.soft(first.filter((part) => part.type === "text-delta").map((part) => part.delta))
      .toEqual(["first only"]);
    expect.soft(second.filter((part) => part.type === "text-delta").map((part) => part.delta))
      .toEqual(["second only"]);
    expect.soft(first.some((part) => part.type === "finish")).toBe(true);
    expect.soft(second.some((part) => part.type === "finish")).toBe(true);
  });

  it.each([
    { label: "completed arrives during invoke drain", late: true },
    { label: "completed arrives before invoke resolves", late: false },
  ])("keeps tool outcomes when $label", async ({ late }) => {
    vi.useFakeTimers();
    const next = nextInvoke();
    const iterator = runSidecarStream(makeOptions())[Symbol.asyncIterator]();
    const firstPending = iterator.next();
    const completedResult = {
      status: "error",
      message: "business failure remains structured",
      exit_code: 23,
      details: { source: "fixture" },
    };

    try {
      const args = await next.started;
      const tag = streamTag(args);
      emit("sidecar:tool_call", "chat-identity", 1301, tag, "tool_call", {
        tool_name: "ssh_command",
        tool_call_id: "backend-tail-tool",
        status: "started",
        params: { command: "fixture-command" },
      });
      const first = await firstPending;
      expect.soft(first.value).toMatchObject({
        type: "tool-input",
        toolName: "ssh_command",
      });
      if (first.value?.type !== "tool-input") return;

      const waitingForTail = iterator.next();
      if (late) {
        next.result.resolve({ observation: "" });
        await vi.advanceTimersByTimeAsync(0);
      }
      emit("sidecar:tool_call", "chat-identity", 1301, tag, "tool_call", {
        tool_name: "ssh_command",
        tool_call_id: "backend-tail-tool",
        status: "error",
        result: completedResult,
      });
      if (!late) next.result.resolve({ observation: "" });
      await vi.advanceTimersByTimeAsync(30);
      const tail = await waitingForTail;
      const remaining = collect({ [Symbol.asyncIterator]: () => iterator });
      await vi.advanceTimersByTimeAsync(30);
      const parts = [first.value, ...(tail.done ? [] : [tail.value]), ...await remaining];
      const inputs = parts.filter((part) => part.type === "tool-input");
      const outputs = parts.filter((part) => part.type === "tool-output");

      expect.soft(inputs).toHaveLength(1);
      expect.soft(outputs).toHaveLength(1);
      expect.soft(outputs[0]).toMatchObject({
        type: "tool-output",
        toolCallId: first.value.toolCallId,
        toolName: "ssh_command",
        output: completedResult,
        isError: true,
      });
      expect.soft(parts.some((part) => part.type === "finish")).toBe(true);
    } finally {
      next.result.resolve({ observation: "fixture cleanup" });
      await vi.runOnlyPendingTimersAsync();
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it("does not yield an event chunk when abort happens as the waiting queue item arrives", async () => {
    const controller = new AbortController();
    const next = nextInvoke();
    const iterator = runSidecarStream(
      makeOptions({ abortSignal: controller.signal }),
    )[Symbol.asyncIterator]();
    const pending = iterator.next();

    try {
      const args = await next.started;
      emit("sidecar:agent_message", "chat-identity", 1201, streamTag(args), "agent_message", {
        type: "output", content: "must not escape after abort",
      });
      controller.abort();
      next.result.resolve({ observation: "fallback must not run" });

      await expect(pending).resolves.toMatchObject({ done: true });
    } finally {
      controller.abort();
      next.result.resolve({ observation: "fixture cleanup" });
      await iterator.return?.();
    }
  });

  it("does not drain a queued event after abort during the invoke completion window", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const next = nextInvoke();
    const iterator = runSidecarStream(
      makeOptions({ abortSignal: controller.signal }),
    )[Symbol.asyncIterator]();
    const firstPending = iterator.next();

    try {
      const args = await next.started;
      const tag = streamTag(args);
      emit("sidecar:agent_message", "chat-identity", 1202, tag, "agent_message", {
        type: "output", content: "first queued chunk",
      });
      const first = await firstPending;
      expect.soft(first.value).toMatchObject({ type: "text-delta", delta: "first queued chunk" });

      emit("sidecar:agent_message", "chat-identity", 1202, tag, "agent_message", {
        type: "output", content: "second queued chunk",
      });
      next.result.resolve({ observation: "fallback must not run" });
      await vi.advanceTimersByTimeAsync(0);
      const draining = iterator.next();
      await vi.advanceTimersByTimeAsync(29);
      controller.abort();
      await vi.advanceTimersByTimeAsync(1);

      await expect(draining).resolves.toMatchObject({ done: true });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    } finally {
      controller.abort();
      next.result.resolve({ observation: "fixture cleanup" });
      await vi.runOnlyPendingTimersAsync();
      await iterator.return?.();
      vi.useRealTimers();
    }
  });

  it.each([
    { label: "fallback output", result: { observation: "x".repeat(512) }, initialStep: "Streaming" },
    { label: "fallback thinking", result: { thinking: "y".repeat(512) }, initialStep: "Thinking" },
    {
      label: "friendly degraded note",
      result: { degraded: true, degraded_reason: "invoke_stalled", observation: "z".repeat(512) },
      initialStep: null,
    },
  ])("stops $label fallback chunks after abort", async ({ result, initialStep }) => {
    const controller = new AbortController();
    const next = nextInvoke();
    const steps: (string | null)[] = [];
    const iterator = runSidecarStream(makeOptions({
      abortSignal: controller.signal,
      onStep: (step: string | null) => steps.push(step),
    }))[Symbol.asyncIterator]();
    const firstPending = iterator.next();

    try {
      await next.started;
      next.result.resolve(result);
      const first = await firstPending;
      expect.soft(first.done).toBe(false);
      expect.soft(first.value?.type).toMatch(/^(text|reasoning)-delta$/);
      if (initialStep) expect.soft(steps).toEqual([initialStep]);
      else expect.soft(steps).toEqual([]);

      controller.abort();
      const remaining: SidecarStreamPart[] = [];
      for await (const part of { [Symbol.asyncIterator]: () => iterator }) remaining.push(part);
      expect.soft(remaining).toEqual([]);
      expect.soft(steps).toEqual(initialStep ? [initialStep] : []);
    } finally {
      controller.abort();
      next.result.resolve({ observation: "fixture cleanup" });
      await iterator.return?.();
    }
  });

  it("preserves normal multi-chunk fallback output when not aborted", async () => {
    const next = nextInvoke();
    const text = "normal fallback output ".repeat(24);
    const partsPromise = collect(runSidecarStream(makeOptions()));
    await next.started;
    next.result.resolve({ observation: text });
    const parts = await partsPromise;

    const deltas = parts.filter((part) => part.type === "text-delta");
    expect.soft(deltas.length).toBeGreaterThan(1);
    expect.soft(deltas.map((part) => part.delta).join("")).toBe(text);
    expect.soft(parts.some((part) => part.type === "finish")).toBe(true);
  });

  it("does not let an unmatched SSH callback renew the activity budget", async () => {
    vi.useFakeTimers();
    localStorage.setItem("tdsf.sidecarTimeoutMs", "10000");
    const next = nextInvoke();
    let settled = false;
    const partsPromise = collect(runSidecarStream(makeOptions()))
      .then((parts) => {
        settled = true;
        return parts;
      });

    try {
      await next.started;
      await vi.advanceTimersByTimeAsync(6000);
      emitSsh({
        conversationSessionId: "chat-identity",
        toolCallId: "unknown-old-tool-call",
        toolName: "ssh_command",
        command: "whoami",
        sshSessionId: 17,
        operationId: "old-operation",
        stream: "stdout",
        chunk: "late output",
        status: "running",
      });
      await vi.advanceTimersByTimeAsync(4000);
      await vi.advanceTimersByTimeAsync(31);
      const timedOutWithoutMatchingTool = settled;

      // Always release the mocked invoke so both the expected timeout and the
      // legacy false-renewal path leave the generator and timers settled.
      next.result.resolve({ observation: "released fixture invoke" });
      await vi.advanceTimersByTimeAsync(100);
      const parts = await partsPromise;

      expect.soft(timedOutWithoutMatchingTool).toBe(true);
      expect.soft(parts.some(
        (part) => part.type === "error" && /超时|timeout/i.test(part.error),
      )).toBe(true);
    } finally {
      next.result.resolve({ observation: "fixture cleanup" });
      await vi.advanceTimersByTimeAsync(100);
      await partsPromise.catch(() => []);
      vi.useRealTimers();
      localStorage.removeItem("tdsf.sidecarTimeoutMs");
    }
  });

  it("makes a saved callback inert after generator cleanup", async () => {
    const next = nextInvoke();
    const moods: string[] = [];
    const steps: (string | null)[] = [];
    const loops: { round: number; toolCount: number }[] = [];
    const partsPromise = collect(runSidecarStream(makeOptions({
      onMood: (mood: string) => moods.push(mood),
      onStep: (step: string | null) => steps.push(step),
      onLoopProgress: (progress: { round: number; toolCount: number }) => loops.push(progress),
    })));
    const args = await next.started;
    const tag = streamTag(args);
    const savedMessage = [...(harness.listeners.get("sidecar:agent_message") ?? [])][0];
    const savedMood = [...(harness.listeners.get("sidecar:mood_change") ?? [])][0];
    const savedLoop = [...(harness.listeners.get("sidecar:loop_progress") ?? [])][0];
    const savedTool = [...(harness.listeners.get("sidecar:tool_call") ?? [])][0];
    const savedSsh = [...(harness.listeners.get("sidecar:ssh_command_output") ?? [])][0];
    const beginSpy = vi.spyOn(useSshCommandOutputStore.getState(), "begin");
    const recordSpy = vi.spyOn(useSshCommandOutputStore.getState(), "record");
    try {
    emit("sidecar:agent_message", "chat-identity", 1001, tag, "agent_message", {
      type: "output", content: "normal output",
    });
    emit("sidecar:tool_call", "chat-identity", 1001, tag, "tool_call", {
      tool_name: "ssh_command",
      tool_call_id: "backend-ssh-current",
      status: "started",
      params: { command: "whoami", ssh_session_id: 17 },
    });
    emitSsh({
      conversationSessionId: "chat-identity",
      toolCallId: "backend-ssh-current",
      toolName: "ssh_command",
      command: "whoami",
      sshSessionId: 17,
      operationId: "current-op",
      stream: "status",
      chunk: "",
      status: "running",
    });
    emitSsh({
      conversationSessionId: "chat-identity",
      toolCallId: "backend-ssh-current",
      toolName: "ssh_command",
      command: "whoami",
      sshSessionId: 17,
      operationId: "current-op",
      stream: "stdout",
      chunk: "current command output",
      status: "running",
    });
    next.result.resolve({ observation: "normal fallback" });
    const completed = await partsPromise;
    const currentTool = completed.find(
      (part): part is Extract<SidecarStreamPart, { type: "tool-input" }> =>
        part.type === "tool-input" && part.toolName === "ssh_command",
    );
    const storeBeforeLateCallback = JSON.parse(
      JSON.stringify(useSshCommandOutputStore.getState().calls),
    ) as unknown;
    const storedCommand = currentTool && currentTool.type === "tool-input"
      ? useSshCommandOutputStore.getState().calls[currentTool.toolCallId]
      : undefined;
    const prior = {
      moods: [...moods],
      steps: [...steps],
      loops: [...loops],
      beginCalls: beginSpy.mock.calls.length,
      recordCalls: recordSpy.mock.calls.length,
    };

    const event = (eventType: string, payload: Record<string, unknown>) => ({
      payload: {
        event_type: eventType,
        session_id: "chat-identity",
        rpc_request_id: 1001,
        rpc_stream_id: tag,
        payload,
      },
    });
    savedMessage(event("agent_message", { type: "output", content: "late stale" }));
    savedMood(event("mood_change", { mood: "late stale" }));
    savedLoop(event("loop_progress", { round: 99, tool_count: 99 }));
    savedTool(event("tool_call", {
      tool_name: "ssh_command",
      tool_call_id: "late-backend-ssh",
      status: "started",
      params: { command: "late", ssh_session_id: 17 },
    }));
    savedSsh({ payload: {
      conversationSessionId: "chat-identity",
      toolCallId: "backend-ssh-current",
      toolName: "ssh_command",
      command: "whoami",
      sshSessionId: 17,
      operationId: "current-op",
      stream: "stdout",
      chunk: "late output",
      status: "running",
    } });

    expect.soft(currentTool).toBeDefined();
    expect.soft(storedCommand?.stdout).toBe("current command output");
    expect.soft(completed.some((part) => part.type === "finish")).toBe(true);
    expect.soft(moods).toEqual(prior.moods);
    expect.soft(steps).toEqual(prior.steps);
    expect.soft(loops).toEqual(prior.loops);
    expect.soft(beginSpy).toHaveBeenCalledTimes(prior.beginCalls);
    expect.soft(recordSpy).toHaveBeenCalledTimes(prior.recordCalls);
    expect.soft(useSshCommandOutputStore.getState().calls).toEqual(storeBeforeLateCallback);
    } finally {
      beginSpy.mockRestore();
      recordSpy.mockRestore();
    }
  });
});
