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
 *
 * TDSF 修复 2026-08-12 (ROADMAP #9): SSH Space 时标题直接显示完整远程位置
 * `user@host:path`（随远端 cd 跟随），此前把 sshLocationLabel 当 explorerRoot
 * 传入，basename() 只取到路径最后段，丢主机信息且混入 pane cwd，导致标题
 * 显示本地目录名。
 */
export function useWindowTitle(
  activeTab: Tab | undefined,
  explorerRoot: string | null,
  sshLocation: string | null = null,
): void {
  useEffect(() => {
    let title: string;
    if (sshLocation) {
      // SSH Space：显示 user@host:path（含主机便于区分多服务器），
      // path 来自会话 OSC 7 同步，cd 后自动跟随。
      title = sshLocation;
    } else {
      const project = explorerRoot ? basename(explorerRoot) : "";
      const label = tabLabel(activeTab);
      if (project && label && label !== project) title = `${project} — ${label}`;
      else title = project || label || APP_NAME;
    }

    document.title = title;
    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 setTitle 调用
    if (!isTauriRuntime()) return;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [activeTab, explorerRoot, sshLocation]);
}
