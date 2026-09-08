import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalBlocksStore } from "./terminalBlocksStore";

describe("terminalBlocksStore agent correlation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T00:00:00Z"));
    useTerminalBlocksStore.setState({ blocksByLeaf: {}, agentPending: {} });
  });

  afterEach(() => vi.useRealTimers());

  it("keeps slow human typing associated with the Agent", () => {
    useTerminalBlocksStore.getState().markAgentPending(7);
    vi.advanceTimersByTime(120_000);
    expect(useTerminalBlocksStore.getState().resolveAuthor(7, "uname -a")).toBe(
      "agent",
    );
  });

  it("can clear a pending marker when visible execution is cancelled", () => {
    useTerminalBlocksStore.getState().markAgentPending(7);
    useTerminalBlocksStore.getState().clearAgentPending(7);
    expect(useTerminalBlocksStore.getState().resolveAuthor(7, "uname -a")).toBe(
      "user",
    );
  });
});
