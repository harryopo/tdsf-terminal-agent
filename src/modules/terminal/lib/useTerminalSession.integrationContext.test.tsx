import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openPty: vi.fn() }));
vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/risk-engine/riskClient", () => ({ evaluateRisk: vi.fn(), evaluateRiskSync: vi.fn(), maxRiskLevel: vi.fn((_a, b) => b) }));
vi.mock("@/modules/settings/preferences", () => {
  const state = { zoomLevel: 1, terminalLetterSpacing: 0, terminalScrollback: 1000, terminalWebglEnabled: false, terminalCursorBlink: false, backgroundKind: "solid", backgroundImageId: null, terminalShell: "" };
  return { usePreferencesStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock("@/modules/spaces", () => ({ useSpaces: { getState: () => ({ spaces: [], activeId: null }) } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./outputHighlight", () => ({ registerOutputHighlight: vi.fn(() => () => {}) }));
vi.mock("../block/lib/blockDecorations", () => ({ BlockDecorations: class {} }));
vi.mock("./terminalBlocks", () => ({ TerminalBlockCollector: class {}, captureBlockOutputWithMeta: vi.fn(), registerBlockOscHandlers: vi.fn(() => () => {}) }));
vi.mock("./terminalBlocksStore", () => ({ useTerminalBlocksStore: { getState: () => ({ clearLeaf: vi.fn(), resolveAuthor: vi.fn(), noteExecStarted: vi.fn(), pushBlock: vi.fn() }) } }));
vi.mock("./osc-handlers", () => ({ createShellIntegrationState: vi.fn(() => ({})), registerCwdHandler: vi.fn(() => ({ dispose: vi.fn() })), registerOsc52ClipboardHandler: vi.fn(() => vi.fn()), registerPromptTracker: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock("./pty-bridge", () => ({ openPty: mocks.openPty }));
vi.mock("./completionInjection", () => ({ clearLeafEnvironment: vi.fn(), setLeafEnvironment: vi.fn() }));
vi.mock("@/lib/param-complete-client", () => ({ setLeafCwd: vi.fn() }));
vi.mock("./agentActivity", () => ({ ensureAgentActivityListener: vi.fn(), isAgentActivePty: vi.fn(() => false) }));
vi.mock("./rendererPool", () => {
  const noop = vi.fn();
  return { acquireSlot: noop, applyBackgroundActive: noop, applyCursorBlink: noop, applyLetterSpacing: noop, applyTheme: noop, applyScrollback: noop, applyTerminalFont: noop, applyWebglPreference: noop, configureRendererPool: noop, discardRetainedSlot: noop, disposeLeafSlot: noop, focusSlot: noop, getLiveSlotForLeaf: () => null, getSlotForLeaf: () => null, isLeafAltScreen: () => false, parkLeafSlot: noop, poolSize: () => 0, poolSlotStats: () => [], refreshLeafSlot: noop, releaseSlot: () => null, setSlotFocused: noop };
});
vi.mock("./useTerminalFont", () => ({ useTerminalFont: () => ({ fontFamily: "monospace", fontWeight: "400", fontSize: 14 }) }));

import { disposeSession, getSshIntegrationContext, subscribeSshIntegrationContext, refreshSshIntegrationContext, terminalDebugStats, useTerminalSession } from "./useTerminalSession";
import type { TerminalTransport, TerminalTransportHandlers } from "./pty-bridge";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { SshIntegrationBadge } from "@/modules/ssh-explorer/SshIntegrationBadge";

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeTransport() {
  let handlers!: TerminalTransportHandlers;
  let context: { connectionId: string; bashHooksPath: string | null } | null = null;
  const refreshIntegrationContext = vi.fn(async () => {
    handlers.onIntegrationContext?.(context);
  });
  const transport = {
    id: "remote-a", write: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), close: vi.fn(), refreshIntegrationContext,
  } as TerminalTransport & { refreshIntegrationContext: () => Promise<void>; write: ReturnType<typeof vi.fn> };
  const openTransport = vi.fn(async (next: TerminalTransportHandlers) => { handlers = next; return transport; });
  return {
    transport, openTransport, refreshIntegrationContext,
    publish(next: typeof context) { context = next; handlers.onIntegrationContext?.(next); },
  };
}

beforeEach(() => Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } }));
afterEach(() => {
  cleanup();
  for (const { leafId } of terminalDebugStats().sessions) disposeSession(leafId);
  useSshStore.setState({ sessions: [], activeSessionId: null, currentPathBySession: {} });
  mocks.openPty.mockReset();
  if (originalFontsDescriptor) Object.defineProperty(document, "fonts", originalFontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
});

describe("terminal session SSH integration context", () => {
  it("publishes actual transport context changes, unsubscribes, and delegates refresh to that leaf", async () => {
    const leafId = 94001;
    const fixture = makeTransport();
    const hook = renderHook(() => useTerminalSession({ leafId, container: { current: document.createElement("div") }, visible: false, transportKey: "session-a", openTransport: fixture.openTransport, remote: true }));
    await waitFor(() => expect(fixture.openTransport).toHaveBeenCalledTimes(1));
    const listener = vi.fn();
    const unsubscribe = subscribeSshIntegrationContext(leafId, listener);

    act(() => fixture.publish({ connectionId: "b".repeat(32), bashHooksPath: "/tmp/hooks" }));
    expect(getSshIntegrationContext(leafId)).toEqual({ connectionId: "b".repeat(32), bashHooksPath: "/tmp/hooks" });
    expect(listener).toHaveBeenCalled();
    await act(async () => { await refreshSshIntegrationContext(leafId); });
    expect(fixture.refreshIntegrationContext).toHaveBeenCalledTimes(1);

    useSshStore.setState({ sessions: [{
      id: "session-a", rustSessionId: 31,
      params: { host: "example.invalid", port: 22, user: "alice", cols: 80, rows: 24, term: "xterm" },
      state: "connected", connectedAt: 1,
      handle: { id: 31, write: vi.fn(), resize: vi.fn(), close: vi.fn() },
    }] });
    render(<SshIntegrationBadge leafId={leafId} sessionId="session-a" active />);
    fireEvent.click(screen.getByRole("button", { name: "恢复目录跟随" }));
    let finishRefresh!: () => void;
    fixture.refreshIntegrationContext.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    act(() => fixture.publish({ connectionId: "d".repeat(32), bashHooksPath: "/tmp/live-hooks" }));
    expect(screen.queryByText("/tmp/live-hooks")).toBeNull();
    await act(async () => { finishRefresh(); });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByRole("button", { name: "已登录，恢复目录跟随" }) as HTMLButtonElement).disabled).toBe(false);

    unsubscribe();
    listener.mockClear();
    act(() => fixture.publish({ connectionId: "c".repeat(32), bashHooksPath: null }));
    expect(listener).not.toHaveBeenCalled();
    expect(getSshIntegrationContext(leafId)?.connectionId).toBe("c".repeat(32));
    hook.unmount();
    const retiredListener = vi.fn();
    const unsubscribeRetired = subscribeSshIntegrationContext(leafId, retiredListener);
    act(() => disposeSession(leafId));
    expect(retiredListener).toHaveBeenCalled();
    expect(await refreshSshIntegrationContext(leafId)).toBeNull();
    unsubscribeRetired();
  });

  it("rejects the old leaf refresh after its transport key changes without touching the shared SSH handle", async () => {
    const leafId = 94002;
    const sharedHandle = { id: 31, write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    useSshStore.setState({ sessions: [{
      id: "session-a", rustSessionId: 31,
      params: { host: "example.invalid", port: 22, user: "alice", cols: 80, rows: 24, term: "xterm" },
      state: "connected", connectedAt: 1, handle: sharedHandle,
    }] });
    const old = makeTransport();
    const current = makeTransport();
    const pendingOldRefresh = deferred<void>();
    const container = { current: document.createElement("div") };
    const hook = renderHook((transportKey: string) => useTerminalSession({
      leafId, container, visible: false, transportKey,
      openTransport: transportKey === "old" ? old.openTransport : current.openTransport,
      remote: true,
    }), { initialProps: "old" });
    await waitFor(() => expect(old.openTransport).toHaveBeenCalledTimes(1));
    old.refreshIntegrationContext.mockImplementationOnce(() => pendingOldRefresh.promise);

    let refreshResult!: Promise<unknown>;
    act(() => { refreshResult = refreshSshIntegrationContext(leafId); });
    hook.rerender("current");
    await waitFor(() => expect(current.openTransport).toHaveBeenCalledTimes(1));
    const currentContext = { connectionId: "f".repeat(32), bashHooksPath: "/tmp/current.hooks" };
    act(() => current.publish(currentContext));
    old.publish({ connectionId: "a".repeat(32), bashHooksPath: "/tmp/old.hooks" });
    await act(async () => { pendingOldRefresh.resolve(); await refreshResult; });

    expect(getSshIntegrationContext(leafId)).toEqual(currentContext);
    expect(await refreshResult).toBeNull();
    expect(old.transport.close).toHaveBeenCalledTimes(1);
    expect(sharedHandle.write).not.toHaveBeenCalled();
    expect(sharedHandle.close).not.toHaveBeenCalled();
  });
});
