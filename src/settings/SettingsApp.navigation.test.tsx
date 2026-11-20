import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SettingsApp } from "./SettingsApp";

vi.mock("@/lib/useZoom", () => ({ useZoom: () => undefined }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (
    select: (s: {
      init: () => Promise<void>;
      terminalOutputHighlightEnabled: boolean;
    }) => unknown,
  ) => select({ init: async () => undefined, terminalOutputHighlightEnabled: true }),
}));
vi.mock("./sections/GeneralSection", () => ({
  GeneralSection: () => <h1>通用内容</h1>,
}));
vi.mock("./sections/EditorSection", () => ({
  EditorSection: () => <h1>编辑器内容</h1>,
}));
vi.mock("./sections/PredictionHistorySection", () => ({
  PredictionHistorySection: () => <h1>预测内容</h1>,
}));
vi.mock("./sections/ThemesSection", () => ({
  ThemesSection: () => <h1>主题内容</h1>,
}));
vi.mock("./sections/ShortcutsSection", () => ({
  ShortcutsSection: () => <h1>快捷键内容</h1>,
}));
vi.mock("./sections/ModelsSection", () => ({
  ModelsSection: () => <h1>模型内容</h1>,
}));
vi.mock("./sections/AgentsSection", () => ({
  AgentsSection: () => <h1>智能体内容</h1>,
}));
vi.mock("./sections/AgentHistorySection", () => ({
  AgentHistorySection: () => <h1>历史内容</h1>,
}));
vi.mock("./sections/RuntimeLogsSection", () => ({
  RuntimeLogsSection: () => <h1>日志内容</h1>,
}));
vi.mock("./sections/AboutReleaseSection", () => ({
  AboutSection: () => <h1>关于内容</h1>,
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("settings navigation", () => {
  it.each([
    ["prediction", "终端预测"],
    ["history", "对话历史"],
    ["logs", "运行日志"],
    ["utilities", "实用功能"],
    ["ai", "AI 模型"],
    ["connections", "AI 模型"],
    ["not-a-tab", "通用"],
  ])("keeps the %s deep link", (id, label) => {
    window.history.replaceState(null, "", `/?tab=${id}`);
    render(<SettingsApp />);
    expect(
      screen.getByRole("tab", { name: label }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByRole("tab")).toHaveLength(11);
  });

  it("groups settings and keeps a labeled, keyboard-navigable panel", async () => {
    render(<SettingsApp />);
    expect(screen.getByText("工作台")).toBeTruthy();
    expect(screen.getByText("AI 与诊断")).toBeTruthy();
    const logs = screen.getByRole("tab", { name: "运行日志" });
    fireEvent.mouseDown(logs, { button: 0, ctrlKey: false });
    expect(screen.getByRole("tabpanel").textContent).toContain("日志内容");
    expect(logs.getAttribute("aria-controls")).toBe(
      screen.getByRole("tabpanel").id,
    );
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe(
      "vertical",
    );
    act(() => logs.focus());
    fireEvent.keyDown(logs, { key: "ArrowUp" });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole("tab", { name: "对话历史" }),
      );
      expect(
        screen
          .getByRole("tab", { name: "对话历史" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
  });
});
