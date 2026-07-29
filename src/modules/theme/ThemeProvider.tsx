/* ThemeProvider.tsx — TDSF 主题上下文 Provider (源自 terax-ai, Apache-2.0)
 * -----------------------------------------------------------------------------
 * 复用自: terax-ai/src/modules/theme/ThemeProvider.tsx
 * License: Apache-2.0, Copyright 2026 Crynta
 *
 * 适配:
 *   - 移除 settings store 依赖 → 用 localStorage 直接持久化
 *   - 移除编辑器主题支持 (TDSF 不集成 CodeMirror)
 *   - 简化 SurfaceLayer (保留背景图能力)
 *   - 保留完整主题切换 + 预览 + 自定义主题能力
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { applyTheme, clearTheme } from "./applyTheme";
import { getBuiltinTheme, getDefaultTheme, listBuiltinThemes } from "./themes";
import { listCustomThemes, onCustomThemesChange } from "./customThemes";
import type { Theme } from "./types";
import { DEFAULT_THEME_ID } from "./types";

export type { Theme };
export type ThemeModePref = "dark" | "light" | "system";

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultMode?: ThemeModePref;
};

type ThemeProviderState = {
  mode: ThemeModePref;
  resolvedMode: "dark" | "light";
  themeId: string;
  activeTheme: Theme;
  builtinThemes: Theme[];
  customThemes: Theme[];
  setMode: (mode: ThemeModePref) => void;
  setThemeId: (id: string) => void;
  /** 预览主题(不持久化); null 回退到已提交 */
  previewThemeId: (id: string | null) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

const LS_KEY_MODE = "tdsf-theme-mode";
const LS_KEY_THEME_ID = "tdsf-theme-id";

function readLS(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}

function resolveTheme(id: string, customThemes: Theme[]): Theme {
  return (
    customThemes.find((t) => t.id === id) ??
    getBuiltinTheme(id) ??
    getDefaultTheme()
  );
}

export function ThemeProvider({ children, defaultMode = "dark" }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemeModePref>(() => {
    // 1. 优先读 localStorage (用户主动切换后的偏好)
    const stored = readLS(LS_KEY_MODE, "");
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
    // 2. TDSF 魔改 (#20): 兜底尊重 HTML 模板预设 (index.html 写了 class="dark"/data-theme="dark")
    //    避免 localStorage 被历史残留清空后回退到 system+light, 导致终端 token 错乱
    const htmlEl = document.documentElement;
    if (htmlEl.classList.contains("dark") || htmlEl.getAttribute("data-theme") === "dark") {
      return "dark";
    }
    if (htmlEl.classList.contains("light") || htmlEl.getAttribute("data-theme") === "light") {
      return "light";
    }
    // 3. 最终兜底
    return defaultMode;
  });
  const [themeId, setThemeIdState] = useState<string>(() =>
    readLS(LS_KEY_THEME_ID, DEFAULT_THEME_ID)
  );
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  const builtinThemes = useMemo(() => listBuiltinThemes(), []);

  // 加载用户自定义主题 + 订阅变化 (tauri store / 跨窗口事件)
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const reload = () => {
      void listCustomThemes()
        .then((themes) => {
          if (!cancelled) setCustomThemes(themes);
        })
        .catch((e) => {
          console.warn("[ThemeProvider] load custom themes failed:", e);
        });
    };

    reload();
    void onCustomThemesChange(reload)
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        /* 非 Tauri 环境 (纯 web dev) 下事件订阅不可用, 忽略 */
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 监听系统主题变化
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedMode: "dark" | "light" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  // 同步 dark/light class
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedMode);
  }, [resolvedMode]);

  const effectiveId = previewId ?? themeId;
  const activeTheme = useMemo(
    () => resolveTheme(effectiveId, customThemes),
    [effectiveId, customThemes],
  );

  // 应用主题到 CSS 变量
  useEffect(() => {
    if (effectiveId === DEFAULT_THEME_ID) {
      clearTheme();
      return;
    }
    applyTheme(activeTheme, resolvedMode);
  }, [effectiveId, activeTheme, resolvedMode]);

  const setMode = useCallback((next: ThemeModePref) => {
    setModeState(next);
    writeLS(LS_KEY_MODE, next);
  }, []);

  const setThemeId = useCallback((id: string) => {
    setPreviewId(null);
    setThemeIdState(id);
    writeLS(LS_KEY_THEME_ID, id);
  }, []);

  const previewThemeId = useCallback((id: string | null) => {
    setPreviewId(id);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      builtinThemes,
      customThemes,
      setMode,
      setThemeId,
      previewThemeId,
    }),
    [mode, resolvedMode, themeId, activeTheme, builtinThemes, customThemes, setMode, setThemeId, previewThemeId],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
