export type Geom = { x: number; y: number; w: number; h: number };
export type Viewport = { vw: number; vh: number };
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const MIN_W = 400;
export const MIN_H = 280;

const MARGIN_X = 16;
const BOTTOM_GAP = 96;
const TOP_GAP = 16;

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * 视觉像素 → 写进 style 的表达式。
 *
 * 小窗挂在 `.zoom-content` 里（跟着「界面缩放」走），而 CSS `zoom` 会把**它自己的
 * left/top/width/height 一起乘上系数** —— 2026-09-29 真机量过：
 * `position:fixed; left:100; width:200; zoom:1.5` 的 rect 是 `x=150, w=300`
 * （#99 那条"单位放错地方"的同类）。所以几何一律按**视觉像素**存（拖动/缩放拿到的
 * `clientX` 差值就是视觉像素，视口边界也是），写样式时除回去 —— 换档位时小窗**停在原地**，
 * 只是里面的字变大，而不是整扇窗被推到屏幕外。
 *
 * 除法**交给浏览器**而不是在 JS 里算：`lib/useZoom.ts` 是在被动 effect 里写
 * `--app-zoom` 的，而子组件的 effect 先于父组件跑 —— 2026-09-29 在 JS 里
 * `getComputedStyle(el).zoom` 除一次的那版，实测换档位后 style 仍是旧系数除出来的值、
 * rect 被 1.5/1.05 推走。写成 `calc(… / var(--app-zoom))` 之后档位一变浏览器自己重算，
 * 不存在"谁先跑"的问题（同一页真机三档 1.05/1.5/0.9 下 rect 恒等）。
 */
export function toLayoutExpr(px: number): string {
  return `calc(${px}px / var(--app-zoom))`;
}

export function defaultGeom(vp: Viewport): Geom {
  const w = Math.max(MIN_W, Math.min(500, vp.vw - MARGIN_X * 2));
  const h = Math.max(MIN_H, Math.min(600, vp.vh - BOTTOM_GAP - TOP_GAP));
  return clampGeom(
    { x: vp.vw - w - MARGIN_X, y: vp.vh - h - BOTTOM_GAP, w, h },
    vp,
  );
}

export function clampGeom(g: Geom, vp: Viewport): Geom {
  const w = clamp(g.w, MIN_W, Math.max(MIN_W, vp.vw));
  const h = clamp(g.h, MIN_H, Math.max(MIN_H, vp.vh));
  return {
    w,
    h,
    x: clamp(g.x, 0, Math.max(0, vp.vw - w)),
    y: clamp(g.y, 0, Math.max(0, vp.vh - h)),
  };
}

export function applyDrag(
  start: Geom,
  dx: number,
  dy: number,
  vp: Viewport,
): Geom {
  return clampGeom({ ...start, x: start.x + dx, y: start.y + dy }, vp);
}

export function applyResize(
  start: Geom,
  dir: ResizeDir,
  dx: number,
  dy: number,
  vp: Viewport,
): Geom {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  const movesW = dir.includes("w");
  const movesE = dir.includes("e");
  const movesN = dir.includes("n");
  const movesS = dir.includes("s");

  if (movesE) right += dx;
  if (movesW) left += dx;
  if (movesS) bottom += dy;
  if (movesN) top += dy;

  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(vp.vw, right);
  bottom = Math.min(vp.vh, bottom);

  if (right - left < MIN_W) {
    if (movesW) left = right - MIN_W;
    else right = left + MIN_W;
  }
  if (bottom - top < MIN_H) {
    if (movesN) top = bottom - MIN_H;
    else bottom = top + MIN_H;
  }

  return clampGeom({ x: left, y: top, w: right - left, h: bottom - top }, vp);
}
