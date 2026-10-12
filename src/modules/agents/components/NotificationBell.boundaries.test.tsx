import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../store/agentStore";
import { NotificationBell } from "./NotificationBell";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(false),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  invoke.mockClear();
  useAgentStore.setState({ sessions: {}, localAgent: null, notifications: [] });
});
afterEach(() => {
  cleanup();
  useAgentStore.setState({ sessions: {}, localAgent: null, notifications: [] });
});

describe("notification bell boundaries", () => {
  it("opens actual notifications without a legacy installer or hooks RPC", () => {
    render(<NotificationBell onActivate={vi.fn()} onActivateLocal={vi.fn()} />);
    fireEvent.click(screen.getByTestId("header-notification-bell"));
    expect(screen.getByText(/暂无智能体活动/)).toBeTruthy();
    expect(screen.queryByText("智能体提醒")).toBeNull();
    expect(screen.queryByRole("button", { name: "启用" })).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps waiting navigation and completion notifications readable and clearable", () => {
    useAgentStore.getState().start(7, 3, "tdsf");
    useAgentStore.getState().setStatus(7, "waiting");
    useAgentStore
      .getState()
      .pushNotification({
        source: "terminal",
        leafId: 8,
        tabId: 4,
        agent: "tdsf",
        kind: "finished",
      });
    const activate = vi.fn();
    render(
      <NotificationBell onActivate={activate} onActivateLocal={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("header-notification-bell"));
    expect(useAgentStore.getState().notifications[0].read).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /等待输入/ }));
    expect(activate).toHaveBeenCalledWith(3, 7);
    fireEvent.click(screen.getByTestId("header-notification-bell"));
    fireEvent.click(screen.getByRole("button", { name: /已完成/ }));
    expect(activate).toHaveBeenCalledWith(4, 8);
    fireEvent.click(screen.getByTestId("header-notification-bell"));
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(useAgentStore.getState().notifications).toEqual([]);
    expect(screen.getByText("等待输入")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps local agent navigation", () => {
    useAgentStore
      .getState()
      .setLocalAgent({ agent: "tdsf", status: "working" });
    const activateLocal = vi.fn();
    render(
      <NotificationBell onActivate={vi.fn()} onActivateLocal={activateLocal} />,
    );
    fireEvent.click(screen.getByTestId("header-notification-bell"));
    fireEvent.click(screen.getByRole("button", { name: /运行中/ }));
    expect(activateLocal).toHaveBeenCalledTimes(1);
  });
});
