import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sshConnect: vi.fn(), sshCommand: vi.fn() }));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-bridge")>();
  return {
    ...actual,
    sshConnect: mocks.sshConnect,
    sshCommand: mocks.sshCommand,
  };
});

vi.mock("@/lib/param-complete-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/param-complete-client")>();
  return {
    ...actual,
    fetchRemoteOsInfo: vi.fn().mockResolvedValue(null),
    fetchRemoteCommands: vi.fn().mockResolvedValue([]),
  };
});

import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useSshLeafTransport } from "./useSshLeafTransport";

const diagnosticKey = "__TDSF_OSC7_LOG__";
const transportCleanups: Array<() => void> = [];

function setDiagnosticLog(value: unknown) {
  Reflect.set(window, diagnosticKey, value);
}

function clearDiagnosticLog() {
  Reflect.deleteProperty(window, diagnosticKey);
}

function makeHandle(write = vi.fn().mockResolvedValue("written")) {
  return { id: 31, write, resize: vi.fn(), close: vi.fn() };
}

function setSession(handle: ReturnType<typeof makeHandle> | null) {
  useSshStore.setState({
    sessions: [
      {
        id: "session-a",
        rustSessionId: 31,
        params: {
          host: "example.invalid",
          port: 22,
          user: "test",
          cols: 80,
          rows: 24,
          term: "xterm",
        },
        state: "connected",
        connectedAt: Date.now(),
        handle,
      },
    ],
  });
}

afterEach(() => {
  cleanup();
  for (const cleanup of transportCleanups.splice(0)) cleanup();
  clearDiagnosticLog();
  useSshStore.setState({
    sessions: [],
    activeSessionId: null,
    currentPathBySession: {},
  });
  vi.clearAllMocks();
});

describe("useSshLeafTransport privacy and byte forwarding", () => {
  it("does not create a diagnostic buffer for discarded input", async () => {
    clearDiagnosticLog();
    setSession(null);
    const { result } = renderHook(() => useSshLeafTransport("session-a"));
    const transport = await result.current.openTransport({
      onData: vi.fn(),
      onExit: vi.fn(),
    });
    transportCleanups.push(() => transport.close());

    for (let i = 0; i < 100; i++) {
      expect(transport.write("\u4f60\u597d\r\u0003")).toBeUndefined();
    }
    expect(Reflect.has(window, diagnosticKey)).toBe(false);
  });

  it("does not log repeated writes without a handle and forwards them once a handle exists", async () => {
    const diagnostic: unknown[] = [];
    setDiagnosticLog(diagnostic);
    setSession(null);
    const { result, rerender } = renderHook(() =>
      useSshLeafTransport("session-a"),
    );
    let transport!: Awaited<ReturnType<typeof result.current.openTransport>>;
    await act(async () => {
      transport = await result.current.openTransport({
        onData: vi.fn(),
        onExit: vi.fn(),
      });
    });
    transportCleanups.push(() => transport.close());

    const input =
      "echo '\u4f60\u597d'\r\n\u0003\u001b[31m\u7ea2\u8272\u001b[0m";
    transport.write(input);
    transport.write(input);

    const writePromise = Promise.resolve("written");
    const write = vi.fn().mockReturnValue(writePromise);
    act(() => setSession(makeHandle(write)));
    act(() => rerender());
    const returned = transport.write(input);
    expect(returned).toBe(writePromise);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(input);
    expect(diagnostic).toEqual([]);
  });

  it("uses the updated handle, unsubscribes on close without closing the shared handle, and forwards the same bytes", async () => {
    const bytes = new Uint8Array([0, 0x1b, 0x9b, 0xff]);
    let sshOnData: ((value: Uint8Array) => void) | undefined;
    const originalHandle = makeHandle();
    mocks.sshConnect.mockImplementation(async (_params, callbacks) => {
      sshOnData = callbacks.onData;
      return originalHandle;
    });
    mocks.sshCommand.mockResolvedValue({
      ok: false,
      output: "",
      stderr: "",
      exitCode: 1,
      duration: 0,
    });
    await act(async () => {
      await useSshStore.getState().connect({
        host: "example.invalid",
        port: 22,
        user: "test",
        auth: { type: "password", password: "test" },
        cols: 80,
        rows: 24,
        term: "xterm",
      });
    });
    const sessionId = useSshStore.getState().sessions[0]!.id;
    const { result, rerender } = renderHook(() =>
      useSshLeafTransport(sessionId),
    );
    let transport!: Awaited<ReturnType<typeof result.current.openTransport>>;
    const received = vi.fn();
    await act(async () => {
      transport = await result.current.openTransport({
        onData: received,
        onExit: vi.fn(),
      });
    });
    transportCleanups.push(() => transport.close());

    const replacementHandle = makeHandle();
    act(() => {
      useSshStore.setState((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === sessionId
            ? { ...session, handle: replacementHandle }
            : session,
        ),
      }));
    });
    act(() => rerender());
    const input = "pwd\r";
    transport.write(input);
    expect(replacementHandle.write).toHaveBeenCalledTimes(1);
    expect(replacementHandle.write).toHaveBeenCalledWith(input);
    expect(originalHandle.write).not.toHaveBeenCalled();

    sshOnData?.(bytes);
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(bytes);

    transport.close();
    sshOnData?.(bytes);
    expect(received).toHaveBeenCalledTimes(1);
    expect(originalHandle.close).not.toHaveBeenCalled();
    expect(replacementHandle.close).not.toHaveBeenCalled();
  });
});
