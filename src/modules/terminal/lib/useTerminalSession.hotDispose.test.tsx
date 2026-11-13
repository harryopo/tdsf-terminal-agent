import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openPty: vi.fn(),
  slots: new Map<number, { term: { write: ReturnType<typeof vi.fn> } }>(),
}));

vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/risk-engine/riskClient", () => ({
  evaluateRisk: vi.fn(), evaluateRiskSync: vi.fn(() => ({ level: "safe" })), maxRiskLevel: vi.fn(),
}));
vi.mock("@/modules/settings/preferences", () => {
  const state = { zoomLevel: 1, terminalLetterSpacing: 0, terminalScrollback: 1000,
    terminalWebglEnabled: false, terminalCursorBlink: false, backgroundKind: "solid",
    backgroundImageId: null, terminalShell: "" };
  return { usePreferencesStore: Object.assign((select: (value: Record<string, unknown>) => unknown) => select(state), { getState: () => state }) };
});
vi.mock("@/modules/spaces", () => ({ useSpaces: { getState: () => ({ spaces: [], activeId: null }) } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./outputHighlight", () => ({ registerOutputHighlight: vi.fn(() => () => {}) }));
vi.mock("../block/lib/blockDecorations", () => ({ BlockDecorations: class {} }));
vi.mock("./terminalBlocks", () => ({ TerminalBlockCollector: class {}, captureBlockOutputWithMeta: vi.fn(), registerBlockOscHandlers: vi.fn(() => () => {}) }));
vi.mock("./terminalBlocksStore", () => ({ useTerminalBlocksStore: { getState: () => ({ clearLeaf: vi.fn() }) } }));
vi.mock("./osc-handlers", () => ({
  createShellIntegrationState: vi.fn(() => ({})), registerCwdHandler: vi.fn(() => ({ dispose: vi.fn() })),
  registerOsc52ClipboardHandler: vi.fn(() => vi.fn()), registerPromptTracker: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock("./pty-bridge", () => ({ openPty: mocks.openPty }));
vi.mock("./completionInjection", () => ({ clearLeafEnvironment: vi.fn(), setLeafEnvironment: vi.fn() }));
vi.mock("@/lib/param-complete-client", () => ({ setLeafCwd: vi.fn() }));
vi.mock("./agentActivity", () => ({ ensureAgentActivityListener: vi.fn(), isAgentActivePty: vi.fn(() => false) }));
vi.mock("./rendererPool", () => {
  const noop = vi.fn();
  return {
    acquireSlot: noop, applyBackgroundActive: noop, applyCursorBlink: noop, applyLetterSpacing: noop,
    applyTheme: noop, applyScrollback: noop, applyTerminalFont: noop, applyWebglPreference: noop,
    configureRendererPool: noop, discardRetainedSlot: noop, disposeLeafSlot: noop, focusSlot: noop,
    getLiveSlotForLeaf: (leafId: number) => mocks.slots.get(leafId) ?? null, getSlotForLeaf: () => null,
    isLeafAltScreen: () => false, parkLeafSlot: noop, poolSize: () => 0, poolSlotStats: () => [],
    refreshLeafSlot: noop, releaseSlot: () => null, setSlotFocused: noop,
  };
});
vi.mock("./useTerminalFont", () => ({ useTerminalFont: () => ({ fontFamily: "monospace", fontWeight: "400", fontSize: 14 }) }));

import { disposeSession, terminalDebugStats, useTerminalSession } from "./useTerminalSession";
import type { TerminalTransport, TerminalTransportHandlers } from "./pty-bridge";

type Handlers = TerminalTransportHandlers;
type HookProps = {
  leafId: number; transportKey?: string; remote?: boolean;
  openTransport?: (handlers: Handlers) => Promise<TerminalTransport>;
};

function makeTransport(id: number | string) {
  return { id, write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mount(props: HookProps) {
  const container = { current: document.createElement("div") };
  return renderHook((current: HookProps) => useTerminalSession({ ...current, container, visible: false }), { initialProps: props });
}

function hotCallback(method: "dispose" | "accept", browserWindow: unknown = window): (() => void) | undefined {
  const path = resolve(process.cwd(), "src/modules/terminal/lib/useTerminalSession.ts");
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback: ts.ArrowFunction | undefined;
  const isImportMetaHot = (node: ts.Node) => ts.isPropertyAccessExpression(node) && node.name.text === "hot" &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && isImportMetaHot(node.expression)) {
      const findDispose = (child: ts.Node) => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === method && isImportMetaHot(child.expression.expression)) {
          const arg = child.arguments[0];
          if (arg && ts.isArrowFunction(arg)) callback = arg;
        }
        ts.forEachChild(child, findDispose);
      };
      findDispose(node.thenStatement);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!callback) return undefined;
  const callbackSource = ts.transpile(`const callback = (${source.slice(callback.getStart(file), callback.end)});`, {
    target: ts.ScriptTarget.ES2022,
  });
  return new Function("disposeSession", "terminalDebugStats", "window", `${callbackSource}\nreturn callback;`)(
    disposeSession, terminalDebugStats, browserWindow,
  ) as () => void;
}

const hotDisposeCallback = () => hotCallback("dispose");

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
});

afterEach(() => {
  cleanup();
  for (const { leafId } of terminalDebugStats().sessions) disposeSession(leafId);
  mocks.slots.clear();
  mocks.openPty.mockReset();
  if (originalFontsDescriptor) Object.defineProperty(document, "fonts", originalFontsDescriptor);
  else Reflect.deleteProperty(document, "fonts");
  Reflect.deleteProperty(window, "__tdsfTerm");
});

describe("useTerminalSession Vite HMR disposal", () => {
  it("reloads the page at its HMR boundary so importers cannot retain an old session map", () => {
    const reload = vi.fn();
    const accept = hotCallback("accept", { location: { reload } });
    expect(accept, "useTerminalSession has no import.meta.hot.accept boundary").toBeTypeOf("function");
    expect(reload).not.toHaveBeenCalled();
    accept?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("registers a real import.meta.hot.dispose callback in the hook module", () => {
    expect(hotDisposeCallback(), "useTerminalSession has no import.meta.hot.dispose callback").toBeTypeOf("function");
  });

  it("closes local and remote sessions and ignores late transport events", async () => {
    const localHandlers: Handlers[] = [];
    const local = makeTransport(1);
    mocks.openPty.mockImplementation((_cols: number, _rows: number, handlers: Handlers) => {
      localHandlers.push(handlers);
      return Promise.resolve(local);
    });
    const remote = makeTransport("ssh");
    let remoteHandlers!: Handlers;
    const remoteOpen = vi.fn((handlers: Handlers) => { remoteHandlers = handlers; return Promise.resolve(remote); });
    const output = vi.fn();
    mocks.slots.set(33201, { term: { write: output } });

    const localHook = mount({ leafId: 33201 });
    const remoteHook = mount({ leafId: 33202, remote: true, transportKey: "ssh:one", openTransport: remoteOpen });
    await waitFor(() => {
      expect(mocks.openPty).toHaveBeenCalledTimes(1);
      expect(remoteOpen).toHaveBeenCalledTimes(1);
    });
    const dispose = hotDisposeCallback();
    expect(dispose, "useTerminalSession has no import.meta.hot.dispose callback").toBeTypeOf("function");
    if (!dispose) return;
    act(() => dispose());

    expect(local.close).toHaveBeenCalledTimes(1);
    expect(remote.close).toHaveBeenCalledTimes(1);
    expect(terminalDebugStats().sessionCount).toBe(0);
    localHandlers[0]!.onData(new TextEncoder().encode("late-local"));
    localHandlers[0]!.onExit(19);
    remoteHandlers.onData(new TextEncoder().encode("late-remote"));
    remoteHandlers.onExit(20);
    expect(output).not.toHaveBeenCalled();
    localHook.unmount();
    remoteHook.unmount();
  });

  it("closes a transport that resolves after disposal without attaching it", async () => {
    const pending = deferred<TerminalTransport>();
    const late = makeTransport("late");
    let handlers!: Handlers;
    const openTransport = vi.fn((next: Handlers) => { handlers = next; return pending.promise; });
    const hook = mount({ leafId: 33203, remote: true, transportKey: "ssh:pending", openTransport });
    await waitFor(() => expect(openTransport).toHaveBeenCalledTimes(1));
    const dispose = hotDisposeCallback();
    expect(dispose, "useTerminalSession has no import.meta.hot.dispose callback").toBeTypeOf("function");
    if (!dispose) return;
    act(() => dispose());
    await act(async () => { pending.resolve(late); await pending.promise; });
    await act(async () => { await Promise.resolve(); });
    handlers.onData(new TextEncoder().encode("too-late"));
    expect(late.close).toHaveBeenCalledTimes(1);
    expect(terminalDebugStats().sessionCount).toBe(0);
    hook.unmount();
  });

  it("deletes only its own debug function and leaves ordinary unmount sessions alive", async () => {
    const transport = makeTransport("retained");
    const openTransport = vi.fn(async (_handlers: Handlers) => transport);
    const hook = mount({ leafId: 33204, remote: true, transportKey: "ssh:retained", openTransport });
    await waitFor(() => expect(openTransport).toHaveBeenCalledTimes(1));
    const dispose = hotDisposeCallback();
    expect(dispose, "useTerminalSession has no import.meta.hot.dispose callback").toBeTypeOf("function");
    if (!dispose) return;

    const ownDebug = terminalDebugStats;
    Object.assign(window, { __tdsfTerm: ownDebug });
    act(() => { hook.unmount(); });
    expect(terminalDebugStats().sessionCount).toBe(1);
    expect(transport.close).not.toHaveBeenCalled();

    act(() => dispose());
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(terminalDebugStats().sessionCount).toBe(0);
    expect(Reflect.has(window, "__tdsfTerm")).toBe(false);

    const newer = vi.fn();
    Object.assign(window, { __tdsfTerm: newer });
    act(() => dispose());
    expect((window as unknown as { __tdsfTerm?: unknown }).__tdsfTerm).toBe(newer);
  });

  it("does not destroy sessions unless the simulated Vite dispose event fires", async () => {
    const transport = makeTransport("no-event");
    const openTransport = vi.fn(async (_handlers: Handlers) => transport);
    const hook = mount({ leafId: 33205, remote: true, transportKey: "ssh:no-event", openTransport });
    await waitFor(() => expect(openTransport).toHaveBeenCalledTimes(1));
    expect(terminalDebugStats().sessionCount).toBe(1);
    expect(transport.close).not.toHaveBeenCalled();
    hook.unmount();
    expect(terminalDebugStats().sessionCount).toBe(1);
    expect(transport.close).not.toHaveBeenCalled();
  });
});
