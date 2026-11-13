import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sshConnect: vi.fn(),
  sshCommand: vi.fn(),
  fetchRemoteCommands: vi.fn(),
  fetchRemoteOsInfo: vi.fn(),
  probeRemoteCarapace: vi.fn(),
}));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-bridge")>();
  return {
    ...actual,
    sshConnect: mocks.sshConnect,
    sshCommand: mocks.sshCommand,
  };
});
vi.mock("@/lib/param-complete-client", () => ({
  fetchRemoteCommands: mocks.fetchRemoteCommands,
  fetchRemoteOsInfo: mocks.fetchRemoteOsInfo,
  probeRemoteCarapace: mocks.probeRemoteCarapace,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({ sshRemoteCarapacePrompt: false }) },
}));

import {
  PROBE_MARK,
  type SshCommandResult,
  type SshConnectParams,
  type SshHandlers,
} from "@/lib/ssh-bridge";
import { useSshStore } from "./sshStore";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const params: SshConnectParams = {
  host: "example.invalid",
  port: 22,
  user: "tester",
  auth: { type: "password", password: "synthetic-test-secret" },
  cols: 80,
  rows: 24,
  term: "xterm-256color",
};

const connectedEvent = {
  state: "connected" as const,
  host: "example.invalid",
  port: 22,
  user: "tester",
  timestamp: 1,
};

function probeResult(
  home: string,
  options: { ok?: boolean; exitCode?: number } = {},
): SshCommandResult {
  return {
    ok: options.ok ?? true,
    output: `${PROBE_MARK}\n${home}\n`,
    stderr: "",
    exitCode: options.exitCode ?? 0,
    duration: 0,
  };
}

function rejectedProbe(): Error {
  return new Error("synthetic probe failure");
}

let handlers: SshHandlers[];
let probes: Array<{ rustSessionId: number; deferred: Deferred<SshCommandResult> }>;
let nextRustSessionId: number;

function currentPath(sessionId: string): string | undefined {
  return useSshStore.getState().currentPathBySession[sessionId];
}

function probeFor(rustSessionId: number) {
  const probe = probes.find((item) => item.rustSessionId === rustSessionId);
  expect(probe, `HOME probe for Rust session ${rustSessionId}`).toBeDefined();
  return probe!.deferred;
}

async function finishProbe(
  probe: Deferred<SshCommandResult>,
  result: SshCommandResult,
) {
  await act(async () => {
    probe.resolve(result);
    await probe.promise;
  });
}

async function connectSession() {
  const sessionId = await useSshStore.getState().connect(params);
  expect(sessionId).toBeTruthy();
  const session = useSshStore
    .getState()
    .sessions.find((item) => item.id === sessionId);
  expect(session?.rustSessionId).not.toBeNull();
  const handler = handlers.at(-1)!;
  act(() => handler.onStatus?.(connectedEvent));
  return {
    sessionId: sessionId!,
    rustSessionId: session!.rustSessionId!,
    handler,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers = [];
  probes = [];
  nextRustSessionId = 500;
  useSshStore.setState({
    sessions: [],
    activeSessionId: null,
    currentPathBySession: {},
    remoteCarapaceBySession: {},
  });
  mocks.sshConnect.mockImplementation(
    async (_params: SshConnectParams, callbacks: SshHandlers) => {
      handlers.push(callbacks);
      const id = nextRustSessionId++;
      return {
        id,
        write: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
    },
  );
  mocks.sshCommand.mockImplementation((rustSessionId: number) => {
    const request = deferred<SshCommandResult>();
    probes.push({ rustSessionId, deferred: request });
    return request.promise;
  });
  mocks.fetchRemoteCommands.mockResolvedValue(undefined);
  mocks.fetchRemoteOsInfo.mockResolvedValue(null);
  mocks.probeRemoteCarapace.mockResolvedValue('missing');
});

describe("sshStore current directory probe lifecycle", () => {
  it.each([
    ["success", () => probeResult("/home/user")],
    ["rejection", () => rejectedProbe()],
    ["nonzero exit", () => probeResult("/home/user", { exitCode: 1 })],
  ] as const)(
    "keeps an OSC cwd when the pending HOME probe finishes with %s",
    async (_outcome, outcome) => {
      const session = await connectSession();
      const probe = probeFor(session.rustSessionId);
      act(() => useSshStore.getState().setCurrentPath(session.sessionId, "/srv/live"));

      const result = outcome();
      if (result instanceof Error) {
        await act(async () => {
          probe.reject(result);
          await probe.promise.catch(() => {});
        });
      } else {
        await finishProbe(probe, result);
      }

      expect(currentPath(session.sessionId)).toBe("/srv/live");
    },
  );

  it.each(["closed", "failed", "reconnecting"] as const)(
    "does not seed cwd when the session becomes %s before HOME returns",
    async (state) => {
      const session = await connectSession();
      const probe = probeFor(session.rustSessionId);
      act(() => {
        if (state === "closed") {
          session.handler.onExit?.(0);
        } else {
          session.handler.onStatus?.({ ...connectedEvent, state });
        }
      });
      await finishProbe(probe, probeResult("/home/user"));

      expect(currentPath(session.sessionId)).toBeUndefined();
      expect(
        useSshStore.getState().sessions.find((item) => item.id === session.sessionId)
          ?.state,
      ).toBe(state);
    },
  );

  it("seeds HOME when no OSC cwd has arrived first", async () => {
    const session = await connectSession();
    await finishProbe(probeFor(session.rustSessionId), probeResult("/home/user"));
    expect(currentPath(session.sessionId)).toBe("/home/user");
  });

  it.each([
    ["rejection", () => rejectedProbe()],
    ["nonzero exit", () => probeResult("/home/user", { exitCode: 1 })],
  ] as const)("falls back to / when HOME probe has no OSC cwd and ends with %s", async (_outcome, outcome) => {
    const session = await connectSession();
    const probe = probeFor(session.rustSessionId);
    const result = outcome();
    if (result instanceof Error) {
      await act(async () => {
        probe.reject(result);
        await probe.promise.catch(() => {});
      });
    } else {
      await finishProbe(probe, result);
    }
    expect(currentPath(session.sessionId)).toBe("/");
  });

  it("does not let a disconnected session's late HOME probe write into its replacement", async () => {
    const oldSession = await connectSession();
    const oldProbe = probeFor(oldSession.rustSessionId);
    await useSshStore.getState().disconnect(oldSession.sessionId);
    const newSession = await connectSession();
    const newProbe = probeFor(newSession.rustSessionId);
    act(() => useSshStore.getState().setCurrentPath(newSession.sessionId, "/srv/new"));

    await finishProbe(oldProbe, probeResult("/old/home"));
    expect(currentPath(oldSession.sessionId)).toBeUndefined();
    expect(currentPath(newSession.sessionId)).toBe("/srv/new");
    await finishProbe(newProbe, probeResult("/new/home"));
    expect(currentPath(oldSession.sessionId)).toBeUndefined();
    expect(currentPath(newSession.sessionId)).toBe("/srv/new");
  });

  it("keeps cwd values isolated between two live sessions whose probes finish out of order", async () => {
    const first = await connectSession();
    const second = await connectSession();
    const firstProbe = probeFor(first.rustSessionId);
    const secondProbe = probeFor(second.rustSessionId);
    act(() => {
      useSshStore.getState().setCurrentPath(first.sessionId, "/srv/first");
      useSshStore.getState().setCurrentPath(second.sessionId, "/srv/second");
    });

    await finishProbe(secondProbe, probeResult("/home/second"));
    await finishProbe(firstProbe, probeResult("/home/first"));
    expect(currentPath(first.sessionId)).toBe("/srv/first");
    expect(currentPath(second.sessionId)).toBe("/srv/second");
  });
});
