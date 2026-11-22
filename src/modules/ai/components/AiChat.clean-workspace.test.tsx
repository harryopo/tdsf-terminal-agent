import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { assessSessionEvidence, fetchEvidence } = vi.hoisted(() => ({
  assessSessionEvidence: vi.fn(async () => ({
    tier: "grounded",
    reason: "fixture evidence",
    sources: [],
  })),
  fetchEvidence: vi.fn(async () => [
    { tool_name: "ssh_command", timestamp: Date.now(), result: "fixture" },
  ]),
}));

vi.mock("../store/chatRuntime", () => ({
  sendMessage: vi.fn(async () => true),
}));
vi.mock("../lib/evidence", () => ({
  evidenceLabel: () => "SSH",
  evidenceTime: () => "",
  fetchEvidence,
  groupEvidence: () => ({ collect: [], execute: [], verify: [] }),
}));
vi.mock("@/lib/confidence/client", () => ({ assessSessionEvidence }));
vi.mock("./NeedsYouApprovalCards", async () => {
  const context = await import("../lib/needsYouApprovalContext");
  return {
    NeedsYouApprovalCards: ({ children }: PropsWithChildren) => (
      <context.NeedsYouApprovalContext.Provider
        value={{
          registerTool: () => () => {},
          inline: null,
          fallback: <div data-testid="approval-fallback" />,
        }}
      >
        <div data-testid="approval-provider">{children}</div>
      </context.NeedsYouApprovalContext.Provider>
    ),
  };
});

import { useChatStore } from "../store/chatStore";
import { AiChatView } from "./AiChat";

const assistantMessage = {
  id: "assistant-1",
  role: "assistant",
  parts: [
    { type: "text", text: "Workspace is ready." },
    {
      type: "tool-get_terminal_output",
      toolCallId: "tool-1",
      state: "output-available",
      input: { lines: 20 },
      output: { output: "terminal output fixture", available: true },
    },
  ],
} as unknown as UIMessage;

beforeEach(() => {
  fetchEvidence.mockClear();
  assessSessionEvidence.mockClear();
  useChatStore.setState({
    activeSessionId: "session-clean-workspace",
    agentMeta: { ...useChatStore.getState().agentMeta, status: "idle" },
  });
});

describe.each(["confirm", "teach"] as const)(
  "AiChatView clean workspace in %s mode",
  (mode) => {
    it("keeps the message, terminal tool, and approval context without evidence UI or RPCs", async () => {
      useChatStore.setState({ agentMode: mode, teach: mode === "teach" });
      await act(async () => {
        render(
          <AiChatView
            messages={[assistantMessage]}
            status="ready"
            error={undefined}
            clearError={vi.fn()}
            addToolApprovalResponse={vi.fn()}
            stop={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      expect(screen.getByText("Workspace is ready.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /终端输出/ }));
      expect(screen.getByText("terminal output fixture")).toBeTruthy();
      expect(screen.getByTestId("approval-provider")).toBeTruthy();
      expect(screen.getByTestId("approval-fallback")).toBeTruthy();
      expect(screen.queryByText(/已有依据|待核验/)).toBeNull();
      expect(screen.queryByText("证据")).toBeNull();
      expect(fetchEvidence).not.toHaveBeenCalled();
      expect(assessSessionEvidence).not.toHaveBeenCalled();
    });
  },
);
