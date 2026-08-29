/**
 * AgentModeSwitcher.test.tsx — 四档信任模式切换器测试（v3.1.3）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 渲染四档（观察/确认/自动/教学）
 *   2. 默认 confirm 档激活（aria-checked）
 *   3. 点击档位 → chatStore.agentMode 更新 + 激活态跟随
 *   4. 教学档联动 teach 布尔（选中 teach=true，切回其他档 teach=false）
 *   5. 当前档位区别说明（agent-mode-hint 随档位更新）
 *   6. 逐字快捷开关已移除（设置页统一管理）
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { toSidecarMode } from "../agents/registry";
import { useChatStore } from "../store/chatStore";
import { AgentModeSwitcher } from "./AgentModeSwitcher";

beforeEach(() => {
  // 重置 store（activeSessionId=null → setAgentMode 不触会话持久化 IPC）
  useChatStore.setState({
    agentMode: "confirm",
    teach: false,
    sessions: [],
    activeSessionId: null,
  });
});

describe("AgentModeSwitcher — 渲染", () => {
  it("渲染四档模式按钮（观察/确认/自动/教学）", () => {
    render(<AgentModeSwitcher />);
    expect(screen.getByTestId("agent-mode-observe")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-confirm")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-auto")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-teach")).toBeTruthy();
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
    expect(
      screen.getByTestId("agent-mode-teach").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("渲染当前档位区别说明行（agent-mode-hint）", () => {
    render(<AgentModeSwitcher />);
    const hint = screen.getByTestId("agent-mode-hint");
    expect(hint.textContent).toContain("确认");
    expect(hint.textContent).toContain("写操作逐条审批后执行");
  });

  it("旧版「教学/逐字」独立开关已移除（教学入四档、逐字归设置页）", () => {
    render(<AgentModeSwitcher />);
    expect(screen.queryByTestId("agent-teach-toggle")).toBeNull();
    expect(screen.queryByTestId("agent-typing-toggle")).toBeNull();
  });
});

describe("AgentModeSwitcher — 交互", () => {
  it("点击观察档 → store.agentMode = observe，激活态跟随", () => {
    render(<AgentModeSwitcher />);
    fireEvent.click(screen.getByTestId("agent-mode-observe"));
    expect(useChatStore.getState().agentMode).toBe("observe");
    expect(useChatStore.getState().teach).toBe(false);
    expect(
      screen.getByTestId("agent-mode-observe").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("agent-mode-confirm").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("点击教学档 → agentMode = teach 且联动 teach=true", () => {
    render(<AgentModeSwitcher />);
    fireEvent.click(screen.getByTestId("agent-mode-teach"));
    expect(useChatStore.getState().agentMode).toBe("teach");
    expect(useChatStore.getState().teach).toBe(true);
    expect(
      screen.getByTestId("agent-mode-teach").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("教学档切回其他档 → teach 自动复位 false", () => {
    render(<AgentModeSwitcher />);
    fireEvent.click(screen.getByTestId("agent-mode-teach"));
    expect(useChatStore.getState().teach).toBe(true);
    fireEvent.click(screen.getByTestId("agent-mode-auto"));
    expect(useChatStore.getState().agentMode).toBe("auto");
    expect(useChatStore.getState().teach).toBe(false);
  });

  it("档位说明行随档位切换更新（教学档显示教学区别）", () => {
    render(<AgentModeSwitcher />);
    fireEvent.click(screen.getByTestId("agent-mode-teach"));
    const hint = screen.getByTestId("agent-mode-hint");
    expect(hint.textContent).toContain("教学");
    expect(hint.textContent).toContain("概念/示例/易错点/练习");
  });
});

describe("toSidecarMode — 四档 → sidecar 三模式 + teach 布尔映射", () => {
  it("教学档展开为 observe + teach=true", () => {
    expect(toSidecarMode("teach")).toEqual({
      agentMode: "observe",
      teach: true,
    });
  });

  it("其余三档透传且 teach=false", () => {
    expect(toSidecarMode("observe")).toEqual({
      agentMode: "observe",
      teach: false,
    });
    expect(toSidecarMode("confirm")).toEqual({
      agentMode: "confirm",
      teach: false,
    });
    expect(toSidecarMode("auto")).toEqual({ agentMode: "auto", teach: false });
  });
});
