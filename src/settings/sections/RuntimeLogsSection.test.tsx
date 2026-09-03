import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RuntimeLogsSection } from "./RuntimeLogsSection";

const isTauriMock = vi.fn();
vi.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }));

const invokeRpcMock = vi.fn();
vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: (...args: unknown[]) => invokeRpcMock(...args),
}));

beforeEach(() => {
  isTauriMock.mockReset();
  invokeRpcMock.mockReset();
});

const LOGS_RESPONSE = {
  ok: true,
  lines: [
    { ts: 1700000000, level: "INFO", logger: "sidecar.adapter", msg: "invoke started" },
    { ts: 1700000001, level: "ERROR", logger: "sidecar.tools", msg: "tool failed: boom" },
  ],
  total: 2,
};

describe("RuntimeLogsSection — 运行日志面板（B3）", () => {
  it("浏览器模式显示降级提示，不调用 RPC", () => {
    isTauriMock.mockReturnValue(false);
    render(<RuntimeLogsSection />);
    expect(screen.getByText(/仅在桌面模式可用/)).toBeTruthy();
    expect(invokeRpcMock).not.toHaveBeenCalled();
  });

  it("桌面模式加载日志并渲染（level 徽标 + logger + msg）", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockResolvedValue(LOGS_RESPONSE);
    render(<RuntimeLogsSection />);
    await waitFor(() => {
      expect(screen.getByText("invoke started")).toBeTruthy();
    });
    expect(screen.getByText("tool failed: boom")).toBeTruthy();
    expect(screen.getByText("INFO")).toBeTruthy();
    expect(screen.getByText("ERROR")).toBeTruthy();
    expect(screen.getByText("sidecar.adapter")).toBeTruthy();
  });

  it("调用 log.tail RPC（默认 ALL 不带 level_filter）", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockResolvedValue(LOGS_RESPONSE);
    render(<RuntimeLogsSection />);
    await waitFor(() => {
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", { lines: 300 });
    });
  });

  it("空日志显示占位文案", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockResolvedValue({ ok: true, lines: [], total: 0 });
    render(<RuntimeLogsSection />);
    await waitFor(() => {
      expect(screen.getByText("暂无日志")).toBeTruthy();
    });
  });

  it("ok:false 显示错误信息", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockResolvedValue({ ok: false, error: "ringbuffer 未初始化" });
    render(<RuntimeLogsSection />);
    await waitFor(() => {
      expect(screen.getByText(/ringbuffer 未初始化/)).toBeTruthy();
    });
  });
});
