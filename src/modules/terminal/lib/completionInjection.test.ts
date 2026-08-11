/**
 * completionInjection.test.ts — 命令预测注入的定位纯函数测试
 * -----------------------------------------------------------------------------
 * 覆盖（P2 #13 弹窗跟随终端光标）:
 *   1. measureCursorPx: 无 getTerm / 无 term / 无 DOM → null；正常 → 按
 *      .xterm-screen 尺寸 ÷ cols/rows 换算光标像素坐标（不依赖私有 API）
 *   2. computePopupPosition: 光标下方定位 / 右边界收拢 / 下边界翻转上方 /
 *      上方不越视口顶
 */
import { describe, expect, it } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import {
  computePopupPosition,
  measureCursorPx,
  POPUP_WIDTH,
} from "./completionInjection";

// === measureCursorPx =========================================================

/** 构造最小可测 xterm 假对象（只暴露本函数用到的公开属性） */
function fakeTerm(over: {
  cols?: number;
  rows?: number;
  cursorX?: number;
  cursorY?: number;
  screenRect?: { left: number; top: number; width: number; height: number };
  hasScreen?: boolean;
  hasRows?: boolean;
}): XTerm {
  const el = document.createElement("div");
  if (over.hasScreen !== false) {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    el.appendChild(screen);
  }
  if (over.hasRows !== false) {
    const rows = document.createElement("div");
    rows.className = "xterm-rows";
    el.appendChild(rows);
  }
  const rect = over.screenRect ?? { left: 10, top: 20, width: 800, height: 480 };
  el.querySelectorAll("div").forEach((d) => {
    d.getBoundingClientRect = () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    });
  });
  return {
    element: el,
    cols: over.cols ?? 80,
    rows: over.rows ?? 24,
    buffer: {
      active: {
        cursorX: over.cursorX ?? 10,
        cursorY: over.cursorY ?? 3,
      },
    },
  } as unknown as XTerm;
}

describe("measureCursorPx", () => {
  it("getTerm 为 null → null", () => {
    expect(measureCursorPx(null, 1)).toBeNull();
  });

  it("找不到 leaf 对应 xterm → null", () => {
    expect(measureCursorPx(() => null, 1)).toBeNull();
  });

  it("term 无 element → null", () => {
    const term = fakeTerm({});
    (term as unknown as { element: HTMLElement | null }).element = null;
    expect(measureCursorPx(() => term, 1)).toBeNull();
  });

  it("无 .xterm-screen 也无 .xterm-rows → null", () => {
    const term = fakeTerm({ hasScreen: false, hasRows: false });
    expect(measureCursorPx(() => term, 1)).toBeNull();
  });

  it("按 .xterm-screen 尺寸 ÷ cols/rows 换算光标像素坐标", () => {
    const term = fakeTerm({
      cols: 80,
      rows: 24,
      cursorX: 20,
      cursorY: 3,
      screenRect: { left: 10, top: 20, width: 800, height: 480 },
    });
    // 单格 = 800/80=10 宽, 480/24=20 高
    // left = 10 + 20*10 = 210; top = 20 + 3*20 = 80
    expect(measureCursorPx(() => term, 1)).toEqual({ left: 210, top: 80 });
  });

  it("无 .xterm-screen 时回退 .xterm-rows", () => {
    const term = fakeTerm({
      hasScreen: false,
      cursorX: 40,
      cursorY: 0,
      screenRect: { left: 0, top: 0, width: 400, height: 120 },
    });
    // 单格 = 400/80=5 宽, 120/24=5 高
    expect(measureCursorPx(() => term, 1)).toEqual({ left: 200, top: 0 });
  });

  it("cols/rows 为 0 时防除零", () => {
    const term = fakeTerm({
      cols: 0,
      rows: 0,
      screenRect: { left: 0, top: 0, width: 0, height: 0 },
    });
    expect(measureCursorPx(() => term, 1)).toEqual({ left: 0, top: 0 });
  });
});

// === computePopupPosition =====================================================

const VP = { width: 1920, height: 1080 };

describe("computePopupPosition", () => {
  it("光标居中 → 弹窗出现在光标下方", () => {
    const pos = computePopupPosition({ left: 500, top: 300 }, VP, 5);
    expect(pos).toEqual({ left: 500, top: 312 });
  });

  it("光标贴近右边缘 → 弹窗左移收拢到视口内", () => {
    const pos = computePopupPosition({ left: 1900, top: 300 }, VP, 5);
    // 384 宽 + 8 边距 → 最大 left = 1920 - 384 - 8 = 1528
    expect(pos.left).toBe(VP.width - POPUP_WIDTH - 8);
  });

  it("光标左边缘 → 弹窗不低于 8px", () => {
    const pos = computePopupPosition({ left: 0, top: 300 }, VP, 5);
    expect(pos.left).toBe(8);
  });

  it("下方放不下 → 翻转到光标上方", () => {
    const pos = computePopupPosition({ left: 500, top: 1050 }, VP, 5);
    // estHeight = 24 + 5*30 + 8 = 182; top = 1050 - 182 - 12 = 856
    expect(pos).toEqual({ left: 500, top: 856 });
  });

  it("上方也放不下 → 不低于视口顶 8px", () => {
    // estHeight = 24 + 20*30 + 8 = 632; cursor.top=500 满足翻转条件
    // (500+12+632 > 1080)，翻转后 500-632-12 < 8 → clamp 8
    const pos = computePopupPosition({ left: 500, top: 500 }, VP, 20);
    expect(pos.top).toBe(8);
  });

  it("视口比弹窗窄 → left 保持 8", () => {
    const pos = computePopupPosition(
      { left: 0, top: 100 },
      { width: 200, height: 600 },
      5,
    );
    expect(pos.left).toBe(8);
  });
});
