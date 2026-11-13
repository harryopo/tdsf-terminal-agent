import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: null as null | Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class<T> {
    onmessage: ((message: T) => void) | null = null;
  },
}));

import type {
  SshConnectParams,
  SshHandlers,
  SshSession,
  SshStatusEvent,
} from "./ssh-bridge";
import { sshConnect } from "./ssh-bridge";

type FakeChannel<T> = {
  onmessage: ((message: T) => void) | null;
};

type ConnectChannels = {
  onData: FakeChannel<ArrayBuffer>;
  onStatus: FakeChannel<SshStatusEvent>;
  onExit: FakeChannel<number>;
};

const params: SshConnectParams = {
  host: "example.invalid",
  port: 22,
  user: "tester",
  auth: { type: "password", password: "synthetic-test-secret" },
  cols: 80,
  rows: 24,
  term: "xterm-256color",
};

const reconnectingEvent: SshStatusEvent = {
  state: "reconnecting",
  host: params.host,
  port: 22,
  user: params.user,
  timestamp: 2,
};

function connectChannels(): ConnectChannels {
  expect(mocks.channels).not.toBeNull();
  return mocks.channels as ConnectChannels;
}

function emitData(channels: ConnectChannels) {
  channels.onData.onmessage?.(new Uint8Array([65, 66]).buffer);
}

function emitStatus(channels: ConnectChannels, event = reconnectingEvent) {
  channels.onStatus.onmessage?.(event);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channels = null;
  mocks.invoke.mockImplementation((command: string, args: unknown) => {
    if (command === "ssh_connect") {
      mocks.channels = args as Record<string, unknown>;
      return Promise.resolve(701);
    }
    return Promise.resolve(undefined);
  });
});

describe("ssh bridge reconnect lifecycle", () => {
  it("keeps data, status, and exit channels alive after an unknown exit", async () => {
    const handlers: SshHandlers = {
      onData: vi.fn(),
      onStatus: vi.fn(),
      onExit: vi.fn(),
    };
    await sshConnect(params, handlers);
    const channels = connectChannels();

    channels.onExit.onmessage?.(-1);
    emitData(channels);
    emitStatus(channels);
    channels.onExit.onmessage?.(-1);

    expect(handlers.onData).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(handlers.onStatus).toHaveBeenCalledWith(reconnectingEvent);
    expect(handlers.onExit).toHaveBeenNthCalledWith(1, -1);
    expect(handlers.onExit).toHaveBeenNthCalledWith(2, -1);
  });

  it.each([0, 7])(
    "releases callbacks after known exit code %i",
    async (code) => {
      const handlers: SshHandlers = {
        onData: vi.fn(),
        onStatus: vi.fn(),
        onExit: vi.fn(),
      };
      await sshConnect(params, handlers);
      const channels = connectChannels();

      channels.onExit.onmessage?.(code);
      emitData(channels);
      emitStatus(channels);

      expect(handlers.onExit).toHaveBeenCalledOnce();
      expect(handlers.onExit).toHaveBeenCalledWith(code);
      expect(handlers.onData).not.toHaveBeenCalled();
      expect(handlers.onStatus).not.toHaveBeenCalled();
    },
  );

  it("releases reconnect callbacks once an explicit close calls ssh_disconnect", async () => {
    const handlers: SshHandlers = {
      onData: vi.fn(),
      onStatus: vi.fn(),
      onExit: vi.fn(),
    };
    const session: SshSession = await sshConnect(params, handlers);
    const channels = connectChannels();
    emitStatus(channels);
    expect(handlers.onStatus).toHaveBeenCalledWith(reconnectingEvent);

    await session.close();
    await session.close();

    expect(mocks.invoke).toHaveBeenCalledWith("ssh_disconnect", {
      sessionId: 701,
    });
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "ssh_disconnect",
      ),
    ).toHaveLength(1);
    emitData(channels);
    emitStatus(channels);
    channels.onExit.onmessage?.(-1);
    expect(handlers.onData).not.toHaveBeenCalled();
    expect(handlers.onStatus).toHaveBeenCalledOnce();
    expect(handlers.onExit).not.toHaveBeenCalled();
  });
});
