import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  saveCalls: 0,
  localListeners: [] as Array<(key: string, value: unknown) => void>,
  eventListeners: [] as Array<(event: { payload: { key: string; value: unknown } }) => void>,
  emitted: [] as Array<[string, { key: string; value: unknown }]>,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries(): Promise<[string, unknown][]> {
      return [...native.values.entries()];
    }
    async get(key: string): Promise<unknown> {
      return native.values.get(key);
    }
    async set(key: string, value: unknown): Promise<void> {
      native.values.set(key, value);
      native.localListeners.forEach((listener) => listener(key, value));
    }
    async save(): Promise<void> {
      native.saveCalls += 1;
    }
    async onChange<T>(callback: (key: string, value: T) => void): Promise<() => void> {
      const listener = callback as (key: string, value: unknown) => void;
      native.localListeners.push(listener);
      return () => {
        native.localListeners = native.localListeners.filter((item) => item !== listener);
      };
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string, payload: { key: string; value: unknown }) => {
    native.emitted.push([name, payload]);
  }),
  listen: vi.fn(async (_name: string, callback: (event: { payload: { key: string; value: unknown } }) => void) => {
    native.eventListeners.push(callback);
    return () => {
      native.eventListeners = native.eventListeners.filter((item) => item !== callback);
    };
  }),
}));

import { DEFAULT_PREFERENCES, loadPreferences, onPreferencesChange } from "./store";

let originalRuntime: PropertyDescriptor | undefined;

function setTauriRuntime(present: boolean): void {
  if (present) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

beforeEach(() => {
  originalRuntime = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
  native.values.clear();
  native.saveCalls = 0;
  native.localListeners = [];
  native.eventListeners = [];
  native.emitted = [];
  setTauriRuntime(true);
});

afterEach(() => {
  if (originalRuntime) Object.defineProperty(window, "__TAURI_INTERNALS__", originalRuntime);
  else delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("terminal output highlighting preference", () => {
  it("defaults to enabled for fresh and loaded preferences", async () => {
    expect(DEFAULT_PREFERENCES).toHaveProperty("terminalOutputHighlightEnabled", true);
    expect(await loadPreferences()).toHaveProperty("terminalOutputHighlightEnabled", true);
  });

  it("persists false, saves, and emits the cross-window preference event", async () => {
    const module = await import("./store");
    const setter = (module as unknown as Record<string, unknown>)["setTerminalOutputHighlightEnabled"];
    expect(setter).toBeTypeOf("function");
    await (setter as (value: boolean) => Promise<void>)(false);

    expect(native.values.get("terminalOutputHighlightEnabled")).toBe(false);
    expect(native.saveCalls).toBe(1);
    expect(native.emitted).toContainEqual([
      "tdsf://prefs-changed",
      { key: "terminalOutputHighlightEnabled", value: false },
    ]);
    expect(await loadPreferences()).toHaveProperty("terminalOutputHighlightEnabled", false);
  });

  it("maps the cross-window event key back to the preference field", async () => {
    const changes: Array<[string, unknown]> = [];
    const unlisten = await onPreferencesChange((key, value) => changes.push([key, value]));
    native.eventListeners.forEach((listener) => listener({
      payload: { key: "terminalOutputHighlightEnabled", value: false },
    }));

    expect(changes).toContainEqual(["terminalOutputHighlightEnabled", false]);
    unlisten();
    expect(native.eventListeners).toHaveLength(0);
  });
});
