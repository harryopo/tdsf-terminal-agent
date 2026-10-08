import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  listeners: new Map<string, Set<(event: { payload: { key: string; value: unknown } }) => void>>(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries() { return [...backend.values.entries()]; }
    async get(key: string) { return backend.values.get(key); }
    async set(key: string, value: unknown) { backend.values.set(key, value); }
    async save() {}
    async onChange() { return () => {}; }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string, payload: { key: string; value: unknown }) => {
    for (const listener of backend.listeners.get(name) ?? []) listener({ payload });
  }),
  listen: vi.fn(async (name: string, callback: (event: { payload: { key: string; value: unknown } }) => void) => {
    const listeners = backend.listeners.get(name) ?? new Set();
    listeners.add(callback);
    backend.listeners.set(name, listeners);
    return () => listeners.delete(callback);
  }),
}));

import { DEFAULT_PREFERENCES, loadPreferences, setTerminalHelpHighlight } from "./store";
import { usePreferencesStore } from "./preferences";

beforeEach(() => {
  backend.values.clear();
  backend.listeners.clear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  usePreferencesStore.setState({ ...DEFAULT_PREFERENCES, hydrated: false });
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("terminal help highlight preference", () => {
  it("defaults on when no stored value exists", async () => {
    expect(DEFAULT_PREFERENCES.terminalHelpHighlight).toBe(true);
    expect((await loadPreferences()).terminalHelpHighlight).toBe(true);
  });

  it("persists false and maps the cross-window event into preferences state", async () => {
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().terminalHelpHighlight).toBe(true);

    await setTerminalHelpHighlight(false);

    expect(backend.values.get("terminalHelpHighlight")).toBe(false);
    expect(usePreferencesStore.getState().terminalHelpHighlight).toBe(false);
  });

  it("wires the General settings row to the stored preference", () => {
    const source = readFileSync(
      join(process.cwd(), "src/settings/sections/GeneralSection.tsx"),
      "utf8",
    );
    expect(source).toContain("setTerminalHelpHighlight");
    expect(source).toMatch(/title="帮助参数高亮"[\s\S]*?checked=\{terminalHelpHighlight\}[\s\S]*?setTerminalHelpHighlight\(v\)/);
  });
});
