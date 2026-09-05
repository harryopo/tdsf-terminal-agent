import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Tool } from "./tool";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useTerminalBlocksStore } from "@/modules/terminal/lib/terminalBlocksStore";
import { useTeachingExecutionStore } from "@/modules/terminal/lib/teachingExecutionStore";

const initialLive = useChatStore.getState().live;
const initialMeta = useChatStore.getState().agentMeta;

beforeEach(() => {
  useTeachingExecutionStore.setState({ executions: {}, activeByLeaf: {} });
  useTerminalBlocksStore.setState({ blocksByLeaf: {}, agentPending: {} });
  useChatStore.setState({
    live: initialLive,
    agentMeta: { ...initialMeta, status: "idle" },
  });
});

afterEach(() => {
  // 先卸载订阅 store 的卡片，再重置全局 Zustand 状态，避免测试环境的 act 噪声。
  cleanup();
  useChatStore.setState({ live: initialLive, agentMeta: initialMeta });
  useTeachingExecutionStore.setState({ executions: {}, activeByLeaf: {} });
  useTerminalBlocksStore.setState({ blocksByLeaf: {}, agentPending: {} });
});

describe("TeachCommandCard", () => {
  it("仅在学生点击后登记执行，并只展示已关联的终端块结果", async () => {
    const startTeachingCommand = vi.fn((command: string) => {
      const executionId = useTeachingExecutionStore
        .getState()
        .begin({ leafId: 71, command, requestedAt: 1000 });
      return { ok: true as const, executionId: executionId! };
    });
    useChatStore.setState({
      live: { ...initialLive, startTeachingCommand },
    });

    render(
      <Tool
        toolName="inspect_processes"
        state="output-available"
        input={{}}
        output={{
          status: "teach_command",
          command: "ps -ef",
          explanation: "查看当前进程。",
        }}
        defaultOpen
      />,
    );

    expect(startTeachingCommand).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "教学命令：点击注入终端执行" }),
    );
    expect(startTeachingCommand).toHaveBeenCalledWith("ps -ef");
    expect(screen.getByText(/正在等待 shell 返回完成标记/)).toBeTruthy();

    act(() => {
      useTerminalBlocksStore.getState().pushBlock({
        id: "tb-71-1",
        sessionId: 71,
        command: "ps -ef",
        cwd: "/srv/app",
        exitCode: 0,
        durationMs: 42,
        author: "agent",
        outputTail: "root 1 0 0 init",
        startedAt: 1000,
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/执行结果 · exit 0/)).toBeTruthy();
    });
    expect(screen.getByText("root 1 0 0 init")).toBeTruthy();
    expect(screen.getByRole("button", { name: "基于结果继续讲解" })).toBeTruthy();
  });
});
