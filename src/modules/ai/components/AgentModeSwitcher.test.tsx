/**
 * AgentModeSwitcher.test.tsx — 三档信任模式切换器 + Teach 开关测试
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 渲染三档（观察/确认/自动）+ 教学开关
 *   2. 默认 confirm 档激活（aria-checked）
 *   3. 点击档位 → chatStore.agentMode 更新 + 激活态跟随
 *   4. 点击教学 → chatStore.teach 切换 + aria-pressed 跟随
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useChatStore } from "../store/chatStore";
import { AgentModeSwitcher } from "./AgentModeSwitcher";

beforeEach(() => {
  // 重置 store（activeSessionId=null → setAgentMode/setTeach 不触会话持久化 IPC）
  useChatStore.setState({
    agentMode: "confirm",
    teach: false,
    sessions: [],
    activeSessionId: null,
  });
});

describe("AgentModeSwitcher — 渲染", () => {
  it("渲染三档模式按钮 + 教学开关", () => {
    render(<AgentModeSwitcher />);
    expect(screen.getByTestId("agent-mode-observe")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-confirm")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-auto")).toBeTruthy();
    expect(screen.getByTestId("agent-teach-toggle")).toBeTruthy();
  });

  it("默认 confirm 档激活（aria-checked），其余未激活", () => {
    render(<AgentModeSwitcher />);
    expect(
      screen.getByTestId("agent-mode-confirm").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("agent-mode-observe").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      screen.getByTestId("agent-mode-auto").getAttribute("aria-checked"),
    ).toBe("false");
  });
});

describe("AgentModeSwitcher — 交互", () => {
  it("点击观察档 → store.agentMode = observe，激活态跟随", () => {
    render(<AgentModeSwitcher />);
    fireEvent.click(screen.getByTestId("agent-mode-observe"));
    expect(useChatStore.getState().agentMode).toBe("observe");
    expect(
      screen.getByTestId("agent-mode-observe").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("agent-mode-confirm").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("点击教学开关 → store.teach 切换 + aria-pressed 跟随", () => {
    render(<AgentModeSwitcher />);
    const toggle = screen.getByTestId("agent-teach-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(useChatStore.getState().teach).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(useChatStore.getState().teach).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("教学开关与模式档位独立（教学不改变模式，符合叠加语义）", () => {
    render(<AgentModeSwitcher />);
    fireEvent.click(screen.getByTestId("agent-mode-auto"));
    fireEvent.click(screen.getByTestId("agent-teach-toggle"));
    expect(useChatStore.getState().agentMode).toBe("auto");
    expect(useChatStore.getState().teach).toBe(true);
  });
});
