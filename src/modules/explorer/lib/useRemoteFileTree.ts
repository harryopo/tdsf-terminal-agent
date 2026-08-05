// TDSF 魔改 (P4-T4.1): 远程文件树 Hook
// -----------------------------------------------------------------------------
// 让 FileExplorer 组件能无缝切换到 SSH 远程文件系统。
// 对外暴露的 API 与 useFileTree 完全一致, 但底层操作的是 sshStore 中的
// 远程文件树状态 (childrenByPathBySession / expandedPathsBySession)。
//
// 设计要点:
//   - rootPath 传 SSH 会话当前 cwd (如 "/home/user")
//   - DirEntry 从 SftpEntry 转换而来 (兼容 FileExplorer 的 Row 构建)
//   - 展开/折叠、创建、重命名、删除都通过 sshStore actions 完成
//   - 不监听本地 fs watcher, 依赖手动刷新或操作后自动刷新

import { joinRemotePath, type SftpEntry } from "@/lib/sftp-bridge";
import {
  type SshSessionInfo,
  useSshStore,
} from "@/modules/ssh-explorer/sshStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEntry, PendingCreate, TreeState } from "./useFileTree";

export type { PendingCreate } from "./useFileTree";

// 稳定空值，避免 Zustand selector 在 sessionId 为 null 时返回新对象引用，
// 触发 useSyncExternalStore 的无限重渲染。
const EMPTY_CHILDREN_MAP: Record<string, SftpEntry[]> = {};
const EMPTY_LOADING_MAP: Record<string, boolean> = {};
const EMPTY_EXPANDED_SET = new Set<string>();

function sftpEntryToDirEntry(e: SftpEntry): DirEntry {
  let kind: DirEntry["kind"] = "file";
  if (e.isDir) kind = "dir";
  else if (e.isSymlink) kind = "symlink";
  return {
    name: e.name,
    kind,
    size: e.size,
    mtime: e.modified,
    gitignored: false,
  };
}

function buildTreeState(
  childrenMap: Record<string, SftpEntry[]>,
  loadingMap: Record<string, boolean>,
): TreeState {
  const state: TreeState = {};
  for (const [path, entries] of Object.entries(childrenMap)) {
    state[path] = {
      status: "loaded",
      entries: entries.map(sftpEntryToDirEntry),
    };
  }
  for (const [path, loading] of Object.entries(loadingMap)) {
    if (loading && !state[path]) {
      state[path] = { status: "loading" };
    }
  }
  return state;
}

type Options = {
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
};

export function useRemoteFileTree(
  session: SshSessionInfo | null,
  rootPath: string | null,
  options?: Options,
) {
  const sessionId = session?.id ?? null;
  const rustSessionId = session?.rustSessionId ?? null;

  const childrenMap = useSshStore(
    (s) =>
      (sessionId ? s.childrenByPathBySession[sessionId] : EMPTY_CHILDREN_MAP) ??
      EMPTY_CHILDREN_MAP,
  );
  const loadingMap = useSshStore(
    (s) =>
      (sessionId
        ? s.loadingChildrenByPathBySession[sessionId]
        : EMPTY_LOADING_MAP) ?? EMPTY_LOADING_MAP,
  );
  const expandedSet = useSshStore(
    (s) =>
      (sessionId ? s.expandedPathsBySession[sessionId] : EMPTY_EXPANDED_SET) ??
      EMPTY_EXPANDED_SET,
  );
  const loadChildrenAction = useSshStore((s) => s.loadChildren);
  const toggleExpandAction = useSshStore((s) => s.toggleExpand);
  const createFileAction = useSshStore((s) => s.createFile);
  const createDirAction = useSshStore((s) => s.createDir);
  const renamePathAction = useSshStore((s) => s.renamePath);
  const deletePathAction = useSshStore((s) => s.deletePath);
  const navigateToAction = useSshStore((s) => s.navigateTo);

  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(
    null,
  );
  const [renaming, setRenaming] = useState<string | null>(null);

  const expandedRef = useRef(expandedSet);
  const nodesRef = useRef<TreeState>({});

  // 同步 ref, 让回调读取最新值
  useEffect(() => {
    expandedRef.current = expandedSet;
  }, [expandedSet]);

  // 根据 rootPath 变化初始化导航
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigateToAction is intentionally omitted to avoid re-navigating on every render; sessionId/rootPath/rustSessionId are the triggers.
  useEffect(() => {
    if (!sessionId || !rootPath || !rustSessionId) return;
    // 确保当前 cwd 已加载
    void navigateToAction(sessionId, rootPath);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- terax 上游既有依赖设计, 变更 deps 有回归风险
  }, [sessionId, rootPath, rustSessionId]);

  const nodes = useMemo(
    () => buildTreeState(childrenMap, loadingMap),
    [childrenMap, loadingMap],
  );

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const expanded = useMemo(() => new Set(expandedSet), [expandedSet]);

  const toggle = useCallback(
    (path: string) => {
      if (!sessionId) return;
      toggleExpandAction(sessionId, path);
    },
    [sessionId, toggleExpandAction],
  );

  const expand = useCallback(
    (path: string) => {
      if (!sessionId) return;
      if (!expandedRef.current.has(path)) {
        toggleExpandAction(sessionId, path);
      }
    },
    [sessionId, toggleExpandAction],
  );

  const refresh = useCallback(
    (path: string) => {
      if (!sessionId) return;
      void loadChildrenAction(sessionId, path);
    },
    [sessionId, loadChildrenAction],
  );

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
      if (sessionId && parentPath !== rootPath) {
        if (!expandedRef.current.has(parentPath)) {
          toggleExpandAction(sessionId, parentPath);
        }
      }
    },
    [sessionId, rootPath, toggleExpandAction],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate || !sessionId) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      try {
        if (pendingCreate.kind === "dir") {
          await createDirAction(sessionId, pendingCreate.parentPath, trimmed);
        } else {
          await createFileAction(sessionId, pendingCreate.parentPath, trimmed);
        }
      } catch (e) {
        console.error("[useRemoteFileTree] commitCreate failed:", e);
      } finally {
        setPendingCreate(null);
      }
    },
    [pendingCreate, sessionId, createDirAction, createFileAction],
  );

  const beginRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming || !sessionId) return;
      const trimmed = newName.trim();
      const parent = renaming.slice(0, renaming.lastIndexOf("/") || 1);
      const oldName = renaming.slice(parent === "/" ? 1 : parent.length + 1);
      if (!trimmed || trimmed === oldName) {
        setRenaming(null);
        return;
      }
      const to = joinRemotePath(parent, trimmed);
      try {
        await renamePathAction(sessionId, renaming, to);
        options?.onPathRenamed?.(renaming, to);
      } catch (e) {
        console.error("[useRemoteFileTree] commitRename failed:", e);
      } finally {
        setRenaming(null);
      }
    },
    [renaming, sessionId, renamePathAction, options],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      try {
        await deletePathAction(sessionId, path);
        options?.onPathDeleted?.(path);
      } catch (e) {
        console.error("[useRemoteFileTree] deletePath failed:", e);
      }
    },
    [sessionId, deletePathAction, options],
  );

  const movePath = useCallback(
    async (from: string, toDir: string) => {
      if (!sessionId) return;
      const name = from.slice(from.lastIndexOf("/") + 1);
      const to = joinRemotePath(toDir, name);
      if (to === from) return;
      try {
        await renamePathAction(sessionId, from, to);
        options?.onPathRenamed?.(from, to);
      } catch (e) {
        console.error("[useRemoteFileTree] movePath failed:", e);
      }
    },
    [sessionId, renamePathAction, options],
  );

  return {
    nodes,
    expanded,
    pendingCreate,
    renaming,
    toggle,
    expand,
    refresh,
    beginCreate,
    cancelCreate,
    commitCreate,
    beginRename,
    cancelRename,
    commitRename,
    deletePath,
    movePath,
    joinPath: joinRemotePath,
  };
}
