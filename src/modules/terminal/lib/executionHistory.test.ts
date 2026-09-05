import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSuggestEngine } from "@/lib/suggest-engine";
import type { TerminalBlock } from "./terminalBlocks";

const mocks = vi.hoisted(() => ({
  historyRecord: vi.fn(),
}));

vi.mock("@/modules/terminal/block/lib/history", () => ({
  historyRecord: mocks.historyRecord,
}));

import {
  clearLeafEnvironment,
  recordSuccessfulTerminalBlock,
  setLeafEnvironment,
} from "./executionHistory";

function block(overrides: Partial<TerminalBlock> = {}): TerminalBlock {
  return {
    id: "block-1",
    sessionId: 11,
    command: "git status",
    cwd: "/work",
    exitCode: 0,
    durationMs: 100,
    author: "user",
    outputTail: "",
    startedAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.historyRecord.mockClear();
  getSuggestEngine().clearHistory();
  clearLeafEnvironment(11);
});

describe("recordSuccessfulTerminalBlock", () => {
  it("only records a completed successful command for its terminal environment", () => {
    setLeafEnvironment(11, "linux");

    recordSuccessfulTerminalBlock(block());

    expect(mocks.historyRecord).toHaveBeenCalledTimes(1);
    expect(mocks.historyRecord).toHaveBeenCalledWith("git status");
    expect(getSuggestEngine().getHistory("linux")).toEqual(["git status"]);
    expect(getSuggestEngine().getHistory("windows")).toEqual([]);
  });

  it.each([
    ["a failed command", { exitCode: 1 }],
    ["a command without an exit code", { exitCode: null }],
    ["an empty command", { command: "  " }],
  ])("does not record %s", (_label, overrides) => {
    recordSuccessfulTerminalBlock(block(overrides));

    expect(mocks.historyRecord).not.toHaveBeenCalled();
    expect(getSuggestEngine().getHistory("linux")).toEqual([]);
    expect(getSuggestEngine().getHistory("windows")).toEqual([]);
  });
});
