import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { setLeafSshSession } from "@/lib/param-complete-client";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TerminalPaneHandle } from "@/modules/terminal";
import { captureBlockOutputWithMeta, registerBlockOscHandlers, TerminalBlockCollector } from "@/modules/terminal/lib/terminalBlocks";
import { useTerminalBlocksStore } from "@/modules/terminal/lib/terminalBlocksStore";
import { RemoteShellIntegration } from "@/modules/terminal/lib/remoteShellIntegration";
import * as terminalSessions from "@/modules/terminal/lib/useTerminalSession";
import { useAiLiveBridge } from "./useAiLiveBridge";

const ipc = vi.fn<(name: string, args?: InvokeArgs) => unknown>();
const humanReply = vi.fn<() => unknown>();
const listeners = new Map<string, Set<number>>();
const disposers: (() => void)[] = [];
const request = { requestId: "vt-receipt", sessionId: 7, command: "printf TDSF_DONE", timeoutMs: 30000 };
const osc = (code: number, value: string) => `\x1b]${code};${value}\x07`;
const context = osc(633, "P;TdsfContext=0123456789abcdef0123456789abcdef;1234-11-22;root;/tmp");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pendingWrite() {
  type Report = { mode: "human" | "fallback"; stopped: boolean; warning: string | null };
  let resolve!: (report: Report) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Report>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function registerListeners(pause?: ReturnType<typeof deferred>, pausedName = "terminal:human_typing") {
  let firstMatch = true;
  ipc.mockImplementation(async (method, args) => {
    if (Array.isArray(args) || args instanceof ArrayBuffer || args instanceof Uint8Array) throw new Error("Unexpected positional IPC parameters");
    if (method === "plugin:event|listen") {
      const name = String(args?.event);
      const id = Number(args?.handler);
      const entries = listeners.get(name) ?? new Set<number>();
      entries.add(id);
      listeners.set(name, entries);
      if (name === pausedName && firstMatch && pause) {
        firstMatch = false;
        await pause.promise;
      }
      return id;
    }
    if (method === "plugin:event|unlisten") {
      listeners.get(String(args?.event))?.delete(Number(args?.eventId));
      return;
    }
    if (method === "ssh_write_human") return humanReply();
    if (method === "sidecar_visible_terminal_response") return;
    throw new Error(`Unexpected native method: ${method}`);
  });
  mockIPC(ipc);
}

async function auxiliaryListenersReady() {
  await waitFor(() => {
    expect(listeners.get("sidecar:update_todos")?.size).toBe(1);
    expect(listeners.get("sidecar:get-terminal-scrollback")?.size).toBe(1);
  });
}

async function emit(name: string, payload: unknown) {
  await act(async () => {
    const runtime = window as unknown as { __TAURI_INTERNALS__: { runCallback: (id: number, data: unknown) => void } };
    for (const id of [...(listeners.get(name) ?? [])]) runtime.__TAURI_INTERNALS__.runCallback(id, { event: name, id, payload });
  });
}

function responses() {
  return ipc.mock.calls.filter(([name]) => name === "sidecar_visible_terminal_response");
}

function mountBridge() {
  const term = new Terminal({ cols: 80, rows: 24 });
  let marker: ReturnType<Terminal["registerMarker"]> | undefined;
  const collector = new TerminalBlockCollector({
    sessionId: 11,
    resolveAuthor: (command) => useTerminalBlocksStore.getState().resolveAuthor(11, command),
    onExecStart: () => {
      useTerminalBlocksStore.getState().noteExecStarted(11);
      marker = term.registerMarker(0);
    },
    onOutputCapture: () => captureBlockOutputWithMeta(term, marker ?? null, null),
    onBlock: (block) => useTerminalBlocksStore.getState().pushBlock(block),
  });
  const integration = new RemoteShellIntegration({ onCwd: (cwd) => collector.setCwd(cwd), onContextChange: () => collector.switchContext() });
  integration.setConnection({ connectionId: "0123456789abcdef0123456789abcdef", bashHooksPath: "/tmp/hooks" });
  const stop = registerBlockOscHandlers(term, collector, integration.acceptFrame);
  const terminal = { write: vi.fn(), focus: vi.fn(), getBuffer: () => "" } as unknown as TerminalPaneHandle;
  const hook = renderHook(() => useAiLiveBridge({
    setLive: () => {}, activeId: 1, tabs: [], explorerRoot: null, launchCwd: null, home: null, wslDistro: null,
    openPreviewTab: () => {}, newAgentTab: () => ({ tabId: 0, leafId: 0 }),
    terminalRefs: { current: new Map([[11, terminal]]) }, getSshLeafId: () => 11,
  }));
  disposers.push(() => { stop(); term.dispose(); });
  return {
    ...hook,
    ready: async () => {
      await waitFor(() => expect(listeners.get("sidecar:visible-terminal-execute")?.size).toBe(1));
      await auxiliaryListenersReady();
    },
    output: async (data: string) => { await act(async () => { await new Promise<void>((resolve) => term.write(data, resolve)); }); },
  };
}

beforeEach(() => {
  listeners.clear();
  ipc.mockReset();
  humanReply.mockReset().mockReturnValue({ mode: "human", stopped: false, warning: null });
  registerListeners();
  setLeafSshSession(11, 7);
  useSshStore.setState({ sessions: [{ id: "receipt-session", rustSessionId: 7, state: "connected", params: { host: "192.0.2.7", port: 22, user: "root" } }] as never, activeSessionId: "receipt-session" });
  usePreferencesStore.setState({ agentExecutionChannel: "visible-terminal", agentTypingMode: "human" });
  useTerminalBlocksStore.setState({ blocksByLeaf: {}, agentPending: {}, execStartedAtByLeaf: {} });
});

afterEach(() => {
  cleanup();
  disposers.splice(0).forEach((dispose) => dispose());
  setLeafSshSession(11, null);
  listeners.clear();
  clearMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("visible SSH result receipts through the live bridge and real parser", () => {
  it("does not rearm timers when a fallback reply arrives after bridge cleanup", async () => {
    const reply = pendingWrite();
    humanReply.mockReturnValueOnce(reply.promise);
    const h = mountBridge();
    await h.ready();
    await emit("sidecar:visible-terminal-execute", request);
    h.unmount();
    expect(responses()).toHaveLength(1);
    expect(responses()[0][1]).toMatchObject({ result: { status: "indeterminate" } });
    vi.useFakeTimers();
    try {
      await act(async () => { reply.resolve({ mode: "fallback", stopped: false, warning: null }); await reply.promise; });
      expect(vi.getTimerCount()).toBe(0);
      expect(responses()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not clear the next command echo when a settled request rejects late", async () => {
    // Observe the real function; do not replace its implementation.
    const clearEcho = vi.spyOn(terminalSessions, "clearAgentCommandEcho");
    const reply = pendingWrite();
    humanReply.mockReturnValueOnce(reply.promise);
    const h = mountBridge();
    await h.ready();
    await h.output(context + osc(133, "A"));
    await emit("sidecar:visible-terminal-execute", request);
    await emit("terminal:human_typing", { phase: "end", target: "ssh", id: 7, mode: "human", stopped: false });
    await h.output(osc(633, "E;printf TDSF_DONE;42") + osc(133, "C") + "TDSF_DONE\r\n" + context + osc(133, "D;0") + osc(133, "A"));
    expect(responses()).toHaveLength(1);
    expect(responses()[0][1]).toMatchObject({ result: { status: "success", output: "TDSF_DONE" } });
    const next = { ...request, requestId: "vt-next", command: "printf TDSF_NEXT" };
    await emit("sidecar:visible-terminal-execute", next);
    expect(ipc.mock.calls.filter(([name]) => name === "ssh_write_human")).toHaveLength(2);
    await act(async () => { reply.reject(new Error("late reply fixture")); await reply.promise.catch(() => undefined); });
    expect(clearEcho).not.toHaveBeenCalled();
    expect(responses()).toHaveLength(1);
    await emit("terminal:human_typing", { phase: "end", target: "ssh", id: 7, mode: "human", stopped: false });
    await h.output(osc(633, "E;printf TDSF_NEXT;43") + osc(133, "C") + "TDSF_NEXT\r\n" + context + osc(133, "D;0") + osc(133, "A"));
    expect(responses()).toHaveLength(2);
    expect(responses()[1][1]).toMatchObject({ requestId: next.requestId, result: { status: "success", exitCode: 0, output: "TDSF_NEXT" } });
  });

  it("still reports an active injection failure and clears its own echo", async () => {
    const clearEcho = vi.spyOn(terminalSessions, "clearAgentCommandEcho");
    humanReply.mockImplementationOnce(() => Promise.reject(new Error("active reply fixture")));
    const h = mountBridge();
    await h.ready();
    await emit("sidecar:visible-terminal-execute", request);
    expect(clearEcho).toHaveBeenCalledTimes(1);
    expect(clearEcho).toHaveBeenCalledWith(11);
    expect(responses()).toHaveLength(1);
    expect(responses()[0][1]).toMatchObject({ requestId: request.requestId, result: { status: "unavailable", reason: "visible_terminal_injection_failed" } });
  });

  it.each(["before-output", "after-output"])("settles a fast command when typing end arrives %s", async (order) => {
    const h = mountBridge();
    await h.ready();
    await h.output(context + osc(133, "A"));
    await emit("sidecar:visible-terminal-execute", request);
    const ended = () => emit("terminal:human_typing", { phase: "end", target: "ssh", id: 7, mode: "human", stopped: false });
    if (order === "before-output") await ended();
    await h.output(osc(633, "E;printf TDSF_DONE;42") + osc(133, "C") + "TDSF_DONE\r\n" + context + osc(133, "D;0") + osc(133, "A"));
    if (order === "after-output") await ended();
    expect(responses()).toHaveLength(1);
    expect(responses()[0][1]).toMatchObject({ requestId: request.requestId, result: { status: "success", exitCode: 0, output: "TDSF_DONE" } });
    expect(ipc.mock.calls.filter(([name]) => name === "ssh_write_human")).toHaveLength(1);
  });

  it("does not infer a command result from visible text without completion markers", async () => {
    const h = mountBridge();
    await h.ready();
    await emit("sidecar:visible-terminal-execute", request);
    await emit("terminal:human_typing", { phase: "end", target: "ssh", id: 7, mode: "human", stopped: false });
    await h.output("TDSF_DONE\r\n");
    expect(responses()).toHaveLength(0);
    h.unmount();
    expect(responses()).toHaveLength(1);
    expect(responses()[0][1]).toMatchObject({ result: { status: "indeterminate" } });
  });

  it.each(["terminal:human_typing", "sidecar:visible-terminal-execute", "sidecar:update_todos", "sidecar:get-terminal-scrollback"])("releases late %s registration without accepting stale requests", async (name) => {
    const pause = deferred();
    registerListeners(pause, name);
    const h = mountBridge();
    await waitFor(() => expect(listeners.get(name)?.size).toBe(1));
    await auxiliaryListenersReady();
    h.unmount();
    await emit("sidecar:visible-terminal-execute", request);
    expect(ipc.mock.calls.filter(([method]) => method === "ssh_write_human")).toHaveLength(0);
    await act(async () => { pause.resolve(); await pause.promise; });
    await emit("sidecar:visible-terminal-execute", request);
    expect(ipc.mock.calls.filter(([method]) => method === "ssh_write_human")).toHaveLength(0);
    for (const handlers of listeners.values()) expect(handlers.size).toBe(0);
  });
});
