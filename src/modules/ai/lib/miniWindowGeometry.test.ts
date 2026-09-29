import { describe, expect, it } from "vitest";
import {
  applyDrag,
  applyResize,
  clampGeom,
  defaultGeom,
  type Geom,
  MIN_H,
  MIN_W,
  toLayoutExpr,
  type Viewport,
} from "./miniWindowGeometry";

const vp: Viewport = { vw: 1440, vh: 900 };

describe("defaultGeom", () => {
  it("anchors to the bottom-right and stays on screen", () => {
    const g = defaultGeom(vp);
    expect(g.x + g.w).toBeLessThanOrEqual(vp.vw);
    expect(g.y + g.h).toBeLessThanOrEqual(vp.vh);
    expect(g.x).toBeGreaterThanOrEqual(0);
    expect(g.y).toBeGreaterThanOrEqual(0);
  });

  it("never goes below the minimum size on a tiny viewport", () => {
    const g = defaultGeom({ vw: 320, vh: 200 });
    expect(g.w).toBe(MIN_W);
    expect(g.h).toBe(MIN_H);
  });
});

describe("clampGeom", () => {
  it("keeps the window fully within the viewport", () => {
    const g = clampGeom({ x: 5000, y: 5000, w: 500, h: 400 }, vp);
    expect(g.x).toBe(vp.vw - 500);
    expect(g.y).toBe(vp.vh - 400);
  });

  it("enforces the minimum size", () => {
    const g = clampGeom({ x: 0, y: 0, w: 10, h: 10 }, vp);
    expect(g.w).toBe(MIN_W);
    expect(g.h).toBe(MIN_H);
  });
});

describe("applyDrag", () => {
  const start: Geom = { x: 800, y: 400, w: 500, h: 300 };

  it("moves by the delta", () => {
    expect(applyDrag(start, -100, -50, vp)).toMatchObject({ x: 700, y: 350 });
  });

  it("cannot be dragged off the right or bottom edge", () => {
    const g = applyDrag(start, 9999, 9999, vp);
    expect(g.x).toBe(vp.vw - start.w);
    expect(g.y).toBe(vp.vh - start.h);
  });

  it("cannot be dragged off the top or left edge", () => {
    const g = applyDrag(start, -9999, -9999, vp);
    expect(g).toMatchObject({ x: 0, y: 0 });
  });
});

describe("applyResize", () => {
  const start: Geom = { x: 800, y: 300, w: 500, h: 400 };

  it("grows width from the east handle", () => {
    expect(applyResize(start, "e", 120, 0, vp).w).toBe(620);
  });

  it("west handle keeps the right edge anchored", () => {
    const g = applyResize(start, "w", -100, 0, vp);
    expect(g.w).toBe(600);
    expect(g.x + g.w).toBe(start.x + start.w);
  });

  it("north handle keeps the bottom edge anchored", () => {
    const g = applyResize(start, "n", 0, -80, vp);
    expect(g.h).toBe(480);
    expect(g.y + g.h).toBe(start.y + start.h);
    expect(g.y).toBe(start.y - 80);
  });

  it("clamps to the minimum size", () => {
    expect(applyResize(start, "se", -9999, -9999, vp)).toMatchObject({
      w: MIN_W,
      h: MIN_H,
    });
  });

  it("north-west corner stops at the viewport edges", () => {
    const g = applyResize(start, "nw", -9999, -9999, vp);
    expect(g.x).toBe(0);
    expect(g.y).toBe(0);
    expect(g.x + g.w).toBe(start.x + start.w);
    expect(g.y + g.h).toBe(start.y + start.h);
  });

  it("south-east corner resizes both axes, clamped to the viewport", () => {
    const g = applyResize(start, "se", 9999, 9999, vp);
    expect(g.x + g.w).toBe(vp.vw);
    expect(g.y + g.h).toBe(vp.vh);
  });

  it("east handle never moves the top edge", () => {
    expect(applyResize(start, "e", 50, 50, vp).y).toBe(start.y);
  });
});

// #166 续（2026-09-29 用户拍板「AI 小窗也跟随缩放」）。
// 真机量过的事实：`position:fixed` 元素带 `zoom:z` 时，**left/top/width/height 全都会被乘上 z**
// （`left:100 width:200 zoom:1.5` 的 rect 是 x=150 w=300）。
// 所以几何按视觉像素存，写样式时**除**回去 —— 方向写反就是 #99 那条"单位放错地方"，
// 症状是"一开缩放小窗整扇飞出屏幕"。
describe("toLayoutExpr — 视觉像素交给浏览器除，不在 JS 里算", () => {
  it("写的是**除** var(--app-zoom)，不是乘（乘会越缩越偏）", () => {
    expect(toLayoutExpr(460)).toBe("calc(460px / var(--app-zoom))");
  });

  it("数值原样带上，不四舍五入（#144：零头一丢，档位×窗口宽就随机偏）", () => {
    expect(toLayoutExpr(38.095238095238095)).toBe(
      "calc(38.095238095238095px / var(--app-zoom))",
    );
    expect(toLayoutExpr(0)).toBe("calc(0px / var(--app-zoom))");
  });

  it("表达式里的数字就是视觉像素本身（拖动增量与 clamp 都按这套单位）", () => {
    const m = /calc\(([-\d.]+)px/.exec(toLayoutExpr(460));
    expect(Number(m?.[1])).toBe(460);
    // 「不在 JS 里读档位」这条回归由 miniWindowZoom.test.ts 的接线断言守：
    // 装回上一版（读 getComputedStyle 除一次）时那里写出的 style 会变成 438.095px。
  });
});
