import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  onSshCommandOutput,
  type SshCommandOutputEvent,
} from "@/lib/sidecar-bridge";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { Tool } from "./tool";

let outputCallback: ((event: SshCommandOutputEvent) => void) | null = null;

vi.mock("@/lib/sidecar-bridge", () => ({
  onSshCommandOutput: vi.fn(
    async (callback: (event: SshCommandOutputEvent) => void) => {
      outputCallback = callback;
      return () => {};
    },
  ),
}));

function emit(event: Partial<SshCommandOutputEvent>) {
  act(() => {
    outputCallback?.({
      operationId: "op-1",
      conversationSessionId: "sess-1",
      sshSessionId: 1,
      toolName: "ssh_command",
      command: "dnf install -y fastfetch",
      stream: "stdout",
      chunk: "",
      status: "running",
      ...event,
    });
  });
}

async function mount() {
  render(
    <Tool
      toolName="ssh_command"
      state="input-streaming"
      input={{ command: "dnf install -y fastfetch" }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  outputCallback = null;
  vi.mocked(onSshCommandOutput).mockClear();
  useChatStore.setState({ activeSessionId: "sess-1" });
});

it("在同一 SSH 工具卡内逐块展示实时回显", async () => {
  await mount();

  expect(screen.getByText("等待命令开始…")).toBeTruthy();
  expect(screen.queryByText("SSH Output")).toBeNull();

  emit({ stream: "status" });
  expect(screen.getByText("实时回显")).toBeTruthy();
  expect(screen.getByText("等待远端输出…")).toBeTruthy();

  emit({ chunk: "Downloading packages…\n" });
  emit({ chunk: "Complete!\n" });
  expect(screen.getByText(/Downloading packages/)).toBeTruthy();
  expect(screen.getByText(/Complete!/)).toBeTruthy();

  emit({ status: "completed", exitCode: 0 });
  expect(screen.getByText("已完成")).toBeTruthy();
});

it("忽略其他会话或其他命令的流式回显", async () => {
  await mount();

  emit({ conversationSessionId: "sess-2", chunk: "other session" });
  emit({ command: "uname -a", chunk: "other command" });

  expect(screen.queryByText("other session")).toBeNull();
  expect(screen.queryByText("other command")).toBeNull();
});
