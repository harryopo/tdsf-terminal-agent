/**
 * AiChat.awaitingUser.test.tsx — 等用户的时候不许说"我在思考"（#133）
 * -----------------------------------------------------------------------------
 * 用户报的是"流式输出的时候卡卡的"。真机量下来不是渲染卡：审批挂起时 Python
 * 那边合法地停着等回答，前端界面上那行转圈却还写着 Thinking…（或上一步的
 * step 文本），看上去就像 AI 卡死了。界面在同一块地方同时给出"在思考"和
 * "等你确认"两种互相矛盾的宣称——这是 #118/#123 那一族病（一句话混两件事）。
 *
 * 判据取"等待优先"：只要本会话有 needs_you 挂着，转圈那行就必须改口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";

vi.mock("../store/chatRuntime", () => ({
  sendMessage: vi.fn(async () => true),
}));
vi.mock("../lib/evidence", () => ({
  evidenceLabel: () => null,
  evidenceTime: () => "",
  fetchEvidence: vi.fn(async () => []),
  groupEvidence: () => [],
}));
// 审批卡本体由 NeedsYouApprovalCards.test.tsx 覆盖；这里只验转圈那行的措辞
vi.mock("./NeedsYouApprovalCards", () => ({
  NeedsYouApprovalCards: () => null,
}));

import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";
import { AiChatView } from "./AiChat";

const userMsg = {
  id: "m-user",
  role: "user",
  parts: [{ type: "text", text: "看看这台机器负载" }],
} as unknown as UIMessage;

function renderBusy() {
  // status=streaming + 最后一条是 user → showSpinner 为真（转圈那行在屏上）
  render(
    <AiChatView
      messages={[userMsg]}
      status="streaming"
      error={undefined}
      clearError={vi.fn()}
      addToolApprovalResponse={vi.fn()}
      stop={vi.fn()}
    />,
  );
}

beforeEach(() => {
  useNeedsYouWait.getState().reset();
  useChatStore.setState({
    activeSessionId: "sess-a",
    agentMeta: { ...useChatStore.getState().agentMeta, step: null },
  });
});

describe("AiChatView — 等待事实反映到转圈那行（#133）", () => {
  it("没有审批挂着 → 仍然显示思考状态（等待文案不许常驻）", () => {
    renderBusy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText("等待你的确认")).toBeNull();
  });

  it("本会话审批挂着 → 说「等待你的确认」，不再谎报 Thinking…", () => {
    useNeedsYouWait.getState().markPending("ny-1", "sess-a");
    renderBusy();
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("step 已有文本时也优先说等待（否则显示的是上一步，比 Thinking… 更误导）", () => {
    useChatStore.setState({
      agentMeta: { ...useChatStore.getState().agentMeta, step: "Running" },
    });
    useNeedsYouWait.getState().markPending("ny-1", "sess-a");
    renderBusy();
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("结算之后回到思考文案（等待状态不许粘住）", () => {
    useNeedsYouWait.getState().markPending("ny-1", "sess-a");
    renderBusy();
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    // 必须走 act：这条用例证的正是"store 一变界面跟着变"这条订阅活着
    act(() => {
      useNeedsYouWait.getState().markSettled("ny-1");
    });
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText("等待你的确认")).toBeNull();
  });

  it("别的会话挂着 → 本会话照旧显示思考（不许串台）", () => {
    useNeedsYouWait.getState().markPending("ny-1", "sess-b");
    renderBusy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(screen.queryByText("等待你的确认")).toBeNull();
  });
});
