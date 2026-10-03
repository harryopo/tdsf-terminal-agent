import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { Tool, type ToolProps } from "@/components/ai-elements/tool";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { NeedsYouApprovalFallback } from "../lib/needsYouApprovalContext";
import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";
import { useSshCommandOutputStore } from "../store/sshCommandOutputStore";

type NeedsYouCb = (payload: unknown) => void;
let needsYouCb: NeedsYouCb | null = null;

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
  onNeedsYou: vi.fn(async (cb: NeedsYouCb) => {
    needsYouCb = cb;
    return () => {};
  }),
}));

type CallOwner = {
  toolCallId: string;
  backendToolCallId: string;
  conversationSessionId: string | null;
  toolName: string;
  command: string;
  sshSessionId?: number;
  operationId?: string;
  toolInput?: Record<string, unknown>;
};

const primaryCall: CallOwner = {
  toolCallId: "sdk-call-a",
  backendToolCallId: "backend-call-a",
  conversationSessionId: "chat-a",
  toolName: "ssh_command",
  command: "systemctl status nginx",
  sshSessionId: 42,
};

function beginCall(call: CallOwner) {
  useSshCommandOutputStore.getState().begin(call);
  if (call.operationId) recordOperation(call, call.operationId);
}

function recordOperation(call: CallOwner, operationId: string) {
  if (call.sshSessionId === undefined) return;
  useSshCommandOutputStore.getState().record({
    toolCallId: call.backendToolCallId,
    conversationSessionId: call.conversationSessionId,
    toolName: call.toolName,
    command: call.command,
    sshSessionId: call.sshSessionId,
    stream: "status",
    chunk: "",
    status: "running",
    operationId,
  });
}

type RequestOverrides = {
  id?: string;
  sessionId?: string | null;
  backendToolCallId?: string | null;
  operationId?: string | null;
  sshSessionId?: number | string | null;
};

function approvalEvent(call = primaryCall, overrides: RequestOverrides = {}) {
  const choose = <T,>(key: keyof RequestOverrides, fallback: T): T =>
    Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key] as T
      : fallback;
  const id = overrides.id ?? "ny-inline";
  const sessionId = choose("sessionId", call.conversationSessionId);
  return {
    event_type: "needs_you",
    payload: {
      needs_type: "approval",
      event: "created",
      request: {
        id,
        type: "approval",
        session_id: sessionId,
        status: "pending",
        extra: {
          command: call.command,
          tool_name: call.toolName,
          tool_call_id: choose("backendToolCallId", call.backendToolCallId),
          operation_id: choose("operationId", "operation-ny-inline"),
          ssh_session_id: choose("sshSessionId", call.sshSessionId),
          semantic: "只读服务状态检查",
          explanation: "读取 nginx 当前状态",
          impact: {
            summary: "仅查看服务状态",
            max_risk_l: 1,
            segments: [{ category: "readonly", risk_l: 1 }],
          },
          risk_l: 1,
        },
      },
    },
    session_id: sessionId,
  };
}

function questionEvent(id = "ny-question") {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: "question",
      event: "created",
      request: {
        id,
        type: "question",
        session_id: "chat-a",
        status: "pending",
        extra: { question: "选择继续方式", options: ["检查", "跳过"] },
      },
    },
    session_id: "chat-a",
  };
}

function terminalEvent(event: "responded" | "cancelled" | "timeout", id = "ny-inline") {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: "approval",
      event,
      request: { id, type: "approval", session_id: "chat-a", status: event },
    },
    session_id: "chat-a",
  };
}

function ack(id: string, status: "approved" | "rejected") {
  return { id, type: "approval", session_id: "chat-a", status };
}

function ownerTree(
  calls: CallOwner[] = [],
  toolProps: Partial<Pick<ToolProps, "state" | "defaultOpen" | "onApprovalRespond">> = {},
) {
  return (
    <NeedsYouApprovalCards>
      {calls.map((call, index) => (
        <div key={`${call.toolCallId}-${index}`} data-testid={`tool-${index}`}>
          <Tool
            toolName={call.toolName}
            toolCallId={call.toolCallId}
            state={toolProps.state ?? "input-available"}
            defaultOpen={toolProps.defaultOpen}
            onApprovalRespond={toolProps.onApprovalRespond}
            input={call.toolInput ?? { command: call.command }}
          />
        </div>
      ))}
      <div data-testid="fallback-slot"><NeedsYouApprovalFallback /></div>
    </NeedsYouApprovalCards>
  );
}

function emit(event: unknown) {
  act(() => needsYouCb?.(event));
}

async function mount(calls: CallOwner[] = [], toolProps?: Parameters<typeof ownerTree>[1]) {
  const view = render(ownerTree(calls, toolProps));
  await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(1));
  return view;
}

function cardInTool(index = 0) {
  return screen.getByTestId(`tool-${index}`).querySelector("[data-approval-card]");
}

function fallbackCard() {
  return screen.getByTestId("fallback-slot").querySelector("[data-approval-card]");
}

function approvalCount() {
  return document.querySelectorAll("[data-approval-card]").length;
}

function isPending(id: string) {
  return useNeedsYouWait.getState().pending.some((item) => item.reqId === id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
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
  useSshCommandOutputStore.setState({ calls: {} });
});

afterEach(() => {
  cleanup();
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: null, sessionReadOnlyTrust: false });
  useSshCommandOutputStore.setState({ calls: {} });
  needsYouCb = null;
  vi.restoreAllMocks();
});

describe("NeedsYouApprovalCards inline ownership", () => {
  it("embeds one exact-owner request in the mounted Tool and subscribes/lists once", async () => {
    beginCall(primaryCall);
    await mount([primaryCall]);
    emit(approvalEvent(primaryCall, { sshSessionId: "42" }));

    await waitFor(() => expect(cardInTool()).not.toBeNull());
    expect(fallbackCard()).toBeNull();
    expect(approvalCount()).toBe(1);
    expect(isPending("ny-inline")).toBe(true);
    expect(onNeedsYou).toHaveBeenCalledTimes(1);
    expect(invokeRpc).toHaveBeenCalledTimes(1);
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.list", {});
  });

  it("embeds an exact-owner write_remote_file approval and keeps it actionable", async () => {
    const writeCall: CallOwner = {
      ...primaryCall,
      toolName: "write_remote_file",
      command: "",
      toolInput: { path: "/srv/app.conf", size: 12, backup_path: "/srv/app.conf.bak" },
    };
    beginCall(writeCall);
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list"
        ? Promise.resolve([])
        : Promise.resolve(ack("ny-inline", "approved")),
    );
    await mount([writeCall]);
    emit(approvalEvent(writeCall));

    await waitFor(() => expect(cardInTool()).not.toBeNull());
    expect(fallbackCard()).toBeNull();
    expect(approvalCount()).toBe(1);
    fireEvent.click(within(screen.getByTestId("tool-0")).getByRole("button", { name: "执行" }));
    await waitFor(() => expect(approvalCount()).toBe(0));
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: "ny-inline",
      response: { approved: true },
    });
  });

  it.each([
    {
      label: "different chat",
      owner: { conversationSessionId: "chat-b" },
      request: { sessionId: "chat-a" },
    },
    {
      label: "different SSH target",
      owner: {},
      request: { sshSessionId: 43 },
    },
    {
      label: "ended call",
      owner: {},
      request: {},
      ended: true,
    },
  ])("keeps a write_remote_file approval answerable in fallback for $label", async (mismatch) => {
    const writeCall: CallOwner = {
      ...primaryCall,
      toolName: "write_remote_file",
      command: "",
      toolInput: { path: "/srv/app.conf", size: 12 },
      ...mismatch.owner,
    };
    beginCall(writeCall);
    if (mismatch.ended === true) useSshCommandOutputStore.getState().finish(writeCall.toolCallId);
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list"
        ? Promise.resolve([])
        : Promise.resolve(ack("ny-inline", "approved")),
    );
    await mount([writeCall]);
    emit(approvalEvent(writeCall, mismatch.request));

    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(cardInTool()).toBeNull();
    expect(approvalCount()).toBe(1);
    fireEvent.click(within(screen.getByTestId("fallback-slot")).getByRole("button", { name: "执行" }));
    await waitFor(() => expect(approvalCount()).toBe(0));
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: "ny-inline",
      response: { approved: true },
    });
  });

  it("keeps an SSH-less Python approval answerable in fallback", async () => {
    const pythonCall: CallOwner = {
      ...primaryCall,
      toolName: "python_run",
      command: "print('local check')",
      sshSessionId: undefined,
      toolInput: { code: "print('local check')" },
    };
    beginCall(pythonCall);
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list"
        ? Promise.resolve([])
        : Promise.resolve(ack("ny-inline", "approved")),
    );
    await mount([pythonCall]);
    emit(approvalEvent(pythonCall, { sshSessionId: null }));

    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(cardInTool()).toBeNull();
    expect(approvalCount()).toBe(1);
    fireEvent.click(within(screen.getByTestId("fallback-slot")).getByRole("button", { name: "执行" }));
    await waitFor(() => expect(approvalCount()).toBe(0));
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: "ny-inline",
      response: { approved: true },
    });
  });

  it("handles request-first, late Tool mount, and Tool unmount back to fallback", async () => {
    beginCall(primaryCall);
    const view = await mount();
    emit(approvalEvent());
    expect(await screen.findByTestId("approval-command")).toBeTruthy();
    expect(fallbackCard()).not.toBeNull();

    view.rerender(ownerTree([primaryCall]));
    await waitFor(() => expect(cardInTool()).not.toBeNull());
    expect(fallbackCard()).toBeNull();
    view.rerender(ownerTree());
    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(approvalCount()).toBe(1);
  });

  it("binds same-command calls by backend identity, not command text", async () => {
    const first = { ...primaryCall, toolCallId: "sdk-a", backendToolCallId: "backend-a" };
    const second = { ...primaryCall, toolCallId: "sdk-b", backendToolCallId: "backend-b" };
    beginCall(first);
    beginCall(second);
    await mount([first, second]);
    emit(approvalEvent(first, { id: "ny-a" }));
    await waitFor(() => expect(cardInTool(0)).not.toBeNull());
    expect(cardInTool(1)).toBeNull();
    emit(terminalEvent("responded", "ny-a"));
    emit(approvalEvent(second, { id: "ny-b" }));
    await waitFor(() => expect(cardInTool(1)).not.toBeNull());
    expect(cardInTool(0)).toBeNull();
    expect(approvalCount()).toBe(1);
  });

  it.each([
    ["missing backend id", { backendToolCallId: null }],
    ["unrelated backend id", { backendToolCallId: "unrelated-call" }],
    ["unknown chat owner", { sessionId: null }],
    ["missing SSH target", { sshSessionId: null }],
    ["different SSH target", { sshSessionId: 43 }],
    ["operation conflict", { operationId: "other-operation" }],
  ])("keeps %s in fallback", async (label, overrides) => {
    const call = { ...primaryCall, ...(label === "operation conflict" ? { operationId: "known-operation" } : {}) };
    beginCall(call);
    await mount([call]);
    const operationId = call.operationId;
    if (operationId) act(() => recordOperation(call, operationId));
    emit(approvalEvent(primaryCall, overrides));

    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(cardInTool()).toBeNull();
    expect(approvalCount()).toBe(1);
  });

  it("does not bind a request to a Tool registered under another conversation", async () => {
    const call = { ...primaryCall, conversationSessionId: "chat-b" };
    beginCall(call);
    await mount([call]);
    emit(approvalEvent(primaryCall));

    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(cardInTool()).toBeNull();
  });

  it("keeps an ended call in fallback", async () => {
    beginCall(primaryCall);
    useSshCommandOutputStore.getState().finish(primaryCall.toolCallId);
    await mount([primaryCall]);
    emit(approvalEvent());

    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(cardInTool()).toBeNull();
  });

  it("falls back when duplicate Tool slots would create duplicate actions", async () => {
    beginCall(primaryCall);
    await mount([primaryCall, primaryCall]);
    emit(approvalEvent());

    await waitFor(() => expect(fallbackCard()).not.toBeNull());
    expect(cardInTool(0)).toBeNull();
    expect(cardInTool(1)).toBeNull();
    expect(approvalCount()).toBe(1);
  });

  it("keeps the inline approval visible when the real Tool details are collapsed", async () => {
    beginCall(primaryCall);
    await mount([primaryCall]);
    const tool = screen.getByTestId("tool-0");
    fireEvent.click(tool.querySelector("button")!);
    expect(tool.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    emit(approvalEvent());

    await waitFor(() => expect(cardInTool()).not.toBeNull());
    expect(tool.querySelector("button")?.getAttribute("data-state")).toBe("closed");
    expect(cardInTool()?.closest(".tdsf-collapsible-content")).toBeNull();
  });

  it("hides the approval for another active chat and restores it when returning", async () => {
    beginCall(primaryCall);
    await mount([primaryCall]);
    emit(approvalEvent());
    await waitFor(() => expect(cardInTool()).not.toBeNull());

    act(() => useChatStore.setState({ activeSessionId: "chat-b" }));
    await waitFor(() => expect(approvalCount()).toBe(0));
    act(() => useChatStore.setState({ activeSessionId: "chat-a" }));
    await waitFor(() => expect(cardInTool()).not.toBeNull());
    expect(approvalCount()).toBe(1);
  });

  it("preserves rejection draft while moving, failing, and retrying the response", async () => {
    const response = deferred<unknown>();
    beginCall(primaryCall);
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : response.promise,
    );
    const view = await mount([primaryCall]);
    emit(approvalEvent());
    await waitFor(() => expect(cardInTool()).not.toBeNull());
    fireEvent.click(within(screen.getByTestId("tool-0")).getByRole("button", { name: "拒绝" }));
    fireEvent.change(within(screen.getByTestId("tool-0")).getByPlaceholderText(/附言/), {
      target: { value: "稍后维护后再运行" },
    });
    fireEvent.click(within(screen.getByTestId("tool-0")).getByRole("button", { name: "确认拒绝" }));
    view.rerender(ownerTree());

    const fallback = screen.getByTestId("fallback-slot");
    const pendingNote = within(fallback).getByPlaceholderText(/附言/) as HTMLTextAreaElement;
    expect(pendingNote.value).toBe("稍后维护后再运行");
    expect(pendingNote.disabled).toBe(true);
    await act(async () => response.reject(new Error("offline")));
    expect(await within(fallback).findByRole("alert")).toBeTruthy();
    expect((within(fallback).getByPlaceholderText(/附言/) as HTMLTextAreaElement).value).toBe("稍后维护后再运行");
    expect((within(fallback).getByPlaceholderText(/附言/) as HTMLTextAreaElement).disabled).toBe(false);

    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : Promise.resolve({ ...ack("ny-inline", "rejected") }),
    );
    view.rerender(ownerTree([primaryCall]));
    await waitFor(() => expect(cardInTool()).not.toBeNull());
    expect((within(screen.getByTestId("tool-0")).getByPlaceholderText(/附言/) as HTMLTextAreaElement).value)
      .toBe("稍后维护后再运行");
    fireEvent.click(within(screen.getByTestId("tool-0")).getByRole("button", { name: "确认拒绝" }));
    await waitFor(() => expect(approvalCount()).toBe(0));
    expect(isPending("ny-inline")).toBe(false);
    expect(invokeRpc).toHaveBeenCalledTimes(3);
  });

  it.each(["cancelled", "timeout"] as const)("does not restore a %s request from a late list snapshot", async (event) => {
    const list = deferred<unknown[]>();
    vi.mocked(invokeRpc).mockImplementation(() => list.promise);
    beginCall(primaryCall);
    await mount([primaryCall]);
    const request = approvalEvent();
    emit(request);
    emit(terminalEvent(event));
    await act(async () => {
      list.resolve([(request.payload as { request: unknown }).request]);
      await list.promise;
    });

    expect(approvalCount()).toBe(0);
    expect(isPending("ny-inline")).toBe(false);
  });

  it("keeps questions answerable in the existing fallback instead of binding them as approvals", async () => {
    beginCall(primaryCall);
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list"
        ? Promise.resolve([])
        : Promise.resolve({ id: "ny-question", type: "question", session_id: "chat-a", status: "resolved" }),
    );
    await mount([primaryCall]);
    emit(questionEvent());

    const fallback = screen.getByTestId("fallback-slot");
    expect(await within(fallback).findByText("选择继续方式")).toBeTruthy();
    expect(fallback.querySelector("[data-question-card]")).not.toBeNull();
    expect(cardInTool()).toBeNull();
    const option = within(fallback).getByRole("button", { name: "检查" });
    fireEvent.click(option);
    const buttons = within(fallback).getAllByRole("button");
    expect(buttons[buttons.length - 1].hasAttribute("disabled")).toBe(false);
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(approvalCount()).toBe(0));
    expect(isPending("ny-question")).toBe(false);
    expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: "ny-question",
      response: { answer: "检查" },
    });
  });

  it("leaves the SDK's own approval callback separate from the needs_you fallback", async () => {
    const sdkRespond = vi.fn();
    beginCall(primaryCall);
    await mount([primaryCall], { state: "approval-requested", onApprovalRespond: sdkRespond });
    emit(approvalEvent());

    const tool = screen.getByTestId("tool-0");
    expect(tool.querySelector("[data-approval-card]")).not.toBeNull();
    expect(fallbackCard()).not.toBeNull();
    expect(approvalCount()).toBe(2);
    fireEvent.click(within(tool).getByRole("button", { name: "执行" }));
    expect(sdkRespond).toHaveBeenCalledWith({ approved: true });
    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.respond")).toHaveLength(0);
    expect(fallbackCard()).not.toBeNull();
  });

  it("does not re-read historical output while editing the current approval note", async () => {
    let statusReads = 0;
    const historicalOutput = {
      get status() {
        statusReads += 1;
        return "success";
      },
      stdout: "checked",
    };
    beginCall(primaryCall);
    render(
      <NeedsYouApprovalCards>
        <div data-testid="history-tool">
          <Tool
            toolName="ssh_command"
            toolCallId="historical-call"
            state="output-available"
            defaultOpen
            input={{ command: "systemctl status old-service" }}
            output={historicalOutput}
          />
        </div>
        <div data-testid="current-tool">
          <Tool
            toolName={primaryCall.toolName}
            toolCallId={primaryCall.toolCallId}
            state="input-available"
            input={{ command: primaryCall.command }}
          />
        </div>
        <NeedsYouApprovalFallback />
      </NeedsYouApprovalCards>,
    );
    await waitFor(() => expect(statusReads).toBeGreaterThan(0));
    expect(screen.getByTestId("history-tool").textContent).toContain("checked");

    emit(approvalEvent());
    const currentTool = screen.getByTestId("current-tool");
    await waitFor(() => expect(currentTool.querySelector("[data-approval-card]")).not.toBeNull());
    fireEvent.click(within(currentTool).getByRole("button", { name: "拒绝" }));
    const note = currentTool.querySelector("textarea");
    expect(note).not.toBeNull();

    statusReads = 0;
    fireEvent.change(note!, { target: { value: "保留当前拒绝说明" } });
    expect(statusReads).toBe(0);
  });
});
