/**
 * workspaceFsStore.ts — WorkspaceFs 前端单一数据源（P2-3a）
 *
 * 消除 FileExplorer 双轨（useFileTree/useRemoteFileTree prop 切换）的根因：
 * 本 store 持有"当前 Space 的文件系统视图"（后端/根路径/树/加载态），
 * Space 切换时 activate() 原子替换全部状态——无 local/ssh 中间态，
 * 杜绝"远程树闪一下 → 回跳本地 → 空白"的时序竞态。
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type FsKind = "local" | "sftp";

export type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
};

export type FsCapabilities = {
  rename: boolean;
  delete: boolean;
  mkdir: boolean;
  write: boolean;
  trash: boolean;
  symlink: boolean;
};

export type FsErrorCode =
  | "NotFound"
  | "PermissionDenied"
  | "NotEmpty"
  | "NotConnected"
  | "InvalidPath"
  | "Io"
  | "Other";

export type FsBackendError = {
  code: FsErrorCode;
  message: string;
};

/** 当前激活的 Space 文件系统视图（原子整体） */
type WorkspaceFsState = {
  spaceId: string | null;
  kind: FsKind | null;
  /** Rust SSH 会话 id (sftp 时有效) */
  sessionId: number | null;
  rootPath: string | null;
  capabilities: FsCapabilities | null;
  entriesByPath: Record<string, FsEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  /** 会话断开等致命错误 → UI 显示降级提示 */
  fatalError: string | null;

  /** Space 切换: 整体原子替换（清空旧树, 不留中间态） */
  activate: (params: {
    spaceId: string;
    kind: FsKind;
    sessionId: number | null;
    rootPath: string;
  }) => void;

  /** 导航到路径（目录） */
  navigate: (path: string) => Promise<void>;

  /** 展开/折叠目录（懒加载子项） */
  toggleExpand: (path: string) => Promise<void>;

  /** 刷新指定目录 */
  refresh: (path: string) => Promise<void>;

  mkdir: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;

  clear: () => void;
};

function params(
  kind: FsKind | null,
  sessionId: number | null,
  root: string | null,
) {
  return {
    sessionId: kind === "sftp" ? sessionId : null,
    root: kind === "sftp" ? root : null,
  };
}

function isError(e: unknown): e is FsBackendError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e
  );
}

export const useWorkspaceFsStore = create<WorkspaceFsState>((set, get) => ({
  spaceId: null,
  kind: null,
  sessionId: null,
  rootPath: null,
  capabilities: null,
  entriesByPath: {},
  expanded: new Set(),
  loading: new Set(),
  fatalError: null,

  activate: ({ spaceId, kind, sessionId, rootPath }) => {
    set({
      spaceId,
      kind,
      sessionId,
      rootPath,
      entriesByPath: {},
      expanded: new Set(),
      loading: new Set(),
      fatalError: null,
    });
    // 能力集随后端加载
    void invoke<FsCapabilities>("fsb_capabilities", {
      sessionId: kind === "sftp" ? sessionId : null,
    })
      .then((caps) => set({ capabilities: caps }))
      .catch(() => set({ capabilities: null }));
    // 根目录加载
    void get().navigate(rootPath);
  },

  navigate: async (path) => {
    const { kind, sessionId, rootPath } = get();
    set((s) => ({
      loading: new Set(s.loading).add(path),
      fatalError: null,
    }));
    try {
      const entries = await invoke<FsEntry[]>("fsb_list", {
        ...params(kind, sessionId, rootPath),
        path,
      });
      set((s) => ({
        entriesByPath: { ...s.entriesByPath, [path]: entries },
      }));
    } catch (e) {
      if (isError(e) && e.code === "NotConnected") {
        set({ fatalError: "SSH 连接已断开，请重新连接" });
      }
    } finally {
      set((s) => {
        const next = new Set(s.loading);
        next.delete(path);
        return { loading: next };
      });
    }
  },

  toggleExpand: async (path) => {
    const { expanded } = get();
    if (expanded.has(path)) {
      const next = new Set(expanded);
      next.delete(path);
      set({ expanded: next });
      return;
    }
    const next = new Set(expanded);
    next.add(path);
    set({ expanded: next });
    await get().navigate(path);
  },

  refresh: (path) => get().navigate(path),

  mkdir: async (path) => {
    const { kind, sessionId, rootPath } = get();
    await invoke("fsb_mkdir", { ...params(kind, sessionId, rootPath), path });
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await get().navigate(parent);
  },

  rename: async (from, to) => {
    const { kind, sessionId, rootPath } = get();
    await invoke("fsb_rename", {
      ...params(kind, sessionId, rootPath),
      from,
      to,
    });
    const parent = from.slice(0, from.lastIndexOf("/")) || "/";
    await get().navigate(parent);
  },

  remove: async (path) => {
    const { kind, sessionId, rootPath } = get();
    await invoke("fsb_delete", { ...params(kind, sessionId, rootPath), path });
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    await get().navigate(parent);
  },

  clear: () =>
    set({
      spaceId: null,
      kind: null,
      sessionId: null,
      rootPath: null,
      capabilities: null,
      entriesByPath: {},
      expanded: new Set(),
      loading: new Set(),
      fatalError: null,
    }),
}));
