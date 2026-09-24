/**
 * AgentStatusPill.test.tsx — T2 循环护栏：循环进度显示测试
 * -----------------------------------------------------------------------------
 * 覆盖（spec add-agent-loop-closure Task 2.3）:
 *   1. busy + loopProgress → 显示"第 N 轮 · 工具 M"
 *   2. 非 busy（idle）不显示循环进度
 *   3. busy 但 loopProgress 为 null（首轮尚未调工具）不显示
 *
 * 数据源：chatStore.agentMeta.loopProgress（sidecar:loop_progress 事件推流，
 * 事件链路在 sidecar-adapter.test.ts 覆盖，此处验证渲染层）
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { AgentStatusPill } from "./AgentStatusPill";
import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";

afterEach(() => {
  useChatStore.setState({
    agentMode: "confirm",
    teach: false,
    agentMeta: {
      status: "idle",
      step: null,
      approvalsPending: 0,
      error: null,
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      },
      lastInputTokens: 0,
      lastCachedTokens: 0,
      hitStepCap: false,
      compactionNotice: null,
      loopProgress: null,
    },
  });
});

describe("AgentStatusPill — 循环进度（T2）", () => {
  it("busy 期间显示第 N 轮 · 已用工具 M", () => {
    useChatStore.setState({
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "streaming",
        loopProgress: { round: 3, toolCount: 12 },
      },
    });
    render(<AgentStatusPill />);
    const progress = screen.getByTestId("agent-loop-progress");
    expect(progress.textContent).toContain("第 3 轮");
    expect(progress.textContent).toContain("工具 12");
  });

  it("idle 状态不显示循环进度", () => {
    useChatStore.setState({
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "idle",
        loopProgress: { round: 3, toolCount: 12 },
      },
    });
    render(<AgentStatusPill />);
    expect(screen.queryByTestId("agent-loop-progress")).toBeNull();
  });

  it("busy 但无进度（首轮未调工具）不显示", () => {
    useChatStore.setState({
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "thinking",
        loopProgress: null,
      },
    });
    render(<AgentStatusPill />);
    expect(screen.queryByTestId("agent-loop-progress")).toBeNull();
  });
});

// ============================================================================
// #133 等用户的时候不许宣称"我在跑"
// ----------------------------------------------------------------------------
// 审批挂着时 agentMeta.status 仍是 thinking/streaming（Python 的 mood 就是
// working），于是顶栏那颗点一直 emerald 闪、循环计数一直挂着"第 N 轮 · 工具 M"
// —— 和聊天区那行 Thinking… 是同一种谎。循环进度那格改成"等你确认"：
// 替换而不是追加，顶栏宽度是量过的（#103/#99），新串比旧串短才不会挤。
// ============================================================================
describe("AgentStatusPill — 等待事实（#133）", () => {
  afterEach(() => {
    useNeedsYouWait.getState().reset();
  });

  it("本会话审批挂着 → 循环进度那格改成「等你确认」", () => {
    useChatStore.setState({
      activeSessionId: "sess-a",
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "streaming",
        loopProgress: { round: 3, toolCount: 12 },
      },
    });
    useNeedsYouWait.getState().markPending("ny-1", "sess-a");
    render(<AgentStatusPill />);
    expect(screen.getByTestId("agent-awaiting-user").textContent).toContain(
      "等你确认",
    );
    expect(screen.queryByTestId("agent-loop-progress")).toBeNull();
  });

  it("等待时不再显示「运行中」的绿色脉冲（圆点改琥珀）", () => {
    useChatStore.setState({
      activeSessionId: "sess-a",
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "streaming",
      },
    });
    useNeedsYouWait.getState().markPending("ny-1", "sess-a");
    const { container } = render(<AgentStatusPill />);
    expect(container.innerHTML).not.toContain("animate-ping");
    expect(container.innerHTML).toContain("bg-amber-500");
  });

  it("没在等 → 脉冲与循环进度照旧（等待态不许粘住）", () => {
    useChatStore.setState({
      activeSessionId: "sess-a",
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "thinking",
        loopProgress: { round: 2, toolCount: 5 },
      },
    });
    const { container } = render(<AgentStatusPill />);
    expect(container.innerHTML).toContain("animate-ping");
    expect(screen.getByTestId("agent-loop-progress")).toBeTruthy();
    expect(screen.queryByTestId("agent-awaiting-user")).toBeNull();
  });

  it("别的会话挂着 → 本会话顶栏不受影响", () => {
    useChatStore.setState({
      activeSessionId: "sess-a",
      agentMeta: {
        ...useChatStore.getState().agentMeta,
        status: "thinking",
        loopProgress: { round: 2, toolCount: 5 },
      },
    });
    useNeedsYouWait.getState().markPending("ny-1", "sess-b");
    render(<AgentStatusPill />);
    expect(screen.queryByTestId("agent-awaiting-user")).toBeNull();
    expect(screen.getByTestId("agent-loop-progress")).toBeTruthy();
  });
});
