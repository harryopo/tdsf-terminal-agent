import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({ setThemeId: vi.fn() }));

vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@/modules/settings/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/settings/store")>();
  return { ...actual, setThemeId: persistence.setThemeId };
});
vi.mock("./customThemes", () => ({
  listCustomThemes: vi.fn(async () => []),
  onCustomThemesChange: vi.fn(async () => () => {}),
}));
vi.mock("./applyTheme", () => ({ applyTheme: vi.fn(), clearTheme: vi.fn() }));

import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { ThemeProvider, useTheme } from "./ThemeProvider";
import { listBuiltinThemes } from "./themes";
import { DEFAULT_THEME_ID } from "./types";

function ThemeProbe({ selectedId }: { selectedId: string }) {
  const { themeId, setThemeId } = useTheme();
  return (
    <>
      <output data-testid="theme-id">{themeId}</output>
      <button onClick={() => setThemeId(selectedId)}>选择主题</button>
    </>
  );
}

describe("ThemeProvider feedback", () => {
  beforeEach(() => {
    localStorage.clear();
    persistence.setThemeId.mockReset();
    persistence.setThemeId.mockImplementation(async (themeId) => {
      // The settings store event returns the persisted selection to this window.
      usePreferencesStore.setState({ themeId });
    });
    usePreferencesStore.setState({
      ...DEFAULT_PREFERENCES,
      hydrated: true,
      themeId: DEFAULT_THEME_ID,
    });
  });

  it("keeps a newly selected built-in theme when preferences echo it back", async () => {
    const selected = listBuiltinThemes().find(
      (theme) => theme.id !== DEFAULT_THEME_ID,
    );
    expect(selected).toBeTruthy();
    render(
      <ThemeProvider>
        <ThemeProbe selectedId={selected!.id} />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("theme-id").textContent).toBe(DEFAULT_THEME_ID),
    );
    fireEvent.click(screen.getByRole("button", { name: "选择主题" }));

    await waitFor(() =>
      expect(screen.getByTestId("theme-id").textContent).toBe(selected!.id),
    );
    expect(persistence.setThemeId).toHaveBeenCalledWith(selected!.id);
    expect(usePreferencesStore.getState().themeId).toBe(selected!.id);
  });
});
