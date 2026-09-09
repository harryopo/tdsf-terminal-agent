import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  onSshCommandOutput,
  type SshCommandOutputEvent,
} from "@/lib/sidecar-bridge";
import { useChatStore } from "../store/chatStore";
import { SshCommandOutputPanel } from "./SshCommandOutputPanel";

let outputCallback: ((event: SshCommandOutputEvent) => void) | null = null;

vi.mock("@/lib/sidecar-bridge", () => ({
  onSshCommandOutput: vi.fn(
    async (callback: (event: SshCommandOutputEvent) => void) => {
      outputCallback = callback;
      return () => {};
    },
  ),
}));

async function mount() {
  render(<SshCommandOutputPanel />);
  await act(async () => {
    await Promise.resolve();
  });
}

function emit(event: Partial<SshCommandOutputEvent>) {
  act(() => {
    outputCallback?.({
      operationId: "op-1",
      conversationSessionId: "sess-1",
      sshSessionId: 1,
      toolName: "package_manage",
      command: "dnf install -y fastfetch",
      stream: "stdout",
      chunk: "",
      status: "running",
      ...event,
    });
  });
}

beforeEach(() => {
  outputCallback = null;
  vi.mocked(onSshCommandOutput).mockClear();
  useChatStore.setState({ activeSessionId: "sess-1" });
});

it("逐块显示 SSH 原生输出并在完成后变更状态", async () => {
  await mount();

  emit({ stream: "status" });
  expect(screen.getByText("实时执行中")).toBeTruthy();
  expect(screen.getByText("等待远端输出…")).toBeTruthy();

  emit({ chunk: "Downloading packages…\n" });
  emit({ chunk: "Complete!\n" });
  expect(screen.getByText(/Downloading packages/)).toBeTruthy();
  expect(screen.getByText(/Complete!/)).toBeTruthy();

  emit({ status: "completed", exitCode: 0 });
  expect(screen.getByText("已完成")).toBeTruthy();
});

it("忽略其他对话的后台输出", async () => {
  await mount();
  emit({ conversationSessionId: "sess-2", chunk: "secret output" });
  expect(screen.queryByText("secret output")).toBeNull();
});
