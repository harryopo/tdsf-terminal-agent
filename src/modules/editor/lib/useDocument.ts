import { decodeUtf8, encodeUtf8, sftpRead, sftpStat, sftpWrite } from "@/lib/sftp-bridge";
import { notifyDocumentSaved } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore } from "@/modules/ssh-explorer";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";

type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type FileStat = { size: number; mtime: number; kind: string };

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type Options = {
  path: string;
  /**
   * TDSF 魔改 2026-07-30: 远程文件标记，非空时 fs 调用分流到 sftp-bridge。
   * undefined / null 走本地 fs_read_file/fs_write_file/fs_stat。
   */
  remote?: { sessionId: string } | null;
  onDirtyChange?: (dirty: boolean) => void;
};

export function useDocument({ path, remote, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const eolRef = useRef<Eol>("\n");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoSaveTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const diskMtimeRef = useRef<number | null>(null);

  // TDSF 魔改 2026-07-30: 实时取 rustSessionId（应对连接断开/重连后的状态迁移）。
  // 绝不缓存到 ref——SSH 重连后 rustSessionId 会变，缓存会导致保存写到旧 session。
  const getRustSessionId = useCallback((): number | null => {
    if (!remote) return null;
    const s = useSshStore.getState().sessions.find(
      (it) => it.id === remote.sessionId,
    );
    return s?.rustSessionId ?? null;
  }, [remote]);

  const writeToDisk = useCallback(async () => {
    const content = bufferRef.current;
    // TDSF 魔改 2026-07-30: 远程文件分流到 sftpWrite。
    // sftpWrite 不返回 mtime，需额外 sftpStat 补，作为下次冲突检测的 baseline。
    if (remote) {
      const sid = getRustSessionId();
      if (sid === null) throw new Error("SSH session not connected");
      await sftpWrite(
        sid,
        path,
        encodeUtf8(restoreEol(content, eolRef.current)),
      );
      const attrs = await sftpStat(sid, path);
      // SftpAttrs.modified 秒级 → 毫秒（与 FileStat.mtime 对齐）。
      diskMtimeRef.current = attrs.modified * 1000;
      savedRef.current = content;
      setDirty(bufferRef.current !== content);
      notifyDocumentSaved(path);
      return;
    }
    const mtime = await invoke<number>("fs_write_file", {
      path,
      content: restoreEol(content, eolRef.current),
      workspace: currentWorkspaceEnv(),
      source: "editor",
    });
    diskMtimeRef.current = mtime;
    savedRef.current = content;
    // Edits typed while the write was in flight must stay dirty.
    setDirty(bufferRef.current !== content);
    notifyDocumentSaved(path);
  }, [path, remote, getRustSessionId]);

  // False when the write was withheld because the file changed on disk
  // since load; overwriting is an explicit user action from the toast.
  const saveNow = useCallback(async (): Promise<boolean> => {
    const known = diskMtimeRef.current;
    if (known !== null) {
      // TDSF 魔改 2026-07-30: 远程用 sftpStat，mtime 秒级 *1000 转毫秒。
      let mtime: number | null = null;
      if (remote) {
        const sid = getRustSessionId();
        if (sid === null) throw new Error("SSH session not connected");
        const attrs = await sftpStat(sid, path).catch(() => null);
        mtime = attrs ? attrs.modified * 1000 : null;
      } else {
        const stat = await invoke<FileStat>("fs_stat", {
          path,
          workspace: currentWorkspaceEnv(),
        }).catch(() => null);
        mtime = stat?.mtime ?? null;
      }
      if (mtime !== null && mtime !== known) {
        const name = path.split(/[\\/]/).pop() ?? path;
        toast.warning("File changed on disk", {
          id: `save-conflict:${path}`,
          description: `${name} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
          action: { label: "Overwrite", onClick: () => void writeToDisk() },
        });
        return false;
      }
    }
    await writeToDisk();
    return true;
  }, [path, remote, writeToDisk, getRustSessionId]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const forceRef = useRef(false);

  // Adopts a read result as the new saved baseline. `skipIfUnchanged` avoids
  // the re-render when disk already matches the buffer (self-save / duplicate
  // watcher event); initial loads must always publish a state.
  const adoptRead = useCallback((res: ReadResult, skipIfUnchanged = false) => {
    if (res.kind === "text") {
      eolRef.current = detectEol(res.content);
      diskMtimeRef.current = res.mtime;
      const content = normalizeToLf(res.content);
      if (skipIfUnchanged && content === savedRef.current) return;
      savedRef.current = content;
      bufferRef.current = content;
      setDirty(false);
      setDoc({ status: "ready", content, size: res.size });
    } else if (res.kind === "binary") {
      setDoc({ status: "binary", size: res.size });
    } else if (res.kind === "toolarge") {
      setDoc({ status: "toolarge", size: res.size, limit: res.limit });
    }
  }, []);

  const readFromDisk = useCallback(
    (force: boolean): Promise<ReadResult> => {
      // TDSF 魔改 2026-07-30: 远程用 sftpRead，需前端做 binary 检测 + sftpStat 补 mtime。
      // force 参数远程分支忽略（sftpRead 全量读取，无 force 概念，openAnyway 行为一致）。
      if (remote) {
        const sid = getRustSessionId();
        if (sid === null) {
          return Promise.reject(new Error("SSH session not connected"));
        }
        return sftpRead(sid, path).then((bytes): Promise<ReadResult> => {
          const size = bytes.length;
          // binary 检测：前 8KB 内含 NUL 字节则判定为二进制（与 Rust 侧 fs_read_file 一致）。
          let isBinary = false;
          const probeLen = Math.min(size, 8192);
          for (let i = 0; i < probeLen; i++) {
            if (bytes[i] === 0) {
              isBinary = true;
              break;
            }
          }
          if (isBinary) return Promise.resolve({ kind: "binary", size });
          const limit = FORCE_READ_LIMIT;
          if (size > limit) {
            return Promise.resolve({ kind: "toolarge", size, limit });
          }
          const content = decodeUtf8(bytes);
          // sftpRead 不返回 mtime，用 sftpStat 补（冲突检测需要）。
          return sftpStat(sid, path).then(
            (attrs): ReadResult => ({
              kind: "text",
              content,
              size,
              mtime: attrs.modified * 1000,
            }),
          );
        });
      }
      return invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
        force,
      });
    },
    [path, remote, getRustSessionId],
  );

  // Load on path change.
  useEffect(() => {
    let cancelled = false;
    // "Open anyway" is a per-file decision; a new path starts unforced.
    forceRef.current = false;
    setDoc({ status: "loading" });
    setDirty(false);

    readFromDisk(forceRef.current)
      .then((res) => {
        if (!cancelled) adoptRead(res);
      })
      .catch((e) => {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [readFromDisk, adoptRead]);

  const openAnyway = useCallback(() => {
    forceRef.current = true;
    setDoc({ status: "loading" });
    readFromDisk(true)
      .then(adoptRead)
      .catch((e) => setDoc({ status: "error", message: String(e) }));
  }, [readFromDisk, adoptRead]);

  // Skipped while dirty: never clobber unsaved edits. Re-checked when the
  // read resolves, since typing can start while it is in flight.
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    void readFromDisk(forceRef.current)
      .then((res) => {
        if (!dirtyRef.current) adoptRead(res, true);
      })
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      .catch((e) => console.warn("[editor] reload failed", path, e));
    return true;
  }, [readFromDisk, adoptRead, path]);

  const save = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer();
    if (bufferRef.current === savedRef.current) return true;
    return saveNow();
  }, [clearAutoSaveTimer, saveNow]);

  // Adopt externally formatted disk content as the saved baseline before the
  // matching editor dispatch lands, so the buffer never flashes dirty. The
  // formatter's own write must also become the known mtime, or the next save
  // would report it as an external conflict.
  // Returns the LF-normalized text the caller should dispatch.
  const adoptDiskText = useCallback(
    (diskText: string, mtime: number): string => {
      eolRef.current = detectEol(diskText);
      diskMtimeRef.current = mtime;
      const content = normalizeToLf(diskText);
      savedRef.current = content;
      setDirty(bufferRef.current !== content);
      return content;
    },
    [],
  );

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      setDirty(isDirty);

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, delay);
      }
    },
    [clearAutoSaveTimer, saveNow],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger that runs the auto-save timer cleanup when the active document changes.
  useEffect(() => clearAutoSaveTimer, [path, clearAutoSaveTimer]);

  return { doc, dirty, onChange, save, reload, adoptDiskText, openAnyway };
}
