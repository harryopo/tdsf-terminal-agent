import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async entries() { return [...backend.values.entries()]; }
    async get(key: string) { return backend.values.get(key); }
    async set(key: string, value: unknown) { backend.values.set(key, value); }
    async save() {}
  },
}));

import { DEFAULT_PREFERENCES, loadPreferences } from "./store";

beforeEach(() => {
  backend.values.clear();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("always-on terminal output highlighting", () => {
  it("does not expose a help-highlight preference in defaults or stored preferences", async () => {
    backend.values.set("terminalHelpHighlight", false);

    expect(DEFAULT_PREFERENCES).not.toHaveProperty("terminalHelpHighlight");
    expect(await loadPreferences()).not.toHaveProperty("terminalHelpHighlight");
  });

  it("does not expose a dedicated highlight toggle or setter in General settings", () => {
    const section = readFileSync(
      join(process.cwd(), "src/settings/sections/GeneralSection.tsx"),
      "utf8",
    );
    const store = readFileSync(join(process.cwd(), "src/modules/settings/store.ts"), "utf8");

    expect(section).not.toMatch(/帮助参数高亮|terminalHelpHighlight|setTerminalHelpHighlight/);
    expect(store).not.toMatch(/terminalHelpHighlight|setTerminalHelpHighlight/);
  });
});
