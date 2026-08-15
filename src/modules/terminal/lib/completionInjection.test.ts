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
import { getSuggestEngine } from "@/lib/suggest-engine";
import {
  completionKeyHandler,
  computePopupPosition,
  getCompletionState,
  initCompletionInjection,
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

// === acceptPrediction（2026-08-15 ipp bug 回归） =============================
// 用户场景：输入 "ip" → fuzzy 预测 "pip"，按右箭头接受。
// 旧实现：remaining = "pip".slice(2) = "p" 直接追加到已回显的 "ip" → "ipp"。
// 修复：先发等量退格清掉屏幕上已回显的 prefix，再写入完整命令。

/** 构造最小可测键盘事件（completionKeyHandler 用到的字段） */
function key(k: string): KeyboardEvent {
  return {
    type: "keydown",
    key: k,
    keyCode: k.length === 1 ? k.charCodeAt(0) : 0,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}

/** 等待 setTimeout(0) 微任务（updatePredictions 在定时器里跑） */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("acceptPrediction", () => {
  it("接受 fuzzy 预测时先退格清 prefix 再写完整命令（输 ip 接受 pip）", async () => {
    // 清空历史，避免 history/dictionary 前缀命中干扰 fuzzy 层
    getSuggestEngine().clearHistory();
    const written: string[] = [];
    initCompletionInjection(
      () => null,
      (_leafId, data) => {
        written.push(data);
      },
    );

    // 输入 "ip"
    expect(completionKeyHandler(1, key("i"))).toBe(true);
    expect(completionKeyHandler(1, key("p"))).toBe(true);
    await tick();

    const state = getCompletionState();
    expect(state.visible).toBe(true);
    // 复现用户场景：预测列表里存在 fuzzy 来源的 "pip"
    const pipIndex = state.items.findIndex(
      (it) => it.command === "pip" && it.source === "fuzzy",
    );
    expect(pipIndex).toBeGreaterThanOrEqual(0);

    // 下移选中 fuzzy 的 "pip"，再右箭头接受
    for (let i = 0; i < pipIndex; i++) {
      expect(completionKeyHandler(1, key("ArrowDown"))).toBe(false);
    }
    expect(completionKeyHandler(1, key("ArrowRight"))).toBe(false);
    // 写入 = 2 个退格 + 完整命令 "pip"，而非 "p" 追加成 "ipp"
    expect(written).toEqual(["\b\b" + "pip"]);
  });

  it("接受 history 预测时同样先退格再写完整命令", async () => {
    // 用独立 leafId 隔离输入缓冲区（leafId 1 已在上一个测试使用）
    getSuggestEngine().clearHistory();
    getSuggestEngine().loadHistory(["ipp"]);
    const written: string[] = [];
    initCompletionInjection(
      () => null,
      (_leafId, data) => {
        written.push(data);
      },
    );

    expect(completionKeyHandler(2, key("i"))).toBe(true);
    expect(completionKeyHandler(2, key("p"))).toBe(true);
    await tick();

    const state = getCompletionState();
    expect(state.visible).toBe(true);
    expect(state.items[0]?.command).toBe("ipp");

    expect(completionKeyHandler(2, key("ArrowRight"))).toBe(false);
    expect(written).toEqual(["\b\b" + "ipp"]);
  });
});
