import { isTauriRuntime } from "@/lib/tauriRuntime";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import type { Tab } from "@/modules/tabs";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
};

/**
 * Keeps open editor tabs in sync with on-disk changes: reloads on applied AI
 * diffs, external writes, and fs-watch events, and maintains the watch set for
 * the directories of open editor files.
 */
export function useEditorFileSync({ tabs, tabsRef, editorRefs }: Params) {
  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs, editorRefs]);

  useEffect(() => {
    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 fs:file-written 监听
    if (!isTauriRuntime()) return;
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source === "editor") return;
          const normalizedPath = event.payload.path.replace(/\\/g, "/");
          const currentTabs = tabsRef.current;
          for (const t of currentTabs) {
            if (t.kind !== "editor") continue;
            // TDSF 魔改 2026-07-30: 远程 tab 不响应本地 fs:file-written
            // （sftpWrite 不触发此事件；且避免本地同名 path 撞车误 reload）。
            if (t.remote) continue;
            if (t.path.replace(/\\/g, "/") === normalizedPath) {
              editorRefs.current.get(t.id)?.reload();
            }
          }
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [tabsRef, editorRefs]);

  const editorWatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) {
      if (t.kind !== "editor") continue;
      // TDSF 魔改 2026-07-30: 远程 tab 不加本地 fs watch（远程路径无意义）。
      if (t.remote) continue;
      want.add(parentDir(t.path));
    }
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
      for (const t of tabsRef.current) {
        if (t.kind !== "editor") continue;
        // TDSF 魔改 2026-07-30: 远程 tab 不响应本地 fs:changed
        // （远程文件变更不触发本地 watch；避免同名 path 撞车误 reload）。
        if (t.remote) continue;
        if (changed.has(t.path.replace(/\\/g, "/"))) {
          editorRefs.current.get(t.id)?.reload();
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [tabsRef, editorRefs]);
}
