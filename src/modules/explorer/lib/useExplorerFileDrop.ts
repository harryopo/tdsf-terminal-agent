import { isTauriRuntime } from "@/lib/tauriRuntime";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Options = {
  rootPath: string | null;
  isDir: (path: string) => boolean | undefined;
  onCopied: (destDir: string) => void;
  /** 有值时将本地拖入文件上传到当前 SSH 会话，而不是复制到本地工作区。 */
  remoteSessionId?: number | null;
  disabled?: boolean;
};

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

export type RemoteUploadTarget = {
  localPath: string;
  remotePath: string;
};

/** 将 Windows/macOS/Linux 本地路径安全地映射为目标远程目录中的同名文件。 */
export function remoteUploadTargets(
  paths: string[],
  destination: string,
): RemoteUploadTarget[] {
  const base = destination === "/" ? "" : destination.replace(/\/+$/, "");
  return paths.map((localPath) => {
    const name = localPath.split(/[\\/]/).filter(Boolean).at(-1);
    if (!name || name === "." || name === "..") {
      throw new Error(`Invalid local file path: ${localPath}`);
    }
    return { localPath, remotePath: `${base}/${name}` };
  });
}

// Tauri reports the drop point in physical pixels on some platforms; scale down
// only when it overflows the logical viewport (mirrors the terminal drop).
function dirAt(
  x: number,
  y: number,
  rootPath: string | null,
  isDir: (p: string) => boolean | undefined,
): string | null {
  let lx = x;
  let ly = y;
  if (x > window.innerWidth || y > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    lx = x / dpr;
    ly = y / dpr;
  }
  const el = document.elementFromPoint(lx, ly) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    return isDir(p) ? p : parentDir(p);
  }
  if (el.closest("[data-explorer-drop]")) return rootPath;
  return null;
}

// Accepts files dropped from the OS onto an explorer folder (copy, not move),
// via Tauri's native drag-drop. One webview-level listener; ignores drops that
// land outside the explorer (the terminal handles its own).
export function useExplorerFileDrop({
  rootPath,
  isDir,
  onCopied,
  remoteSessionId = null,
  disabled,
}: Options) {
  const [targetDir, setTargetDir] = useState<string | null>(null);
  const optsRef = useRef({ rootPath, isDir, onCopied, remoteSessionId });
  optsRef.current = { rootPath, isDir, onCopied, remoteSessionId };

  // biome-ignore lint/correctness/useExhaustiveDependencies: listener is set up once on mount; optsRef carries live values for rootPath/isDir/onCopied to avoid re-subscribing.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    if (disabled) return;

    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 native drag-drop 监听
    if (!isTauriRuntime()) {
      if (typeof console !== "undefined") {
        console.debug("[useExplorerFileDrop] dev mode, skip native drag-drop");
      }
      return;
    }

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        const { rootPath, isDir, onCopied, remoteSessionId } = optsRef.current;
        if (p.type === "enter" || p.type === "over") {
          setTargetDir(dirAt(p.position.x, p.position.y, rootPath, isDir));
          return;
        }
        if (p.type === "leave") {
          setTargetDir(null);
          return;
        }
        if (p.type === "drop") {
          const dir = dirAt(p.position.x, p.position.y, rootPath, isDir);
          setTargetDir(null);
          if (!dir || p.paths.length === 0) return;
          const copy =
            remoteSessionId === null
              ? invoke("fs_copy", {
                  sources: p.paths,
                  destDir: dir,
                  workspace: currentWorkspaceEnv(),
                })
              : (async () => {
                  let uploaded = 0;
                  try {
                    for (const target of remoteUploadTargets(p.paths, dir)) {
                      await invoke("sftp_upload_file", {
                        sessionId: remoteSessionId,
                        localPath: target.localPath,
                        remotePath: target.remotePath,
                      });
                      uploaded += 1;
                    }
                  } finally {
                    if (uploaded > 0) onCopied(dir);
                  }
                })();
          void copy
            .then(() => {
              if (remoteSessionId !== null) {
                toast.success(`Uploaded ${p.paths.length} file${p.paths.length === 1 ? "" : "s"}`);
              } else {
                onCopied(dir);
              }
            })
            .catch((err) => toast.error(`传输失败：${String(err)}`));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[tdsf] explorer drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTargetDir(null);
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- terax 上游既有依赖设计, 变更 deps 有回归风险
  }, []);

  return { externalTargetDir: targetDir };
}
