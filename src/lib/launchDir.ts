import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "@/lib/tauriRuntime";

let cached: string | undefined;

/**
 * #64: one process can own several main windows now, and the backend keeps the
 * launch target keyed by window label — asking with someone else's label would
 * hand this window another window's folder. Outside the desktop runtime
 * (vitest / plain browser dev) there is no window to name; "main" is what the
 * backend seeds anyway.
 */
function selfLabel(): string {
  return isTauriRuntime() ? getCurrentWindow().label : "main";
}

export async function initLaunchDir(): Promise<void> {
  const dir =
    (await invoke<string | null>("get_launch_dir", {
      label: selfLabel(),
    }).catch(() => null)) ??
    (await invoke<string>("workspace_current_dir").catch(() => null));
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/**
 * Drains the files passed via the OS "Open With" action (CLI args on
 * Linux/Windows, macOS open-files event). Drained once so HMR / re-mounts
 * can't replay them. Returns [] when the app wasn't launched with a file.
 */
export async function consumeLaunchFiles(): Promise<string[]> {
  const files = await invoke<string[]>("get_launch_files", {
    label: selfLabel(),
  }).catch(() => []);
  return files.map((f) => f.replace(/\\/g, "/"));
}
