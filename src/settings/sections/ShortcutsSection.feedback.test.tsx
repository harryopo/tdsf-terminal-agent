import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  setShortcuts: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@/modules/settings/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/settings/store")>();
  return { ...actual, setShortcuts: persistence.setShortcuts };
});

import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { ShortcutsSection } from "./ShortcutsSection";

function shortcutRow(id: string) {
  const label = screen.getByText(id, { exact: true });
  return within(label.parentElement!.parentElement!);
}

describe("ShortcutsSection feedback", () => {
  beforeEach(() => {
    persistence.setShortcuts.mockReset();
    persistence.setShortcuts.mockImplementation(async (shortcuts) => {
      usePreferencesStore.setState({ shortcuts });
    });
    usePreferencesStore.setState({
      ...DEFAULT_PREFERENCES,
      hydrated: true,
      shortcuts: { ...DEFAULT_PREFERENCES.shortcuts },
    });
  });

  it("saves a captured chord and leaves recording mode", async () => {
    render(<ShortcutsSection />);
    const row = shortcutRow("tab.new");
    fireEvent.click(row.getByRole("button", { name: "录制" }));
    fireEvent.keyDown(window, { key: "j", ctrlKey: true, shiftKey: true });

    await waitFor(() => {
      expect(persistence.setShortcuts).toHaveBeenCalledWith(
        expect.objectContaining({
          "tab.new": [{ key: "j", ctrl: true, shift: true, alt: false, meta: false }],
        }),
      );
      expect(screen.queryByText("按下新组合键 (Esc 取消)")).toBeNull();
    });
    expect(usePreferencesStore.getState().shortcuts["tab.new"]).toEqual([
      { key: "j", ctrl: true, shift: true, alt: false, meta: false },
    ]);
  });

  it("ignores a modifier-only key and Escape cancels without saving", () => {
    render(<ShortcutsSection />);
    const row = shortcutRow("tab.new");
    fireEvent.click(row.getByRole("button", { name: "录制" }));

    act(() => fireEvent.keyDown(window, { key: "Control", ctrlKey: true }));
    expect(screen.getByText("按下新组合键 (Esc 取消)")).toBeTruthy();
    expect(persistence.setShortcuts).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("按下新组合键 (Esc 取消)")).toBeNull();
    expect(persistence.setShortcuts).not.toHaveBeenCalled();
  });

  it("resets through the same persistent setter", async () => {
    render(<ShortcutsSection />);
    const row = shortcutRow("tab.new");
    fireEvent.click(row.getByRole("button", { name: "重置" }));
    await waitFor(() => expect(persistence.setShortcuts).toHaveBeenCalledOnce());
    expect(persistence.setShortcuts).toHaveBeenCalledWith(
      expect.objectContaining({ "tab.new": expect.any(Array) }),
    );
  });
});
