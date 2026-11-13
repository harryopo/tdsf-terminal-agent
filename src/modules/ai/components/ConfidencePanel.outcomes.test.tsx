import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../lib/sessionDiagnostics";

const { invokeRpc, revealItemInDir } = vi.hoisted(() => ({
  invokeRpc: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir }));

import { ConfidencePanel } from "./ConfidencePanel";

const sessionId = "diagnostic-outcome-session";
const callIds = {
  cancelled: "call-cancelled-01",
  indeterminate: "call-indeterminate-02",
  error: "call-error-03",
  success: "call-success-04",
} as const;
const events: RunEvent[] = [
  {
    event_id: "cancelled-result-event",
    ts: 1,
    type: "tool_result",
    content: JSON.stringify({ status: "cancelled", message: "user stopped" }),
    meta: {
      tool_name: "cancelled_tool",
      tool_call_id: callIds.cancelled,
      status: "completed",
    },
  },
  {
    event_id: "indeterminate-result-event",
    ts: 2,
    type: "tool_result",
    content: JSON.stringify({ status: "indeterminate", message: "result not confirmed" }),
    meta: {
      tool_name: "indeterminate_tool",
      tool_call_id: callIds.indeterminate,
      status: "completed",
    },
  },
  {
    event_id: "error-result-event",
    ts: 3,
    type: "tool_result",
    content: JSON.stringify({ status: "error", message: "command rejected" }),
    meta: {
      tool_name: "error_tool",
      tool_call_id: callIds.error,
      status: "completed",
    },
  },
  {
    event_id: "success-result-event",
    ts: 4,
    type: "tool_result",
    content: JSON.stringify({ status: "success", message: "command completed" }),
    meta: {
      tool_name: "success_tool",
      tool_call_id: callIds.success,
      status: "completed",
    },
  },
];
const evidence = [
  {
    evidence_id: "evidence-cancelled",
    tool_name: "cancelled_tool",
    status: "cancelled",
    result_status: "cancelled",
    detail: "cancelled invocation",
    result: "user stopped",
    agent: "synthetic-agent",
    timestamp: 1,
    tool_call_id: callIds.cancelled,
  },
  {
    evidence_id: "evidence-indeterminate",
    tool_name: "indeterminate_tool",
    status: "indeterminate",
    result_status: "indeterminate",
    detail: "indeterminate invocation",
    result: "completion not observed",
    exit_code: 17,
    agent: "synthetic-agent",
    timestamp: 2,
    tool_call_id: callIds.indeterminate,
  },
  {
    evidence_id: "evidence-error",
    tool_name: "error_tool",
    status: "error",
    result_status: "failed",
    detail: "error invocation",
    result: "command rejected",
    exit_code: 2,
    agent: "synthetic-agent",
    timestamp: 3,
    tool_call_id: callIds.error,
  },
  {
    evidence_id: "evidence-success",
    tool_name: "success_tool",
    status: "success",
    result_status: "success",
    detail: "successful invocation",
    result: "command completed",
    exit_code: 0,
    agent: "synthetic-agent",
    timestamp: 4,
    tool_call_id: callIds.success,
  },
];
const messages: UIMessage[] = [
  { id: "diagnostic-user-message", role: "user", parts: [{ type: "text", text: "synthetic diagnostic" }] },
] as unknown as UIMessage[];

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freezeDeep);
  }
  return value;
}

const log = (id: string, lines: RunEvent[] = events) => ({ ok: true, session_id: id, lines });
const panel = () => document.querySelector("[data-confidence-panel]") as HTMLElement;
const inPanel = () => within(panel());
const openPanel = () => fireEvent.click(screen.getByRole("button", { name: "置信度" }));
const switchView = (name: string) => fireEvent.click(inPanel().getByRole("button", { name }));
const selectRow = async (name: RegExp) => {
  fireEvent.click(await inPanel().findByRole("button", { name }));
};
const fieldValue = (label: string) => {
  const labelNode = inPanel().getByText(label, { exact: true });
  return labelNode.nextElementSibling?.textContent ?? "";
};

beforeEach(() => {
  vi.clearAllMocks();
  invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => {
    if (method === "debug.agent_log_tail") return log(params.session_id);
    if (method === "evidence.list") return freezeDeep(evidence);
    return { ok: true, path: "diagnostics/synthetic.json" };
  });
  revealItemInDir.mockResolvedValue(undefined);
});

describe("ConfidencePanel lifecycle and business outcomes", () => {
  it("preserves cancelled, indeterminate, error, and success through DOM correlation and confirmed export", async () => {
    const frozenEvents = freezeDeep(events);
    const frozenEvidence = freezeDeep(evidence);
    invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail") return log(params.session_id, frozenEvents);
      if (method === "evidence.list") return frozenEvidence;
      return { ok: true, path: "diagnostics/synthetic.json" };
    });

    render(<ConfidencePanel sessionId={sessionId} messages={messages} />);
    openPanel();
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledWith(
      "evidence.list", { session_id: sessionId },
    ));

    await selectRow(/cancelled_tool/);
    expect(fieldValue("记录状态")).toContain("completed");
    expect(panel().querySelector("pre")?.textContent).toContain('"status":"cancelled"');
    expect(panel().textContent).toContain(callIds.cancelled);
    expect(panel().textContent).toContain("1 条流程 · 1 条证据");

    await selectRow(/indeterminate_tool/);
    expect(fieldValue("记录状态")).toContain("completed");
    expect(panel().querySelector("pre")?.textContent).toContain('"status":"indeterminate"');

    switchView("工具证据");
    await selectRow(/cancelled invocation/);
    expect(fieldValue("工具状态")).toContain("cancelled");
    expect(fieldValue("业务状态")).toContain("cancelled");
    expect(fieldValue("退出码")).toContain("未采集");
    expect(panel().textContent).toContain(callIds.cancelled);
    expect(panel().textContent).toContain("1 条流程 · 1 条证据");

    await selectRow(/indeterminate invocation/);
    expect(fieldValue("工具状态")).toContain("indeterminate");
    expect(fieldValue("业务状态")).toContain("indeterminate");
    expect(fieldValue("退出码")).toContain("17");
    expect(panel().textContent).toContain(callIds.indeterminate);
    expect(panel().textContent).toContain("1 条流程 · 1 条证据");

    await selectRow(/error invocation/);
    expect(fieldValue("工具状态")).toContain("error");
    expect(fieldValue("业务状态")).toContain("failed");
    expect(fieldValue("退出码")).toContain("2");

    await selectRow(/successful invocation/);
    expect(fieldValue("工具状态")).toContain("success");
    expect(fieldValue("业务状态")).toContain("success");
    expect(fieldValue("退出码")).toContain("0");

    fireEvent.click(inPanel().getByRole("button", { name: "导出日志" }));
    expect(inPanel().getByRole("region", { name: "确认导出日志" })).toBeTruthy();
    fireEvent.click(inPanel().getByRole("button", { name: "确认保存 JSON" }));
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledWith(
      "debug.export_session_diagnostics",
      expect.objectContaining({ session_id: sessionId }),
    ));

    const [, exportParams] = invokeRpc.mock.calls.find(
      ([method]) => method === "debug.export_session_diagnostics",
    )!;
    const snapshot = exportParams.snapshot;
    const exportedEvents = snapshot.sources.journal.data.lines;
    const exportedEvidence = snapshot.sources.evidence.data;
    expect(exportedEvents.find((event: { event_id: string }) => event.event_id === "cancelled-result-event"))
      .toMatchObject({ meta: { status: "completed", tool_call_id: callIds.cancelled } });
    expect(exportedEvents.find((event: { event_id: string }) => event.event_id === "cancelled-result-event").content)
      .toContain('"status":"cancelled"');
    expect(exportedEvidence.find((item: { evidence_id: string }) => item.evidence_id === "evidence-cancelled"))
      .toMatchObject({ status: "cancelled", result_status: "cancelled", tool_call_id: callIds.cancelled });
    expect(exportedEvidence.find((item: { evidence_id: string }) => item.evidence_id === "evidence-cancelled"))
      .not.toHaveProperty("exit_code");
    expect(exportedEvidence.find((item: { evidence_id: string }) => item.evidence_id === "evidence-indeterminate"))
      .toMatchObject({ status: "indeterminate", result_status: "indeterminate", exit_code: 17 });
    expect(exportedEvidence.find((item: { evidence_id: string }) => item.evidence_id === "evidence-error"))
      .toMatchObject({ status: "error", result_status: "failed", exit_code: 2 });
    expect(exportedEvidence.find((item: { evidence_id: string }) => item.evidence_id === "evidence-success"))
      .toMatchObject({ status: "success", result_status: "success", exit_code: 0 });
    expect(frozenEvents[0].meta?.status).toBe("completed");
    expect(frozenEvidence[0]).not.toHaveProperty("exit_code");
    await waitFor(() => expect(panel().textContent).toContain("已保存：diagnostics/synthetic.json"));
  });

  it("does not synthesize a missing result or empty data when a source reports an error", async () => {
    const pendingOnly = [{
      event_id: "call-without-result",
      ts: 5,
      type: "tool_call",
      content: "synthetic command",
      meta: { tool_name: "pending_tool", tool_call_id: "call-pending-05", status: "started" },
    }];
    invokeRpc.mockImplementation(async (method: string, params: { session_id: string }) => {
      if (method === "debug.agent_log_tail" && params.session_id === "source-error") {
        return { ok: false, session_id: params.session_id, lines: [], error: "synthetic journal failure" };
      }
      if (method === "debug.agent_log_tail") return log(params.session_id, pendingOnly);
      if (method === "evidence.list") return [];
      return { ok: true, path: "diagnostics/unused.json" };
    });

    const { rerender } = render(<ConfidencePanel sessionId="pending-only" messages={messages} />);
    openPanel();
    await selectRow(/pending_tool/);
    expect(panel().querySelector("pre")?.textContent).toBe("synthetic command");
    expect(await inPanel().findByRole("button", { name: /调用工具.*pending_tool/ })).toBeTruthy();
    expect(invokeRpc.mock.calls.some(([method, params]) => method === "evidence.list" && params.session_id === "pending-only"))
      .toBe(true);
    switchView("工具证据");
    await waitFor(() => expect(inPanel().getByText("当前会话暂无此类记录", { exact: true })).toBeTruthy());

    rerender(<ConfidencePanel sessionId="source-error" messages={messages} />);
    switchView("运行流程");
    const sourceAlert = await inPanel().findByRole("alert");
    expect(sourceAlert.textContent).toContain("synthetic journal failure");
    expect(panel().textContent).not.toContain("当前会话暂无此类记录");
  });
});
