import { invoke } from "@tauri-apps/api/core";

export type SettingsTab =
  | "general"
  | "editor"
  | "themes"
  | "shortcuts"
  | "models"
  | "agents"
  | "history"
  | "about";

export async function openSettingsWindow(tab?: SettingsTab): Promise<void> {
  await invoke("open_settings_window", { tab: tab ?? null });
}
