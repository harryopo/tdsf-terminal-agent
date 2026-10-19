import { render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/chatRuntime", () => ({
  sendMessage: vi.fn(async () => true),
}));
vi.mock("../lib/evidence", () => ({
  evidenceLabel: () => null,
  evidenceTime: () => "",
  fetchEvidence: vi.fn(async () => []),
  groupEvidence: () => [],
}));
vi.mock("./NeedsYouApprovalCards", () => ({
  NeedsYouApprovalCards: ({ children }: PropsWithChildren) => children ?? null,
}));

import { AiChatView } from "./AiChat";
import { useChatStore } from "../store/chatStore";

type ToolPart = {
  type: "dynamic-tool";
  toolName: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

let nextToolCallId = 0;

function assistantMessage(id: string, parts: unknown[]): UIMessage {
  return { id, role: "assistant", parts } as unknown as UIMessage;
}

function toolPart(
  toolName: string,
  state: ToolPart["state"],
  input?: unknown,
  result: Partial<ToolPart> = {},
): ToolPart {
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId: `${toolName}-${state}-${++nextToolCallId}`,
    state,
    input,
    ...result,
  };
}

function chat(messages: UIMessage[], status: "streaming" | "ready") {
  return (
    <AiChatView
      messages={messages}
      status={status}
      error={undefined}
      clearError={vi.fn()}
      addToolApprovalResponse={vi.fn()}
      stop={vi.fn()}
    />
  );
}

beforeEach(() => {
  nextToolCallId = 0;
  useChatStore.setState({
    activeSessionId: "turn-end-session",
    agentMode: "confirm",
    teach: false,
    agentMeta: { ...useChatStore.getState().agentMeta, step: null, status: "idle" },
  });
});

describe("AiChatView — finished turns do not leave unresolved tools marked running", () => {
  it.each(["python_run", "ask_user", "write_file"] as const)(
    "%s becomes indeterminate when its assistant turn ends without a tool result",
    (toolName) => {
      const input =
        toolName === "write_file"
          ? { path: "synthetic.txt", content: "fixture" }
          : toolName === "ask_user"
            ? { question: "Continue?" }
            : { code: "print('fixture')" };
      const messages = [
        assistantMessage("assistant-turn", [
          toolPart(toolName, "input-available", input),
        ]),
      ];
      const view = render(chat(messages, "streaming"));

      expect(screen.getByLabelText("running")).toBeTruthy();
      view.rerender(chat(messages, "ready"));

      expect(screen.getByLabelText("indeterminate")).toBeTruthy();
      expect(screen.getByText("结果未确认")).toBeTruthy();
      expect(screen.queryByLabelText("running")).toBeNull();
    },
  );

  it.each([
    { name: "empty streamed input", state: "input-streaming", input: undefined },
    { name: "partial streamed input", state: "input-streaming", input: { code: "print(" } },
    { name: "empty parsed input", state: "input-available", input: {} },
  ] as const)("does not treat $name as a successful result after turn end", ({ state, input }) => {
    render(
      chat(
        [assistantMessage("assistant-partial", [toolPart("python_run", state, input)])],
        "ready",
      ),
    );

    expect(screen.getByLabelText("indeterminate")).toBeTruthy();
    expect(screen.getByText("结果未确认")).toBeTruthy();
    expect(screen.queryByLabelText("done")).toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("keeps real success, rejection, denial, and failure outcomes intact", () => {
    render(
      chat(
        [
          assistantMessage("assistant-results", [
            toolPart("python_run", "output-available", {}, {
              output: { status: "success", stdout: "fixture success" },
            }),
            toolPart("python_run", "output-available", {}, {
              output: { status: "rejected", message: "fixture rejection" },
            }),
            toolPart("python_run", "output-denied", {}),
            toolPart("python_run", "output-error", {}, {
              errorText: "[failed] fixture failure",
            }),
          ]),
        ],
        "ready",
      ),
    );

    expect(screen.getByLabelText("done")).toBeTruthy();
    expect(screen.getByLabelText("rejected")).toBeTruthy();
    expect(screen.getByLabelText("denied")).toBeTruthy();
    expect(screen.getByLabelText("failed")).toBeTruthy();
    expect(screen.queryByLabelText("indeterminate")).toBeNull();
    expect(screen.queryByText("结果未确认")).toBeNull();
  });

  it("does not revive an older unresolved tool while the next assistant turn streams", () => {
    render(
      chat(
        [
          assistantMessage("assistant-old", [
            toolPart("python_run", "input-available", { code: "print('old')" }),
          ]),
          assistantMessage("assistant-new", [
            { type: "text", text: "The next turn is streaming." },
          ]),
        ],
        "streaming",
      ),
    );

    expect(screen.getByText("The next turn is streaming.")).toBeTruthy();
    expect(screen.getByLabelText("indeterminate")).toBeTruthy();
    expect(screen.queryByLabelText("running")).toBeNull();
  });
});
