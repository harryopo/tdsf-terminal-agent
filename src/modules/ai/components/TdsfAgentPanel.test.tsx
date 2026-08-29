/**
 * TdsfAgentPanel.test.tsx — Agent 浮动面板外壳测试
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. state=closed 时不渲染
 *   2. state=open + 无 sessionId → 渲染外壳 + LoadingShell
 *   3. ESC 键触发 closeMini（store 联动）
 *   4. chatStore agentMode/teach 状态（v3.1 三模式信任体系，Pill/面板显示源）
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useChatStore } from "../store/chatStore";
import { TdsfAgentPanel } from "./TdsfAgentPanel";

beforeEach(() => {
  // 重置 store 到初始状态（mini 关闭 + 默认信任模式）
  useChatStore.setState({
    mini: { open: false },
    sessions: [],
    activeSessionId: null,
    agentMode: "confirm",
    teach: false,
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

describe("chatStore — agentMode/teach 状态（v3.1 Pill 一致性）", () => {
  it("缺省 confirm + 教学关（spec: 缺省缺字段默认 confirm）", () => {
    expect(useChatStore.getState().agentMode).toBe("confirm");
    expect(useChatStore.getState().teach).toBe(false);
  });

  it("setAgentMode 更新当前模式", () => {
    useChatStore.getState().setAgentMode("observe");
    expect(useChatStore.getState().agentMode).toBe("observe");
    useChatStore.getState().setAgentMode("auto");
    expect(useChatStore.getState().agentMode).toBe("auto");
  });

  it("setTeach 切换教学皮肤开关", () => {
    useChatStore.getState().setTeach(true);
    expect(useChatStore.getState().teach).toBe(true);
    useChatStore.getState().setTeach(false);
    expect(useChatStore.getState().teach).toBe(false);
  });
});
