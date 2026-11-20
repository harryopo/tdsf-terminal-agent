import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Slot = {
  term: Terminal;
  disposers: (() => void)[];
};

const mocks = vi.hoisted(() => ({
  slots: new Map<number, Slot>(),
  terms: [] as Terminal[],
}));

vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/risk-engine/riskClient", () => ({
  evaluateRisk: vi.fn(),
  evaluateRiskSync: vi.fn(() => ({ level: "safe" })),
  maxRiskLevel: vi.fn((_left, right) => right),
}));
vi.mock("@/modules/settings/preferences", () => {
  const state = {
    zoomLevel: 1,
    terminalLetterSpacing: 0,
    terminalScrollback: 1000,
    terminalWebglEnabled: false,
    terminalCursorBlink: false,
    backgroundKind: "solid",
    backgroundImageId: null,
    terminalShell: "",
  };
  const store = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  return { usePreferencesStore: store };
});
vi.mock("@/modules/spaces", () => ({ useSpaces: { getState: () => ({ spaces: [], activeId: null }) } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./outputHighlight", () => ({ registerOutputHighlight: vi.fn(() => () => {}) }));
vi.mock("../block/lib/blockDecorations", () => ({
  BlockDecorations: class { dispose() {} },
}));
vi.mock("./pty-bridge", () => ({ openPty: vi.fn() }));
vi.mock("./completionInjection", () => ({ clearLeafEnvironment: vi.fn(), setLeafEnvironment: vi.fn() }));
vi.mock("@/lib/param-complete-client", () => ({ setLeafCwd: vi.fn() }));
vi.mock("./agentActivity", () => ({ ensureAgentActivityListener: vi.fn(), isAgentActivePty: vi.fn(() => false) }));
vi.mock("./rendererPool", () => {
  const noop = vi.fn();
  return {
    acquireSlot: vi.fn((options: { leafId: number; registerOsc: (term: Terminal) => (() => void)[] }) => {
      const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
      mocks.terms.push(term);
      mocks.slots.set(options.leafId, { term, disposers: options.registerOsc(term) });
    }),
    applyBackgroundActive: noop,
    applyCursorBlink: noop,
    applyLetterSpacing: noop,
    applyTheme: noop,
    applyScrollback: noop,
    applyTerminalFont: noop,
    applyWebglPreference: noop,
    configureRendererPool: noop,
    discardRetainedSlot: noop,
    disposeLeafSlot: noop,
    focusSlot: noop,
    getLiveSlotForLeaf: (leafId: number) => mocks.slots.get(leafId) ?? null,
    getSlotForLeaf: (leafId: number) => mocks.slots.get(leafId) ?? null,
    isLeafAltScreen: () => false,
    parkLeafSlot: noop,
    poolSize: () => 0,
    poolSlotStats: () => [],
    refreshLeafSlot: noop,
    releaseSlot: (leafId: number) => {
      const slot = mocks.slots.get(leafId);
      if (!slot) return null;
      slot.disposers.forEach((dispose) => dispose());
      mocks.slots.delete(leafId);
      return { cols: 80, rows: 24 };
    },
    setSlotFocused: noop,
  };
});
vi.mock("./useTerminalFont", () => ({ useTerminalFont: () => ({ fontFamily: "monospace", fontWeight: "400", fontSize: 14 }) }));

import { disposeSession, respawnSession, terminalDebugStats, useTerminalSession } from "./useTerminalSession";
import { useTerminalBlocksStore } from "./terminalBlocksStore";
import type { TerminalTransport, TerminalTransportHandlers } from "./pty-bridge";
import type { SshTerminalContext } from "./remoteShellIntegration";

const ESC = String.fromCharCode(27);
const ST = `${ESC}\\`;
const connA = "0123456789abcdef0123456789abcdef";
const connB = "fedcba9876543210fedcba9876543210";
const osc = (code: number, data: string) => `${ESC}]${code};${data}${ST}`;
const integrationContext: SshTerminalContext = { connectionId: connA, bashHooksPath: "/hooks" };

function sendIntegrationContext(handlers: TerminalTransportHandlers) {
  const notify = handlers.onIntegrationContext;
  if (!notify) throw new Error("remote transport did not provide the integration context callback");
  notify(integrationContext);
}

function makeContext(connectionId = connA, cwd = "/srv/alpha") {
  return osc(633, `P;TdsfContext=${connectionId};1234-11-22;alice;${encodeURIComponent(cwd)}`);
}

function write(term: Terminal, text: string) {
  return new Promise<void>((resolve) => term.write(text, resolve));
}

function makeTransport() {
  let handlers!: TerminalTransportHandlers;
  const transport = {
    id: "ssh-transport",
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } satisfies TerminalTransport;
  const openTransport = vi.fn(async (next: TerminalTransportHandlers) => {
    handlers = next;
    return transport;
  });
  return { openTransport, transport, handlers: () => handlers };
}

function mount(leafId: number, ref = { current: document.createElement("div") }, transport = makeTransport()) {
  const hook = renderHook(() => useTerminalSession({
    leafId,
    container: ref,
    visible: true,
    focused: false,
    blocks: false,
    remote: true,
    transportKey: "ssh:stable",
    openTransport: transport.openTransport,
  }));
  return { ...hook, ref, ...transport };
}

function mountLocal(leafId: number) {
  const ref = { current: document.createElement("div") };
  const transport = makeTransport();
  const hook = renderHook(() => useTerminalSession({
    leafId,
    container: ref,
    visible: true,
    focused: false,
    blocks: false,
    remote: false,
    transportKey: "local:respawn-test",
    openTransport: transport.openTransport,
  }));
  return { ...hook, ref, ...transport };
}

async function rebound(leafId: number, openTransport: ReturnType<typeof makeTransport>["openTransport"]) {
  const ref = { current: document.createElement("div") };
  const hook = renderHook(() => useTerminalSession({
    leafId,
    container: ref,
    visible: true,
    focused: false,
    blocks: false,
    remote: true,
    transportKey: "ssh:stable",
    openTransport,
  }));
  await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
  return hook;
}

function blocks(leafId: number) {
  return useTerminalBlocksStore.getState().blocksByLeaf[leafId] ?? [];
}

async function send(term: Terminal, content: string) {
  await act(async () => write(term, content));
}

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
});

afterEach(() => {
  cleanup();
  for (const { leafId } of terminalDebugStats().sessions) disposeSession(leafId);
  for (const [leafId, slot] of mocks.slots) {
    slot.disposers.forEach((dispose) => dispose());
    mocks.slots.delete(leafId);
  }
  mocks.terms.forEach((term) => term.dispose());
  mocks.terms = [];
  if (originalFontsDescriptor) Object.defineProperty(document, "fonts", originalFontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
});

describe("useTerminalSession command block residency", () => {
  it("keeps a started command across renderer replacement and captures only the new renderer", async () => {
    const leafId = 93301;
    const hook = mount(leafId);
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    const first = mocks.slots.get(leafId)!.term;
    await waitFor(() => expect(hook.openTransport).toHaveBeenCalledOnce());
    sendIntegrationContext(hook.handlers());
    const startedAtBefore = Date.now();
    await send(first, makeContext() + osc(133, "A") + osc(133, "C;printf first") + "first\r\n");
    const startedAtAfter = Date.now();

    hook.unmount();
    const reboundHook = await rebound(leafId, hook.openTransport);
    const second = mocks.slots.get(leafId)!.term;
    await send(second, makeContext() + osc(133, "D;7"));
    expect(blocks(leafId)).toHaveLength(1);
    expect(blocks(leafId)[0]).toMatchObject({ command: "printf first", exitCode: 7 });
    expect(blocks(leafId)[0].startedAt).toBeGreaterThanOrEqual(startedAtBefore);
    expect(blocks(leafId)[0].startedAt).toBeLessThanOrEqual(startedAtAfter);
    reboundHook.unmount();
  });

  it("allocates monotonically unique IDs when a Session is rebound repeatedly", async () => {
    const leafId = 93302;
    const firstHook = mount(leafId);
    const openTransport = firstHook.openTransport;
    let activeHook: Pick<ReturnType<typeof mount>, "unmount"> = firstHook;
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    await waitFor(() => expect(openTransport).toHaveBeenCalledOnce());
    sendIntegrationContext(firstHook.handlers());
    for (let index = 0; index < 3; index += 1) {
      const term = mocks.slots.get(leafId)!.term;
      await send(term, makeContext() + osc(133, `C;command-${index}`) + `output-${index}\r\n` + makeContext() + osc(133, `D;${index}`));
      if (index < 2) {
        activeHook.unmount();
        activeHook = await rebound(leafId, openTransport);
      }
    }
    expect(blocks(leafId).map((block) => block.id)).toEqual([
      `tb-${leafId}-1`, `tb-${leafId}-2`, `tb-${leafId}-3`,
    ]);
    activeHook.unmount();
  });

  it("keeps RemoteShellIntegration source gating on the real OSC chain", async () => {
    const leafId = 93303;
    const hook = mount(leafId);
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    await waitFor(() => expect(hook.openTransport).toHaveBeenCalledOnce());
    sendIntegrationContext(hook.handlers());
    const term = mocks.slots.get(leafId)!.term;
    await send(term, makeContext() + osc(133, "C;source-guard") + "guarded\r\n");
    await send(term, makeContext(connB, "/srv/wrong") + osc(133, "D;9"));
    expect(blocks(leafId)).toHaveLength(0);
    await send(term, makeContext() + osc(133, "D;7"));
    expect(blocks(leafId)).toHaveLength(1);
    expect(blocks(leafId)[0]).toMatchObject({ command: "source-guard", exitCode: 7 });
    hook.unmount();
  });

  it("disposes old renderer markers and refuses to capture its scrollback", async () => {
    const leafId = 93304;
    const hook = mount(leafId);
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    await waitFor(() => expect(hook.openTransport).toHaveBeenCalledOnce());
    sendIntegrationContext(hook.handlers());
    const oldTerm = mocks.slots.get(leafId)!.term;
    const registeredMarkers: ReturnType<Terminal["registerMarker"]>[] = [];
    const registerMarker = oldTerm.registerMarker.bind(oldTerm);
    vi.spyOn(oldTerm, "registerMarker").mockImplementation((offset) => {
      const marker = registerMarker(offset);
      if (marker) registeredMarkers.push(marker);
      return marker;
    });
    await send(oldTerm, makeContext() + osc(133, "C;old-output") + "SECRET_OLD_SCROLLBACK\r\n");
    expect(registeredMarkers).toHaveLength(1);

    hook.unmount();
    const next = await rebound(leafId, hook.openTransport);
    expect(registeredMarkers[0].isDisposed).toBe(true);
    const current = mocks.slots.get(leafId)!.term;
    await send(current, makeContext() + osc(133, "D;7"));
    expect(blocks(leafId)[0]).toMatchObject({ outputTail: "", outputTruncated: true, exitCode: 7 });
    expect(blocks(leafId)[0].outputTail).not.toContain("SECRET_OLD_SCROLLBACK");

    await send(current, osc(133, "C;new-output") + "CURRENT_OUTPUT\r\n" + makeContext() + osc(133, "D;0"));
    expect(blocks(leafId)[1]).toMatchObject({ outputTail: expect.stringContaining("CURRENT_OUTPUT"), outputTruncated: false });
    next.unmount();
  });

  it("clears pending commands when the Session is retired", async () => {
    const leafId = 93305;
    const old = mount(leafId);
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    await waitFor(() => expect(old.openTransport).toHaveBeenCalledOnce());
    sendIntegrationContext(old.handlers());
    await send(mocks.slots.get(leafId)!.term, makeContext() + osc(133, "C;old-pending"));
    old.unmount();
    disposeSession(leafId);

    const fresh = mount(leafId);
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    await waitFor(() => expect(fresh.openTransport).toHaveBeenCalledOnce());
    sendIntegrationContext(fresh.handlers());
    await send(mocks.slots.get(leafId)!.term, makeContext() + osc(133, "D;7"));
    expect(blocks(leafId)).toHaveLength(0);
    fresh.unmount();
  });

  it("does not let a new local shell D confirm a command pending at respawn", async () => {
    const leafId = 93306;
    const hook = mountLocal(leafId);
    await waitFor(() => expect(mocks.slots.has(leafId)).toBe(true));
    await waitFor(() => expect(hook.openTransport).toHaveBeenCalledOnce());
    const oldTerm = mocks.slots.get(leafId)!.term;
    await send(oldTerm, osc(133, "C;old-shell-command") + "OLD_SHELL_OUTPUT\r\n");

    await act(async () => respawnSession(leafId));
    await waitFor(() => expect(hook.openTransport).toHaveBeenCalledTimes(2));
    expect(blocks(leafId)).toHaveLength(1);
    expect(blocks(leafId)[0]).toMatchObject({
      command: "old-shell-command",
      exitCode: null,
    });

    const newTerm = mocks.slots.get(leafId)!.term;
    await send(newTerm, osc(133, "D;7"));
    expect(blocks(leafId)).toHaveLength(1);

    await send(newTerm, osc(133, "C;new-shell-command") + "NEW_SHELL_OUTPUT\r\n" + osc(133, "D;0"));
    expect(blocks(leafId)).toHaveLength(2);
    expect(blocks(leafId)[1]).toMatchObject({
      id: `tb-${leafId}-2`,
      command: "new-shell-command",
      exitCode: 0,
    });
    hook.unmount();
  });
});
