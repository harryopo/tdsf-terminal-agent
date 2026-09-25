/**
 * useSidebarPanel.test.ts — 侧栏宽度变量的取值口径（#144）
 * ---------------------------------------------------------------------------
 * 只测一件事：这个变量是**顶栏竖线的对齐依据**，所以它的值必须与探针量到的是
 * 同一个数。真机量到的缺陷是发布时四舍五入：面板 307.85px → 发布 307px，
 * 两条线差 1.15px 越过 `probe:ui` 的 1px 判据；零头有多大取决于窗口宽与缩放，
 * 所以症状是"拖一下侧栏就随机红一条"，而不是稳定错位。
 *
 * jsdom 不做布局（`getBoundingClientRect()` 恒为 0），所以"两条线对齐"这件事
 * 只能由 `pnpm probe:ui` 在真机量；这里钉的是**不丢精度**这条能离线判的部分。
 */
import { describe, expect, it } from "vitest";
import { formatSidebarWidthVar } from "./useSidebarPanel";

describe("formatSidebarWidthVar — 视觉像素零头不许被抹掉（#144）", () => {
  it("带小数的宽度原样发布（旧写法 Math.round 会把 307.85 变成 307）", () => {
    expect(formatSidebarWidthVar(307.85)).toBe("307.85px");
  });

  it("整数宽度不带多余的 .0（CSS 值两种写法都行，但别写成 '307.0px' 让人以为是精度）", () => {
    expect(formatSidebarWidthVar(260)).toBe("260px");
  });

  it("折叠成 0 与负数都归到 0px，不给顶栏留一个负宽度", () => {
    expect(formatSidebarWidthVar(0)).toBe("0px");
    expect(formatSidebarWidthVar(-12)).toBe("0px");
  });
});
