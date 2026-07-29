import { isTauriRuntime } from "@/lib/tauriRuntime";
import { setThemeId as persistThemeId } from "@/modules/settings/store";
import type { Tab } from "@/modules/tabs";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  deleteBgImage,
  getBgImage,
  importBgImageFromFile,
  putBgImage,
} from "./bgImageStore";
import { listCustomThemes, saveCustomTheme } from "./customThemes";
import {
  isThemeFilePath,
  onThemeEdit,
  parseThemeFile,
  starterTheme,
  themeFilePath,
  writeThemeFile,
} from "./themeFiles";

export type ThemeImage = {
  id: string;
  url: string;
  label: string;
};

type Params = {
  tabsRef?: RefObject<Tab[]>;
  openFileTab?: (path: string) => void;
};

const BUILTIN_BG_IDS = [
  "bg-aurora",
  "bg-mountains",
  "bg-ocean",
  "bg-grid",
  "bg-stars",
];

function builtinImageLabel(id: string): string {
  switch (id) {
    case "bg-aurora":
      return "极光";
    case "bg-mountains":
      return "山脉";
    case "bg-ocean":
      return "海洋";
    case "bg-grid":
      return "网格";
    case "bg-stars":
      return "星空";
    default:
      return id;
  }
}

async function listCustomBgImageIds(): Promise<string[]> {
  // 通过尝试加载已知 ID 列表简单实现:
  // 用户上传图片后 ID 由 importBgImageFromFile 随机生成,
  // 我们使用一个固定的 localStorage 索引维护自定义图片 ID 列表
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("tdsf-ui-bg-custom-ids");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function pushCustomBgImageId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const cur = listCustomBgImageIdsSync();
    if (!cur.includes(id)) {
      cur.push(id);
      window.localStorage.setItem("tdsf-ui-bg-custom-ids", JSON.stringify(cur));
    }
  } catch {
    /* ignore */
  }
}

function removeCustomBgImageId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const cur = listCustomBgImageIdsSync().filter((x) => x !== id);
    window.localStorage.setItem("tdsf-ui-bg-custom-ids", JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

function listCustomBgImageIdsSync(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("tdsf-ui-bg-custom-ids");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function revokeUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/**
 * 主题文件编辑 + 背景图管理的统一 hook
 *
 * 设计:
 *   - tabsRef / openFileTab 可选: 传入时启用主题文件编辑（App.tsx）
 *   - 不传时只暴露背景图管理（ThemesSection）
 *
 * 背景图来源:
 *   - 内置 5 张 (data URL 或内置 SVG 路径, 走 /public/bg/*)
 *   - 用户上传 (IndexedDB 持久化, blob URL 加载)
 */
export function useThemeFileEditing(params: Params = {}) {
  const { tabsRef, openFileTab } = params;

  // ===== 主题文件编辑: 保存自定义主题后重新加载 =====
  useEffect(() => {
    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 fs:file-written 监听
    if (!isTauriRuntime()) return;
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source !== "editor") return;
          if (!isThemeFilePath(event.payload.path)) return;
          void (async () => {
            try {
              const res = await invoke<{ kind: string; content?: string }>(
                "fs_read_file",
                { path: event.payload.path, workspace: currentWorkspaceEnv() },
              );
              if (res.kind !== "text" || typeof res.content !== "string")
                return;
              const parsed = parseThemeFile(res.content);
              if (!parsed.ok) {
                console.warn("[tdsf] theme not applied:", parsed.error);
                return;
              }
              await saveCustomTheme(parsed.theme);
            } catch (e) {
              console.warn("[tdsf] theme ingest failed:", e);
            }
          })();
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  // ===== 主题文件编辑: 主题请求通道 =====
  useEffect(() => {
    if (!tabsRef || !openFileTab) return;
    let alive = true;
    let unsub: (() => void) | undefined;
    void onThemeEdit(async (req) => {
      const theme =
        req.action === "create"
          ? starterTheme()
          : (await listCustomThemes()).find((t) => t.id === req.id);
      if (!theme) return;
      if (req.action === "create") await saveCustomTheme(theme);
      const path = await themeFilePath(theme.id);
      const open = tabsRef.current.some(
        (t) => t.kind === "editor" && t.path === path,
      );
      if (!open) await writeThemeFile(theme);
      void persistThemeId(theme.id);
      openFileTab(path);
      void getCurrentWebviewWindow().setFocus();
    }).then((fn) => {
      if (alive) unsub = fn;
      else fn();
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [openFileTab, tabsRef]);

  // ===== 背景图管理: 列表 / 选择 / 上传 / 删除 =====
  const [availableImages, setAvailableImages] = useState<ThemeImage[]>([]);
  // TDSF 修复 2026-07-30: 用 ref 追踪本轮创建的 blob URL。
  // 原实现把 availableImages 放进下方 useEffect 依赖, 而 effect 通过
  // refreshImages → setAvailableImages(全新数组) 每次产生新引用, 形成
  // effect→setState→重渲染→effect 的无限循环 (setState 在 async 微任务内,
  // 逃过 React max-update-depth 守卫, 无报错但整树疯狂重渲染, 应用卡死)。
  const createdUrlsRef = useRef<string[]>([]);

  const refreshImages = useCallback(async () => {
    // 先释放上一轮创建的 blob URL, 防止泄漏 (内置 /bg/*.svg 非 blob, 不涉及)
    for (const u of createdUrlsRef.current) revokeUrl(u);
    createdUrlsRef.current = [];

    const images: ThemeImage[] = [];

    // 1. 内置图片
    for (const id of BUILTIN_BG_IDS) {
      images.push({
        id,
        url: `/bg/${id}.svg`,
        label: builtinImageLabel(id),
      });
    }

    // 2. 用户自定义图片
    const customIds = await listCustomBgImageIds();
    for (const id of customIds) {
      const blob = await getBgImage(id);
      if (!blob) {
        removeCustomBgImageId(id);
        continue;
      }
      const url = URL.createObjectURL(blob);
      createdUrlsRef.current.push(url);
      images.push({
        id,
        url,
        label: `自定义 ${id.slice(0, 6)}`,
      });
    }

    setAvailableImages(images);
  }, []);

  useEffect(() => {
    void refreshImages();
    return () => {
      // 从 ref 读取待释放的 blob URL, 不依赖 availableImages (避免依赖循环)
      for (const u of createdUrlsRef.current) revokeUrl(u);
    };
  }, [refreshImages]);

  const pickCustomImage = useCallback(async (): Promise<string | null> => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";
      document.body.appendChild(input);
      const file = await new Promise<File | null>((resolve) => {
        input.onchange = () => {
          const f = input.files?.[0] ?? null;
          document.body.removeChild(input);
          resolve(f);
        };
        input.oncancel = () => {
          document.body.removeChild(input);
          resolve(null);
        };
        input.click();
      });
      if (!file) return null;
      const { id } = await importBgImageFromFile(file);
      pushCustomBgImageId(id);
      await refreshImages();
      return id;
    } catch (e) {
      console.warn("[tdsf] pickCustomImage failed:", e);
      return null;
    }
  }, [refreshImages]);

  const clearCustomImage = useCallback(async (): Promise<void> => {
    const ids = listCustomBgImageIdsSync();
    for (const id of ids) {
      await deleteBgImage(id);
      removeCustomBgImageId(id);
    }
    await refreshImages();
  }, [refreshImages]);

  return {
    availableImages,
    pickCustomImage,
    clearCustomImage,
  };
}

// 保持旧 API 调用不破坏 (导出供其他位置直接用,例如 buildImageIdToFile)
export { putBgImage };
