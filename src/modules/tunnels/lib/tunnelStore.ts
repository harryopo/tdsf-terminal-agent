/**
 * tunnels/lib/tunnelStore.ts — SSH 隧道 store（Zustand）
 *
 * 隧道是运行时资源（应用重启后不存在，随 SSH 会话断开自动清理），
 * 因此不持久化（与 snippets 的 LazyStore 不同）。
 *
 * dev 模式（纯浏览器，无 Tauri 运行时）下降级：列表恒为空 + 操作报错，
 * 保证面板可预览（空状态 + 提示）。
 */
import { isTauriRuntime } from "@/lib/tauriRuntime";
import {
  tunnelList,
  tunnelStart,
  tunnelStop,
  type TunnelInfo,
  type TunnelSpec,
} from "@/lib/tunnel-bridge";
import { create } from "zustand";

/** 操作结果（避免 store 内抛错，由 UI 层 toast 展示） */
export interface TunnelOpResult {
  ok: boolean;
  error?: string;
}

type TunnelsState = {
  /** 隧道列表（按 id 升序，来自 Rust tunnel_list） */
  tunnels: TunnelInfo[];
  /** 是否已加载过列表（mount 时 refresh 置 true） */
  loaded: boolean;
  /** 是否有创建/停止操作进行中（禁用按钮防重复提交） */
  busy: boolean;
  /** 从 Rust 拉取隧道列表（dev 模式降级为空） */
  refresh: () => Promise<void>;
  /** 创建隧道（成功后自动刷新列表） */
  startTunnel: (spec: TunnelSpec) => Promise<TunnelOpResult>;
  /** 停止隧道（成功后自动刷新列表） */
  stopTunnel: (tunnelId: number) => Promise<TunnelOpResult>;
};

export const useTunnelsStore = create<TunnelsState>((set, get) => ({
  tunnels: [],
  loaded: false,
  busy: false,

  refresh: async () => {
    if (!isTauriRuntime()) {
      set({ tunnels: [], loaded: true });
      return;
    }
    try {
      const list = await tunnelList();
      set({ tunnels: list, loaded: true });
    } catch (e) {
      console.warn("[tunnels] refresh failed:", e);
      set({ loaded: true });
    }
  },

  startTunnel: async (spec) => {
    if (!isTauriRuntime()) {
      return { ok: false, error: "隧道功能需要桌面应用（Tauri 运行时）" };
    }
    set({ busy: true });
    try {
      await tunnelStart(spec);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    } finally {
      set({ busy: false });
    }
  },

  stopTunnel: async (tunnelId) => {
    if (!isTauriRuntime()) {
      return { ok: false, error: "隧道功能需要桌面应用（Tauri 运行时）" };
    }
    set({ busy: true });
    try {
      await tunnelStop(tunnelId);
      await get().refresh();
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    } finally {
      set({ busy: false });
    }
  },
}));
