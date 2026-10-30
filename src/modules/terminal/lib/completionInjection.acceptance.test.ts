import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigSpec } from "@/lib/spec-data/types";
import type { SuggestionResult } from "@/lib/suggest-engine";

const fixtures = vi.hoisted(() => ({ specs: new Map<string, FigSpec>() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/predictionEvents", () => ({ PREDICTION_CLEAR_EVENT: "prediction-clear" }));
vi.mock("@/lib/spec-data/loader", () => ({
  getCommandSpec: async (cmd: string) => fixtures.specs.get(cmd) ?? null,
}));
vi.mock("@/lib/param-complete-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/param-complete-client")>();
  return {
    ...actual,
    remoteCarapaceInstalled: async () => false,
    remoteParamComplete: async () => [],
  };
});

type CompletionModule = typeof import("./completionInjection");
type ParamClient = typeof import("@/lib/param-complete-client");

const key = (value: string): KeyboardEvent => ({
  type: "keydown",
  key: value,
  keyCode: value.length === 1 ? value.charCodeAt(0) : 0,
  isComposing: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  preventDefault: vi.fn(),
} as unknown as KeyboardEvent);

const drain = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};

let completion: CompletionModule;
let paramClient: ParamClient;
let leafIds: number[] = [];
let nextLeafId = 700;

async function boot() {
  vi.resetModules();
  completion = await import("./completionInjection");
  paramClient = await import("@/lib/param-complete-client");
  completion.initCompletionInjection(() => null, () => {});
  return { completion, paramClient };
}

function makeLeaf(env: "linux" | "windows", session: number | null, remoteCwd?: () => string | null) {
  const id = ++nextLeafId;
  leafIds.push(id);
  completion.setLeafEnvironment(id, env);
  if (session !== null) paramClient.setLeafSshSession(id, session, remoteCwd ?? (() => "/srv/repo"));
  paramClient.setLeafCwd(id, "C:/work/repo");
  return id;
}

async function typeAndShow(leafId: number, text: string) {
  for (const char of text) completion.completionKeyHandler(leafId, key(char));
  await vi.advanceTimersByTimeAsync(completion.PREDICT_DEBOUNCE_MS + 1);
  await drain();
  const state = completion.getCompletionState();
  expect(state.visible).toBe(true);
  expect(state.leafId).toBe(leafId);
  return state;
}

async function showCheckout(leafId: number) {
  fixtures.specs.set("git", {
    name: "git",
    subcommands: [{ name: "checkout", description: "切换分支" }],
  });
  const state = await typeAndShow(leafId, "git c");
  expect(state.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ command: "checkout", description: "切换分支" }),
  ]));
  return state.items.findIndex((item) => item.command === "checkout");
}

beforeEach(async () => {
  vi.useFakeTimers();
  fixtures.specs.clear();
  leafIds = [];
  await boot();
});

afterEach(() => {
  completion.closeCompletion();
  for (const id of leafIds) {
    completion.clearLeafEnvironment(id);
    paramClient.setLeafSshSession(id, null);
    paramClient.setLeafCwd(id, null);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("completion acceptance context", () => {
  it.each([
    ["remote cwd", (id: number, client: ParamClient) => {
      let cwd = "/srv/repo";
      client.setLeafSshSession(id, 7, () => cwd);
      cwd = "/srv/other";
    }, "mouse"],
    ["SSH session", (id: number, client: ParamClient) => client.setLeafSshSession(id, 8, () => "/srv/repo"), "arrow"],
    ["environment", (id: number) => completion.setLeafEnvironment(id, "windows"), "mouse"],
    ["local cwd", (id: number, client: ParamClient) => client.setLeafCwd(id, "C:/work/other"), "arrow"],
  ] as const)("rejects an already visible candidate after %s changes", async (name, change, method) => {
    const local = name === "local cwd";
    const leaf = makeLeaf(local ? "windows" : "linux", local ? null : 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    const index = await showCheckout(leaf);

    change(leaf, paramClient);
    if (method === "mouse") completion.selectCompletionByIndex(index);
    else expect(completion.completionKeyHandler(leaf, key("ArrowRight"))).toBe(true);

    expect(writes).toEqual([]);
    expect(completion.getCompletionState().visible).toBe(false);
  });

  it("invalidates a shown command-mode candidate when its SSH target changes", async () => {
    const leaf = makeLeaf("linux", 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    const state = await typeAndShow(leaf, "syst");
    expect(state.items.map((item: SuggestionResult) => item.command)).toContain("systemctl");

    paramClient.setLeafSshSession(leaf, 8, () => "/srv/repo");
    completion.selectCompletionByIndex(state.items.findIndex((item) => item.command === "systemctl"));

    expect(writes).toEqual([]);
    expect(completion.getCompletionState().visible).toBe(false);
  });

  it("clearing the old leaf does not cancel the next leaf's pending prediction", async () => {
    const first = makeLeaf("linux", 7);
    const second = makeLeaf("linux", 8);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    await typeAndShow(first, "syst");

    for (const char of "syst") completion.completionKeyHandler(second, key(char));
    expect(completion.getCompletionState().visible).toBe(false);
    completion.clearLeafEnvironment(first);
    await vi.advanceTimersByTimeAsync(completion.PREDICT_DEBOUNCE_MS + 1);
    await drain();

    const state = completion.getCompletionState();
    expect(state).toMatchObject({ visible: true, leafId: second, prefix: "syst" });
    expect(state.items.map((item) => item.command)).toContain("systemctl");
    expect(completion.completionKeyHandler(second, key("ArrowRight"))).toBe(false);
    expect(writes).toEqual(["\b\b\b\bsystemctl"]);
  });

  it("clear of the active leaf closes its candidate before it can be accepted", async () => {
    const leaf = makeLeaf("linux", 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    const index = await showCheckout(leaf);

    completion.clearLeafEnvironment(leaf);
    expect(completion.getCompletionState().visible).toBe(false);
    completion.selectCompletionByIndex(index);

    expect(completion.getCompletionState().visible).toBe(false);
    expect(writes).toEqual([]);
  });

  it("clearing another leaf leaves the active candidate valid", async () => {
    const active = makeLeaf("linux", 7);
    const other = makeLeaf("linux", 9);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    const index = await showCheckout(active);

    completion.clearLeafEnvironment(other);
    completion.selectCompletionByIndex(index);

    expect(writes).toEqual(["\bcheckout"]);
  });

  it("accepts a current candidate by mouse after focus moves to the popup", async () => {
    const terminal = document.createElement("div");
    const input = document.createElement("textarea");
    terminal.append(input);
    const popupButton = document.createElement("button");
    document.body.append(terminal, popupButton);
    input.focus();
    const leaf = makeLeaf("linux", 7);
    const term = { element: terminal, cols: 80, rows: 24, buffer: { active: { cursorX: 0, cursorY: 0 } } };
    const writes: string[] = [];
    completion.initCompletionInjection((id) => id === leaf ? term as never : null, (_id, data) => writes.push(data));
    const index = await showCheckout(leaf);
    expect(document.activeElement).toBe(input);

    popupButton.focus();
    completion.selectCompletionByIndex(index);

    expect(writes).toEqual(["\bcheckout"]);
  });

  it("accepts a current ArrowRight candidate exactly once and always passes Enter through", async () => {
    const leaf = makeLeaf("linux", 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    await showCheckout(leaf);
    expect(completion.completionKeyHandler(leaf, key("Enter"))).toBe(true);
    expect(writes).toEqual([]);

    completion.closeCompletion();
    await showCheckout(leaf);
    expect(completion.completionKeyHandler(leaf, key("ArrowRight"))).toBe(false);
    expect(writes).toEqual(["\bcheckout"]);
  });
});

describe("completion modifier arrows", () => {
  beforeEach(() => {
    fixtures.specs.set("git", {
      name: "git",
      subcommands: [
        { name: "checkout", description: "切换分支" },
        { name: "cherry-pick", description: "拣选提交" },
      ],
    });
  });

  it.each(
    (["ctrlKey", "altKey", "metaKey", "shiftKey"] as const).flatMap((modifier) =>
      (["ArrowRight", "ArrowUp", "ArrowDown"] as const).map((arrow) => [modifier, arrow] as const),
    ),
  )("passes %s + %s through without accepting or selecting a prediction", async (modifier, arrow) => {
    const leaf = makeLeaf("linux", 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    const state = await typeAndShow(leaf, "git c");
    expect(state.items.length).toBeGreaterThan(1);
    const event = new KeyboardEvent("keydown", {
      key: arrow,
      code: arrow,
      keyCode: { ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 }[arrow],
      cancelable: true,
      [modifier]: true,
    });
    expect(event[modifier]).toBe(true);

    expect(completion.completionKeyHandler(leaf, event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(writes).toEqual([]);
    expect(completion.getCompletionState().visible).toBe(false);

    for (const char of "heck") completion.completionKeyHandler(leaf, key(char));
    await vi.advanceTimersByTimeAsync(completion.PREDICT_DEBOUNCE_MS + 1);
    await drain();
    expect(completion.getCompletionState().visible).toBe(false);
    expect(writes).toEqual([]);
    expect(completion.completionKeyHandler(leaf, key("Enter"))).toBe(true);
    await typeAndShow(leaf, "git c");
  });

  it("keeps ordinary arrows selecting and accepting the current prediction", async () => {
    const leaf = makeLeaf("linux", 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    const state = await typeAndShow(leaf, "git c");
    expect(state.items.length).toBeGreaterThan(1);
    expect(state.items[0].command).toBe("checkout");

    expect(completion.completionKeyHandler(leaf, key("ArrowDown"))).toBe(false);
    expect(completion.getCompletionState().selectedIndex).toBe(1);
    expect(completion.completionKeyHandler(leaf, key("ArrowUp"))).toBe(false);
    expect(completion.getCompletionState().selectedIndex).toBe(0);
    expect(writes).toEqual([]);
    expect(completion.completionKeyHandler(leaf, key("ArrowRight"))).toBe(false);
    expect(writes).toEqual(["\bcheckout"]);
    expect(completion.getCompletionState().visible).toBe(false);
  });
});

describe("completion clipboard input boundaries", () => {
  beforeEach(async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT 10.0");
    await boot();
    fixtures.specs.set("git", {
      name: "git",
      subcommands: [{ name: "checkout", description: "切换分支" }],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["linux", 7, "C"],
    ["windows", null, "c"],
  ] as const)("preserves the %s command prefix after terminal copy", async (env, session, letter) => {
    const leaf = makeLeaf(env, session);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    await typeAndShow(leaf, "git c");
    const copy = new KeyboardEvent("keydown", {
      key: letter, code: "KeyC", ctrlKey: true, shiftKey: true, cancelable: true,
    });

    expect(completion.completionKeyHandler(leaf, copy)).toBe(true);
    expect(copy.defaultPrevented).toBe(false);
    expect(completion.getCompletionState()).toMatchObject({ visible: true, prefix: "git c" });
    expect(writes).toEqual([]);
    const state = await typeAndShow(leaf, "h");
    expect(state.prefix).toBe("git ch");
    completion.selectCompletionByIndex(state.items.findIndex((item) => item.command === "checkout"));
    expect(writes).toEqual(["\b\bcheckout"]);
  });

  it("keeps Ctrl+Shift+C as a terminal control on macOS", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
    await boot();
    const leaf = makeLeaf("linux", 7);
    await typeAndShow(leaf, "git c");
    const control = new KeyboardEvent("keydown", { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });
    expect(completion.completionKeyHandler(leaf, control)).toBe(true);
    expect(completion.getCompletionState().visible).toBe(false);
    const state = await typeAndShow(leaf, "git c");
    expect(state.prefix).toBe("git c");
  });

  it.each(["c", "u"])("keeps Ctrl+%s clearing the input prefix", async (letter) => {
    const leaf = makeLeaf("linux", 7);
    await typeAndShow(leaf, "git c");
    const control = new KeyboardEvent("keydown", { key: letter, ctrlKey: true });
    expect(completion.completionKeyHandler(leaf, control)).toBe(true);
    const state = await typeAndShow(leaf, "git c");
    expect(state.prefix).toBe("git c");
  });

  it("invalidates a pasted line on Shift+Insert until the next command", async () => {
    const leaf = makeLeaf("linux", 7);
    const writes: string[] = [];
    completion.initCompletionInjection(() => null, (_id, data) => writes.push(data));
    await typeAndShow(leaf, "git c");
    const paste = new KeyboardEvent("keydown", { key: "Insert", code: "Insert", shiftKey: true, cancelable: true });
    expect(completion.completionKeyHandler(leaf, paste)).toBe(true);
    expect(paste.defaultPrevented).toBe(false);
    expect(completion.getCompletionState().visible).toBe(false);
    for (const char of "heck") completion.completionKeyHandler(leaf, key(char));
    await vi.advanceTimersByTimeAsync(completion.PREDICT_DEBOUNCE_MS + 1);
    await drain();
    expect(completion.getCompletionState().visible).toBe(false);
    expect(writes).toEqual([]);
    expect(completion.completionKeyHandler(leaf, key("Enter"))).toBe(true);
    const state = await typeAndShow(leaf, "git c");
    expect(state.prefix).toBe("git c");
  });

  it("does not treat an unmodified Insert key as paste", async () => {
    const leaf = makeLeaf("linux", 7);
    await typeAndShow(leaf, "git c");
    expect(completion.completionKeyHandler(leaf, new KeyboardEvent("keydown", { key: "Insert" }))).toBe(true);
    expect(completion.getCompletionState()).toMatchObject({ visible: true, prefix: "git c" });
  });
});
