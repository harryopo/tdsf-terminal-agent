import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeRpc, revealItemInDir } = vi.hoisted(() => ({ invokeRpc: vi.fn(), revealItemInDir: vi.fn() }));
vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));

import { ConfidencePanel } from "./ConfidencePanel";

const journal = (session_id: string, content = "journal entry") => ({
  ok: true, session_id, lines: [{ event_id: `${session_id}-event`, ts: 1, type: "tool_result", content }],
});
const evidence = [{ evidence_id: "ev-1", tool_name: "ssh_command", status: "success", detail: "evidence entry", result: "ok", agent: "agent", timestamp: 1 }];
const messages = (text = "conversation entry") => [{ id: `msg-${text}`, role: "user", parts: [{ type: "text", text }] }] as unknown as UIMessage[];
const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "置信度" }));
const panel = () => document.querySelector("[data-confidence-panel]") as HTMLElement;
const navButton = (name: string) => within(panel()).getByRole("button", { name });
const settleFetch = async () => waitFor(() => expect(invokeRpc).toHaveBeenCalled());

beforeEach(() => {
  vi.clearAllMocks();
  invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => method === "debug.agent_log_tail"
    ? journal(params.session_id)
    : method === "evidence.list" ? evidence : { ok: true, path: "diagnostics/current.json" });
  revealItemInDir.mockResolvedValue(undefined);
});

describe("ConfidencePanel real dialog interaction", () => {
  it("opens, switches views, searches, and shows selected detail", async () => {
    render(<ConfidencePanel sessionId="chat-a" messages={messages("needle conversation")} />);
    openPanel();
    await settleFetch();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(navButton("对话"));
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("needle conversation"));
    const search = within(panel()).getByRole("textbox");
    fireEvent.change(search, { target: { value: "does-not-match" } });
    expect(panel().querySelector('section[aria-label="记录列表"] p')?.textContent).toContain("没有匹配");
    fireEvent.change(search, { target: { value: "needle" } });
    fireEvent.click(await screen.findByRole("button", { name: /needle conversation/ }));
    expect(panel().textContent).toContain("needle conversation");
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(navButton("工具证据"));
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("evidence entry"));
  });

  it("distinguishes empty, source error, and loading states", async () => {
    invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => method === "debug.agent_log_tail"
      ? { ...journal(params.session_id), lines: [] } : evidence);
    const { rerender } = render(<ConfidencePanel sessionId="empty" messages={[]} />);
    openPanel();
    await settleFetch();
    await waitFor(() => expect(panel().querySelector('section[aria-label="记录列表"] p')?.textContent).toBe("当前会话暂无此类记录"));

    invokeRpc.mockImplementation(async (method: string) => method === "debug.agent_log_tail"
      ? ({ ok: false, session_id: "failed", lines: [] }) : evidence);
    rerender(<ConfidencePanel sessionId="failed" messages={[]} />);
    await waitFor(() => expect(within(panel()).getByRole("alert")).toBeTruthy());

    const pending = new Promise(() => {});
    invokeRpc.mockImplementation(() => pending);
    rerender(<ConfidencePanel sessionId="pending" messages={[]} />);
    expect(panel().textContent).toMatch(/正在读取|读取/);
  });

  it("shows unknown correlation counts when evidence failed for a journal call id", async () => {
    invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => method === "debug.agent_log_tail"
      ? { ...journal(params.session_id), lines: [{ event_id: "linked", ts: 1, type: "tool_result", content: "linked call output", meta: { tool_call_id: "call-1" } }] }
      : [{ invalid: true }]);
    render(<ConfidencePanel sessionId="chat-a" messages={[]} />);
    openPanel();
    await settleFetch();
    const row = await screen.findByRole("button", { name: /linked call output/ });
    fireEvent.click(row);
    await waitFor(() => expect(panel().textContent).toContain("未知"));
    expect(panel().textContent).not.toContain("call-1 0 次");
  });

  it("stops polling after close, ignores a late response, and never leaks old chat rows on switch", async () => {
    let finish!: (value: unknown) => void;
    invokeRpc.mockImplementation((method: string) => method === "debug.agent_log_tail"
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(evidence));
    const { rerender } = render(<ConfidencePanel sessionId="old-chat" messages={messages("old conversation")} />);
    openPanel();
    const close = within(panel()).getByRole("button", { name: "关闭置信度面板" });
    fireEvent.click(close);
    await act(async () => finish(journal("old-chat", "late old record")));
    expect(document.querySelector("[data-confidence-panel]")).toBeNull();
    expect(invokeRpc).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 3100));
    expect(invokeRpc).toHaveBeenCalledTimes(2);

    openPanel();
    rerender(<ConfidencePanel sessionId="new-chat" messages={messages("new conversation")} />);
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("debug.agent_log_tail", { session_id: "new-chat", lines: 200 }));
    expect(panel().textContent).not.toContain("old record");
    expect(panel().textContent).not.toContain("old conversation");
  });

  it("requires export confirmation, cancellation performs no RPC, and confirmed preview is frozen to this chat", async () => {
    const { rerender } = render(<ConfidencePanel sessionId="chat-a" messages={messages("snapshot A")} />);
    openPanel();
    await settleFetch();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(within(panel()).getByRole("button", { name: "导出日志" }));
    expect(panel().querySelector('[aria-label="确认导出日志"]')).toBeTruthy();
    const rpcBeforeCancel = invokeRpc.mock.calls.filter(([method]) => method === "debug.export_session_diagnostics").length;
    fireEvent.click(within(panel()).getByRole("button", { name: "取消" }));
    expect(invokeRpc.mock.calls.filter(([method]) => method === "debug.export_session_diagnostics")).toHaveLength(rpcBeforeCancel);

    fireEvent.click(within(panel()).getByRole("button", { name: "导出日志" }));
    rerender(<ConfidencePanel sessionId="chat-a" messages={messages("updated A")} />);
    fireEvent.click(within(panel()).getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("debug.export_session_diagnostics", expect.objectContaining({ session_id: "chat-a", snapshot: expect.objectContaining({ session_id: "chat-a", conversation: expect.arrayContaining([expect.objectContaining({ text: "snapshot A" })]) }) })));
    fireEvent.click(within(panel()).getByRole("button", { name: "关闭置信度面板" }));
    openPanel();
    fireEvent.click(navButton("对话"));
    await waitFor(() => expect(panel().textContent).toContain("updated A"));
    fireEvent.click(within(panel()).getByRole("button", { name: "关闭置信度面板" }));
    openPanel();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(within(panel()).getByRole("button", { name: "导出日志" }));
    rerender(<ConfidencePanel sessionId="chat-b" messages={messages("snapshot B")} />);
    expect(panel().querySelector('[aria-label="确认导出日志"]')).toBeNull();
  });

  it("reports save failures and handles Escape without consuming the parent window key handler", async () => {
    const parentKey = vi.fn();
    window.addEventListener("keydown", parentKey);
    render(<ConfidencePanel sessionId="chat-a" messages={messages()} />);
    const trigger = screen.getByRole("button", { name: "置信度" });
    openPanel();
    await settleFetch();
    await waitFor(() => expect(panel().querySelector("pre")?.textContent).toContain("journal entry"));
    fireEvent.click(within(panel()).getByRole("button", { name: "导出日志" }));
    invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => method === "debug.export_session_diagnostics"
      ? { ok: false, path: "" } : method === "debug.agent_log_tail" ? journal(params.session_id) : evidence);
    fireEvent.click(panel().querySelector('[aria-label="确认导出日志"] button:last-child')!);
    expect(await within(panel()).findByRole("alert")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("[data-confidence-panel]")).toBeNull();
    expect(parentKey).not.toHaveBeenCalled();
    expect(document.body.contains(trigger)).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    window.removeEventListener("keydown", parentKey);
  });
});
