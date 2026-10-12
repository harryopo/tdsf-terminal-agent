import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  windowLabel: "main",
}));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-bridge")>();
  return { ...actual, sshSessionsDetail: mocks.detail };
});

vi.mock("@tauri-apps/api/webviewWindow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tauri-apps/api/webviewWindow")>();
  return {
    ...actual,
    getCurrentWebviewWindow: () => ({ label: mocks.windowLabel }),
  };
});

import type { SshSessionDetail, SshSessionStateValue } from "@/lib/ssh-bridge";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useSshLeafTransport } from "./useSshLeafTransport";

const params = {
  host: "example.invalid",
  port: 2222,
  user: "alice",
  cols: 80,
  rows: 24,
  term: "xterm",
};
const transportCleanups: Array<() => void> = [];

function makeHandle(id = 31) {
  return { id, write: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), close: vi.fn() };
}

function setSession(options: {
  handle?: ReturnType<typeof makeHandle> | null;
  rustSessionId?: number | null;
  state?: SshSessionStateValue;
  params?: typeof params;
} = {}) {
  const handle = options.handle === undefined ? makeHandle() : options.handle;
  useSshStore.setState({
    sessions: [{
      id: "session-a",
      rustSessionId: options.rustSessionId === undefined ? 31 : options.rustSessionId,
      params: options.params ?? params,
      state: options.state ?? "connected",
      connectedAt: Date.now(),
      handle,
    }],
  });
  return handle;
}

function detail(overrides: Partial<SshSessionDetail> = {}): SshSessionDetail {
  return {
    sessionId: 31,
    host: params.host,
    port: params.port,
    user: params.user,
    state: "connected",
    ownerWindow: "main",
    terminalContext: { connectionId: "a".repeat(32), bashHooksPath: "/tmp/hooks" },
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  for (const close of transportCleanups.splice(0)) close();
  useSshStore.setState({ sessions: [], activeSessionId: null, currentPathBySession: {} });
  mocks.detail.mockReset();
  mocks.windowLabel = "main";
});

describe("useSshLeafTransport integration context lifecycle", () => {
  it("delivers matching metadata asynchronously without delaying writes", async () => {
    let resolveDetail!: (rows: SshSessionDetail[]) => void;
    mocks.detail.mockReturnValue(new Promise((resolve) => { resolveDetail = resolve; }));
    const handle = setSession();
    if (!handle) throw new Error("connected fixture must have a handle");
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    let transport!: Awaited<ReturnType<typeof result.current.openTransport>>;
    await act(async () => {
      transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    });
    transportCleanups.push(() => transport.close());
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(onContext).toHaveBeenLastCalledWith(null);
    const input = "printf '\u4f60\u597d'\r";
    expect(transport.write(input)).toBeInstanceOf(Promise);
    expect(handle.write).toHaveBeenCalledWith(input);
    await act(async () => { resolveDetail([detail()]); await Promise.resolve(); });
    expect(onContext).toHaveBeenLastCalledWith({ connectionId: "a".repeat(32), bashHooksPath: "/tmp/hooks" });
  });

  it("does not query for a disconnected session and reports null", async () => {
    setSession({ state: "closed", rustSessionId: null, handle: null });
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(onContext).toHaveBeenCalledWith(null);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong rust id", () => detail({ sessionId: 99 })],
    ["wrong host", () => detail({ host: "other.invalid" })],
    ["wrong port", () => detail({ port: 22 })],
    ["wrong user", () => detail({ user: "bob" })],
    ["wrong owner", () => detail({ ownerWindow: "other-window" })],
  ] as const)("rejects %s metadata and does not retry", async (_name, makeDetail) => {
    setSession();
    mocks.detail.mockResolvedValue([makeDetail()]);
    const onContext = vi.fn();
    const { result, rerender } = renderHook(() => useSshLeafTransport("session-a"));
    let transport!: Awaited<ReturnType<typeof result.current.openTransport>>;
    await act(async () => {
      transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    });
    transportCleanups.push(() => transport.close());
    await flush();
    expect(onContext).toHaveBeenLastCalledWith(null);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    rerender();
    await flush();
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    transport.close();
  });

  it("keeps context null and does not retry when the metadata request rejects", async () => {
    setSession();
    mocks.detail.mockRejectedValue(new Error("metadata unavailable"));
    const onContext = vi.fn();
    const { result, rerender } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();
    expect(onContext).toHaveBeenLastCalledWith(null);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    rerender();
    await flush();
    expect(onContext).toHaveBeenLastCalledWith(null);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
  });

  it("clears context on store disconnect and accepts a new connection generation", async () => {
    setSession();
    mocks.detail.mockResolvedValue([detail()]);
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();
    expect(onContext).toHaveBeenCalledWith({ connectionId: "a".repeat(32), bashHooksPath: "/tmp/hooks" });
    act(() => setSession({ state: "closed", rustSessionId: null, handle: null }));
    expect(onContext).toHaveBeenLastCalledWith(null);
    mocks.detail.mockResolvedValue([detail({ terminalContext: { connectionId: "b".repeat(32), bashHooksPath: null } })]);
    act(() => setSession({ handle: makeHandle() }));
    await flush();
    expect(onContext).toHaveBeenLastCalledWith({ connectionId: "b".repeat(32), bashHooksPath: null });
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    transport.close();
  });

  it("requeries when the connected handle changes even if its Rust id stays the same", async () => {
    setSession();
    mocks.detail.mockResolvedValue([detail()]);
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();
    expect(onContext).toHaveBeenLastCalledWith({ connectionId: "a".repeat(32), bashHooksPath: "/tmp/hooks" });
    mocks.detail.mockResolvedValue([detail({ terminalContext: { connectionId: "c".repeat(32), bashHooksPath: null } })]);
    act(() => setSession({ handle: makeHandle() }));
    await flush();
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    expect(onContext).toHaveBeenLastCalledWith({ connectionId: "c".repeat(32), bashHooksPath: null });
    transport.close();
  });

  it("ignores an older query after a connection boundary changes", async () => {
    let resolveOld!: (rows: SshSessionDetail[]) => void;
    setSession();
    mocks.detail.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    let transport!: Awaited<ReturnType<typeof result.current.openTransport>>;
    await act(async () => {
      transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    });
    transportCleanups.push(() => transport.close());
    mocks.detail.mockResolvedValue([detail({ terminalContext: { connectionId: "b".repeat(32), bashHooksPath: null } })]);
    act(() => setSession({ handle: makeHandle() }));
    await flush();
    const accepted = onContext.mock.calls.length;
    await act(async () => { resolveOld([detail()]); await Promise.resolve(); });
    expect(onContext).toHaveBeenCalledTimes(accepted);
    expect(onContext).toHaveBeenLastCalledWith({ connectionId: "b".repeat(32), bashHooksPath: null });
  });

  it("does not query when the connected handle id differs from the store Rust id", async () => {
    setSession({ rustSessionId: 31, handle: makeHandle(32) });
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    expect(onContext).toHaveBeenCalledWith(null);
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("invalidates a pending query on close and never closes the shared handle", async () => {
    let resolveDetail!: (rows: SshSessionDetail[]) => void;
    mocks.detail.mockReturnValue(new Promise((resolve) => { resolveDetail = resolve; }));
    const handle = setSession();
    if (!handle) throw new Error("connected fixture must have a handle");
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    transport.close();
    await act(async () => { resolveDetail([detail()]); await Promise.resolve(); });
    expect(onContext).toHaveBeenLastCalledWith(null);
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(handle.close).not.toHaveBeenCalled();
  });

  it("does not fetch metadata for legacy callers without the optional callback", async () => {
    setSession();
    mocks.detail.mockResolvedValue([detail()]);
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn() });
    transportCleanups.push(() => transport.close());
    await flush();
    expect(mocks.detail).not.toHaveBeenCalled();
  });
});
