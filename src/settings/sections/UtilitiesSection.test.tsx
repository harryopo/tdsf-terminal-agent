import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const native = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
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
    async save(): Promise<void> {}
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
    if (name === "tdsf://prefs-changed") {
      native.eventListeners.forEach((listener) => listener({ payload }));
    }
  }),
  listen: vi.fn(async (_name: string, callback: (event: { payload: { key: string; value: unknown } }) => void) => {
    native.eventListeners.push(callback);
    return () => {
      native.eventListeners = native.eventListeners.filter((item) => item !== callback);
    };
  }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: async () => () => {} }),
}));
vi.mock("@/lib/useZoom", () => ({ useZoom: () => undefined }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("./GeneralSection", () => ({ GeneralSection: () => <h1>通用内容</h1> }));
vi.mock("./EditorSection", () => ({ EditorSection: () => <h1>编辑器内容</h1> }));
vi.mock("./PredictionHistorySection", () => ({ PredictionHistorySection: () => <h1>预测内容</h1> }));
vi.mock("./ThemesSection", () => ({ ThemesSection: () => <h1>主题内容</h1> }));
vi.mock("./ShortcutsSection", () => ({ ShortcutsSection: () => <h1>快捷键内容</h1> }));
vi.mock("./ModelsSection", () => ({ ModelsSection: () => <h1>模型内容</h1> }));
vi.mock("./AgentsSection", () => ({ AgentsSection: () => <h1>智能体内容</h1> }));
vi.mock("./AgentHistorySection", () => ({ AgentHistorySection: () => <h1>历史内容</h1> }));
vi.mock("./RuntimeLogsSection", () => ({ RuntimeLogsSection: () => <h1>日志内容</h1> }));
vi.mock("./AboutReleaseSection", () => ({ AboutSection: () => <h1>关于内容</h1> }));

import { SettingsApp } from "../SettingsApp";
import { usePreferencesStore } from "@/modules/settings/preferences";

let originalRuntime: PropertyDescriptor | undefined;

function preferenceValue(): unknown {
  return (usePreferencesStore.getState() as unknown as Record<string, unknown>)
    .terminalOutputHighlightEnabled;
}

beforeEach(() => {
  originalRuntime = Object.getOwnPropertyDescriptor(window, "__TAURI_INTERNALS__");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  native.values.clear();
  native.localListeners = [];
  native.eventListeners = [];
  native.emitted = [];
  window.history.replaceState(null, "", "/?tab=utilities");
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  if (originalRuntime) Object.defineProperty(window, "__TAURI_INTERNALS__", originalRuntime);
  else delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("Utilities settings", () => {
  it("opens from the real settings deep link, toggles the persisted preference, and shows all theme-color examples", async () => {
    render(<SettingsApp />);

    const toggle = await screen.findByRole("switch", { name: "彩色输出增强" });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(preferenceValue()).toBe(true);
    expect(screen.getByText(/程序原生 ANSI.*不受影响/)).toBeTruthy();

    const examples = [
      ["选项、键、路径", "--terminal-ansi-cyan"],
      ["值、关键字", "--terminal-ansi-magenta"],
      ["字符串、成功", "--terminal-ansi-green"],
      ["数值、警告", "--terminal-ansi-yellow"],
      ["注释", "--terminal-ansi-bright-black"],
      ["错误", "--terminal-ansi-red"],
      ["地址", "--terminal-ansi-blue"],
    ];
    for (const [label, token] of examples) {
      expect(screen.getByText(label).getAttribute("style")).toContain(`var(${token})`);
    }

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "彩色输出增强" }).getAttribute("aria-checked")).toBe("false");
      expect(preferenceValue()).toBe(false);
    });
    expect(native.values.get("terminalOutputHighlightEnabled")).toBe(false);
    expect(native.emitted).toContainEqual([
      "tdsf://prefs-changed",
      { key: "terminalOutputHighlightEnabled", value: false },
    ]);

    fireEvent.click(screen.getByRole("switch", { name: "彩色输出增强" }));
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "彩色输出增强" }).getAttribute("aria-checked")).toBe("true");
      expect(preferenceValue()).toBe(true);
    });
  });
});
