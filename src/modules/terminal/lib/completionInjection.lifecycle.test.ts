import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";

const harness = vi.hoisted(() => ({
  requests: [] as Array<{
    sessionId: number;
    completer: string;
    tokens: string[];
    current: string;
    cwd?: string | null;
    resolve: (candidates: Array<{
      command: string;
      source: "arg";
      kind: "arg";
      description?: string;
    }>) => void;
  }>,
  sessions: new Map<number, number>(),
  environments: new Map<number, "linux" | "windows">(),
  cwds: new Map<number, string | null>(),
  remoteCommands: null as Set<string> | null,
  seededCommands: new Set<string>(),
  seedCalls: 0,
  queryCalls: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/lib/predictionEvents", () => ({ PREDICTION_CLEAR_EVENT: "prediction-clear" }));
vi.mock("@/lib/param-complete-client", () => ({
  buildParamRequest: (prefix: string) => {
    const trailingSpace = /\s+$/.test(prefix);
    const tokens = prefix.trimEnd().split(/\s+/).filter(Boolean);
    return { cmd: tokens[0] ?? "", tokens, current: trailingSpace ? "" : tokens.at(-1) ?? "" };
  },
  getLeafCwd: () => null,
  getLeafRemoteCwd: (leafId: number) => harness.cwds.get(leafId) ?? null,
  getLeafSshSession: (leafId: number) => harness.sessions.get(leafId) ?? null,
  getCachedRemoteCommands: () => harness.remoteCommands,
  getCachedRemoteOsInfo: () => ({ family: "linux", prettyName: "Linux" }),
  mergeCandidates: (candidates: Array<{ value: string; description?: string }>) =>
    candidates.map((candidate) => ({
      command: candidate.value,
      description: candidate.description,
      source: "arg",
      kind: "arg",
    })),
  remoteCarapaceInstalled: async () => true,
  remoteParamComplete: (
    sessionId: number,
    completer: string,
    tokens: string[],
    current: string,
    cwd?: string | null,
  ) => new Promise<Array<{ command: string; source: "arg"; kind: "arg"; description?: string }>>((resolve) => {
    harness.requests.push({ sessionId, completer, tokens, current, cwd, resolve });
  }),
}));
vi.mock("@/lib/os-family", () => ({ commandSupportsFamily: () => true }));
vi.mock("@/lib/command-abbrevs", () => ({
  COMMAND_ABBREVS: {},
  findAbbrevSuggestions: () => [],
}));
vi.mock("@/lib/suggest-engine", () => ({
  getSuggestEngine: () => ({
    getSuggestions: (prefix: string) => {
      harness.queryCalls++;
      return [...harness.seededCommands]
        .filter((name) => name.startsWith(prefix))
        .map((command) => ({ command, source: "dictionary" as const }));
    },
    setEnvironmentCommands: (names: Iterable<string>) => {
      harness.seedCalls++;
      for (const name of names) harness.seededCommands.add(name);
    },
    clearHistory: vi.fn(),
  }),
}));
vi.mock("@/lib/spec-data/tldr-params", () => ({
  isParamCandidateCommand: () => false,
  tldrOptionZh: () => undefined,
  tldrParamSuggestions: () => [],
}));
vi.mock("@/lib/spec-data/loader", () => ({ getCommandSpec: async () => null }));
vi.mock("@/lib/spec-data/paramSuggest", () => ({
  parseCommandLine: (prefix: string) => ({ cmd: prefix.trim().split(/\s+/)[0] ?? "" }),
  suggestParams: () => [],
}));
vi.mock("./executionHistory", () => ({
  getLeafEnvironment: (leafId: number) => harness.environments.get(leafId) ?? "linux",
}));

const settleMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
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

async function boot(getTerm: (leafId: number) => XTerm | null = () => null) {
  vi.resetModules();
  const completion = await import("./completionInjection");
  completion.initCompletionInjection(getTerm, () => {});
  return completion;
}

async function typeText(
  completion: Awaited<ReturnType<typeof boot>>,
  leafId: number,
  text: string,
) {
  for (const character of text) completion.completionKeyHandler(leafId, key(character));
  await vi.advanceTimersByTimeAsync(120);
  await settleMicrotasks();
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.requests.length = 0;
  harness.sessions.clear();
  harness.environments.clear();
  harness.cwds.clear();
  harness.remoteCommands = null;
  harness.seededCommands.clear();
  harness.seedCalls = 0;
  harness.queryCalls = 0;
  harness.sessions.set(1, 7);
  harness.sessions.set(2, 8);
  harness.environments.set(1, "linux");
  harness.environments.set(2, "linux");
  harness.cwds.set(1, "/work/tree");
});

afterEach(() => {
  try {
    document.body.replaceChildren();
  } finally {
    vi.useRealTimers();
  }
});

describe("completionInjection async result lifecycle", () => {
  it.each([
    ["Enter", (completion: Awaited<ReturnType<typeof boot>>) => completion.completionKeyHandler(1, key("Enter"))],
    ["Ctrl+C", (completion: Awaited<ReturnType<typeof boot>>) => completion.completionKeyHandler(1, key("c", { ctrlKey: true }))],
  ])("does not reopen a prediction after %s", async (_name, cancel) => {
    const completion = await boot();
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({ sessionId: 7, completer: "git", current: "c" });

    cancel(completion);
    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();

    expect(completion.getCompletionState().visible).toBe(false);
  });

  it("rejects the old git c reply after typing git ch, then shows the latest reply", async () => {
    const completion = await boot();
    const typeAndStart = async (text: string) => {
      for (const character of text) completion.completionKeyHandler(1, key(character));
      await vi.advanceTimersByTimeAsync(120);
      await settleMicrotasks();
    };

    await typeAndStart("git c");
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0].current).toBe("c");

    completion.completionKeyHandler(1, key("h"));
    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();
    expect(harness.requests).toHaveLength(1); // the single-flight request is still pending

    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();
    expect(completion.getCompletionState().visible).toBe(false);

    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();
    expect(harness.requests).toHaveLength(2);
    expect(harness.requests[1]).toMatchObject({ current: "ch", tokens: ["ch"] });
    harness.requests[1].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();

    expect(completion.getCompletionState()).toMatchObject({
      visible: true,
      prefix: "git ch",
      leafId: 1,
    });
    expect(completion.getCompletionState().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "checkout" })]),
    );
  });

  it("closeCompletion cancels both an in-flight reply and its queued refresh", async () => {
    const completion = await boot();
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);
    completion.completionKeyHandler(1, key("h"));
    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();

    completion.closeCompletion();
    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();

    expect(completion.getCompletionState().visible).toBe(false);
    expect(harness.requests).toHaveLength(1);
  });

  it.each([
    ["Tab", () => key("Tab")],
    ["Escape before the popup appears", () => key("Escape")],
    ["Ctrl+Backspace", () => key("Backspace", { ctrlKey: true })],
    ["ArrowRight before the popup appears", () => key("ArrowRight")],
  ])("cancels a pending reply after %s", async (_name, makeKey) => {
    const completion = await boot();
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);
    expect(completion.getCompletionState().visible).toBe(false);

    completion.completionKeyHandler(1, makeKey());
    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();
    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();

    expect(completion.getCompletionState().visible).toBe(false);
    expect(harness.requests).toHaveLength(1);
  });

  it("does not show leaf 1's result after leaf 2 starts typing", async () => {
    const completion = await boot();
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);

    for (const character of "git s") completion.completionKeyHandler(2, key(character));
    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();
    expect(harness.requests).toHaveLength(1);

    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();
    expect(completion.getCompletionState().visible).toBe(false);
    expect(completion.getCompletionState().leafId).not.toBe(1);
  });

  it("rejects a result when the same leaf changes its SSH session", async () => {
    const completion = await boot();
    await typeText(completion, 1, "git c");
    expect(harness.requests[0]?.sessionId).toBe(7);

    harness.sessions.set(1, 8);
    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();

    expect(completion.getCompletionState().visible).toBe(false);
  });

  it("does not show a result after focus leaves the terminal", async () => {
    document.body.replaceChildren();
    const terminalElement = document.createElement("div");
    terminalElement.tabIndex = 0;
    const terminalInput = document.createElement("textarea");
    terminalElement.append(terminalInput);
    const elsewhere = document.createElement("button");
    document.body.append(terminalElement, elsewhere);
    terminalInput.focus();

    const term = {
      element: terminalElement,
      cols: 80,
      rows: 24,
      buffer: { active: { cursorX: 0, cursorY: 0 } },
    } as unknown as XTerm;
    const completion = await boot((leafId) => leafId === 1 ? term : null);
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);
    expect(document.activeElement).toBe(terminalInput);

    elsewhere.focus();
    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();

    expect(document.activeElement).toBe(elsewhere);
    expect(completion.getCompletionState().visible).toBe(false);
  });

  it("shows a reply when focus remains in the terminal", async () => {
    const terminalElement = document.createElement("div");
    terminalElement.tabIndex = 0;
    const terminalInput = document.createElement("textarea");
    terminalElement.append(terminalInput);
    document.body.append(terminalElement);
    terminalInput.focus();

    const term = {
      element: terminalElement,
      cols: 80,
      rows: 24,
      buffer: { active: { cursorX: 0, cursorY: 0 } },
    } as unknown as XTerm;
    const completion = await boot(() => term);
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);
    expect(document.activeElement).toBe(terminalInput);

    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();

    expect(completion.getCompletionState()).toMatchObject({ visible: true, prefix: "git c", leafId: 1 });
    expect(completion.getCompletionState().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "checkout" })]),
    );
  });

  it("seeds cached remote commands before the first command prediction query", async () => {
    harness.remoteCommands = new Set(["zebra-tool"]);
    const completion = await boot();

    completion.completionKeyHandler(1, key("z"));
    await vi.advanceTimersByTimeAsync(120);
    await settleMicrotasks();

    expect(harness.seedCalls).toBeGreaterThan(0);
    expect(harness.queryCalls).toBe(1);
    expect(completion.getCompletionState()).toMatchObject({ visible: true, prefix: "z" });
    expect(completion.getCompletionState().items.map((item) => item.command)).toContain("zebra-tool");
    expect(harness.requests).toHaveLength(0);
  });

  it.each([
    ["environment", () => harness.environments.set(1, "windows")],
    ["cwd", () => harness.cwds.set(1, "/work/other")],
  ])("rejects a result when the same leaf changes its %s", async (_name, change) => {
    const completion = await boot();
    await typeText(completion, 1, "git c");
    expect(harness.requests).toHaveLength(1);

    change();
    harness.requests[0].resolve([{ command: "checkout", source: "arg", kind: "arg" }]);
    await settleMicrotasks();

    expect(completion.getCompletionState().visible).toBe(false);
  });
});
