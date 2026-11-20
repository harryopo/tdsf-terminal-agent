import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readUIMessageStream } from "ai";
import { beforeEach, expect, it } from "vitest";
import type { SshCommandOutputEvent } from "@/lib/sidecar-bridge";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useSshCommandOutputStore } from "@/modules/ai/store/sshCommandOutputStore";
import {
  sidecarStreamToUIMessageStream,
  type SidecarStreamPart,
} from "@/modules/ai/lib/sidecar-adapter";
import { Tool } from "./tool";

const command = "dnf install -y fastfetch";
const sessionId = "session-1";
const backendToolCallId = "backend-call-1";

async function readToolPart(parts: SidecarStreamPart[]) {
  const stream = sidecarStreamToUIMessageStream(
    (async function* () {
      yield* parts;
    })(),
  );
  let toolPart: Record<string, unknown> | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    toolPart = message.parts.find(
      (part) => "toolCallId" in part && part.toolCallId,
    ) as Record<string, unknown> | undefined;
  }
  if (!toolPart) throw new Error("SDK did not produce the SSH tool part");
  return toolPart;
}

function startCall(toolCallId: string, backendId: string, cmd = command) {
  useSshCommandOutputStore.getState().begin({
    toolCallId,
    backendToolCallId: backendId,
    conversationSessionId: sessionId,
    toolName: "ssh_command",
    command: cmd,
  });
}

function record(
  backendId: string,
  fields: Partial<SshCommandOutputEvent> = {},
) {
  useSshCommandOutputStore.getState().record({
    toolCallId: backendId,
    operationId: "operation-1",
    conversationSessionId: sessionId,
    sshSessionId: 1,
    toolName: "ssh_command",
    command,
    stream: "status",
    chunk: "",
    status: "running",
    ...fields,
  });
}

async function mountFromSidecar(
  parts: SidecarStreamPart[],
  toolCallId: string,
) {
  const part = await readToolPart(parts);
  render(
    <Tool
      toolName={String(part.toolName)}
      toolCallId={toolCallId}
      state={part.state as "input-available" | "output-available"}
      input={part.input}
      output={part.output}
      defaultOpen
    />,
  );
}

function inputParts(): SidecarStreamPart[] {
  return [
    {
      type: "tool-input",
      toolCallId: backendToolCallId,
      toolName: "ssh_command",
      input: { command },
    },
    { type: "finish", id: "stream-1" },
  ];
}

function finalParts(
  stdout: string,
  stderr: string,
  executionChannel?: string,
): SidecarStreamPart[] {
  return [
    {
      type: "tool-input",
      toolCallId: backendToolCallId,
      toolName: "ssh_command",
      input: { command },
    },
    {
      type: "tool-output",
      toolCallId: backendToolCallId,
      toolName: "ssh_command",
      output: { output: stdout, stderr, exit_code: 0, execution_channel: executionChannel },
      isError: false,
    },
    { type: "finish", id: "stream-1" },
  ];
}

beforeEach(() => {
  useSshCommandOutputStore.setState({ calls: {} });
  useChatStore.setState({ activeSessionId: sessionId });
});

it("renders live output for a real SDK input-available part", async () => {
  const parts = inputParts();
  const sdkPart = await readToolPart(parts);
  expect(sdkPart.state).toBe("input-available");
  const toolCallId = String(sdkPart.toolCallId);
  startCall(toolCallId, backendToolCallId);
  record(backendToolCallId);
  await mountFromSidecar(parts, toolCallId);

  act(() => {
    record(backendToolCallId, { stream: "stdout", chunk: "live stdout" });
  });
  expect(screen.getByText("live stdout")).toBeTruthy();
});

it("keeps output after recording before mount and across collapse/reopen", async () => {
  const sdkPart = await readToolPart(inputParts());
  const toolCallId = String(sdkPart.toolCallId);
  startCall(toolCallId, backendToolCallId);
  record(backendToolCallId);
  record(backendToolCallId, { stream: "stdout", chunk: "buffered before mount" });
  await mountFromSidecar(inputParts(), toolCallId);

  const card = screen.getByText("buffered before mount");
  expect(card).toBeTruthy();
  const trigger = screen.getByRole("button");
  fireEvent.click(trigger);
  act(() => {
    record(backendToolCallId, { stream: "stdout", chunk: "arrived while collapsed" });
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(screen.getByText(/buffered before mount/)).toBeTruthy();
  expect(screen.getByText(/arrived while collapsed/)).toBeTruthy();
});

it("keeps same-command calls separate when the active conversation changes", async () => {
  const firstPart = await readToolPart(inputParts());
  const firstId = String(firstPart.toolCallId);
  startCall(firstId, "backend-first");
  record("backend-first", { chunk: "", operationId: "op-first" });
  record("backend-first", {
    operationId: "op-first",
    stream: "stdout",
    chunk: "first output",
  });

  const secondParts = inputParts().map((part) =>
    part.type === "tool-input" ? { ...part, toolCallId: "backend-second" } : part,
  );
  const secondPart = await readToolPart(secondParts);
  const secondId = String(secondPart.toolCallId);
  startCall(secondId, "backend-second");
  record("backend-second", { chunk: "", operationId: "op-second" });
  record("backend-second", {
    operationId: "op-second",
    stream: "stderr",
    chunk: "second error",
  });

  useChatStore.setState({ activeSessionId: "another-session" });
  const { container } = render(
    <>
      <Tool toolName="ssh_command" toolCallId={firstId} state="input-available" input={{ command }} defaultOpen />
      <Tool toolName="ssh_command" toolCallId={secondId} state="input-available" input={{ command }} defaultOpen />
    </>,
  );
  act(() => {
    record("backend-first", { operationId: "op-first", stream: "stdout", chunk: "first after switch" });
    record("backend-second", { operationId: "op-second", stream: "stderr", chunk: "second after switch" });
  });

  const stdout = screen.getByText(/first output/);
  const stderr = screen.getByText(/second error/);
  expect(stdout).toBeTruthy();
  expect(stderr).toBeTruthy();
  const cards = Array.from(container.querySelectorAll("[data-slot='collapsible']"));
  expect(cards).toHaveLength(2);
  expect(within(cards[0] as HTMLElement).getByText(/first output/)).toBeTruthy();
  expect(within(cards[0] as HTMLElement).queryByText(/second error/)).toBeNull();
  expect(within(cards[1] as HTMLElement).getByText(/second error/)).toBeTruthy();
  expect(within(cards[1] as HTMLElement).queryByText(/first output/)).toBeNull();
  expect(within(cards[0] as HTMLElement).getByText(/first after switch/)).toBeTruthy();
  expect(within(cards[0] as HTMLElement).queryByText(/second after switch/)).toBeNull();
  expect(within(cards[1] as HTMLElement).getByText(/second after switch/)).toBeTruthy();
  expect(within(cards[1] as HTMLElement).queryByText(/first after switch/)).toBeNull();
});

it("shows stdout and stderr separately without duplicating the final result", async () => {
  const sdkPart = await readToolPart(finalParts("same stdout", "same stderr"));
  const toolCallId = String(sdkPart.toolCallId);
  startCall(toolCallId, backendToolCallId);
  record(backendToolCallId);
  record(backendToolCallId, { stream: "stdout", chunk: "same stdout" });
  record(backendToolCallId, { stream: "stderr", chunk: "same stderr" });
  record(backendToolCallId, { status: "completed", stream: "status", exitCode: 0 });
  await mountFromSidecar(finalParts("same stdout", "same stderr"), toolCallId);

  expect(screen.getAllByText("same stdout")).toHaveLength(1);
  expect(screen.getAllByText("same stderr")).toHaveLength(1);
});

it("ignores a legacy native event without toolCallId while retaining the final result", async () => {
  const sdkPart = await readToolPart(finalParts("final stdout", "final stderr"));
  const toolCallId = String(sdkPart.toolCallId);
  startCall(toolCallId, backendToolCallId);
  useSshCommandOutputStore.getState().record({
    operationId: "operation-1",
    conversationSessionId: sessionId,
    sshSessionId: 1,
    toolName: "ssh_command",
    command,
    stream: "stdout",
    chunk: "legacy unmatched output",
    status: "running",
  });
  await mountFromSidecar(finalParts("final stdout", "final stderr"), toolCallId);

  expect(screen.getByText("final stdout")).toBeTruthy();
  expect(screen.getByText("final stderr")).toBeTruthy();
  expect(screen.queryByText("legacy unmatched output")).toBeNull();
});

it("labels visible-terminal final output as a merged terminal echo", async () => {
  const sdkPart = await readToolPart(finalParts("merged terminal text", "", "visible-terminal"));
  await mountFromSidecar(finalParts("merged terminal text", "", "visible-terminal"), String(sdkPart.toolCallId));

  expect(screen.getByText("merged terminal text")).toBeTruthy();
  expect(screen.getByText("终端回显（合流）")).toBeTruthy();
  expect(screen.queryByText("stdout", { exact: true })).toBeNull();
});

it("does not label a nonzero native exit as the business failure verdict", async () => {
  const sdkPart = await readToolPart(inputParts());
  const toolCallId = String(sdkPart.toolCallId);
  startCall(toolCallId, backendToolCallId);
  record(backendToolCallId);
  record(backendToolCallId, { status: "completed", exitCode: 7 });
  await mountFromSidecar(inputParts(), toolCallId);

  expect(screen.getByText("输出已返回")).toBeTruthy();
  expect(screen.queryByText("执行失败")).toBeNull();
});

it.each([undefined, -1])("labels native exit status %s as unknown", async (exitCode) => {
  const sdkPart = await readToolPart(inputParts());
  const toolCallId = String(sdkPart.toolCallId);
  startCall(toolCallId, backendToolCallId);
  record(backendToolCallId);
  record(backendToolCallId, { status: "completed", exitCode });
  expect(useSshCommandOutputStore.getState().calls[toolCallId].ended).toBe(true);
  await mountFromSidecar(inputParts(), toolCallId);

  expect(screen.getByText("退出状态未确认")).toBeTruthy();
});
