import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sshConnect: vi.fn(),
  sshCommand: vi.fn(),
  fetchRemoteCommands: vi.fn(),
  fetchRemoteOsInfo: vi.fn(),
  remoteCarapaceInstalled: vi.fn(),
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
  remoteCarapaceInstalled: mocks.remoteCarapaceInstalled,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: () => ({ sshRemoteCarapacePrompt: false }) },
}));

import type {
  SshCommandResult,
  SshConnectParams,
  SshHandlers,
  SshSession,
  SshStatusEvent,
} from "@/lib/ssh-bridge";
import { useSshStore } from "./sshStore";

const params: SshConnectParams = {
  host: "example.invalid",
  port: 22,
  user: "tester",
  auth: { type: "password", password: "synthetic-test-secret" },
  cols: 80,
  rows: 24,
  term: "xterm-256color",
};

const connectedEvent: SshStatusEvent = {
  state: "connected",
  host: params.host,
  port: 22,
  user: params.user,
  timestamp: 1,
};

let handlers: SshHandlers[];
let handles: SshSession[];
let nextRustSessionId: number;

async function connectSession() {
  const sessionId = await useSshStore.getState().connect(params);
  expect(sessionId).toBeTruthy();
  const session = useSshStore
    .getState()
    .sessions.find((item) => item.id === sessionId);
  const handler = handlers.at(-1)!;
  const handle = handles.at(-1)!;
  act(() => handler.onStatus?.(connectedEvent));
  return { sessionId: sessionId!, handler, handle, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers = [];
  handles = [];
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
      const handle: SshSession = {
        id: nextRustSessionId++,
        write: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      handles.push(handle);
      return handle;
    },
  );
  mocks.sshCommand.mockResolvedValue({
    ok: false,
    output: "",
    stderr: "",
    exitCode: 1,
    duration: 0,
  } satisfies SshCommandResult);
  mocks.fetchRemoteCommands.mockResolvedValue(undefined);
  mocks.fetchRemoteOsInfo.mockResolvedValue(null);
  mocks.remoteCarapaceInstalled.mockResolvedValue(false);
});

describe("sshStore reconnect lifecycle", () => {
  it("keeps an unknown exit connected and accepts reconnecting then connected on the same handle", async () => {
    const session = await connectSession();

    act(() => session.handler.onExit?.(-1));

    expect(session.handle.close).not.toHaveBeenCalled();
    expect(
      useSshStore
        .getState()
        .sessions.find((item) => item.id === session.sessionId),
    ).toMatchObject({ state: "connected", handle: session.handle });

    act(() =>
      session.handler.onStatus?.({ ...connectedEvent, state: "reconnecting" }),
    );
    expect(
      useSshStore
        .getState()
        .sessions.find((item) => item.id === session.sessionId)?.state,
    ).toBe("reconnecting");

    act(() => session.handler.onStatus?.(connectedEvent));
    expect(
      useSshStore
        .getState()
        .sessions.find((item) => item.id === session.sessionId),
    ).toMatchObject({ state: "connected", handle: session.handle });
  });

  it.each([0, 7])(
    "closes and marks the session closed for known exit %i",
    async (code) => {
      const session = await connectSession();

      act(() => session.handler.onExit?.(code));

      expect(session.handle.close).toHaveBeenCalledOnce();
      expect(
        useSshStore
          .getState()
          .sessions.find((item) => item.id === session.sessionId)?.state,
      ).toBe("closed");
    },
  );

  it("ignores a late unknown exit after disconnect without touching another live session", async () => {
    const disconnected = await connectSession();
    const remaining = await connectSession();
    await useSshStore.getState().disconnect(disconnected.sessionId);
    expect(disconnected.handle.close).toHaveBeenCalledOnce();

    act(() => disconnected.handler.onExit?.(-1));

    expect(disconnected.handle.close).toHaveBeenCalledOnce();
    expect(
      useSshStore
        .getState()
        .sessions.find((item) => item.id === disconnected.sessionId),
    ).toBeUndefined();
    expect(
      useSshStore
        .getState()
        .sessions.find((item) => item.id === remaining.sessionId),
    ).toMatchObject({ state: "connected", handle: remaining.handle });
  });
});
