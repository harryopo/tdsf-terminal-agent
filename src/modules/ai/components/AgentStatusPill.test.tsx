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
