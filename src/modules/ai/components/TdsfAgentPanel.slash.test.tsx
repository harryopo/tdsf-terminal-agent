/**
 * TEAM-FIX-01 组件级回归：`/skill` 真实消费段
 * -----------------------------------------------------------------------------
 * 渲染真实 TdsfAgentPanel（Body → handleSubmit），输入 `/skill:<name>`，
 * 断言：
 *   - 消费段只发一次 skill.invoke（无额外 shell/SSH/终端写入）
 *   - toast 内容与返回 mode 一致（reference 不称执行；executed 不称未执行）
 *
 * 依赖用最小 mock：useChat 只提供空消息列表，chatRuntime 不连接真实 transport。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store/chatStore";
import { TdsfAgentPanel } from "./TdsfAgentPanel";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSpaces } from "@/modules/spaces";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({ messages: [] }),
}));
vi.mock("../store/chatRuntime", () => ({
  getOrCreateChat: vi.fn(() => ({})),
  sendMessage: vi.fn(async () => true),
}));
vi.mock("@/modules/settings/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/settings/store")>();
  return { ...actual, setAgentAutoTypeCommands: vi.fn() };
});
vi.mock("./AiChat", () => ({
  AiChatView: () => <div data-testid="ai-chat-view" />,
}));
vi.mock("./TodoStrip", () => ({
  TodoStrip: () => <div data-testid="todo-strip" />,
}));
vi.mock("./WorkspaceGate", () => ({
  WorkspaceGate: () => <div data-testid="workspace-gate" />,
}));

const mockedInvoke = vi.mocked(invoke);

const referenceResult = {
  name: "linux-ops",
  content: "# Linux 运维\n\n仅作参考。",
  when_to_use: "排查 Linux 服务",
  params: {},
  source: "builtin",
  execution: "not_run" as const,
  executor: { type: "shell" as const, command: "uptime", timeout: 5 },
};

beforeEach(() => {
  mockedInvoke.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.warning).mockReset();
  useChatStore.setState({
    activeSessionId: "session-1",
    syncSessionToWorkspace: vi.fn(),
    closeMini: vi.fn(),
    focusInput: vi.fn(),
  } as never);
  useSpaces.setState({
    spaces: [{ id: "workspace-1" }],
    activeId: "workspace-1",
  } as never);
  usePreferencesStore.setState({ agentAutoTypeCommands: false } as never);
});

afterEach(() => {
  cleanup();
});

describe("TdsfAgentPanel — /skill 消费段", () => {
  it("reference 通知参考资料已加载，且只发一次 skill.invoke", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    render(<TdsfAgentPanel state="open" />);
    fireEvent.change(screen.getByTestId("tdsf-agent-input"), {
      target: { value: "/skill:linux-ops uptime" },
    });
    fireEvent.click(screen.getByTestId("tdsf-agent-send"));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });

    const [title, options] = vi.mocked(toast.success).mock.calls[0] ?? [];
    expect(String(title)).toContain("参考资料已加载");
    expect(String(title)).not.toContain("执行完成");
    expect(String((options as { description?: string })?.description)).toContain(
      "未执行命令",
    );
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls[0]?.[1]).toMatchObject({
      method: "skill.invoke",
      params: { name: "linux-ops" },
    });
    expect(screen.queryByTestId("workspace-gate")).toBeNull();
  });

  it("executed 通知执行结束，不写未执行", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
        name: "uptime",
        executor: { type: "shell", command: "uptime", timeout: 5 },
        success: true,
        exit_code: 0,
        output: "up 3 days",
        stdout: "up 3 days",
        stderr: "",
        duration_ms: 3,
        params: {},
        source: "builtin",
      },
    } as never);

    render(<TdsfAgentPanel state="open" />);
    fireEvent.change(screen.getByTestId("tdsf-agent-input"), {
      target: { value: "/skill:uptime" },
    });
    fireEvent.click(screen.getByTestId("tdsf-agent-send"));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });

    const [title, options] = vi.mocked(toast.success).mock.calls[0] ?? [];
    expect(String(title)).toContain("执行结束");
    expect(String(title)).not.toContain("参考资料");
    expect(String((options as { description?: string })?.description)).not.toContain(
      "未执行命令",
    );
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });
});