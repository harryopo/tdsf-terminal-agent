import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";

type NeedsYouCb = (payload: unknown) => void;
let needsYouCb: NeedsYouCb | null = null;

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
  onNeedsYou: vi.fn(async (cb: NeedsYouCb) => {
    needsYouCb = cb;
    return () => {};
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function approval(id = "ny-a", sessionId: string | null = "chat-a") {
  return {
    id,
    type: "approval",
    title: `Approval ${id}`,
    description: `Approval ${id}`,
    session_id: sessionId,
    status: "pending",
    extra: {
      command: "systemctl status nginx",
      semantic: `检查服务状态 ${id}`,
      explanation: `只读诊断 ${id}`,
      impact: {
        summary: `只读查看服务状态 ${id}`,
        max_risk_l: 1,
        segments: [{ category: "readonly", risk_l: 1 }],
      },
      risk_l: 1,
      tool_name: "ssh_command",
    },
  };
}

function question(id = "ny-q", sessionId: string | null = "chat-a", options: string[] = []) {
  return {
    id,
    type: "question",
    title: `Question ${id}`,
    description: `Question ${id}`,
    session_id: sessionId,
    status: "pending",
    extra: { question: `Question ${id}`, options, confirm_label: "确认并继续" },
  };
}

function created(req: ReturnType<typeof approval> | ReturnType<typeof question>) {
  return {
    event_type: "needs_you",
    payload: { needs_type: req.type, event: "created", request: req, title: req.title },
    session_id: req.session_id,
  };
}

function terminal(
  req: ReturnType<typeof approval> | ReturnType<typeof question>,
  event: "responded" | "cancelled" | "timeout",
) {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: req.type,
      event,
      request: { id: req.id, type: req.type, session_id: req.session_id, status: event },
    },
    session_id: req.session_id,
  };
}

function ack(
  req: ReturnType<typeof approval> | ReturnType<typeof question>,
  status: "approved" | "rejected" | "resolved",
) {
  return { id: req.id, type: req.type, session_id: req.session_id, status };
}

function emit(payload: unknown) {
  act(() => needsYouCb?.(payload));
}

async function mount() {
  render(<NeedsYouApprovalCards />);
  await waitFor(() => expect(onNeedsYou).toHaveBeenCalled());
  expect(needsYouCb).toBeTruthy();
}

function isPending(reqId: string) {
  return useNeedsYouWait.getState().pending.some((item) => item.reqId === reqId);
}

function approvalCardCount() {
  return document.querySelectorAll("[data-approval-card]").length;
}

function questionCardCount() {
  return document.querySelectorAll("[data-question-card]").length;
}

beforeEach(() => {
  vi.mocked(invokeRpc).mockReset();
  vi.mocked(invokeRpc).mockImplementation((method: string) =>
    method === "needs_you.list" ? Promise.resolve([]) : Promise.resolve({}),
  );
  vi.mocked(onNeedsYou).mockClear();
  needsYouCb = null;
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: "chat-a", sessionReadOnlyTrust: false });
});

afterEach(() => {
  cleanup();
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: null, sessionReadOnlyTrust: false });
  needsYouCb = null;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("NeedsYouApprovalCards response state", () => {
  it("shows approval submission state, disables its controls, and synchronously blocks duplicate clicks", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const req = approval();
    emit(created(req));

    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    fireEvent.click(screen.getByRole("button", { name: "执行" }));

    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.respond")).toHaveLength(1);
    expect(await screen.findByText(/正在提交确认/)).toBeTruthy();
    expect(
      [...document.querySelectorAll("[data-approval-card] button")].every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    await act(async () => response.resolve(ack(req, "approved")));
  });

  it("keeps reject note and all approval actions disabled until the rejection response is accepted", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    emit(created(approval()));
    fireEvent.click(await screen.findByRole("button", { name: "拒绝" }));
    const note = screen.getByPlaceholderText(/附言/);
    fireEvent.change(note, { target: { value: "稍后维护窗口再操作" } });
    fireEvent.click(screen.getByRole("button", { name: "确认拒绝" }));

    expect(await screen.findByText(/正在提交确认/)).toBeTruthy();
    expect((screen.getByPlaceholderText(/附言/) as HTMLTextAreaElement).disabled).toBe(true);
    expect(
      [...document.querySelectorAll("[data-approval-card] button")].every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: "ny-a",
      response: { approved: false, reason: "稍后维护窗口再操作", note: "稍后维护窗口再操作" },
    });
    await act(async () => response.resolve(ack(approval(), "rejected")));
    await waitFor(() => expect(approvalCardCount()).toBe(0));
  });

  it("shows answer submission, disables free text and submit, and blocks duplicate Enter", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const req = question();
    emit(created(req));
    const input = await screen.findByRole("textbox", { name: "回答" });
    fireEvent.change(input, { target: { value: "先检查日志" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.respond"),
    ).toHaveLength(1);
    expect(await screen.findByText(/正在提交回答/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "回答" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "确认并继续" }).hasAttribute("disabled")).toBe(true);
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: req.id,
      response: { answer: "先检查日志" },
    });
    await act(async () => response.resolve(ack(req, "resolved")));
  });

  it("disables selectable question options while an answer is being submitted", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const req = question("ny-options", "chat-a", ["NAT", "桥接"]);
    emit(created(req));
    fireEvent.click(await screen.findByRole("button", { name: "桥接" }));
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));

    expect(await screen.findByText(/正在提交回答/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "NAT" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "桥接" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "确认并继续" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => response.resolve(ack(req, "resolved")));
  });

  it("accepts an identity-matched approved response and settles the wait", async () => {
    await mount();
    const req = approval();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : Promise.resolve(ack(req, "approved")),
    );
    emit(created(req));
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));

    await waitFor(() => expect(approvalCardCount()).toBe(0));
    expect(isPending(req.id)).toBe(false);
  });

  it("accepts an identity-matched resolved answer response", async () => {
    await mount();
    const req = question();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : Promise.resolve(ack(req, "resolved")),
    );
    emit(created(req));
    fireEvent.change(await screen.findByRole("textbox", { name: "回答" }), {
      target: { value: "先检查日志" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));

    await waitFor(() => expect(questionCardCount()).toBe(0));
    expect(isPending(req.id)).toBe(false);
  });

  it.each([
    ["null", null],
    ["empty object", {}],
    ["wrong id", { id: "ny-other", type: "approval", session_id: "chat-a", status: "approved" }],
    ["wrong type", { id: "ny-a", type: "question", session_id: "chat-a", status: "approved" }],
    ["wrong session", { id: "ny-a", type: "approval", session_id: "chat-b", status: "approved" }],
    ["wrong status", { id: "ny-a", type: "approval", session_id: "chat-a", status: "resolved" }],
  ])("keeps approval pending and reports a %s business acknowledgement", async (_label, result) => {
    await mount();
    emit(created(approval()));
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : Promise.resolve(result),
    );
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    expect(isPending("ny-a")).toBe(true);
  });

  it("allows retrying an unanswered question after a null acknowledgement without rerunning a command", async () => {
    const req = question();
    let respondCount = 0;
    vi.mocked(invokeRpc).mockImplementation((method: string) => {
      if (method === "needs_you.list") return Promise.resolve([]);
      respondCount += 1;
      return Promise.resolve(respondCount === 1 ? null : ack(req, "resolved"));
    });
    await mount();
    emit(created(req));
    const input = await screen.findByRole("textbox", { name: "回答" });
    fireEvent.change(input, { target: { value: "先检查日志" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(isPending(req.id)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "确认并继续" }));
    await waitFor(() => expect(approvalCardCount()).toBe(0));
    expect(respondCount).toBe(2);
    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.respond")).toHaveLength(2);
    expect(vi.mocked(invokeRpc).mock.calls.every(([method]) => method === "needs_you.respond" || method === "needs_you.list")).toBe(true);
  });

  it("sets session trust only after an accepted approval acknowledgement for the current owner", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const req = approval();
    emit(created(req));
    fireEvent.click(await screen.findByRole("button", { name: "批准且本会话只读免审" }));

    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(false);
    expect(await screen.findByText(/正在提交确认/)).toBeTruthy();
    await act(async () => response.resolve(ack(req, "approved")));
    await waitFor(() => expect(useChatStore.getState().sessionReadOnlyTrust).toBe(true));
    expect(approvalCardCount()).toBe(0);
  });

  it("does not set trust when the response transport rejects", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    emit(created(approval()));
    fireEvent.click(await screen.findByRole("button", { name: "批准且本会话只读免审" }));
    await act(async () => response.reject(new Error("private transport detail")));

    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(false);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toContain("private transport detail");
    expect(isPending("ny-a")).toBe(true);
  });

  it("does not apply a late trust acknowledgement to another chat or disable its card", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const owner = approval("ny-owner", "chat-a");
    const other = approval("ny-other-chat", "chat-b");
    emit(created(owner));
    fireEvent.click(await screen.findByRole("button", { name: "批准且本会话只读免审" }));
    emit(created(other));

    act(() => useChatStore.setState({ activeSessionId: "chat-b", sessionReadOnlyTrust: false }));
    const otherButton = await screen.findByRole("button", { name: "执行" });
    expect((otherButton as HTMLButtonElement).disabled).toBe(false);
    await act(async () => response.resolve(ack(owner, "approved")));

    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(false);
    expect(approvalCardCount()).toBe(1);
    expect((screen.getByRole("button", { name: "执行" }) as HTMLButtonElement).disabled).toBe(false);
    expect(isPending(other.id)).toBe(true);
  });

  it("accepts an unknown-owner response by request identity but does not infer trust from the ack session", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const req = approval("ny-unknown-owner-ack", null);
    emit(created(req));
    fireEvent.click(await screen.findByRole("button", { name: "批准且本会话只读免审" }));
    await act(async () => response.resolve({ ...ack(req, "approved"), session_id: "chat-a" }));

    await waitFor(() => expect(approvalCardCount()).toBe(0));
    expect(isPending(req.id)).toBe(false);
    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(false);
  });

  it("applies a valid known-owner trust acknowledgement after a service responded event", async () => {
    const response = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    await mount();
    const req = approval("ny-responded-before-trust-ack", "chat-a");
    emit(created(req));
    fireEvent.click(await screen.findByRole("button", { name: "批准且本会话只读免审" }));
    emit(terminal(req, "responded"));

    expect(approvalCardCount()).toBe(0);
    expect(isPending(req.id)).toBe(false);
    await act(async () => response.resolve(ack(req, "approved")));

    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(true);
    expect(approvalCardCount()).toBe(0);
    expect(isPending(req.id)).toBe(false);
  });

  it("preserves responded, cancelled, and timeout terminal states when an in-flight RPC later rejects", async () => {
    await mount();
    for (const event of ["responded", "cancelled", "timeout"] as const) {
      const response = deferred<unknown>();
      vi.mocked(invokeRpc).mockImplementation((method: string) =>
        method === "needs_you.list" ? Promise.resolve([]) : response.promise,
      );
      const req = approval(`ny-${event}`);
      emit(created(req));
      fireEvent.click(await screen.findByRole("button", { name: "执行" }));
      emit(terminal(req, event));
      await act(async () => response.reject(new Error("late transport failure")));
      emit(created(req));

      expect(approvalCardCount()).toBe(0);
      expect(isPending(req.id)).toBe(false);
    }
  });

  it("preserves responded, cancelled, and timeout terminal states when an in-flight RPC resolves null", async () => {
    await mount();
    for (const event of ["responded", "cancelled", "timeout"] as const) {
      const response = deferred<unknown>();
      vi.mocked(invokeRpc).mockImplementation((method: string) =>
        method === "needs_you.list" ? Promise.resolve([]) : response.promise,
      );
      const req = approval(`ny-null-${event}`);
      emit(created(req));
      fireEvent.click(await screen.findByRole("button", { name: "执行" }));
      emit(terminal(req, event));
      await act(async () => response.resolve(null));
      emit(created(req));

      expect(approvalCardCount()).toBe(0);
      expect(isPending(req.id)).toBe(false);
    }
  });

  it("filters a terminal request from a delayed list snapshot while restoring another pending request", async () => {
    const list = deferred<unknown[]>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? list.promise : Promise.resolve({}),
    );
    await mount();
    const stale = approval("ny-list-stale");
    const fresh = approval("ny-list-fresh");
    emit(terminal(stale, "cancelled"));
    await act(async () => {
      list.resolve([stale, fresh]);
      await list.promise;
    });

    expect(approvalCardCount()).toBe(1);
    expect(await screen.findByText("只读诊断 ny-list-fresh")).toBeTruthy();
    expect(isPending(stale.id)).toBe(false);
    expect(isPending(fresh.id)).toBe(true);
  });
});
