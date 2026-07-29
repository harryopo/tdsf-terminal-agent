import { invoke } from "@tauri-apps/api/core";

export type SettingsTab =
  | "general"
  | "editor"
  | "themes"
  | "shortcuts"
  | "models"
  | "agents"
  | "tdsf" // TDSF 自研模块面板（T2.4 阶段新增）
  | "logs" // TDSF 魔改 (2026-07-28): 后端日志独立通路 - 子审查 agent 专用
  | "about";

export async function openSettingsWindow(tab?: SettingsTab): Promise<void> {
  await invoke("open_settings_window", { tab: tab ?? null });
}
