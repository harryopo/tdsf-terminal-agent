import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openPty: vi.fn(),
  riskLevel: "safe" as string,
  slots: new Map<number, { term: { write: ReturnType<typeof vi.fn> } }>(),
}));

vi.mock("@/lib/fonts", () => ({
  ensureMonoFontsLoaded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/risk-engine/riskClient", () => ({
  evaluateRisk: vi.fn().mockImplementation(async () => ({ level: mocks.riskLevel })),
  evaluateRiskSync: vi.fn().mockImplementation(() => ({ level: mocks.riskLevel })),
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
vi.mock("@/modules/spaces", () => ({
  useSpaces: { getState: () => ({ spaces: [], activeId: null }) },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./outputHighlight", () => ({ registerOutputHighlight: vi.fn(() => () => {}) }));
vi.mock("../block/lib/blockDecorations", () => ({ BlockDecorations: class {} }));
vi.mock("./terminalBlocks", () => ({
  TerminalBlockCollector: class {},
  captureBlockOutputWithMeta: vi.fn(),
  registerBlockOscHandlers: vi.fn(() => () => {}),
}));
vi.mock("./terminalBlocksStore", () => ({
  useTerminalBlocksStore: {
    getState: () => ({
      clearLeaf: vi.fn(),
      resolveAuthor: vi.fn(),
      noteExecStarted: vi.fn(),
      pushBlock: vi.fn(),
    }),
  },
}));
vi.mock("./osc-handlers", () => ({
  createShellIntegrationState: vi.fn(() => ({})),
  registerCwdHandler: vi.fn(() => ({ dispose: vi.fn() })),
  registerOsc52ClipboardHandler: vi.fn(() => vi.fn()),
  registerPromptTracker: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("./pty-bridge", () => ({ openPty: mocks.openPty }));
vi.mock("./completionInjection", () => ({
  clearLeafEnvironment: vi.fn(),
  setLeafEnvironment: vi.fn(),
}));
vi.mock("@/lib/param-complete-client", () => ({ setLeafCwd: vi.fn() }));
vi.mock("./agentActivity", () => ({
  ensureAgentActivityListener: vi.fn(),
  isAgentActivePty: vi.fn(() => false),
}));
vi.mock("./rendererPool", () => {
  const noop = vi.fn();
  return {
    acquireSlot: noop,
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
    getSlotForLeaf: () => null,
    isLeafAltScreen: () => false,
    parkLeafSlot: noop,
    poolSize: () => 0,
    poolSlotStats: () => [],
    refreshLeafSlot: noop,
    releaseSlot: () => null,
    setSlotFocused: noop,
  };
});
vi.mock("./useTerminalFont", () => ({
  useTerminalFont: () => ({ fontFamily: "monospace", fontWeight: "400", fontSize: 14 }),
}));

import {
  armAgentCommandEcho,
  confirmPendingRiskCommand,
  disposeSession,
  getPendingRiskCommand,
  submitToLeaf,
  subscribePendingRiskCommand,
  terminalDebugStats,
  useTerminalSession,
} from "./useTerminalSession";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalTransport } from "./pty-bridge";

type OpenHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number) => void;
};

type Props = {
  leafId: number;
  transportKey?: string;
  openTransport?: (handlers: OpenHandlers) => Promise<TerminalTransport>;
  remote?: boolean;
  initialCwd?: string;
  visible?: boolean;
  onExit?: (code: number) => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTransport(id: string | number) {
  return {
    id,
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn<TerminalTransport["close"]>(),
  } satisfies TerminalTransport & {
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function mount(props: Props) {
  const container = { current: document.createElement("div") };
  const hook = renderHook((current: Props) =>
    useTerminalSession({
      ...current,
      container,
      visible: current.visible ?? false,
    }),
  { initialProps: props });
  return { ...hook, container };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function sessionCount() {
  return terminalDebugStats().sessionCount;
}

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

afterEach(() => {
  cleanup();
  for (const { leafId } of terminalDebugStats().sessions) disposeSession(leafId);
  mocks.slots.clear();
  mocks.openPty.mockReset();
  mocks.riskLevel = "safe";
  if (originalFontsDescriptor) {
    Object.defineProperty(document, "fonts", originalFontsDescriptor);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
});

describe("useTerminalSession transport identity lifecycle", () => {
  it("读取当前命令颜色并固定到本条回显，下一条使用新颜色且不向SSH写颜色", async () => {
    const leafId = 93120;
    const output = vi.fn();
    mocks.slots.set(leafId, { term: { write: output } });
    const transport = makeTransport("color-fixture");
    let handlers!: OpenHandlers;
    const openTransport = vi.fn(async (value: OpenHandlers) => { handlers = value; return transport; });
    mount({ leafId, transportKey: "color-fixture", openTransport, remote: true });
    await waitFor(() => expect(openTransport).toHaveBeenCalledTimes(1));
    const prefs = usePreferencesStore.getState();
    const previous = prefs.agentCommandColor;
    try {
      prefs.agentCommandColor = "#22aa77";
      armAgentCommandEcho(leafId, "pwd\n", { progressive: true, promptReady: true });
      prefs.agentCommandColor = "#ffaa00";
      act(() => handlers.onData(new TextEncoder().encode("pwd\r\n/tmp\r\n[root]# ")));
      expect(new TextDecoder().decode(output.mock.calls[0][0])).toBe("\x1b[38;2;34;170;119mpwd\x1b[0m\r\n/tmp\r\n[root]# ");
      armAgentCommandEcho(leafId, "pwd\n", { progressive: true, promptReady: true });
      act(() => handlers.onData(new TextEncoder().encode("pwd\r\n/tmp\r\n[root]# ")));
      expect(new TextDecoder().decode(output.mock.calls[1][0])).toBe("\x1b[38;2;255;170;0mpwd\x1b[0m\r\n/tmp\r\n[root]# ");
      expect(transport.write).not.toHaveBeenCalled();
    } finally {
      prefs.agentCommandColor = previous;
    }
  });

  it("retires a pending old transport on key change and ignores its late resolve, data, exit, and queued input", async () => {
    const leafId = 93101;
    const output = vi.fn();
    mocks.slots.set(leafId, { term: { write: output } });
    const oldOpen = deferred<TerminalTransport>();
    const oldTransport = makeTransport("old");
    const newTransport = makeTransport("new");
    let oldHandlers!: OpenHandlers;
    let newHandlers!: OpenHandlers;
    const openOld = vi.fn((handlers: OpenHandlers) => {
      oldHandlers = handlers;
      return oldOpen.promise;
    });
    const openNew = vi.fn(async (handlers: OpenHandlers) => {
      newHandlers = handlers;
      return newTransport;
    });
    const oldExit = vi.fn();
    const newExit = vi.fn();
    const hook = mount({
      leafId,
      transportKey: "ssh:old",
      openTransport: openOld,
      remote: true,
      onExit: oldExit,
    });

    await waitFor(() => expect(openOld).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.write("typed-before-switch\r"));
    hook.rerender({
      leafId,
      transportKey: "ssh:new",
      openTransport: openNew,
      remote: true,
      onExit: newExit,
    });
    await settle();
    expect(openNew).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldOpen.resolve(oldTransport);
      await oldOpen.promise;
    });
    await settle();

    act(() => hook.result.current.write("typed-after-switch\r"));
    oldHandlers.onData(new TextEncoder().encode("old-bytes"));
    oldHandlers.onExit(17);
    newHandlers.onData(new TextEncoder().encode("new-bytes"));

    expect(oldTransport.close).toHaveBeenCalledTimes(1);
    expect(oldTransport.write).not.toHaveBeenCalled();
    expect(newTransport.write).toHaveBeenCalledTimes(1);
    expect(newTransport.write).toHaveBeenCalledWith("typed-after-switch\r");
    expect(
      output.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)),
    ).toEqual(["new-bytes"]);
    expect(oldExit).not.toHaveBeenCalled();
    expect(newExit).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledTimes(1);
  });

  it("keeps the transport for a stable key while factory, cwd, callback, and visibility props change", async () => {
    const transport = makeTransport("stable");
    const onExit = vi.fn();
    const replacementFactory = vi.fn(async (_handlers: OpenHandlers) => makeTransport("wrong"));
    let handlers!: OpenHandlers;
    const initialFactory = vi.fn(async (next: OpenHandlers) => {
      handlers = next;
      return transport;
    });
    const hook = mount({
      leafId: 93102,
      transportKey: "ssh:stable",
      openTransport: initialFactory,
      remote: true,
      initialCwd: "/srv/one",
    });
    await waitFor(() => expect(initialFactory).toHaveBeenCalledTimes(1));
    await settle();
    hook.rerender({
      leafId: 93102,
      transportKey: "ssh:stable",
      openTransport: replacementFactory,
      remote: true,
      initialCwd: "/srv/two",
      visible: true,
      onExit,
    });
    await settle();
    handlers.onExit(0);
    expect(replacementFactory).not.toHaveBeenCalled();
    expect(transport.close).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledWith(0);
    expect(sessionCount()).toBe(1);
  });

  it("reuses the same keyed transport across unmount and remount", async () => {
    const transport = makeTransport("remount");
    const openTransport = vi.fn(async (_handlers: OpenHandlers) => transport);
    const props = { leafId: 93103, transportKey: "ssh:remount", openTransport, remote: true };
    const first = mount(props);
    await waitFor(() => expect(openTransport).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = mount(props);
    await settle();
    act(() => second.result.current.write("still-live\r"));
    expect(openTransport).toHaveBeenCalledTimes(1);
    expect(transport.write).toHaveBeenCalledWith("still-live\r");
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("switches one leaf without disposing another leaf's transport", async () => {
    const firstTransport = makeTransport("leaf-a-old");
    const secondTransport = makeTransport("leaf-b");
    const replacement = makeTransport("leaf-a-new");
    const openA1 = vi.fn(async (_handlers: OpenHandlers) => firstTransport);
    const openA2 = vi.fn(async (_handlers: OpenHandlers) => replacement);
    const openB = vi.fn(async (_handlers: OpenHandlers) => secondTransport);
    const a = mount({ leafId: 93104, transportKey: "a1", openTransport: openA1, remote: true });
    const b = mount({ leafId: 93105, transportKey: "b", openTransport: openB, remote: true });
    await waitFor(() => {
      expect(openA1).toHaveBeenCalledTimes(1);
      expect(openB).toHaveBeenCalledTimes(1);
    });
    a.rerender({ leafId: 93104, transportKey: "a2", openTransport: openA2, remote: true });
    await settle();
    act(() => {
      a.result.current.write("to-a\r");
      b.result.current.write("to-b\r");
    });
    expect(firstTransport.close).toHaveBeenCalledTimes(1);
    expect(replacement.write).toHaveBeenCalledWith("to-a\r");
    expect(secondTransport.close).not.toHaveBeenCalled();
    expect(secondTransport.write).toHaveBeenCalledWith("to-b\r");
  });

  it("pairs local to SSH to local with the matching transport kind", async () => {
    const leafId = 93106;
    const output = vi.fn();
    mocks.slots.set(leafId, { term: { write: output } });
    const localFirst = makeTransport(1);
    const ssh = makeTransport("ssh-current");
    const localLast = makeTransport(2);
    const localHandlers: OpenHandlers[] = [];
    let localOpenCount = 0;
    mocks.openPty.mockImplementation((_cols: number, _rows: number, handlers: OpenHandlers) => {
      localHandlers.push(handlers);
      localOpenCount += 1;
      return Promise.resolve(localOpenCount === 1 ? localFirst : localLast);
    });
    const openSsh = vi.fn(async (_handlers: OpenHandlers) => ssh);
    const onExit = vi.fn();
    const hook = mount({ leafId, onExit });
    await waitFor(() => expect(mocks.openPty).toHaveBeenCalledTimes(1));
    hook.rerender({ leafId, transportKey: "ssh:one", openTransport: openSsh, remote: true, onExit });
    await settle();
    expect(openSsh).toHaveBeenCalledTimes(1);
    hook.rerender({ leafId, onExit });
    await settle();
    expect(mocks.openPty).toHaveBeenCalledTimes(2);
    expect(localFirst.close).toHaveBeenCalledTimes(1);
    expect(ssh.close).toHaveBeenCalledTimes(1);

    localHandlers[0]!.onData(new TextEncoder().encode("stale-local"));
    localHandlers[0]!.onExit(41);
    localHandlers[1]!.onData(new TextEncoder().encode("current-local"));
    act(() => hook.result.current.write("local-again\r"));
    expect(localLast.write).toHaveBeenCalledWith("local-again\r");
    expect(onExit).not.toHaveBeenCalled();
    expect(
      output.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)),
    ).toEqual(["current-local"]);
  });

  it("does not let an old A transport write into a new A session after A to B to A", async () => {
    const leafId = 93107;
    const output = vi.fn();
    mocks.slots.set(leafId, { term: { write: output } });
    const a1 = makeTransport("a1");
    const b = makeTransport("b");
    const a2 = makeTransport("a2");
    let oldA!: OpenHandlers;
    let currentA!: OpenHandlers;
    let openIndex = 0;
    const openA = vi.fn(async (handlers: OpenHandlers) => {
      openIndex++;
      if (openIndex === 1) {
        oldA = handlers;
        return a1;
      }
      currentA = handlers;
      return a2;
    });
    let bHandlers!: OpenHandlers;
    const openB = vi.fn(async (handlers: OpenHandlers) => {
      bHandlers = handlers;
      return b;
    });
    const onExit = vi.fn();
    const hook = mount({ leafId, transportKey: "A", openTransport: openA, remote: true, onExit });
    await waitFor(() => expect(openA).toHaveBeenCalledTimes(1));
    hook.rerender({ leafId, transportKey: "B", openTransport: openB, remote: true, onExit });
    await waitFor(() => expect(openB).toHaveBeenCalledTimes(1));
    hook.rerender({ leafId, transportKey: "A", openTransport: openA, remote: true, onExit });
    await waitFor(() => expect(openA).toHaveBeenCalledTimes(2));

    oldA.onData(new TextEncoder().encode("stale-A"));
    oldA.onExit(23);
    bHandlers.onData(new TextEncoder().encode("stale-B"));
    currentA.onData(new TextEncoder().encode("current-A"));
    act(() => hook.result.current.write("write-A\r"));

    expect(a1.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(a2.write).toHaveBeenCalledWith("write-A\r");
    expect(onExit).not.toHaveBeenCalled();
    expect(
      output.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes)),
    ).toEqual(["current-A"]);
  });

  it("preserves the risk listener across transport replacement and clears old pending input", async () => {
    const leafId = 93108;
    const oldTransport = makeTransport("risk-old");
    const newTransport = makeTransport("risk-new");
    const openOld = vi.fn(async (_handlers: OpenHandlers) => oldTransport);
    const openNew = vi.fn(async (_handlers: OpenHandlers) => newTransport);
    const hook = mount({ leafId, transportKey: "risk-old", openTransport: openOld, remote: true });
    await waitFor(() => expect(openOld).toHaveBeenCalledTimes(1));
    const listener = vi.fn();
    const unsubscribe = subscribePendingRiskCommand(leafId, listener);

    mocks.riskLevel = "high";
    act(() => submitToLeaf(leafId, "shutdown -h now"));
    expect(getPendingRiskCommand(leafId)?.text).toBe("shutdown -h now");
    await settle();
    listener.mockClear();

    hook.rerender({ leafId, transportKey: "risk-new", openTransport: openNew, remote: true });
    await waitFor(() => expect(openNew).toHaveBeenCalledTimes(1));
    expect(getPendingRiskCommand(leafId)).toBeNull();
    expect(listener).toHaveBeenCalled();
    act(() => confirmPendingRiskCommand(leafId));
    expect(oldTransport.write).not.toHaveBeenCalled();

    listener.mockClear();
    act(() => submitToLeaf(leafId, "shutdown -h now"));
    expect(getPendingRiskCommand(leafId)?.text).toBe("shutdown -h now");
    expect(listener).toHaveBeenCalled();
    act(() => confirmPendingRiskCommand(leafId));
    expect(newTransport.write).toHaveBeenCalledWith("shutdown -h now\r");
    unsubscribe();
  });

  it("wires the SSH session identity from PaneTreeView through TerminalPane", () => {
    const paneTree = readFileSync(resolve(process.cwd(), "src/modules/terminal/PaneTreeView.tsx"), "utf8");
    const terminalPane = readFileSync(resolve(process.cwd(), "src/modules/terminal/TerminalPane.tsx"), "utf8");
    const sshPaneProps = paneTree.match(
      /<TerminalPane\b(?=[\s\S]*?\/>)([\s\S]*?openTransport=\{openTransport\}[\s\S]*?\/>)/,
    )?.[1];
    const sessionOptions = terminalPane.match(/useTerminalSession\(\{([\s\S]*?)\}\)/)?.[1];

    expect(sshPaneProps).toBeDefined();
    expect(sshPaneProps).toMatch(/\btransportKey=\{sessionId\}/);
    expect(sessionOptions).toBeDefined();
    expect(sessionOptions).toMatch(/^\s*transportKey,\s*$/m);
  });
});
