import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { SidebarViewId } from "./types";

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_WIDTH_STORAGE_KEY = "tdsf.sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "tdsf.sidebar.view";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "tdsf.sidebar.collapsed";

/**
 * 侧栏宽度对 CSS 暴露的自定义属性名。顶栏左侧簇用它把自己的宽度钉成侧栏宽度，
 * 于是「顶栏工作区/通知之间的分隔线」与「侧栏右边界线」始终落在同一 x
 * （用户 2026-09-20 实测：两条线差几十像素，看着像没对齐）。
 * 走 CSS 变量而不是 React state：拖拽时 onResize 每帧都触发，重渲染整棵 App
 * 换 1 像素的对齐不划算。
 */
export const SIDEBAR_WIDTH_CSS_VAR = "--tdsf-sidebar-w";

/** 把面板像素宽度写进根元素；0（折叠）也照写，顶栏据此回退到内容宽 */
function publishSidebarWidthVar(px: number) {
  document.documentElement.style.setProperty(
    SIDEBAR_WIDTH_CSS_VAR,
    `${Math.max(0, Math.round(px))}px`,
  );
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)),
  );
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? clampSidebarWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function readSidebarView(): SidebarViewId {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    // TDSF (P4-T4.4): 新增 "skills" 视图
    // TDSF 修复 2026-08-01: 移除 "ssh" 视图（登录统一走新建工作区）
    if (
      stored === "explorer" ||
      stored === "source-control" ||
      stored === "skills"
    )
      return stored;
  } catch {
    // ignore
  }
  return "explorer";
}

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

// TDSF (2026-07-28 P1-A): 抽出纯函数, 供 NoTerminalEmptyState 等非 hook 上下文复用,
// 避免在多处复制 localStorage 写入逻辑.
export function persistSidebarViewRaw(view: SidebarViewId): void {
  try {
    window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
  } catch {
    // storage may fail in private mode
  }
}

type FocusableExplorer = {
  focus: () => void;
  isFocused: () => boolean;
};

export function useSidebarPanel(
  explorerRef: RefObject<FocusableExplorer | null>,
) {
  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  const sidebarWidthRef = useRef(readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);
  const [sidebarView, setSidebarViewState] =
    useState<SidebarViewId>(readSidebarView);
  const [initialSidebarCollapsed] = useState(readSidebarCollapsed);
  const collapsedRef = useRef(initialSidebarCollapsed);

  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    persistSidebarViewRaw(view);
  }, []);

  const persistSidebarCollapsed = useCallback((collapsed: boolean) => {
    if (collapsedRef.current === collapsed) return;
    collapsedRef.current = collapsed;
    // 折叠 = 侧栏那条线不存在了，顶栏宽度回退到自身内容宽（见 Header 的 min-w-max）
    if (collapsed) publishSidebarWidthVar(0);
    try {
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_STORAGE_KEY,
        collapsed ? "1" : "0",
      );
    } catch {
      // storage may fail in private mode
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) p.resize(`${sidebarWidthRef.current}px`);
    else p.collapse();
  }, []);

  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, sidebarView],
  );

  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    publishSidebarWidthVar(next);
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);

  useEffect(() => {
    // 首帧就钉好两条竖线的对齐：面板 defaultSize 用的是同一个 ref，不一定触发
    // onResize，所以初始值自己发布一次。
    publishSidebarWidthVar(
      initialSidebarCollapsed ? 0 : sidebarWidthRef.current,
    );
  }, [initialSidebarCollapsed]);

  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [explorerRef, persistSidebarView, sidebarView]);

  return {
    sidebarRef,
    sidebarWidthRef,
    sidebarView,
    initialSidebarCollapsed,
    persistSidebarView,
    persistSidebarCollapsed,
    toggleSidebar,
    cycleSidebarView,
    persistSidebarWidth,
    toggleExplorerFocus,
  };
}
