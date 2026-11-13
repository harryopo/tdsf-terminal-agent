import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigSpec } from "@/lib/spec-data/types";
import type { SuggestionResult } from "@/lib/suggest-engine";

type RemoteCandidate = SuggestionResult;

const harness = vi.hoisted(() => ({
  specs: new Map<string, FigSpec>(),
  sessions: new Map<number, number>(),
  remoteCommands: new Map<number, Set<string>>(),
  tldrItems: new Map<string, SuggestionResult[]>(),
  tldrZh: new Map<string, Record<string, string>>(),
  remoteCalls: [] as Array<{ sessionId: number; cmd: string; tokens: string[]; current: string }>,
  remoteInstalled: null as ((sessionId: number) => Promise<boolean>) | null,
  remoteReply: null as ((sessionId: number, cmd: string, tokens: string[], current: string) => Promise<RemoteCandidate[] | null>) | null,
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
    getLeafSshSession: (leafId: number) => harness.sessions.get(leafId) ?? null,
    getCachedRemoteCommands: (sessionId: number) => harness.remoteCommands.get(sessionId) ?? null,
    getCachedRemoteOsInfo: () => ({ family: "unknown" }),
    remoteCarapaceInstalled: (sessionId: number) => harness.remoteInstalled?.(sessionId) ?? Promise.resolve(false),
    remoteParamComplete: (
      sessionId: number,
      cmd: string,
      tokens: string[],
      current: string,
    ) => {
      harness.remoteCalls.push({ sessionId, cmd, tokens, current });
      const reply = harness.remoteReply?.(sessionId, cmd, tokens, current) ?? Promise.resolve([]);
      return reply.then((items) => items?.map((item) => ({
        ...item,
        description: harness.tldrZh.get(cmd)?.[item.command] ?? item.description,
      })) ?? null);
    },
  };
});
vi.mock("@/lib/os-family", () => ({ commandSupportsFamily: () => true }));
vi.mock("@/lib/suggest-engine", () => ({
  getSuggestEngine: () => ({
    getSuggestions: (prefix: string) => ["apt", "git", "ip", "tar", "tool", "echo"]
      .filter((name) => name.startsWith(prefix) || (prefix.endsWith("gi") && name === "git"))
      .map((command) => ({ command, source: "dictionary", kind: "cmd" })),
    setEnvironmentCommands: vi.fn(),
    clearHistory: vi.fn(),
  }),
}));
vi.mock("@/lib/spec-data/tldr-params", () => ({
  isParamCandidateCommand: (cmd: string) => harness.specs.has(cmd) || harness.tldrItems.has(cmd),
  tldrOptionZh: (cmd: string, value: string) => harness.tldrZh.get(cmd)?.[value],
  tldrParamSuggestions: (cmd: string, current: string) => (harness.tldrItems.get(cmd) ?? [])
    .filter((item) => !current || item.command.startsWith(current))
    .map((item) => ({ ...item, description: harness.tldrZh.get(cmd)?.[item.command] ?? item.description })),
}));
vi.mock("@/lib/spec-data/loader", () => ({
  getCommandSpec: async (cmd: string) => harness.specs.get(cmd) ?? null,
}));
import {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function drain() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

async function settlePrediction() {
  await vi.advanceTimersByTimeAsync(PREDICT_DEBOUNCE_MS + 1);
  await drain();
}

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

let nextLeafId = 200;
function init(write: (leafId: number, text: string) => void = () => {}) {
  const leafId = ++nextLeafId;
  harness.sessions.set(leafId, 7);
  harness.remoteCommands.set(7, new Set(["apt", "git", "ip", "tar", "tool", "echo", "systemctl"]));
  setLeafEnvironment(leafId, "linux");
  initCompletionInjection(() => null, write);
  return leafId;
}

async function typeText(leafId: number, text: string) {
  for (const character of text) completionKeyHandler(leafId, key(character));
  await settlePrediction();
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.specs.clear();
  harness.sessions.clear();
  harness.remoteCommands.clear();
  harness.tldrItems.clear();
  harness.tldrZh.clear();
  harness.remoteCalls.length = 0;
  harness.remoteInstalled = null;
  harness.remoteReply = null;
});

afterEach(() => {
  closeCompletion();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("completion prediction context feedback", () => {
  it.each(["Enter", "Backspace", "Ctrl+C"] as const)("recovers full-command and partial-argument prediction after discarding a typo with %s", async (reset) => {
    harness.specs.set("systemctl", {
      name: "systemctl",
      subcommands: [{ name: "status", description: "查看服务状态" }, { name: "start", description: "启动服务" }],
    });
    const writes: string[] = [];
    const leafId = init((_leafId, text) => writes.push(text));

    await typeText(leafId, "s");
    expect(completionKeyHandler(leafId, reset === "Ctrl+C" ? key("c", { ctrlKey: true }) : key(reset))).toBe(true);
    await typeText(leafId, "systemctl");
    const fullCommand = getCompletionState();

    expect(fullCommand).toMatchObject({ visible: true, leafId, prefix: "systemctl" });
    expect(fullCommand.items).toContainEqual(expect.objectContaining({ command: "status", description: expect.stringMatching(/[\u4e00-\u9fff]/) }));
    expect(writes).toEqual([]);

    await typeText(leafId, " st");
    const partialArgument = getCompletionState();
    expect(partialArgument).toMatchObject({ visible: true, leafId, prefix: "systemctl st" });
    const index = partialArgument.items.findIndex((item) => item.command === "status");
    expect(index).toBeGreaterThanOrEqual(0);
    selectCompletionByIndex(index);

    expect(writes).toEqual(["\b\bstatus"]);
  });

  it("shows static candidates and refreshes the newest prefix while remote installation is pending", async () => {
    harness.specs.set("tool", {
      name: "tool",
      subcommands: [
        { name: "inspect", description: "检查" },
        { name: "install", description: "安装" },
      ],
    });
    const installGate = deferred<boolean>();
    harness.remoteInstalled = () => installGate.promise;
    const leafId = init();
    let first: ReturnType<typeof getCompletionState> | undefined;
    let latest: ReturnType<typeof getCompletionState> | undefined;

    try {
      await typeText(leafId, "tool i");
      first = getCompletionState();
      for (const character of "nst") completionKeyHandler(leafId, key(character));
      await settlePrediction();
      latest = getCompletionState();
    } finally {
      installGate.resolve(false);
      await drain();
      await settlePrediction();
    }

    expect(first).toMatchObject({ visible: true, prefix: "tool i" });
    expect(first?.items.map((item) => item.command)).toEqual(expect.arrayContaining(["inspect", "install"]));
    expect(latest).toMatchObject({ visible: true, prefix: "tool inst" });
    expect(latest?.items.map((item) => item.command)).toEqual(["install"]);
    expect(getCompletionState()).toMatchObject({ visible: true, prefix: "tool inst" });
  });

  it("merges dynamic and static options once, keeps the eight-item limit, and retains Chinese labels", async () => {
    harness.specs.set("tool", {
      name: "tool",
      options: [{ name: "--force", description: "Fig label" }, { name: "--fig-only", description: "Fig-only" }],
    });
    harness.tldrItems.set("tool", [arg("--force", "generic label"), arg("--tldr-only", "tldr-only")]);
    harness.tldrZh.set("tool", { "--force": "强制执行" });
    harness.remoteInstalled = async () => true;
    harness.remoteReply = async () => [
      arg("--force", "dynamic label"),
      ...["--one", "--two", "--three", "--four", "--five"].map((command) => arg(command)),
    ];
    const leafId = init();

    await typeText(leafId, "tool ");
    const items = getCompletionState().items;
    const force = items.filter((item) => item.command === "--force");

    expect(items).toHaveLength(8);
    expect(force).toHaveLength(1);
    expect(force[0]?.description).toBe("强制执行");
    expect(items.map((item) => item.command)).toEqual(expect.arrayContaining([
      "--one", "--five", "--tldr-only", "--fig-only",
    ]));
  });

  it("does not write a dynamic value containing a newline but still accepts a safe value", async () => {
    harness.remoteInstalled = async () => true;
    harness.remoteReply = async () => [arg("unsafe\ncommand"), arg("safe-value")];
    const writes: string[] = [];
    const unsafeLeaf = init((_leafId, text) => writes.push(text));

    await typeText(unsafeLeaf, "tool ");
    const unsafeIndex = getCompletionState().items.findIndex((item) => item.command === "unsafe\ncommand");
    expect(unsafeIndex).toBeGreaterThanOrEqual(0);
    selectCompletionByIndex(unsafeIndex);
    expect(writes).toEqual([]);

    const safeLeaf = init((_leafId, text) => writes.push(text));
    await typeText(safeLeaf, "tool ");
    const safeIndex = getCompletionState().items.findIndex((item) => item.command === "safe-value");
    expect(safeIndex).toBeGreaterThanOrEqual(0);
    selectCompletionByIndex(safeIndex);

    expect(writes).toEqual(["safe-value "]);
  });

  it("uses the last pipeline command context and accepts without deleting the echoed prefix", async () => {
    harness.specs.set("git", { name: "git", subcommands: [{ name: "checkout", description: "切换分支" }] });
    harness.remoteInstalled = async () => true;
    harness.remoteReply = async (_sessionId, cmd) => cmd === "git" ? [arg("checkout")] : [];
    const writes: string[] = [];
    const leafId = init((_leafId, text) => writes.push(text));

    await typeText(leafId, "echo hi | git ch");
    const beforeAccept = getCompletionState();
    const index = beforeAccept.items.findIndex((item) => item.command === "checkout");
    if (index >= 0) selectCompletionByIndex(index);

    expect(harness.remoteCalls.some((call) => call.cmd === "git")).toBe(true);
    expect(beforeAccept.items.map((item) => item.command)).toContain("checkout");
    expect(writes).toEqual(["\b\bcheckout"]);
  });

  it("predicts and accepts a partial command name in the last pipeline segment", async () => {
    const writes: string[] = [];
    const leafId = init((_leafId, text) => writes.push(text));

    await typeText(leafId, "echo hi | gi");
    const state = getCompletionState();
    const index = state.items.findIndex((item) => item.command === "git");
    if (index >= 0) selectCompletionByIndex(index);

    expect(state.items.map((item) => item.command)).toContain("git");
    expect(writes).toEqual(["\b\bgit"]);
  });

  it("parses sudo options before the command and replaces only the partial subcommand", async () => {
    harness.specs.set("systemctl", {
      name: "systemctl",
      subcommands: [{ name: "status", description: "查看状态" }, { name: "start", description: "启动" }],
    });
    harness.remoteInstalled = async () => true;
    harness.remoteReply = async (_sessionId, cmd) => cmd === "systemctl" ? [arg("status")] : [];
    const writes: string[] = [];
    const leafId = init((_leafId, text) => writes.push(text));

    await typeText(leafId, "sudo -u root systemctl st");
    const state = getCompletionState();
    const index = state.items.findIndex((item) => item.command === "status");
    if (index >= 0) selectCompletionByIndex(index);

    expect(harness.remoteCalls.some((call) => call.cmd === "systemctl")).toBe(true);
    expect(state.items.map((item) => item.command)).toContain("status");
    expect(writes).toEqual(["\b\bstatus"]);
  });

  it("matches an equals-form option value and replaces only its value prefix", async () => {
    harness.specs.set("tar", {
      name: "tar",
      options: [{ name: "--hole-detection", args: { suggestions: ["seek", "raw"] } }],
    });
    harness.remoteInstalled = async () => false;
    const writes: string[] = [];
    const leafId = init((_leafId, text) => writes.push(text));

    await typeText(leafId, "tar --hole-detection=ra");
    const state = getCompletionState();
    const index = state.items.findIndex((item) => item.command === "raw");
    if (index >= 0) selectCompletionByIndex(index);

    expect(state.items.map((item) => item.command)).toEqual(["raw"]);
    expect(writes).toEqual(["\b\braw"]);
  });

  it("matches and accepts a quoted static value without replacing the opening quote", async () => {
    harness.specs.set("tool", {
      name: "tool",
      options: [{ name: "--format", args: { suggestions: ["json", "yaml"] } }],
    });
    harness.remoteInstalled = async () => false;
    const writes: string[] = [];
    const leafId = init((_leafId, text) => writes.push(text));

    await typeText(leafId, 'tool --format "j');
    const state = getCompletionState();
    const index = state.items.findIndex((item) => item.command === "json");
    if (index >= 0) selectCompletionByIndex(index);

    expect(state.items.map((item) => item.command)).toEqual(["json"]);
    expect(writes).toEqual(["\bjson"]);
  });

  it("ignores an old remote response after its session changes and still shows the next leaf's result", async () => {
    harness.specs.set("tool", { name: "tool", subcommands: [{ name: "checkout", description: "切换" }] });
    harness.remoteInstalled = async () => true;
    const oldReply = deferred<RemoteCandidate[] | null>();
    harness.remoteReply = async (sessionId) => sessionId === 7
      ? oldReply.promise
      : [arg("fresh-result")];
    const firstLeaf = init();
    let secondLeaf = 0;
    let oldState: ReturnType<typeof getCompletionState> | undefined;
    let freshState: ReturnType<typeof getCompletionState> | undefined;

    try {
      await typeText(firstLeaf, "tool ch");
      harness.sessions.set(firstLeaf, 9);
      secondLeaf = init();
      harness.sessions.set(secondLeaf, 8);
      harness.remoteCommands.set(8, new Set(["tool"]));
      await typeText(secondLeaf, "tool fr");
      oldReply.resolve([arg("stale-result")]);
      await drain();
      await settlePrediction();
      oldState = getCompletionState();
      await drain();
      freshState = getCompletionState();
    } finally {
      oldReply.resolve([]);
      await drain();
      await settlePrediction();
    }

    expect(harness.remoteCalls.some((call) => call.sessionId === 8)).toBe(true);
    expect(oldState?.items.map((item) => item.command)).not.toContain("stale-result");
    expect(freshState).toMatchObject({ visible: true, leafId: secondLeaf, prefix: "tool fr" });
    expect(freshState?.items.map((item) => item.command)).toContain("fresh-result");
  });
});
