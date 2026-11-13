import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args: unknown): Promise<unknown> => ({ ok: true })),
  listen: vi.fn(async (_event: string, _handler: unknown): Promise<() => void> => vi.fn<() => void>()),
  getKey: vi.fn(async (_provider?: string): Promise<string | null> => "synthetic-key"),
  getCustomEndpointKey: vi.fn(async () => "synthetic-key"),
  pushRecentModel: vi.fn(async (_id: string) => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: boundary.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: boundary.listen }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("../lib/keyring", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/keyring")>();
  return {
    ...actual,
    getKey: boundary.getKey,
    getCustomEndpointKey: boundary.getCustomEndpointKey,
  };
});
vi.mock("../lib/modelPrefs", () => ({ pushRecentModel: boundary.pushRecentModel }));

import { useChatStore } from "../store/chatStore";
import {
  resetSidecarConfigSyncFlag,
  runSidecarConfigSyncNow,
} from "./sidecar-config-sync";
import {
  runSidecarStream,
  type SidecarStreamPart,
} from "./sidecar-adapter";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function rpcMethod(args: unknown): string | undefined {
  return (args as { method?: string }).method;
}

function callsFor(method: string) {
  return boundary.invoke.mock.calls.filter(([, args]) => rpcMethod(args) === method);
}

function configuredModels(): string[] {
  return callsFor("agent.configure").map(([, args]) => {
    const payload = args as { params: { config: { model: string } } };
    return payload.params.config.model;
  });
}

function streamOptions(
  sessionId: string,
  abortSignal = new AbortController().signal,
) {
  return {
    agentId: "main" as const,
    sessionId,
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
  };
}

function collect(stream: AsyncIterable<SidecarStreamPart>): Promise<SidecarStreamPart[]> {
  const parts: SidecarStreamPart[] = [];
  return (async () => {
    for await (const part of stream) parts.push(part);
    return parts;
  })();
}

async function finishStream(promise: Promise<SidecarStreamPart[]>) {
  await vi.advanceTimersByTimeAsync(100);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  boundary.invoke.mockReset().mockImplementation(async (_command, args) =>
    rpcMethod(args) === "agent.invoke" ? { output: "synthetic output" } : { ok: true },
  );
  boundary.listen.mockReset().mockImplementation(async () => vi.fn<() => void>());
  boundary.getKey.mockReset().mockResolvedValue("synthetic-key");
  boundary.getCustomEndpointKey.mockReset().mockResolvedValue("synthetic-key");
  boundary.pushRecentModel.mockReset().mockResolvedValue(undefined);
  resetSidecarConfigSyncFlag();
  useChatStore.setState({ selectedModelId: "deepseek-v4-flash" });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetSidecarConfigSyncFlag();
  useChatStore.setState({ selectedModelId: "deepseek-v4-flash" });
});

describe("first-message sidecar configuration readiness", () => {
  it("waits for a background key lookup and configures once before the first invoke", async () => {
    const keyReadStarted = deferred<void>();
    const key = deferred<string | null>();
    boundary.getKey.mockImplementationOnce(async () => {
      keyReadStarted.resolve();
      return key.promise;
    });
    const backgroundSync = runSidecarConfigSyncNow();
    let stream: Promise<SidecarStreamPart[]> | undefined;

    try {
      await keyReadStarted.promise;
      stream = collect(runSidecarStream(streamOptions("readiness-background-key")));
      await vi.advanceTimersByTimeAsync(0);

      expect(callsFor("agent.invoke")).toHaveLength(0);
      expect(callsFor("agent.configure")).toHaveLength(0);

      key.resolve("synthetic-key");
      expect((await backgroundSync).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor("agent.configure")).toHaveLength(1);
      expect(callsFor("agent.invoke")).toHaveLength(1);
      await finishStream(stream!);
    } finally {
      key.resolve("synthetic-key");
      await backgroundSync;
      if (stream) await finishStream(stream);
    }
  });

  it("waits for the configure acknowledgement before invoking the agent", async () => {
    const configureStarted = deferred<void>();
    const acknowledgement = deferred<{ ok: boolean }>();
    boundary.invoke.mockImplementation(async (_command, args) => {
      if (rpcMethod(args) === "agent.configure") {
        configureStarted.resolve();
        return acknowledgement.promise;
      }
      return rpcMethod(args) === "agent.invoke"
        ? { output: "synthetic output" }
        : { ok: true };
    });
    const backgroundSync = runSidecarConfigSyncNow();
    let stream: Promise<SidecarStreamPart[]> | undefined;

    try {
      await configureStarted.promise;
      stream = collect(runSidecarStream(streamOptions("readiness-background-ack")));
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor("agent.invoke")).toHaveLength(0);

      acknowledgement.resolve({ ok: true });
      expect((await backgroundSync).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(configuredModels()).toEqual(["deepseek-v4-flash"]);
      expect(callsFor("agent.invoke")).toHaveLength(1);
      await finishStream(stream!);
    } finally {
      acknowledgement.resolve({ ok: true });
      await backgroundSync;
      if (stream) await finishStream(stream);
    }
  });

  it("caches a background failure, reports it in Chinese, and does not retry or invoke", async () => {
    boundary.invoke.mockImplementation(async (_command, args) =>
      rpcMethod(args) === "agent.configure"
        ? { ok: false, message: "SYNTHETIC_PRIVATE_DIAGNOSTIC" }
        : { output: "synthetic output" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runSidecarConfigSyncNow();
      expect(result.ok).toBe(false);

      const stream = collect(runSidecarStream(streamOptions("readiness-cached-failure")));
      await vi.advanceTimersByTimeAsync(100);
      const parts = await stream;

      const errorText = parts.find((part) => part.type === "error");
      expect(errorText?.type === "error" && errorText.error).toContain("本条消息未发送");
      expect(errorText?.type === "error" && errorText.error).not.toContain(
        "SYNTHETIC_PRIVATE_DIAGNOSTIC",
      );
      expect(boundary.getKey).toHaveBeenCalledTimes(1);
      expect(callsFor("agent.configure")).toHaveLength(1);
      expect(callsFor("agent.invoke")).toHaveLength(0);
      expect(boundary.listen).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("stops the first message with a Chinese error when its foreground sync fails", async () => {
    const keyReadStarted = deferred<void>();
    boundary.getKey.mockImplementationOnce(async () => {
      keyReadStarted.resolve();
      return "synthetic-key";
    });
    boundary.invoke.mockImplementation(async (_command, args) =>
      rpcMethod(args) === "agent.configure"
        ? Promise.reject(new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"))
        : { output: "synthetic output" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stream = collect(runSidecarStream(streamOptions("readiness-foreground-failure")));

    try {
      await keyReadStarted.promise;
      await vi.advanceTimersByTimeAsync(100);
      const parts = await stream;

      const errorText = parts.find((part) => part.type === "error");
      expect(errorText?.type === "error" && errorText.error).toContain("本条消息未发送");
      expect(errorText?.type === "error" && errorText.error).not.toContain(
        "SYNTHETIC_PRIVATE_DIAGNOSTIC",
      );
      expect(boundary.getKey).toHaveBeenCalledTimes(1);
      expect(callsFor("agent.configure")).toHaveLength(1);
      expect(callsFor("agent.invoke")).toHaveLength(0);
      expect(boundary.listen).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await finishStream(stream);
      vi.restoreAllMocks();
    }
  });

  it("shares one in-flight configuration sync across two first messages", async () => {
    const keyReadStarted = deferred<void>();
    const key = deferred<string | null>();
    boundary.getKey.mockImplementationOnce(async () => {
      keyReadStarted.resolve();
      return key.promise;
    });
    let first: Promise<SidecarStreamPart[]> | undefined;
    let second: Promise<SidecarStreamPart[]> | undefined;

    try {
      first = collect(runSidecarStream(streamOptions("readiness-shared-sync")));
      await keyReadStarted.promise;
      second = collect(runSidecarStream(streamOptions("readiness-shared-sync")));
      await vi.advanceTimersByTimeAsync(0);

      expect(boundary.getKey).toHaveBeenCalledTimes(1);
      expect(callsFor("agent.invoke")).toHaveLength(0);

      key.resolve("synthetic-key");
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor("agent.configure")).toHaveLength(1);
      expect(callsFor("agent.invoke")).toHaveLength(2);
      await Promise.all([finishStream(first!), finishStream(second!)]);
    } finally {
      key.resolve("synthetic-key");
      if (first) await finishStream(first);
      if (second) await finishStream(second);
    }
  });

  it.each([true, false])("lets an aborted waiter exit without cancelling the sync (background=%s)", async (background) => {
    const keyReadStarted = deferred<void>();
    const key = deferred<string | null>();
    boundary.getKey.mockImplementationOnce(async () => {
      keyReadStarted.resolve();
      return key.promise;
    });
    const backgroundSync = background ? runSidecarConfigSyncNow() : undefined;
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let abandoned: Promise<SidecarStreamPart[]> | undefined;
    let abandonedSettled = false;
    let next: Promise<SidecarStreamPart[]> | undefined;

    try {
      abandoned = collect(runSidecarStream(
        streamOptions("readiness-abort", controller.signal),
      )).then(
        (parts) => {
          abandonedSettled = true;
          return parts;
        },
      );
      await keyReadStarted.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor("agent.invoke")).toHaveLength(0);

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(abandonedSettled).toBe(true);
      expect(await abandoned).toEqual([]);
      expect(boundary.listen).not.toHaveBeenCalled();
      const abortListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(abortListener).toBeDefined();
      expect(removeListener.mock.calls.some(([type, listener]) =>
        type === "abort" && listener === abortListener,
      )).toBe(true);

      key.resolve("synthetic-key");
      await vi.advanceTimersByTimeAsync(0);
      if (backgroundSync) expect((await backgroundSync).ok).toBe(true);
      next = collect(runSidecarStream(streamOptions("readiness-abort")));
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor("agent.configure")).toHaveLength(1);
      expect(callsFor("agent.invoke")).toHaveLength(1);
      await finishStream(next!);
    } finally {
      controller.abort();
      key.resolve("synthetic-key");
      await backgroundSync;
      if (abandoned) await finishStream(abandoned);
      if (next) await finishStream(next);
    }
  });

  it("ends an old message on model change and ignores its late key result", async () => {
    const oldKeyReadStarted = deferred<void>();
    const oldKey = deferred<string | null>();
    const newConfigureSent = deferred<void>();
    boundary.getKey.mockImplementationOnce(async () => {
      oldKeyReadStarted.resolve();
      return oldKey.promise;
    });
    boundary.invoke.mockImplementation(async (_command, args) => {
      if (rpcMethod(args) === "agent.configure") {
        const payload = args as { params: { config: { model: string } } };
        if (payload.params.config.model === "claude-sonnet-5") {
          newConfigureSent.resolve();
        }
        return { ok: true };
      }
      return rpcMethod(args) === "agent.invoke"
        ? { output: "synthetic output" }
        : { ok: true };
    });
    let oldMessageSettled = false;
    const oldMessage = collect(runSidecarStream(
      streamOptions("readiness-model-change"),
    )).then((parts) => {
      oldMessageSettled = true;
      return parts;
    });
    let newMessage: Promise<SidecarStreamPart[]> | undefined;

    try {
      await oldKeyReadStarted.promise;
      useChatStore.getState().setSelectedModelId("claude-sonnet-5");
      await vi.advanceTimersByTimeAsync(0);
      expect(oldMessageSettled).toBe(true);
      expect(callsFor("agent.invoke")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(500);
      await newConfigureSent.promise;
      await vi.advanceTimersByTimeAsync(0);

      expect(configuredModels()).toEqual(["claude-sonnet-5"]);

      oldKey.resolve("stale-synthetic-key");
      await vi.advanceTimersByTimeAsync(100);
      await oldMessage;
      expect(configuredModels()).toEqual(["claude-sonnet-5"]);
      expect(callsFor("agent.invoke")).toHaveLength(0);

      newMessage = collect(runSidecarStream(streamOptions("readiness-model-change")));
      await vi.advanceTimersByTimeAsync(0);
      expect(configuredModels()).toEqual(["claude-sonnet-5"]);
      expect(callsFor("agent.invoke")).toHaveLength(1);
      await finishStream(newMessage!);
    } finally {
      oldKey.resolve("stale-synthetic-key");
      await vi.advanceTimersByTimeAsync(600);
      await oldMessage;
      if (newMessage) await finishStream(newMessage);
    }
  });

  it.each([true, false])(
    "stops a message if the model changes while listener registration is pending (new sync succeeds=%s)",
    async (newSyncSucceeds) => {
      const listenerStarted = deferred<void>();
      const registration = deferred<() => void>();
      const unlisten = vi.fn<() => void>();
      boundary.listen.mockImplementation(async (event) => {
        if (event === "sidecar:ssh_command_output") {
          listenerStarted.resolve();
          return registration.promise;
        }
        return vi.fn<() => void>();
      });
      boundary.invoke.mockImplementation(async (_command, args) => {
        if (rpcMethod(args) === "agent.configure") {
          const payload = args as { params: { config: { model: string } } };
          if (payload.params.config.model === "claude-sonnet-5" && !newSyncSucceeds) {
            return { ok: false, message: "SYNTHETIC_PRIVATE_DIAGNOSTIC" };
          }
          return { ok: true };
        }
        return rpcMethod(args) === "agent.invoke"
          ? { output: "synthetic output" }
          : { ok: true };
      });

      expect((await runSidecarConfigSyncNow()).ok).toBe(true);
      let oldMessage: Promise<SidecarStreamPart[]> | undefined;
      let followup: Promise<SidecarStreamPart[]> | undefined;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        oldMessage = collect(runSidecarStream(
          streamOptions(`readiness-listener-model-change-${newSyncSucceeds}`),
        ));
        await listenerStarted.promise;

        useChatStore.getState().setSelectedModelId("claude-sonnet-5");
        expect((await runSidecarConfigSyncNow()).ok).toBe(newSyncSucceeds);
        expect(callsFor("agent.invoke")).toHaveLength(0);

        registration.resolve(unlisten);
        const oldParts = await finishStream(oldMessage);
        const oldError = oldParts.find((part) => part.type === "error");
        expect(oldError?.type === "error" && oldError.error).toContain("本条消息未发送");
        expect(callsFor("agent.invoke")).toHaveLength(0);
        expect(unlisten).toHaveBeenCalledTimes(1);

        followup = collect(runSidecarStream(
          streamOptions(`readiness-listener-followup-${newSyncSucceeds}`),
        ));
        await vi.advanceTimersByTimeAsync(100);
        const followupParts = await followup;
        if (newSyncSucceeds) {
          expect(callsFor("agent.configure")).toHaveLength(2);
          expect(callsFor("agent.invoke")).toHaveLength(1);
          expect(followupParts.some((part) => part.type === "finish")).toBe(true);
        } else {
          const followupError = followupParts.find((part) => part.type === "error");
          expect(followupError?.type === "error" && followupError.error).toContain(
            "本条消息未发送",
          );
          expect(callsFor("agent.configure")).toHaveLength(2);
          expect(callsFor("agent.invoke")).toHaveLength(0);
        }
        expect(warn).toHaveBeenCalledTimes(newSyncSucceeds ? 0 : 1);
      } finally {
        registration.resolve(unlisten);
        await vi.advanceTimersByTimeAsync(100);
        if (oldMessage) await oldMessage;
        if (followup) await followup;
        vi.restoreAllMocks();
      }
    },
  );
});
