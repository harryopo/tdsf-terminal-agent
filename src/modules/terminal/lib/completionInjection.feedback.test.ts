import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigSpec } from "@/lib/spec-data/types";
import type { SuggestionResult } from "@/lib/suggest-engine";

const harness = vi.hoisted(() => ({
  spec: null as FigSpec | null,
  sessions: new Map<number, number>(),
  remoteCommands: new Set<string>(),
  tldrItems: [] as Array<{ command: string; source: "arg"; kind: "arg"; description?: string }>,
  tldrZh: {} as Record<string, Record<string, string>>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/predictionEvents", () => ({ PREDICTION_CLEAR_EVENT: "prediction-clear" }));
vi.mock("@/lib/param-complete-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/param-complete-client")>();
  return {
    ...actual,
    getLeafCwd: () => null,
    getLeafRemoteCwd: () => null,
    getLeafSshSession: (id: number) => harness.sessions.get(id) ?? null,
    getCachedRemoteCommands: () => harness.remoteCommands,
    getCachedRemoteOsInfo: () => ({ family: "unknown" }),
    remoteCarapaceInstalled: async () => false,
    remoteParamComplete: vi.fn(async () => []),
  };
});
vi.mock("@/lib/os-family", () => ({ commandSupportsFamily: () => true }));
vi.mock("@/lib/suggest-engine", () => ({
  getSuggestEngine: () => ({
    getSuggestions: (prefix: string) => {
      const matches = ["apt", "systemctl", "xray", "aa-target"].filter((name) => name.startsWith(prefix));
      return matches.map((command) => ({ command, source: "dictionary", kind: "cmd" }));
    },
    setEnvironmentCommands: vi.fn(),
    clearHistory: vi.fn(),
  }),
}));
vi.mock("@/lib/spec-data/tldr-params", () => ({
  isParamCandidateCommand: () => true,
  tldrOptionZh: (cmd: string, option: string) => harness.tldrZh[cmd]?.[option],
  tldrParamSuggestions: (cmd: string, current: string) => harness.tldrItems
    .filter((item) => !current || item.command.startsWith(current))
    .map((item) => ({
      ...item,
      description: harness.tldrZh[cmd]?.[item.command] ?? item.description,
    })),
}));
vi.mock("@/lib/spec-data/loader", () => ({ getCommandSpec: async () => harness.spec }));

import { suggestParams } from "@/lib/spec-data/paramSuggest";
import {
  appendAbbrevItems,
  closeCompletion,
  completionKeyHandler,
  getCompletionState,
  initCompletionInjection,
  PREDICT_DEBOUNCE_MS,
  selectCompletionByIndex,
  setLeafEnvironment,
} from "./completionInjection";

const arg = (command: string, description?: string): SuggestionResult => ({
  command,
  source: "arg",
  kind: "arg",
  description,
});

const optionRichSpec: FigSpec = {
  name: "systemctl",
  options: Array.from({ length: 9 }, (_, index) => ({ name: `--option-${index}` })),
  subcommands: [
    { name: "status", description: "查看单元运行状态" },
    { name: "start", description: "启动单元" },
    { name: "stop", description: "停止单元" },
  ],
};

const simpleSpec: FigSpec = {
  name: "systemctl",
  subcommands: [
    { name: "status", description: "查看单元运行状态" },
    { name: "start", description: "启动单元" },
    { name: "stop", description: "停止单元" },
  ],
};

const settle = async () => {
  await vi.advanceTimersByTimeAsync(PREDICT_DEBOUNCE_MS + 1);
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function key(value: string, modifiers: { ctrlKey?: boolean } = {}): KeyboardEvent {
  return {
    type: "keydown",
    key: value,
    keyCode: value.length === 1 ? value.charCodeAt(0) : 0,
    isComposing: false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

async function typeText(leafId: number, text: string) {
  for (const character of text) completionKeyHandler(leafId, key(character));
  await settle();
}

let leafId = 100;
function init(write: (id: number, data: string) => void) {
  const id = ++leafId;
  setLeafEnvironment(id, "linux");
  harness.sessions.set(id, 7);
  initCompletionInjection(() => null, write);
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.spec = simpleSpec;
  harness.sessions.clear();
  harness.remoteCommands = new Set(["systemctl", "lsblk", "tool"]);
  harness.tldrItems = [];
  harness.tldrZh = {};
});

afterEach(() => {
  closeCompletion();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("installed feedback: parameter candidate priority", () => {
  it("keeps subcommands visible when the Fig spec has more than eight top-level options", () => {
    const items = suggestParams(optionRichSpec, "systemctl ", 8);
    expect(items.map((item) => item.command)).toContain("status");
  });

  it("does not lose start behind a full top-level option list", () => {
    const items = suggestParams(optionRichSpec, "systemctl ", 8);
    expect(items.map((item) => item.command)).toContain("start");
  });

  const formatSpec: FigSpec = {
    name: "tool",
    options: [
      { name: "--format", args: { suggestions: ["json", "yaml"] } },
      { name: "--force" },
      { name: "--verbose" },
    ],
  };

  it("shows only values after an empty --format slot", () => {
    const spec = formatSpec;
    expect(suggestParams(spec, "tool --format ").map((item) => item.command)).toEqual(["json", "yaml"]);
  });

  it("filters --format values by the current prefix", () => {
    const spec = formatSpec;
    expect(suggestParams(spec, "tool --format j").map((item) => item.command)).toEqual(["json"]);
  });

  it("returns no --format value for an unknown prefix", () => {
    const spec = formatSpec;
    expect(suggestParams(spec, "tool --format x")).toEqual([]);
  });

  const full = Array.from({ length: 8 }, (_, index) => arg(`--option-${index}`));

  it("reserves a useful abbreviation slot for partial systemctl input at eight results", () => {
    const items = appendAbbrevItems(full, "systemctl", "systemctl st");
    expect(items.map((item) => item.command)).toContain("status");
    expect(items.find((item) => item.command === "status")?.description).toContain("查看");
  });

  it("reserves a useful abbreviation slot for an empty systemctl subcommand at eight results", () => {
    const emptyPrefix = appendAbbrevItems(full, "systemctl", "systemctl ");
    expect(emptyPrefix.map((item) => item.command)).toContain("status");
  });

  it("deduplicates status and keeps its Chinese label over an existing generic label", () => {
    const withDuplicate = appendAbbrevItems([arg("status", "old label")], "systemctl", "systemctl st");
    expect(withDuplicate.filter((item) => item.command === "status")).toHaveLength(1);
    expect(withDuplicate.find((item) => item.command === "status")?.description).toContain("查看");
  });

  it("does not suggest status again after the subcommand is complete", () => {
    const completed = appendAbbrevItems([], "systemctl", "systemctl status ");
    expect(completed.map((item) => item.command)).not.toContain("status");
  });

  function configureLongLsblkFallback() {
    harness.spec = {
      name: "lsblk",
      options: [{ name: "-o", args: { suggestions: ["NAME", "SIZE", "TYPE"] } }],
    };
    harness.tldrItems = ["--all", "--bytes", "--discard", "--fs", "--noheadings", "--list", "--json", "--paths"]
      .map((command) => ({ command, source: "arg" as const, kind: "arg" as const }));
  }

  it("keeps static lsblk -o values when eight unrelated tldr flags precede Fig", async () => {
    configureLongLsblkFallback();
    const id = init(() => {});

    await typeText(id, "lsblk -o ");
    expect(getCompletionState().items.map((item) => item.command)).toEqual(["NAME", "SIZE", "TYPE"]);
  });

  it("matches an lsblk -o value prefix against the static candidates", async () => {
    configureLongLsblkFallback();
    const id = init(() => {});
    await typeText(id, "lsblk -o N");
    expect(getCompletionState().items.map((item) => item.command)).toEqual(["NAME"]);
  });

  it("keeps the tldr Chinese option label when Fig returns the same option", async () => {
    harness.spec = {
      name: "tool",
      options: [{ name: "--format", description: "format from Fig" }],
    };
    harness.tldrItems = [{ command: "--format", source: "arg", kind: "arg", description: "format from tldr" }];
    harness.tldrZh = { tool: { "--format": "格式选择" } };
    const id = init(() => {});

    await typeText(id, "tool ");
    const format = getCompletionState().items.filter((item) => item.command === "--format");
    expect(format).toHaveLength(1);
    expect(format[0]?.description).toBe("格式选择");
  });
});

describe("installed feedback: accepting and invalidating tracked input", () => {
  it.each([
    ["systemctl", " status ", "status"],
    ["sudo systemctl", " status ", "status"],
    ["systemctl st", "\\b\\bstatus", "status"],
  ])("accepts the right status token for %s", async (prefix, expectedWrite, expected) => {
    harness.spec = simpleSpec;
    const writes: string[] = [];
    const id = init((_leaf, data) => writes.push(data));
    await typeText(id, prefix);
    const index = getCompletionState().items.findIndex((item) => item.command === expected);
    expect(index).toBeGreaterThanOrEqual(0);
    selectCompletionByIndex(index);
    expect(writes).toEqual([expectedWrite.replaceAll("\\b", "\b")]);
  });

  it.each([
    ["Backspace", () => key("Backspace")],
    ["Enter", () => key("Enter")],
    ["Ctrl+C", () => key("c", { ctrlKey: true })],
    ["Ctrl+U", () => key("u", { ctrlKey: true })],
  ])("starts a fresh systemctl prediction after %s clears the s prefix", async (_name, makeKey) => {
    harness.spec = simpleSpec;
    const id = init(() => {});
    completionKeyHandler(id, key("s"));
    completionKeyHandler(id, makeKey());
    await typeText(id, "systemctl ");
    expect(getCompletionState().prefix).toBe("systemctl ");
    expect(getCompletionState().items.map((item) => item.command)).toContain("status");
  });

  it.each([
    ["ArrowUp", () => key("ArrowUp")],
    ["ArrowDown", () => key("ArrowDown")],
    ["Tab", () => key("Tab")],
    ["Ctrl+W", () => key("w", { ctrlKey: true })],
    ["Ctrl+K", () => key("k", { ctrlKey: true })],
    ["Home", () => key("Home")],
    ["End", () => key("End")],
  ])("passes %s through and suppresses predictions until a new line", async (_name, makeKey) => {
    const id = init(() => {});
    await typeText(id, "a");
    closeCompletion();
    expect(completionKeyHandler(id, makeKey())).toBe(true);
    completionKeyHandler(id, key("a"));
    await settle();
    expect(getCompletionState().visible).toBe(false);

    completionKeyHandler(id, key("Enter"));
    await typeText(id, "systemctl ");
    expect(getCompletionState().items.map((item) => item.command)).toContain("status");
  });
});
