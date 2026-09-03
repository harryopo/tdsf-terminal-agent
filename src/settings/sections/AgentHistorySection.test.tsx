import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentHistorySection } from "./AgentHistorySection";

// isTauri / invokeRpc 可控 mock（B2 对话历史面板）
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

const LINES_RESPONSE = {
  ok: true,
  lines: [
    { ts: 1700000000, type: "user_msg", content: "查看磁盘空间" },
    {
      ts: 1700000001,
      type: "tool_call",
      content: '{"command":"df -h"}',
      meta: { tool_name: "ssh_command" },
    },
    { ts: 1700000002, type: "assistant_msg", content: "磁盘使用 50%" },
  ],
  total_in_file: 3,
};

const SESSIONS_RESPONSE = {
  ok: true,
  files: [
    {
      session_id: "sess-abc-123456",
      file: "sess-abc-123456.jsonl",
      size: 2048,
      mtime: 1700000000,
    },
  ],
  latest_session_id: "sess-abc-123456",
};

describe("AgentHistorySection — 对话历史面板（B2）", () => {
  it("浏览器模式显示仅桌面可用提示，不调用 RPC", () => {
    isTauriMock.mockReturnValue(false);
    render(<AgentHistorySection />);
    expect(screen.getByText(/仅在桌面模式可用/)).toBeTruthy();
    expect(invokeRpcMock).not.toHaveBeenCalled();
  });

  it("桌面模式加载会话流水并渲染时间线（含事件徽标 + 工具名）", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockImplementation((_method: string, params?: Record<string, unknown>) => {
      if (params && params.session_id) return Promise.resolve(LINES_RESPONSE);
      return Promise.resolve(SESSIONS_RESPONSE);
    });
    render(<AgentHistorySection />);
    // 等待异步加载会话 → 加载流水
    await waitFor(() => {
      expect(screen.getByText("查看磁盘空间")).toBeTruthy();
    });
    expect(screen.getByText("磁盘使用 50%")).toBeTruthy();
    // 事件类型中文徽标
    expect(screen.getByText("用户")).toBeTruthy();
    expect(screen.getByText("工具调用")).toBeTruthy();
    expect(screen.getByText("回答")).toBeTruthy();
    // 工具名（meta.tool_name）
    expect(screen.getByText("ssh_command")).toBeTruthy();
  });

  it("调用 debug.agent_log_tail RPC（会话列表 + 流水）", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockImplementation((_method: string, params?: Record<string, unknown>) => {
      if (params && params.session_id) return Promise.resolve(LINES_RESPONSE);
      return Promise.resolve(SESSIONS_RESPONSE);
    });
    render(<AgentHistorySection />);
    await waitFor(() => {
      expect(invokeRpcMock).toHaveBeenCalledWith("debug.agent_log_tail", {
        lines: 1,
      });
    });
    // 选中最新会话后加载流水（带 session_id）
    await waitFor(() => {
      expect(invokeRpcMock).toHaveBeenCalledWith(
        "debug.agent_log_tail",
        expect.objectContaining({ session_id: "sess-abc-123456", lines: 200 }),
      );
    });
  });

  it("空流水显示占位文案", async () => {
    isTauriMock.mockReturnValue(true);
    invokeRpcMock.mockImplementation((_method: string, params?: Record<string, unknown>) => {
      if (params && params.session_id)
        return Promise.resolve({ ok: true, lines: [], total_in_file: 0 });
      return Promise.resolve(SESSIONS_RESPONSE);
    });
    render(<AgentHistorySection />);
    await waitFor(() => {
      expect(screen.getByText("暂无流水记录")).toBeTruthy();
    });
  });
});
