import { render, screen } from "@testing-library/react";
import { readUIMessageStream } from "ai";
import { afterEach, expect, it } from "vitest";
import {
  sidecarStreamToUIMessageStream,
  type SidecarStreamPart,
} from "@/modules/ai/lib/sidecar-adapter";
import { Tool } from "./tool";

let nextToolCallId = 0;

async function readToolPart(
  toolName: string,
  output: unknown,
  isError: boolean,
) {
  const toolCallId = `outcome-${++nextToolCallId}`;
  const parts: SidecarStreamPart[] = [
    {
      type: "tool-input",
      toolCallId,
      toolName,
      input: toolName === "ssh_command" ? { command: "printf result" } : {},
    },
    { type: "tool-output", toolCallId, toolName, output, isError },
    { type: "finish", id: `stream-${nextToolCallId}` },
  ];
  const stream = sidecarStreamToUIMessageStream(
    (async function* () {
      yield* parts;
    })(),
  );
  let result: Record<string, unknown> | undefined;
  for await (const message of readUIMessageStream({ stream })) {
    result = message.parts.find(
      (part) => "toolCallId" in part && part.toolCallId === toolCallId,
    ) as Record<string, unknown> | undefined;
  }
  if (!result) throw new Error("SDK did not produce the tool result part");
  return result;
}

async function renderOutput(
  toolName: string,
  output: unknown,
  isError: boolean,
) {
  const part = await readToolPart(toolName, output, isError);
  render(
    <Tool
      toolName={toolName}
      toolCallId={String(part.toolCallId)}
      state={part.state as "output-available" | "output-error"}
      input={part.input}
      output={part.output}
      errorText={typeof part.errorText === "string" ? part.errorText : undefined}
      defaultOpen
    />,
  );
  return part;
}

afterEach(() => {
  nextToolCallId = 0;
});

const nonFailureOutcomes = [
  { status: "indeterminate", label: "indeterminate", text: "结果未确认" },
  { status: "rejected", label: "rejected", text: "已拒绝" },
  { status: "cancelled", label: "cancelled", text: "已取消" },
  { status: "canceled", label: "canceled", text: "已取消" },
  { status: "command_blocked", label: "command_blocked", text: "已阻止" },
];

it.each(nonFailureOutcomes)(
  "preserves the structured $status outcome when the backend marks it as an error",
  async ({ status, label, text }) => {
    const output = {
      status,
      message: `${status} message`,
      stdout: "partial stdout",
      stderr: "diagnostic stderr",
      exit_code: 4,
    };
    const part = await renderOutput("ssh_command", output, true);

    expect(part.output).toEqual(output);
    expect(screen.getByLabelText(label)).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByLabelText("failed")).toBeNull();
    expect(screen.queryByLabelText("done")).toBeNull();
    expect(screen.queryByRole("button", { name: /run|retry/i })).toBeNull();
  },
);

it.each([undefined, -1])(
  "keeps partial indeterminate output and never invents an exit code for %s",
  async (exitCode) => {
    const output = {
      status: "indeterminate",
      message: "Command may have run, result is not confirmed",
      stdout: "partial stdout",
      stderr: "partial stderr",
      exit_code: exitCode,
    };
    const part = await renderOutput("ssh_command", output, true);
    const visibleText = document.body.textContent ?? "";

    expect(part.output).toEqual(output);
    expect(screen.getByLabelText("indeterminate")).toBeTruthy();
    expect(screen.getByText("结果未确认")).toBeTruthy();
    expect(screen.getByText("退出状态未确认")).toBeTruthy();
    expect(screen.getByText("partial stdout")).toBeTruthy();
    expect(screen.getByText("partial stderr")).toBeTruthy();
    expect(visibleText).not.toContain("命令已返回");
    expect(visibleText).not.toContain("退出码 -1");
    expect(screen.queryByLabelText("done")).toBeNull();
    expect(screen.queryByRole("button", { name: /run|retry/i })).toBeNull();
  },
);

it.each(["failed", "error"])(
  "retains both streams, exit code, and message for a structured %s failure",
  async (status) => {
    const output = {
      status,
      message: `${status} message`,
      stdout: "failure stdout",
      stderr: "failure stderr",
      exit_code: 9,
    };
    const part = await renderOutput("ssh_command", output, true);

    expect(part.output).toEqual(output);
    expect(screen.getByLabelText("failed")).toBeTruthy();
    expect(screen.getByText("failure stdout")).toBeTruthy();
    expect(screen.getByText("failure stderr")).toBeTruthy();
    expect(screen.getByText(/退出码\s*9/)).toBeTruthy();
    expect(screen.getByText(`${status} message`)).toBeTruthy();
    expect(screen.queryByText("命令已返回")).toBeNull();
  },
);

it.each([undefined, -1])("shows unknown exit status for success with exit code %s", async (exitCode) => {
  const output = {
    status: "success",
    output: "diagnostic stdout",
    stderr: "diagnostic stderr",
    exit_code: exitCode,
  };
  const part = await renderOutput("ssh_command", output, false);

  expect(part.state).toBe("output-available");
  expect(screen.getByLabelText("done")).toBeTruthy();
  expect(screen.getByText("diagnostic stdout")).toBeTruthy();
  expect(screen.getByText("diagnostic stderr")).toBeTruthy();
  const visibleText = document.body.textContent ?? "";
  expect({
    unknownLabel: visibleText.includes("退出状态未确认"),
    fabricatedExitCode: visibleText.includes("退出码 -1"),
  }).toEqual({ unknownLabel: true, fabricatedExitCode: false });
});

it("keeps a successful nonzero diagnostic result and both streams", async () => {
  const output = {
    status: "success",
    output: "diagnostic stdout",
    stderr: "diagnostic stderr",
    exit_code: 3,
  };
  const part = await renderOutput("ssh_command", output, false);

  expect(part.output).toEqual(output);
  expect(screen.getByLabelText("done")).toBeTruthy();
  expect(screen.getByText(/退出码\s*3/)).toBeTruthy();
  expect(screen.getByText("diagnostic stdout")).toBeTruthy();
  expect(screen.getByText("diagnostic stderr")).toBeTruthy();
});

it("keeps an unstructured string error in output-error with its error text", async () => {
  const part = await renderOutput("ssh_command", "boom", true);

  expect(part.state).toBe("output-error");
  expect(screen.getByLabelText("error")).toBeTruthy();
  expect(screen.getByText("failed")).toBeTruthy();
  expect(screen.getByText("Error")).toBeTruthy();
  expect(screen.getByText("boom")).toBeTruthy();
  expect(screen.queryByLabelText("done")).toBeNull();
});

it.each([
  {
    errorText: "[indeterminate] 已提交但尚无结果",
    label: "indeterminate",
    visible: "结果未确认",
  },
  {
    errorText: "[rejected] 用户拒绝",
    label: "rejected",
    visible: "已拒绝",
  },
])("recognizes the explicit legacy status in $errorText", async ({ errorText, label, visible }) => {
  const part = await renderOutput("ssh_command", errorText, true);

  expect(part.state).toBe("output-error");
  expect(part.errorText).toBe(errorText);
  expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.getByText(visible)).toBeTruthy();
  expect(screen.getByText(/已提交但尚无结果|用户拒绝/)).toBeTruthy();
});

it("keeps unknown legacy status prefixes as ordinary errors", async () => {
  const part = await renderOutput("ssh_command", "[transport] connection reset", true);

  expect(part.state).toBe("output-error");
  expect(screen.getByText("failed")).toBeTruthy();
  expect(screen.getByText("[transport] connection reset")).toBeTruthy();
  expect(screen.queryByLabelText("indeterminate")).toBeNull();
});

it("does not turn an unknown error object into a successful done result", async () => {
  const part = await renderOutput("ssh_command", { detail: "x" }, true);

  expect(part.state).toBe("output-error");
  expect(screen.getByLabelText("error")).toBeTruthy();
  expect(screen.queryByLabelText("done")).toBeNull();
  expect(screen.getByText(/detail/)).toBeTruthy();
});

it("keeps teach_command output on its existing card", async () => {
  await renderOutput("teach_command", { status: "teach_command", command: "pwd" }, false);
  expect(screen.getByText("pwd")).toBeTruthy();
  expect(screen.queryByText("Error")).toBeNull();
});

it("keeps suggest_command output on its existing suggestion card", async () => {
  await renderOutput(
    "suggest_command",
    { command: "echo predicted", explanation: "Suggested by history" },
    false,
  );
  expect(screen.getByText("echo predicted")).toBeTruthy();
  expect(screen.queryByText("Error")).toBeNull();
});

it("keeps an unmatched suggest_command on its no-run result card", async () => {
  const output = {
    status: "unmatched",
    command: null,
    explanation: "No matching command was found",
    suggestions: ["uname -a", "pwd"],
  };
  const part = await renderOutput("suggest_command", output, true);

  expect(part.output).toEqual(output);
  expect(screen.getByText("未匹配命令")).toBeTruthy();
  expect(screen.getByText("No matching command was found")).toBeTruthy();
  expect(screen.getByText("uname -a")).toBeTruthy();
  expect(screen.getByText("pwd")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /run|retry/i })).toBeNull();
});

it("renders an unmatched suggestion with neutral card styling and no Run action", async () => {
  const output = {
    status: "unmatched",
    command: null,
    explanation: "No matching command was found",
    suggestions: ["uname -a"],
  };
  await renderOutput("suggest_command", output, true);

  const explanation = screen.getByText("No matching command was found");
  const card = explanation.parentElement;
  expect(card?.className).toContain("border-border");
  expect(card?.className).toContain("bg-card");
  expect(card?.className).not.toMatch(/border-amber|bg-amber/);
  expect(screen.getByText("uname -a")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /run|retry/i })).toBeNull();
});

it("keeps a failed suggest_command failed and does not offer Run", async () => {
  const output = {
    status: "failed",
    command: "echo should-not-run",
    message: "Suggestion execution failed",
  };
  const part = await renderOutput("suggest_command", output, true);

  expect(part.output).toEqual(output);
  expect(screen.getByLabelText("failed")).toBeTruthy();
  expect(screen.getAllByText("failed")).toHaveLength(2);
  expect(screen.getByText("Suggestion execution failed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /run|retry/i })).toBeNull();
});
