import { isTauriRuntime } from "@/lib/tauriRuntime";
import { findLeafCwd } from "@/modules/terminal/lib/panes";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import type { Tab } from "./useTabs";

const APP_NAME = "TDSF";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/** Label of the focused tab — for terminals, the active pane's folder. */
function tabLabel(tab: Tab | undefined): string {
  if (!tab) return "";
  if (tab.kind === "terminal") {
    const cwd = findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd;
    return cwd ? basename(cwd) : tab.title;
  }
  return tab.title;
}

/**
 * Drives the OS window title from the focused tab + project folder, the way
 * Spotify shows the current track instead of just the app name. Without this
 * the window keeps the build-time default ("Tauri App" on Linux).
 *
 * Format: `<project> — <tab>` (e.g. `tdsf — src`), collapsing to just the
 * project when the focused terminal sits at the project root. Falls back to the
 * app name when there's nothing to show.
 */
export function useWindowTitle(
  activeTab: Tab | undefined,
  explorerRoot: string | null,
): void {
  const project = explorerRoot ? basename(explorerRoot) : "";
  const label = tabLabel(activeTab);

  useEffect(() => {
    let title: string;
    if (project && label && label !== project) title = `${project} — ${label}`;
    else title = project || label || APP_NAME;

    document.title = title;
    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 setTitle 调用
    if (!isTauriRuntime()) return;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [project, label]);
}
