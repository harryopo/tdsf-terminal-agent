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
 *
 * **单位 = 侧栏在屏幕上实际占的视觉像素**（`getBoundingClientRect().width`），
 * 不是 react-resizable-panels 的 `inPixels`。后者是布局像素，会随 `--app-zoom`
 * 变（实测 zoom=1.05 时 294 布局 px ↔ 308.5 视觉 px），拿它去乘 zoom 只是把
 * 单位换算写在了消费方，而它**只在 onResize 时发布**：改缩放会让面板重新布局却
 * 常常不触发 onResize，变量就停在旧值上 —— CDP 实测这样能歪 70px。
 * 现在由 ResizeObserver 直接量面板自己的渲染宽，顶栏拿到的数字与探针量的是同一个，
 * 不需要再乘任何系数，也不可能滞后。
 */
export const SIDEBAR_WIDTH_CSS_VAR = "--tdsf-sidebar-w";

/** 把面板**视觉**像素宽度写进根元素；0（折叠）也照写，顶栏据此回退到内容宽 */
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

  const sidebarPanelObserverRef = useRef<ResizeObserver | null>(null);

  /**
   * 挂到侧栏面板 DOM 元素上的 callback ref：把面板**实际渲染出来的宽度**发布成
   * CSS 变量，顶栏那条分隔竖线据此与侧栏右边界对齐。
   *
   * 为什么量 DOM 而不是直接用 react-resizable-panels 的 `size.inPixels`：那个值是
   * 布局像素、且只在 onResize 时给出；改缩放（`--app-zoom`）会让面板重新布局却常常
   * 不触发 onResize，变量就停在旧值上（CDP 实测歪 70px）。ResizeObserver 对任何
   * 原因引起的尺寸变化都会回调，折叠成 0 也照样发布，所以顶栏永远拿到当前真值。
   */
  const sidebarPanelRef = useCallback((el: HTMLElement | null) => {
    sidebarPanelObserverRef.current?.disconnect();
    sidebarPanelObserverRef.current = null;
    if (!el) return;
    const publish = () => publishSidebarWidthVar(el.getBoundingClientRect().width);
    publish();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    sidebarPanelObserverRef.current = ro;
  }, []);

  useEffect(() => {
    return () => {
      sidebarPanelObserverRef.current?.disconnect();
      sidebarPanelObserverRef.current = null;
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
    sidebarPanelRef,
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
