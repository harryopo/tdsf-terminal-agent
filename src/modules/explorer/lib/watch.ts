import { isTauriRuntime } from "@/lib/tauriRuntime";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const FS_CHANGED_EVENT = "fs:changed";

type FsChangedPayload = { paths: string[] };

export function watchAdd(paths: string[]): void {
  if (paths.length === 0) return;
  // TDSF 魔改: dev 模式 (无 Tauri 运行时) 直接 noop, 避免 invoke 抛错
  if (!isTauriRuntime()) return;
  void invoke("fs_watch_add", {
    paths,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function watchRemove(paths: string[]): void {
  if (paths.length === 0) return;
  // TDSF 魔改: dev 模式 (无 Tauri 运行时) 直接 noop
  if (!isTauriRuntime()) return;
  void invoke("fs_watch_remove", {
    paths,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export async function listenFsChanged(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  // TDSF 魔改: dev 模式 (无 Tauri 运行时) 返回 noop 取消函数
  if (!isTauriRuntime()) {
    if (typeof console !== "undefined") {
      console.debug(
        "[listenFsChanged] dev mode, no tauri runtime, returning noop",
      );
    }
    return () => {};
  }
  const unlisten = await getCurrentWebviewWindow().listen<FsChangedPayload>(
    FS_CHANGED_EVENT,
    (e) => handler(e.payload.paths),
  );
  return unlisten;
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  return path.slice(0, i);
}
