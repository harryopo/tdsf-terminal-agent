import { decodeUtf8, encodeUtf8, sftpRead, sftpStat, sftpWrite } from "@/lib/sftp-bridge";
import { notifyDocumentSaved } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore } from "@/modules/ssh-explorer";
import { ipcWorkspaceEnv, type LocalWorkspaceEnv } from "@/modules/workspace";
import { fileSourceKey } from "@/modules/workspace/fileSource";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";
import { trackFileSave } from "./pendingFileSaves";

type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type FileStat = { size: number; mtime: number; kind: string };
type SaveSnapshot = { generation: number; path: string; sourceKey: string | null; content: string; eol: Eol };
type SaveConflict = { id: string };
export type DocumentRelocation = { ready: Promise<void>; cancel: () => void };

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
   * TDSF 2026-07-30: 远程文件标记，非空时 fs 调用分流到 sftp-bridge。
   * undefined / null 走本地 fs_read_file/fs_write_file/fs_stat。
   */
  remote?: { sessionId: string } | null;
  workspace?: LocalWorkspaceEnv | null;
  relocation?: { from: string; to: string };
  onDirtyChange?: (dirty: boolean) => void;
};

export function useDocument({ path, remote, workspace, relocation, onDirtyChange }: Options) {
  const [mountWorkspace] = useState(() => ({ ...ipcWorkspaceEnv() }));
  const documentWorkspace = workspace === undefined ? mountWorkspace : workspace;
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const sourceKey = fileSourceKey(remote ? { kind: "ssh", sessionId: remote.sessionId } : documentWorkspace);
  const identityRef = useRef({ path, sourceKey });
  const liveIdentityRef = useRef({ path, sourceKey });
  liveIdentityRef.current = { path, sourceKey };
  const saveGenerationRef = useRef(0);
  const documentReadyRef = useRef(false);
  const saveTailRef = useRef<Promise<boolean> | null>(null);
  const relocationRef = useRef<{ from: string; to: string; sourceKey: string | null } | null>(null);
  const conflictRef = useRef<SaveConflict | null>(null);
  const conflictId = useId();
  const clearSaveConflict = useCallback(() => {
    if (conflictRef.current) toast.dismiss(conflictRef.current.id);
    conflictRef.current = null;
  }, []);
  const ownsSave = useCallback((snapshot: SaveSnapshot) => (
    documentReadyRef.current && snapshot.generation === saveGenerationRef.current &&
    snapshot.path === liveIdentityRef.current.path &&
    snapshot.sourceKey === liveIdentityRef.current.sourceKey
  ), []);

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

  // TDSF 2026-07-30: 实时取 rustSessionId（应对连接断开/重连后的状态迁移）。
  // 绝不缓存到 ref——SSH 重连后 rustSessionId 会变，缓存会导致保存写到旧 session。
  const getRustSessionId = useCallback((): number | null => {
    if (!remote) return null;
    const s = useSshStore.getState().sessions.find(
      (it) => it.id === remote.sessionId,
    );
    return s?.rustSessionId ?? null;
  }, [remote]);

  const writeToDisk = useCallback(async (snapshot: SaveSnapshot, sid: number | null): Promise<boolean> => {
    if (!ownsSave(snapshot)) return false;
    const { content, eol } = snapshot;
    // TDSF 2026-07-30: 远程文件分流到 sftpWrite。
    // sftpWrite 不返回 mtime，需额外 sftpStat 补，作为下次冲突检测的 baseline。
    if (remote) {
      if (sid === null) throw new Error("SSH session not connected");
      await sftpWrite(
        sid,
        path,
        encodeUtf8(restoreEol(content, eol)),
      );
      if (!ownsSave(snapshot)) return false;
      const attrs = await sftpStat(sid, path);
      if (!ownsSave(snapshot)) return false;
      // SftpAttrs.modified 秒级 → 毫秒（与 FileStat.mtime 对齐）。
      diskMtimeRef.current = attrs.modified * 1000;
      savedRef.current = content;
      dirtyRef.current = bufferRef.current !== content;
      setDirty(dirtyRef.current);
      notifyDocumentSaved(path);
      return true;
    }
    if (!documentWorkspace) throw new Error("无法确认文件所属环境，未执行保存；请保留草稿并重新打开文件。");
    const mtime = await invoke<number>("fs_write_file", {
      path,
      content: restoreEol(content, eol),
      workspace: documentWorkspace,
      source: "editor",
    });
    if (!ownsSave(snapshot)) return false;
    diskMtimeRef.current = mtime;
    savedRef.current = content;
    // Edits typed while the write was in flight must stay dirty.
    dirtyRef.current = bufferRef.current !== content;
    setDirty(dirtyRef.current);
    notifyDocumentSaved(path);
    return true;
  }, [path, remote, documentWorkspace, ownsSave]);

  // False when the write was withheld because the file changed on disk
  // since load; overwriting is an explicit user action from the toast.
  const saveNow = useCallback((overwrite?: SaveConflict): Promise<boolean> => {
    if (!remote && !documentWorkspace) {
      return Promise.reject(new Error("无法确认文件所属环境，未执行保存；请保留草稿并重新打开文件。"));
    }
    if (!documentReadyRef.current || relocationRef.current) return Promise.resolve(false);
    const snapshot: SaveSnapshot = {
      generation: saveGenerationRef.current, path, sourceKey,
      content: bufferRef.current, eol: eolRef.current,
    };
    const run = async (): Promise<boolean> => {
      if (!ownsSave(snapshot) || (overwrite && conflictRef.current !== overwrite)) return false;
      if (snapshot.content === savedRef.current) {
        clearSaveConflict();
        return true;
      }
      const sid = remote ? getRustSessionId() : null;
      const known = diskMtimeRef.current;
      if (!overwrite && known !== null) {
        // SFTP mtime is seconds; the editor baseline uses milliseconds.
        let mtime: number | null = null;
        if (remote) {
          if (sid === null) throw new Error("SSH session not connected");
          const attrs = await sftpStat(sid, path).catch(() => null);
          mtime = attrs ? attrs.modified * 1000 : null;
        } else {
          if (!documentWorkspace) throw new Error("无法确认文件所属环境，未执行保存；请保留草稿并重新打开文件。");
          const stat = await invoke<FileStat>("fs_stat", {
            path,
            workspace: documentWorkspace,
          }).catch(() => null);
          mtime = stat?.mtime ?? null;
        }
        if (!ownsSave(snapshot)) return false;
        if (mtime !== null && mtime !== known) {
          const name = path.split(/[\\/]/).pop() ?? path;
          clearSaveConflict();
          const conflict = { id: `save-conflict:${conflictId}` };
          conflictRef.current = conflict;
          toast.warning("文件已被外部修改", {
            id: conflict.id,
            description: `“${name}”在存在未保存更改时被其他程序修改。仅在确认保留当前版本时选择覆盖保存。`,
            action: {
              label: "覆盖保存",
              onClick: () => {
                if (!ownsSave(snapshot) || conflictRef.current !== conflict) return;
                void saveNow(conflict).catch((e) => {
                  if (ownsSave(snapshot)) toast.error("覆盖保存失败", { description: String(e) });
                });
              },
            },
          });
          return false;
        }
      }
      clearSaveConflict();
      return writeToDisk(snapshot, sid);
    };
    // Snapshot at enqueue, but compare against the baseline of the last ACK.
    const previous = saveTailRef.current;
    const pending = previous ? previous.catch(() => false).then(run) : run();
    saveTailRef.current = pending;
    trackFileSave(sourceKey, path, pending);
    const release = () => {
      if (saveTailRef.current === pending) saveTailRef.current = null;
    };
    void pending.then(release, release);
    return pending;
  }, [path, sourceKey, remote, writeToDisk, getRustSessionId, documentWorkspace, ownsSave, clearSaveConflict, conflictId]);

  const beginRelocation = useCallback((to: string): DocumentRelocation => {
    if (relocationRef.current) throw new Error("文件正在迁移，请等待本次重命名或移动完成。");
    const ticket = { from: path, to, sourceKey };
    relocationRef.current = ticket;
    clearAutoSaveTimer();
    clearSaveConflict();
    return {
      ready: (saveTailRef.current ?? Promise.resolve()).then(() => {}),
      cancel: () => {
        if (relocationRef.current !== ticket) return;
        relocationRef.current = null;
        const prefs = autoSaveRef.current;
        if (dirtyRef.current && prefs.autoSave && documentReadyRef.current) {
          timeoutRef.current = setTimeout(() => {
            saveNow().catch((e) => console.error("[autosave]", e));
          }, prefs.autoSaveDelay);
        }
      },
    };
  }, [path, sourceKey, clearAutoSaveTimer, clearSaveConflict, saveNow]);
  const isRelocating = useCallback(() => relocationRef.current !== null, []);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const forceRef = useRef(false);
  // All read entry points share ownership, including refreshes after rename.
  const readRequestRef = useRef(0);

  // Adopts a read result as the new saved baseline. `skipIfUnchanged` avoids
  // the re-render when disk already matches the buffer (self-save / duplicate
  // watcher event); initial loads must always publish a state.
  const adoptRead = useCallback((res: ReadResult, skipIfUnchanged = false) => {
    documentReadyRef.current = res.kind === "text";
    clearSaveConflict();
    ++saveGenerationRef.current;
    if (res.kind === "text") {
      eolRef.current = detectEol(res.content);
      diskMtimeRef.current = res.mtime;
      const content = normalizeToLf(res.content);
      if (skipIfUnchanged && content === savedRef.current) return;
      savedRef.current = content;
      bufferRef.current = content;
      dirtyRef.current = false;
      setDirty(false);
      setDoc({ status: "ready", content, size: res.size });
    } else if (res.kind === "binary") {
      setDoc({ status: "binary", size: res.size });
    } else if (res.kind === "toolarge") {
      setDoc({ status: "toolarge", size: res.size, limit: res.limit });
    }
  }, [clearSaveConflict]);

  const readFromDisk = useCallback(
    (force: boolean): Promise<ReadResult> => {
      // TDSF 2026-07-30: 远程用 sftpRead，需前端做 binary 检测 + sftpStat 补 mtime。
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
      if (!documentWorkspace) return Promise.reject(new Error("无法确认文件所属环境，请从原工作区重新打开文件。"));
      return invoke<ReadResult>("fs_read_file", {
        path,
        workspace: documentWorkspace,
        force,
      });
    },
    [path, remote, getRustSessionId, documentWorkspace],
  );

  // Load on path change.
  useEffect(() => {
    const readRequests = readRequestRef;
    const saveGeneration = saveGenerationRef;
    ++saveGeneration.current;
    clearSaveConflict();
    const request = ++readRequests.current;
    const previous = identityRef.current;
    identityRef.current = { path, sourceKey };
    const moving = relocationRef.current;
    if (moving && (sourceKey !== moving.sourceKey || path !== moving.from)) {
      relocationRef.current = null;
    }
    clearAutoSaveTimer();
    if (relocation?.from === previous.path && relocation.to === path &&
      sourceKey !== null && previous.sourceKey === sourceKey && docRef.current.status === "ready") {
      documentReadyRef.current = true;
      setDoc({ ...docRef.current, content: bufferRef.current, size: encodeUtf8(bufferRef.current).length });
      const prefs = autoSaveRef.current;
      if (dirtyRef.current && prefs.autoSave) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, prefs.autoSaveDelay);
      }
      return () => { ++readRequests.current; ++saveGeneration.current; documentReadyRef.current = false; clearSaveConflict(); };
    }
    // "Open anyway" is a per-file decision; a new path starts unforced.
    forceRef.current = false;
    documentReadyRef.current = false;
    setDoc({ status: "loading" });
    dirtyRef.current = false;
    setDirty(false);

    readFromDisk(forceRef.current)
      .then((res) => {
        if (request === readRequests.current) adoptRead(res);
      })
      .catch((e) => {
        if (request === readRequests.current) {
          setDoc({ status: "error", message: String(e) });
        }
      });

    return () => {
      ++readRequests.current;
      ++saveGeneration.current;
      documentReadyRef.current = false;
      clearSaveConflict();
    };
  }, [readFromDisk, adoptRead, path, sourceKey, relocation, clearAutoSaveTimer, saveNow, clearSaveConflict]);

  const openAnyway = useCallback(() => {
    if (relocationRef.current) return;
    documentReadyRef.current = false;
    clearSaveConflict();
    const request = ++readRequestRef.current;
    forceRef.current = true;
    setDoc({ status: "loading" });
    readFromDisk(true)
      .then((res) => {
        if (request === readRequestRef.current) adoptRead(res);
      })
      .catch((e) => {
        if (request === readRequestRef.current) {
          setDoc({ status: "error", message: String(e) });
        }
      });
  }, [readFromDisk, adoptRead, clearSaveConflict]);

  // Skipped while dirty: never clobber unsaved edits. Re-checked when the
  // read resolves, since typing can start while it is in flight.
  const reload = useCallback((): boolean => {
    if (dirtyRef.current || relocationRef.current) return false;
    const request = ++readRequestRef.current;
    void readFromDisk(forceRef.current)
      .then((res) => {
        if (request === readRequestRef.current && !dirtyRef.current) {
          adoptRead(res, true);
        }
      })
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      .catch((e) => console.warn("[editor] reload failed", path, e));
    return true;
  }, [readFromDisk, adoptRead, path]);

  const save = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer();
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
      dirtyRef.current = bufferRef.current !== content;
      setDirty(dirtyRef.current);
      return content;
    },
    [],
  );

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      dirtyRef.current = isDirty;
      setDirty(isDirty);

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty && !relocationRef.current) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, delay);
      }
    },
    [clearAutoSaveTimer, saveNow],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger that runs the auto-save timer cleanup when the active document changes.
  useEffect(() => clearAutoSaveTimer, [path, documentWorkspace, clearAutoSaveTimer]);

  return { doc, dirty, onChange, save, reload, adoptDiskText, openAnyway, beginRelocation, isRelocating, workspace: documentWorkspace };
}
