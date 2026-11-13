import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeRpc } = vi.hoisted(() => ({ invokeRpc: vi.fn() }));
vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc }));

import { ConfidencePanel } from "./ConfidencePanel";

const journal = (session_id: string, content = "journal entry") => ({
  ok: true,
  session_id,
  lines: [{ event_id: `${session_id}-event`, ts: 1, type: "tool_result", content }],
});
const evidence = [{ evidence_id: "ev-1", tool_name: "ssh_command", status: "success", detail: "evidence entry", result: "ok", agent: "agent", timestamp: 1 }];
const messages = (text: string): UIMessage[] => [
  { id: `msg-${text}`, role: "user", parts: [{ type: "text", text }] },
] as unknown as UIMessage[];
const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "置信度" }));
const panel = () => document.querySelector("[data-confidence-panel]") as HTMLElement;
const inPanel = () => within(panel());
const exportCalls = () => invokeRpc.mock.calls.filter(([method]) => method === "debug.export_session_diagnostics");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function controlledRefreshTimers() {
  const timers = new Map<number, { callback: () => void; active: boolean }>();
  const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
  const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
  let nextId = -1;

  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 3000 && typeof callback === "function") {
      const id = nextId--;
      timers.set(id, { callback: () => callback(...args), active: true });
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((id?: number | ReturnType<typeof setTimeout>) => {
    const timer = typeof id === "number" ? timers.get(id) : undefined;
    if (timer) {
      timer.active = false;
      return;
    }
    originalClearTimeout(id);
  }) as typeof clearTimeout);

  return {
    activeCount: () => [...timers.values()].filter((timer) => timer.active).length,
    async runNext() {
      const timer = [...timers.values()].find((candidate) => candidate.active);
      expect(timer).toBeDefined();
      if (!timer) return;
      timer.active = false;
      await act(async () => timer.callback());
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => {
    if (method === "debug.agent_log_tail") return journal(params.session_id);
    if (method === "evidence.list") return evidence;
    return { ok: true, path: "diagnostics/current.json" };
  });
});

afterEach(() => vi.restoreAllMocks());

describe("ConfidencePanel asynchronous boundaries", () => {
  it("keeps the export snapshot stable while saving and allows a later chat snapshot", async () => {
    const firstSave = deferred<{ ok: boolean; path: string }>();
    let saveCount = 0;
    invokeRpc.mockImplementation((method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail") return Promise.resolve(journal(params.session_id));
      if (method === "evidence.list") return Promise.resolve(evidence);
      saveCount += 1;
      return saveCount === 1 ? firstSave.promise : Promise.resolve({ ok: true, path: "diagnostics/chat-b.json" });
    });
    const { rerender } = render(<ConfidencePanel sessionId="chat-a" messages={messages("snapshot A")} />);
    openPanel();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(inPanel().getByRole("button", { name: "导出日志" }));
    rerender(<ConfidencePanel sessionId="chat-a" messages={messages("snapshot B")} />);

    const confirm = inPanel().getByRole("button", { name: "确认保存 JSON" });
    fireEvent.click(confirm);
    await waitFor(() => expect(exportCalls()).toHaveLength(1));
    expect(exportCalls()[0][1]).toMatchObject({ snapshot: { conversation: [{ text: "snapshot A" }] } });

    // Saving must not allow replacement of the confirmed preview.
    const exportEntry = inPanel().getByRole("button", { name: "导出日志" }) as HTMLButtonElement;
    expect(exportEntry.disabled).toBe(true);
    fireEvent.click(exportEntry);
    expect(exportCalls()).toHaveLength(1);
    expect(inPanel().getByRole("region", { name: "确认导出日志" })).toBeTruthy();

    await act(async () => firstSave.resolve({ ok: true, path: "diagnostics/chat-a.json" }));
    await waitFor(() => expect(panel().textContent).toContain("已保存：diagnostics/chat-a.json"));
    expect(panel().querySelector('[aria-label="确认导出日志"]')).toBeNull();
    expect(exportEntry.disabled).toBe(false);

    fireEvent.click(exportEntry);
    fireEvent.click(inPanel().getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(exportCalls()).toHaveLength(2));
    expect(exportCalls()[1][1]).toMatchObject({ snapshot: { conversation: [{ text: "snapshot B" }] } });
    await waitFor(() => expect(panel().textContent).toContain("已保存：diagnostics/chat-b.json"));
  });

  it("restores export controls after failure and retries the original preview", async () => {
    const failedSave = deferred<{ ok: boolean; path: string }>();
    let saveCount = 0;
    invokeRpc.mockImplementation((method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail") return Promise.resolve(journal(params.session_id));
      if (method === "evidence.list") return Promise.resolve(evidence);
      saveCount += 1;
      return saveCount === 1
        ? failedSave.promise
        : Promise.resolve({ ok: true, path: "diagnostics/retry.json" });
    });
    const { rerender } = render(<ConfidencePanel sessionId="chat-a" messages={messages("snapshot A")} />);
    openPanel();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(inPanel().getByRole("button", { name: "导出日志" }));
    fireEvent.click(inPanel().getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(exportCalls()).toHaveLength(1));
    await act(async () => failedSave.reject(new Error("export unavailable")));
    await screen.findByRole("alert");

    expect((inPanel().getByRole("button", { name: "确认保存 JSON" }) as HTMLButtonElement).disabled).toBe(false);
    expect((inPanel().getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(false);
    expect((inPanel().getByRole("button", { name: "导出日志" }) as HTMLButtonElement).disabled).toBe(false);
    rerender(<ConfidencePanel sessionId="chat-a" messages={messages("snapshot B")} />);
    fireEvent.click(inPanel().getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(exportCalls()).toHaveLength(2));
    expect(exportCalls()[1][1]).toMatchObject({ snapshot: { conversation: [{ text: "snapshot A" }] } });
    await waitFor(() => expect(panel().textContent).toContain("已保存：diagnostics/retry.json"));

    fireEvent.click(inPanel().getByRole("button", { name: "导出日志" }));
    const callsBeforeCancel = exportCalls().length;
    fireEvent.click(inPanel().getByRole("button", { name: "取消" }));
    expect(exportCalls()).toHaveLength(callsBeforeCancel);
    expect(panel().querySelector('[aria-label="确认导出日志"]')).toBeNull();
  });

  it.each(["success", "failure"] as const)("does not let an old chat %s export affect the new chat", async (outcome) => {
    const oldSave = deferred<{ ok: boolean; path: string }>();
    invokeRpc.mockImplementation((method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail") return Promise.resolve(journal(params.session_id));
      if (method === "evidence.list") return Promise.resolve(evidence);
      if (params.session_id === "chat-a") return oldSave.promise;
      return Promise.resolve({ ok: true, path: "diagnostics/chat-b.json" });
    });
    const { rerender } = render(<ConfidencePanel sessionId="chat-a" messages={messages("snapshot A")} />);
    openPanel();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(inPanel().getByRole("button", { name: "导出日志" }));
    fireEvent.click(inPanel().getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(exportCalls()).toHaveLength(1));

    rerender(<ConfidencePanel sessionId="chat-b" messages={messages("snapshot B")} />);
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("debug.agent_log_tail", { session_id: "chat-b", lines: 200 }));
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    await act(async () => {
      if (outcome === "success") oldSave.resolve({ ok: true, path: "diagnostics/old-chat.json" });
      else oldSave.reject(new Error("old chat export failed"));
    });
    expect(panel().textContent).not.toContain("diagnostics/old-chat.json");
    expect(panel().textContent).not.toContain("old chat export failed");
    expect(panel().querySelector('[aria-label="确认导出日志"]')).toBeNull();
    expect(within(panel()).queryByRole("alert")).toBeNull();

    fireEvent.click(inPanel().getByRole("button", { name: "导出日志" }));
    fireEvent.click(inPanel().getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(exportCalls()).toHaveLength(2));
    expect(exportCalls()[1][1]).toMatchObject({ session_id: "chat-b", snapshot: { conversation: [{ text: "snapshot B" }] } });
    await waitFor(() => expect(panel().textContent).toContain("已保存：diagnostics/chat-b.json"));
  });

  it("waits for each read before scheduling another, pauses after the current read, and resumes polling", async () => {
    const firstRead = deferred<ReturnType<typeof journal>>();
    const secondRead = deferred<ReturnType<typeof journal>>();
    let journalReads = 0;
    const timers = controlledRefreshTimers();
    invokeRpc.mockImplementation((method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail") {
        journalReads += 1;
        if (journalReads === 1) return firstRead.promise;
        if (journalReads === 2) return secondRead.promise;
        return Promise.resolve(journal(params.session_id));
      }
      return Promise.resolve(evidence);
    });
    render(<ConfidencePanel sessionId="chat-a" messages={messages("conversation")} />);
    openPanel();
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledTimes(2));
    expect(timers.activeCount()).toBe(0);
    await act(async () => firstRead.resolve(journal("chat-a", "first read")));
    await waitFor(() => expect(panel().textContent).toContain("first read"));
    await waitFor(() => expect(timers.activeCount()).toBe(1));

    await timers.runNext();
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledTimes(4));
    expect(timers.activeCount()).toBe(0);
    await act(async () => secondRead.resolve(journal("chat-a", "second read")));
    await waitFor(() => expect(panel().textContent).toContain("second read"));
    await waitFor(() => expect(timers.activeCount()).toBe(1));

    fireEvent.click(inPanel().getByRole("button", { name: "自动刷新" }));
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(panel().textContent).toContain("已暂停刷新"));
    expect(timers.activeCount()).toBe(0);

    fireEvent.click(inPanel().getByRole("button", { name: "已暂停刷新" }));
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledTimes(8));
    await waitFor(() => expect(timers.activeCount()).toBe(1));
  });

  it("keeps evidence visible through a journal error and recovers on manual refresh", async () => {
    let journalReads = 0;
    invokeRpc.mockImplementation((method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail") {
        journalReads += 1;
        return Promise.resolve(journalReads === 1
          ? { ok: false, session_id: params.session_id, lines: [] }
          : journal(params.session_id, "journal recovered"));
      }
      return Promise.resolve(evidence);
    });
    render(<ConfidencePanel sessionId="chat-a" messages={messages("conversation")} />);
    openPanel();
    await screen.findByRole("alert");
    fireEvent.click(inPanel().getByRole("button", { name: "工具证据" }));
    await waitFor(() => expect(panel().textContent).toContain("evidence entry"));

    fireEvent.click(inPanel().getByRole("button", { name: "刷新运行记录" }));
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledTimes(4));
    fireEvent.click(inPanel().getByRole("button", { name: "运行流程" }));
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal recovered"));
    expect(within(panel()).queryByRole("alert")).toBeNull();
  });
});
