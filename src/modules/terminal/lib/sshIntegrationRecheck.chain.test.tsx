import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ detail: vi.fn(), windowLabel: "main" }));
vi.mock("@/lib/ssh-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ssh-bridge")>()),
  sshSessionsDetail: mocks.detail,
}));
vi.mock("@tauri-apps/api/webviewWindow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/webviewWindow")>()),
  getCurrentWebviewWindow: () => ({ label: mocks.windowLabel }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/risk-engine/riskClient", () => ({ evaluateRisk: vi.fn(), evaluateRiskSync: vi.fn(), maxRiskLevel: vi.fn((_a, b) => b) }));
vi.mock("@/modules/settings/preferences", () => {
  const state = { zoomLevel: 1, terminalLetterSpacing: 0, terminalScrollback: 1000, terminalWebglEnabled: false, terminalCursorBlink: false, backgroundKind: "solid", backgroundImageId: null, terminalShell: "" };
  return { usePreferencesStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock("@/modules/spaces", () => ({ useSpaces: { getState: () => ({ spaces: [], activeId: null }) } }));
vi.mock("./outputHighlight", () => ({ registerOutputHighlight: vi.fn(() => () => {}) }));
vi.mock("../block/lib/blockDecorations", () => ({ BlockDecorations: class {} }));
vi.mock("./terminalBlocks", () => ({ TerminalBlockCollector: class {}, captureBlockOutputWithMeta: vi.fn(), registerBlockOscHandlers: vi.fn(() => () => {}) }));
vi.mock("./terminalBlocksStore", () => ({ useTerminalBlocksStore: { getState: () => ({ clearLeaf: vi.fn(), resolveAuthor: vi.fn(), noteExecStarted: vi.fn(), pushBlock: vi.fn() }) } }));
vi.mock("./osc-handlers", () => ({ createShellIntegrationState: vi.fn(() => ({})), registerCwdHandler: vi.fn(() => ({ dispose: vi.fn() })), registerOsc52ClipboardHandler: vi.fn(() => vi.fn()), registerPromptTracker: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock("./completionInjection", () => ({ clearLeafEnvironment: vi.fn(), setLeafEnvironment: vi.fn() }));
vi.mock("@/lib/param-complete-client", () => ({ setLeafCwd: vi.fn() }));
vi.mock("./agentActivity", () => ({ ensureAgentActivityListener: vi.fn(), isAgentActivePty: vi.fn(() => false) }));
vi.mock("./rendererPool", () => {
  const noop = vi.fn();
  return { acquireSlot: noop, applyBackgroundActive: noop, applyCursorBlink: noop, applyLetterSpacing: noop, applyTheme: noop, applyScrollback: noop, applyTerminalFont: noop, applyWebglPreference: noop, configureRendererPool: noop, discardRetainedSlot: noop, disposeLeafSlot: noop, focusSlot: noop, getLiveSlotForLeaf: () => null, getSlotForLeaf: () => null, isLeafAltScreen: () => false, parkLeafSlot: noop, poolSize: () => 0, poolSlotStats: () => [], refreshLeafSlot: noop, releaseSlot: () => null, setSlotFocused: noop };
});
vi.mock("./useTerminalFont", () => ({ useTerminalFont: () => ({ fontFamily: "monospace", fontWeight: "400", fontSize: 14 }) }));

import type { SshSessionDetail } from "@/lib/ssh-bridge";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { SshIntegrationBadge } from "@/modules/ssh-explorer/SshIntegrationBadge";
import { useSshLeafTransport } from "./useSshLeafTransport";
import { disposeSession, getSshIntegrationContext, subscribeSshIntegrationContext, terminalDebugStats, useTerminalSession } from "./useTerminalSession";

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
const params = { host: "example.invalid", port: 2222, user: "alice", cols: 80, rows: 24, term: "xterm" };
const leafId = 94101;
function detail(sessionId: number, overrides: Partial<SshSessionDetail> = {}): SshSessionDetail {
  return { sessionId, host: params.host, port: params.port, user: params.user, state: "connected", ownerWindow: "main", terminalContext: { connectionId: sessionId.toString(16).padStart(32, "0"), bashHooksPath: `/tmp/hooks-${sessionId}` }, ...overrides };
}
function setSessions(ids = ["session-a"], rustIds = [31]) {
  const handles = ids.map((_, index) => ({ id: rustIds[index], write: vi.fn().mockResolvedValue(undefined), resize: vi.fn(), close: vi.fn() }));
  useSshStore.setState({ activeSessionId: ids[0] ?? null, currentPathBySession: {}, sessions: ids.map((id, index) => ({ id, rustSessionId: rustIds[index], params: { ...params, host: `example${index ? index + 1 : ""}.invalid` }, state: "connected" as const, connectedAt: index + 1, handle: handles[index] })) });
  return handles;
}
function Leaf({ sessionId }: { sessionId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const { openTransport } = useSshLeafTransport(sessionId);
  useTerminalSession({ leafId, container, visible: false, transportKey: sessionId, openTransport, remote: true });
  return <><div ref={container} /><SshIntegrationBadge leafId={leafId} sessionId={sessionId} active /></>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function mounted(sessionId = "session-a") {
  const view = render(<Leaf sessionId={sessionId} />);
  await waitFor(() => expect(mocks.detail).toHaveBeenCalledTimes(1));
  await flush();
  return view;
}
function openBadge() { fireEvent.click(screen.getByRole("button", { name: "恢复目录跟随" })); }

beforeEach(() => Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } }));
afterEach(() => {
  cleanup();
  for (const { leafId: id } of terminalDebugStats().sessions) disposeSession(id);
  useSshStore.setState({ sessions: [], activeSessionId: null, currentPathBySession: {} });
  mocks.detail.mockReset();
  mocks.windowLabel = "main";
  vi.useRealTimers();
  if (originalFontsDescriptor) Object.defineProperty(document, "fonts", originalFontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
});

describe("SSH integration recheck across the real leaf, transport, session, store, and badge", () => {
  it("recovers the visible metadata after the initial RPC fails without restoring or writing", async () => {
    const [handle] = setSessions();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    await mounted();
    expect(getSshIntegrationContext(leafId)).toBeNull();
    openBadge();
    expect(screen.getByText("尚未获取有效连接信息")).toBeTruthy();
    const update = vi.fn();
    const unsubscribe = subscribeSshIntegrationContext(leafId, update);
    const reply = deferred<SshSessionDetail[]>();
    mocks.detail.mockReturnValueOnce(reply.promise);
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    expect(screen.getByText("正在检测连接信息…")).toBeTruthy();
    await act(async () => { reply.resolve([detail(31)]); await reply.promise; });
    await flush();
    const context = detail(31).terminalContext;
    expect(getSshIntegrationContext(leafId)).toEqual(context);
    expect(screen.getByText("连接信息已确认")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const restore = screen.getByRole("button", { name: "已登录，恢复目录跟随" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(false);
    expect(screen.queryByText("等待终端回执…")).toBeNull();
    expect(update).toHaveBeenCalled();
    expect(handle.write).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
    expect(screen.queryByText(/已恢复，目录跟随/)).toBeNull();
    unsubscribe();
  });

  it("keeps the second check busy and authoritative when the first timed-out RPC arrives late", async () => {
    const [handle] = setSessions();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    await mounted();
    openBadge();
    const first = deferred<SshSessionDetail[]>();
    const second = deferred<SshSessionDetail[]>();
    mocks.detail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    await flush();
    await act(async () => { vi.advanceTimersByTime(4000); await Promise.resolve(); });
    vi.useRealTimers();
    expect(screen.getByText("检测未确认，可重试")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    const update = vi.fn();
    const unsubscribe = subscribeSshIntegrationContext(leafId, update);
    await act(async () => { first.resolve([detail(31, { terminalContext: { connectionId: "1".repeat(32), bashHooksPath: "/tmp/old.hooks" } })]); await first.promise; });
    await flush();
    expect(screen.getByText("正在检测连接信息…")).toBeTruthy();
    expect(getSshIntegrationContext(leafId)).toBeNull();
    const current = { connectionId: "2".repeat(32), bashHooksPath: "/tmp/current.hooks" };
    await act(async () => { second.resolve([detail(31, { terminalContext: current })]); await second.promise; });
    await flush();
    expect(getSshIntegrationContext(leafId)).toEqual(current);
    expect(screen.getByText("连接信息已确认")).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);
    expect(handle.write).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("isolates a pending old leaf reply from the replacement SSH session and preserves both handles", async () => {
    const [oldHandle, newHandle] = setSessions(["session-a", "session-b"], [31, 32]);
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    const view = await mounted();
    openBadge();
    const oldReply = deferred<SshSessionDetail[]>();
    mocks.detail.mockReturnValueOnce(oldReply.promise).mockResolvedValueOnce([detail(32, { host: "example2.invalid" })]);
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    await flush();
    view.rerender(<Leaf sessionId="session-b" />);
    await waitFor(() => expect(mocks.detail).toHaveBeenCalledTimes(3));
    await flush();
    expect(getSshIntegrationContext(leafId)).toEqual(detail(32, { host: "example2.invalid" }).terminalContext);
    expect(screen.queryByText("连接信息已确认")).toBeNull();
    openBadge();
    expect(screen.getByText("连接信息已确认")).toBeTruthy();
    const changes = vi.fn();
    const unsubscribe = subscribeSshIntegrationContext(leafId, changes);
    await act(async () => { oldReply.resolve([detail(31, { terminalContext: { connectionId: "3".repeat(32), bashHooksPath: "/tmp/old.hooks" } })]); await oldReply.promise; });
    await flush();
    expect(getSshIntegrationContext(leafId)).toEqual(detail(32, { host: "example2.invalid" }).terminalContext);
    expect(screen.getByText("连接信息已确认")).toBeTruthy();
    expect(changes).not.toHaveBeenCalled();
    expect(oldHandle.write).not.toHaveBeenCalled();
    expect(oldHandle.close).not.toHaveBeenCalled();
    expect(newHandle.write).not.toHaveBeenCalled();
    expect(newHandle.close).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("ignores a late RPC after the leaf exits while retaining the shared SSH and SFTP handle", async () => {
    const [handle] = setSessions();
    mocks.detail.mockRejectedValueOnce(new Error("offline"));
    await mounted();
    openBadge();
    const late = deferred<SshSessionDetail[]>();
    mocks.detail.mockReturnValueOnce(late.promise);
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    await flush();
    const events = vi.fn();
    const unsubscribe = subscribeSshIntegrationContext(leafId, events);
    act(() => disposeSession(leafId));
    const count = events.mock.calls.length;
    await act(async () => { late.resolve([detail(31)]); await late.promise; });
    await flush();
    expect(getSshIntegrationContext(leafId)).toBeNull();
    expect(events).toHaveBeenCalledTimes(count);
    expect(handle.write).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
