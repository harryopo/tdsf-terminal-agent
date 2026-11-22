import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const deferredCleanup: Array<() => void> = [];
let initPromises: Promise<void>[] = [];

function deferred<T>(fallback: T): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  deferredCleanup.push(() => resolve(fallback));
  return { promise, resolve, reject };
}

const harness = vi.hoisted(() => ({
  entries: undefined as (() => Promise<[string, unknown][]>) | undefined,
  entriesCalls: 0,
  onChangeCalls: 0,
  localListeners: [] as Array<(key: string, value: unknown) => void>,
  eventListeners: [] as Array<(event: { payload: { key: string; value: unknown } }) => void>,
  listenCalls: 0,
  localUnlistens: 0,
  eventUnlistens: 0,
  listenImpl: undefined as undefined | ((callback: (event: { payload: { key: string; value: unknown } }) => void) => Promise<() => void>),
  apiCalls: 0,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    private values = new Map<string, unknown>();

    async entries(): Promise<[string, unknown][]> {
      harness.entriesCalls += 1;
      return harness.entries ? harness.entries() : [...this.values.entries()];
    }

    async get(key: string): Promise<unknown> {
      return this.values.get(key);
    }

    async set(key: string, value: unknown): Promise<void> {
      this.values.set(key, value);
      for (const listener of harness.localListeners) listener(key, value);
    }

    async save(): Promise<void> {}

    async onChange<T>(callback: (key: string, value: T) => void): Promise<() => void> {
      harness.onChangeCalls += 1;
      const listener = callback as (key: string, value: unknown) => void;
      harness.localListeners.push(listener);
      return () => {
        harness.localUnlistens += 1;
        harness.localListeners = harness.localListeners.filter((item) => item !== listener);
      };
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string, payload?: { key: string; value: unknown }) => {
    harness.apiCalls += 1;
    if (name === "tdsf://prefs-changed" && payload) {
      for (const listener of harness.eventListeners) listener({ payload });
    }
  }),
  listen: vi.fn(async (_name: string, callback: (event: { payload: { key: string; value: unknown } }) => void) => {
    harness.apiCalls += 1;
    harness.listenCalls += 1;
    if (harness.listenImpl) return harness.listenImpl(callback);
    harness.eventListeners.push(callback);
    return () => {
      harness.eventUnlistens += 1;
      harness.eventListeners = harness.eventListeners.filter((item) => item !== callback);
    };
  }),
}));

const fastPathKeys = ["tdsf-ui-bg-kind-shadow", "tdsf-ui-bg-image-shadow"] as const;
let originalRuntimeDescriptor: PropertyDescriptor | undefined;
let originalFastPath = new Map<string, string | null>();

async function loadPreferencesModule() {
  const preferences = await import("./preferences");
  const store = await import("./store");
  return { preferences, store };
}

function startInit(preferences: Awaited<ReturnType<typeof loadPreferencesModule>>["preferences"]) {
  const promise = preferences.usePreferencesStore.getState().init();
  initPromises.push(promise);
  return promise;
}

function enableTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

describe("preferences startup synchronization", () => {
  beforeEach(async () => {
    originalRuntimeDescriptor = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
    originalFastPath = new Map(fastPathKeys.map((key) => [key, window.localStorage.getItem(key)]));
    harness.entries = undefined;
    harness.entriesCalls = 0;
    harness.onChangeCalls = 0;
    harness.localListeners = [];
    harness.eventListeners = [];
    harness.listenCalls = 0;
    harness.localUnlistens = 0;
    harness.eventUnlistens = 0;
    harness.listenImpl = undefined;
    harness.apiCalls = 0;
    deferredCleanup.length = 0;
    initPromises = [];
    vi.resetModules();
    enableTauriRuntime();
  });

  afterEach(async () => {
    for (const release of deferredCleanup) release();
    await Promise.allSettled(initPromises);
    harness.localListeners = [];
    harness.eventListeners = [];
    if (originalRuntimeDescriptor) {
      Object.defineProperty(window, "__TAURI_INTERNALS__", originalRuntimeDescriptor);
    } else {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
    for (const key of fastPathKeys) {
      const value = originalFastPath.get(key);
      if (value === null) window.localStorage.removeItem(key);
      else if (value !== undefined) window.localStorage.setItem(key, value);
    }
  });

  it("默认命令蓝色随偏好初始化，不增加原生读取", async () => {
    const { preferences } = await loadPreferencesModule();
    await startInit(preferences);
    expect(preferences.usePreferencesStore.getState()).toMatchObject({ agentCommandColor: "#5b8cff" });
    expect(harness.entriesCalls).toBe(1);
  });

  it("规范化已保存颜色，无效配置回退默认蓝色", async () => {
    harness.entries = async () => [["agentCommandColor", "#AAbbCC"]];
    const { store } = await loadPreferencesModule();
    expect(await store.loadPreferences()).toMatchObject({ agentCommandColor: "#aabbcc" });
    harness.entries = async () => [["agentCommandColor", "\x1b[31m"]];
    expect(await store.loadPreferences()).toMatchObject({ agentCommandColor: "#5b8cff" });
  });

  it("命令颜色持久化并跨窗口同步，初始化旧快照不覆盖新选择", async () => {
    const snapshot = deferred<[string, unknown][]>([]);
    harness.entries = () => snapshot.promise;
    const { preferences, store } = await loadPreferencesModule();
    const init = startInit(preferences);
    await vi.waitFor(() => expect(harness.entriesCalls).toBe(1));
    expect(store).toHaveProperty("setAgentCommandColor", expect.any(Function));
    const setColor = (store as unknown as { setAgentCommandColor: (color: string) => Promise<void> }).setAgentCommandColor;
    await setColor("#22AA77");
    snapshot.resolve([["agentCommandColor", "#aabbcc"]]);
    await init;
    expect(preferences.usePreferencesStore.getState()).toMatchObject({ agentCommandColor: "#22aa77" });
    harness.entries = undefined;
    expect(await store.loadPreferences()).toMatchObject({ agentCommandColor: "#22aa77" });
    const { emit } = await import("@tauri-apps/api/event");
    await emit("tdsf://prefs-changed", { key: "agentCommandColor", value: "#AABBCC" });
    expect(preferences.usePreferencesStore.getState()).toMatchObject({ agentCommandColor: "#aabbcc" });
    await emit("tdsf://prefs-changed", { key: "agentCommandColor", value: "invalid" });
    expect(preferences.usePreferencesStore.getState()).toMatchObject({ agentCommandColor: "#5b8cff" });
    await setColor("invalid");
    expect(await store.loadPreferences()).toMatchObject({ agentCommandColor: "#5b8cff" });
  });

  it("waits for cross-window subscription before reporting hydration", async () => {
    const subscription = deferred<() => void>(() => {});
    harness.listenImpl = async (callback) => {
      harness.eventListeners.push(callback);
      return subscription.promise;
    };
    const { preferences } = await loadPreferencesModule();
    const init = startInit(preferences);
    await vi.waitFor(() => expect(harness.listenCalls).toBe(1));

    expect(preferences.usePreferencesStore.getState().hydrated).toBe(false);
    let settled = false;
    void init.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    subscription.resolve(() => {});
    await init;
    expect(preferences.usePreferencesStore.getState().hydrated).toBe(true);
  });

  it("keeps setter changes made during snapshot loading while applying untouched snapshot values", async () => {
    const snapshot = deferred<[string, unknown][]>([]);
    harness.entries = () => snapshot.promise;
    const { preferences, store } = await loadPreferencesModule();
    const init = startInit(preferences);
    await vi.waitFor(() => expect(harness.entriesCalls).toBe(1));

    await store.setAgentExecutionChannel("visible-terminal");
    await store.setAgentTypingMode("human");
    await store.setAgentTypingMode("instant");
    await store.setAgentTypingMode("human");
    await store.setAgentTypingSpeed(2.4);
    await store.setAgentAutoTypeCommands(false);
    snapshot.resolve([
      ["agentExecutionChannel", "background"],
      ["agentTypingMode", "instant"],
      ["agentTypingSpeed", 0.8],
      ["agentAutoTypeCommands", true],
      ["themeId", "snapshot-theme"],
    ]);
    await init;

    const state = preferences.usePreferencesStore.getState();
    expect(state.agentExecutionChannel).toBe("visible-terminal");
    expect(state.agentTypingMode).toBe("human");
    expect(state.agentTypingSpeed).toBe(2.4);
    expect(state.agentAutoTypeCommands).toBe(false);
    expect(state.themeId).toBe("snapshot-theme");
  });

  it("mirrors the latest cross-window background changes after a stale startup snapshot resolves", async () => {
    const snapshot = deferred<[string, unknown][]>([]);
    harness.entries = () => snapshot.promise;
    const { preferences } = await loadPreferencesModule();
    const init = startInit(preferences);
    await vi.waitFor(() => expect(harness.entriesCalls).toBe(1));
    const { emit } = await import("@tauri-apps/api/event");
    await emit("tdsf://prefs-changed", { key: "backgroundKind", value: "image" });
    await emit("tdsf://prefs-changed", { key: "backgroundImageId", value: "new-image" });
    snapshot.resolve([
      ["backgroundKind", "none"],
      ["backgroundImageId", null],
    ]);
    await init;

    expect(window.localStorage.getItem(fastPathKeys[0])).toBe("image");
    expect(window.localStorage.getItem(fastPathKeys[1])).toBe("new-image");
  });

  it("continues to apply real setters after initialization", async () => {
    const { preferences, store } = await loadPreferencesModule();
    await startInit(preferences);

    await store.setAgentTypingMode("human");
    await store.setAgentTypingSpeed(3.1);

    expect(preferences.usePreferencesStore.getState().agentTypingMode).toBe("human");
    expect(preferences.usePreferencesStore.getState().agentTypingSpeed).toBe(3.1);
  });

  it("shares concurrent init and creates one snapshot read and subscription", async () => {
    const snapshot = deferred<[string, unknown][]>([]);
    harness.entries = () => snapshot.promise;
    const { preferences } = await loadPreferencesModule();
    const state = preferences.usePreferencesStore.getState();
    const first = startInit(preferences);
    const second = state.init();
    initPromises.push(second);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(harness.entriesCalls).toBe(1));
    snapshot.resolve([["themeId", "once"]]);
    await Promise.all([first, second]);

    expect(harness.entriesCalls).toBe(1);
    expect(harness.listenCalls).toBe(1);
  });

  it("cleans up after entries failure and allows a clean retry", async () => {
    const failure = deferred<[string, unknown][]>([]);
    harness.entries = () => failure.promise;
    const { preferences, store } = await loadPreferencesModule();
    const first = startInit(preferences);
    await vi.waitFor(() => expect(harness.entriesCalls).toBe(1));
    failure.reject(new Error("snapshot failed"));
    await expect(first).rejects.toThrow("snapshot failed");
    expect(harness.localListeners).toHaveLength(0);
    expect(harness.eventListeners).toHaveLength(0);

    harness.entries = async () => [["themeId", "retry"]];
    await startInit(preferences);
    expect(preferences.usePreferencesStore.getState().themeId).toBe("retry");
    expect(harness.localListeners).toHaveLength(1);
    expect(harness.eventListeners).toHaveLength(1);
    await store.setThemeId("updated-after-retry");
    expect(preferences.usePreferencesStore.getState().themeId).toBe("updated-after-retry");
  });

  it("removes the local subscription when event registration fails and can retry", async () => {
    harness.listenImpl = async () => { throw new Error("event listen failed"); };
    const { store } = await loadPreferencesModule();
    await expect(store.onPreferencesChange(() => {})).rejects.toThrow("event listen failed");
    expect(harness.localListeners).toHaveLength(0);
    expect(harness.eventListeners).toHaveLength(0);

    harness.listenImpl = undefined;
    const unlisten = await store.onPreferencesChange(() => {});
    expect(harness.localListeners).toHaveLength(1);
    expect(harness.eventListeners).toHaveLength(1);
    unlisten();
    expect(harness.localListeners).toHaveLength(0);
    expect(harness.eventListeners).toHaveLength(0);
  });

  it("uses defaults and becomes ready without calling native APIs outside Tauri", async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const { preferences } = await loadPreferencesModule();
    await startInit(preferences);

    expect(preferences.usePreferencesStore.getState().hydrated).toBe(true);
    expect(preferences.usePreferencesStore.getState().agentExecutionChannel).toBe("background");
    expect(preferences.usePreferencesStore.getState().agentTypingMode).toBe("instant");
    expect(preferences.usePreferencesStore.getState().agentTypingSpeed).toBe(1);
    expect(preferences.usePreferencesStore.getState().agentAutoTypeCommands).toBe(true);
    expect(harness.entriesCalls).toBe(0);
    expect(harness.onChangeCalls).toBe(0);
    expect(harness.listenCalls).toBe(0);
    expect(harness.apiCalls).toBe(0);
  });
});
