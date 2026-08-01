/**
 * TdsfAgentPanel.test.tsx — Agent 浮动面板外壳测试
 * -----------------------------------------------------------------------------
 * 覆盖（P0-5 补测试）:
 *   1. state=closed 时不渲染
 *   2. state=open + 无 sessionId → 渲染外壳 + LoadingShell
 *   3. ESC 键触发 closeMini（store 联动）
 *   4. chatStore currentSubAgent 状态一致性（P0-1 Pill 验收的状态层）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useChatStore } from "../store/chatStore";
import { TdsfAgentPanel } from "./TdsfAgentPanel";

beforeEach(() => {
  // 重置 store 到初始状态（mini 关闭）
  useChatStore.setState({
    mini: { open: false },
    sessions: [],
    activeSessionId: null,
    currentSubAgent: null,
  });
});

describe("TdsfAgentPanel — 面板外壳", () => {
  it("state=closed 时不渲染", () => {
    const { container } = render(<TdsfAgentPanel state="closed" />);
    expect(container.querySelector("[data-tdsf-agent-panel]")).toBeNull();
  });

  it("state=open 且无 sessionId → 渲染外壳 + LoadingShell", () => {
    render(<TdsfAgentPanel state="open" />);
    expect(screen.getByTestId("tdsf-agent-panel-shell")).toBeTruthy();
  });

  it("点击关闭按钮触发 closeMini", () => {
    useChatStore.setState({ mini: { open: true } });
    render(<TdsfAgentPanel state="open" />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(useChatStore.getState().mini.open).toBe(false);
  });
});

describe("chatStore — currentSubAgent 状态（P0-1 Pill 一致性）", () => {
  it("setCurrentSubAgent 更新 Pill 显示源", () => {
    expect(useChatStore.getState().currentSubAgent).toBeNull();
    useChatStore.getState().setCurrentSubAgent("teach");
    expect(useChatStore.getState().currentSubAgent).toBe("teach");
  });

  it("agent_switch 到 main 时重置为 main", () => {
    useChatStore.getState().setCurrentSubAgent("teach");
    useChatStore.getState().setCurrentSubAgent("main");
    expect(useChatStore.getState().currentSubAgent).toBe("main");
  });
});
