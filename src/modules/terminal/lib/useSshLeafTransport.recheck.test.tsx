import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ detail: vi.fn(), windowLabel: "main" }));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh-bridge")>()),
  sshSessionsDetail: mocks.detail,
}));
vi.mock("@tauri-apps/api/webviewWindow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/webviewWindow")>()),
  getCurrentWebviewWindow: () => ({ label: mocks.windowLabel }),
}));

import type { SshSessionDetail } from "@/lib/ssh-bridge";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useSshLeafTransport } from "./useSshLeafTransport";

const params = { host: "example.invalid", port: 2222, user: "alice", cols: 80, rows: 24, term: "xterm" };
const transportCleanups: Array<() => void> = [];

function detail(overrides: Partial<SshSessionDetail> = {}): SshSessionDetail {
  return {
    sessionId: 31, host: params.host, port: params.port, user: params.user,
    state: "connected", ownerWindow: "main",
    terminalContext: { connectionId: "a".repeat(32), bashHooksPath: "/tmp/hooks" },
    ...overrides,
  };
}

function setSession() {
  const handle = { id: 31, write: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), close: vi.fn() };
  useSshStore.setState({ sessions: [{ id: "session-a", rustSessionId: 31, params, state: "connected", connectedAt: 1, handle }] });
  return handle;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  for (const close of transportCleanups.splice(0)) close();
  useSshStore.setState({ sessions: [], activeSessionId: null, currentPathBySession: {} });
  mocks.detail.mockReset();
  mocks.windowLabel = "main";
});

describe("SSH transport manual metadata recheck", () => {
  it("rechecks after the initial metadata request fails without writing to the terminal", async () => {
    const handle = setSession();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();
    expect(onContext).toHaveBeenLastCalledWith(null);

    mocks.detail.mockResolvedValueOnce([detail()]);
    await act(async () => { await transport.refreshIntegrationContext!(); });

    expect(onContext).toHaveBeenLastCalledWith(detail().terminalContext);
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    expect(handle.write).not.toHaveBeenCalled();
  });

  it("rejects a result if the current window owner changes while metadata is pending", async () => {
    setSession();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();

    let resolveRows!: (rows: SshSessionDetail[]) => void;
    mocks.detail.mockReturnValueOnce(new Promise((resolve) => { resolveRows = resolve; }));
    const refresh = transport.refreshIntegrationContext!();
    await flush();
    mocks.windowLabel = "different-window";
    await act(async () => { resolveRows([detail()]); await refresh; });

    expect(onContext).toHaveBeenLastCalledWith(null);
  });

  it("keeps the newest result when two manual metadata requests resolve out of order", async () => {
    setSession();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();

    const first = deferred<SshSessionDetail[]>();
    const second = deferred<SshSessionDetail[]>();
    mocks.detail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const older = transport.refreshIntegrationContext!();
    await flush();
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    const newer = transport.refreshIntegrationContext!();
    await flush();
    expect(mocks.detail).toHaveBeenCalledTimes(3);

    const newestContext = { connectionId: "b".repeat(32), bashHooksPath: null };
    await act(async () => { second.resolve([detail({ terminalContext: newestContext })]); await newer; });
    await act(async () => { first.resolve([detail()]); await older; });
    expect(onContext).toHaveBeenLastCalledWith(newestContext);
    expect(onContext).not.toHaveBeenCalledWith(detail().terminalContext);
  });

  it.each([
    ["wrong host", () => mocks.detail.mockResolvedValueOnce([detail({ host: "other.invalid" })])],
    ["rejected RPC", () => mocks.detail.mockRejectedValueOnce(new Error("C:/private/raw-rpc-detail"))],
  ])("keeps metadata null after a manual %s", async (_name, prepareResponse) => {
    setSession();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    transportCleanups.push(() => transport.close());
    await flush();
    prepareResponse();

    await act(async () => { await transport.refreshIntegrationContext!(); });
    expect(onContext).toHaveBeenLastCalledWith(null);
    expect(onContext.mock.calls.flat().join(" ")).not.toContain("private/raw-rpc-detail");
  });

  it("does not query or emit after the transport has closed", async () => {
    const handle = setSession();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    const onContext = vi.fn();
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({ onData: vi.fn(), onExit: vi.fn(), onIntegrationContext: onContext });
    await flush();
    const calls = onContext.mock.calls.length;
    transport.close();

    await transport.refreshIntegrationContext!();
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    expect(onContext).toHaveBeenCalledTimes(calls);
    expect(handle.write).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
  });
});
