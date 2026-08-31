/**
 * AgentModeSwitcher.test.tsx — 四档信任模式折叠选择器测试（v3.1.4）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 默认收起：只有触发按钮（当前模式），面板不渲染
 *   2. 点击触发按钮 → 面板展开，渲染四档（观察/确认/自动/教学）
 *   3. 默认 confirm 档激活（aria-checked）
 *   4. 面板内每档带描述文字（原底部 hint 行已移除，描述移入面板）
 *   5. 点击档位 → chatStore.agentMode 更新 + 面板关闭 + 重开激活态跟随
 *   6. 教学档联动 teach 布尔（选中 teach=true，切回其他档 teach=false）
 *   7. 逐字快捷开关已移除（设置页统一管理）
 *   8. Escape 关闭面板
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

/** 打开折叠面板（点击触发按钮） */
function openMenu() {
  fireEvent.click(screen.getByTestId("agent-mode-trigger"));
}

describe("AgentModeSwitcher — 渲染", () => {
  it("默认收起：触发按钮显示当前模式，面板不渲染", () => {
    render(<AgentModeSwitcher />);
    expect(screen.getByTestId("agent-mode-trigger").textContent).toContain(
      "确认",
    );
    expect(screen.queryByTestId("agent-mode-menu")).toBeNull();
  });

  it("点击触发按钮 → 面板展开，渲染四档模式（观察/确认/自动/教学）", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    expect(screen.getByTestId("agent-mode-menu")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-observe")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-confirm")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-auto")).toBeTruthy();
    expect(screen.getByTestId("agent-mode-teach")).toBeTruthy();
  });

  it("默认 confirm 档激活（aria-checked），其余未激活", () => {
    render(<AgentModeSwitcher />);
    openMenu();
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

  it("面板内每档带描述文字（描述从底部 hint 行移入面板）", () => {
    render(<AgentModeSwitcher />);
    expect(screen.queryByTestId("agent-mode-hint")).toBeNull();
    openMenu();
    const menu = screen.getByTestId("agent-mode-menu");
    expect(menu.textContent).toContain("写操作逐条审批后执行");
    expect(menu.textContent).toContain("只读分析，不执行任何写操作");
  });

  it("旧版「教学/逐字」独立开关已移除（教学入四档、逐字归设置页）", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    expect(screen.queryByTestId("agent-teach-toggle")).toBeNull();
    expect(screen.queryByTestId("agent-typing-toggle")).toBeNull();
  });
});

describe("AgentModeSwitcher — 交互", () => {
  it("点击观察档 → store.agentMode = observe，面板关闭，重开后激活态跟随", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    fireEvent.click(screen.getByTestId("agent-mode-observe"));
    expect(useChatStore.getState().agentMode).toBe("observe");
    expect(useChatStore.getState().teach).toBe(false);
    // 选中后面板关闭
    expect(screen.queryByTestId("agent-mode-menu")).toBeNull();
    // 重开验证激活态跟随
    openMenu();
    expect(
      screen.getByTestId("agent-mode-observe").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByTestId("agent-mode-confirm").getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("点击教学档 → agentMode = teach 且联动 teach=true", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    fireEvent.click(screen.getByTestId("agent-mode-teach"));
    expect(useChatStore.getState().agentMode).toBe("teach");
    expect(useChatStore.getState().teach).toBe(true);
    openMenu();
    expect(
      screen.getByTestId("agent-mode-teach").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("教学档切回其他档 → teach 自动复位 false", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    fireEvent.click(screen.getByTestId("agent-mode-teach"));
    expect(useChatStore.getState().teach).toBe(true);
    openMenu();
    fireEvent.click(screen.getByTestId("agent-mode-auto"));
    expect(useChatStore.getState().agentMode).toBe("auto");
    expect(useChatStore.getState().teach).toBe(false);
  });

  it("Escape 键关闭面板", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    expect(screen.getByTestId("agent-mode-menu")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("agent-mode-menu")).toBeNull();
  });

  it("再次点击触发按钮收起面板", () => {
    render(<AgentModeSwitcher />);
    openMenu();
    expect(screen.getByTestId("agent-mode-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("agent-mode-trigger"));
    expect(screen.queryByTestId("agent-mode-menu")).toBeNull();
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
