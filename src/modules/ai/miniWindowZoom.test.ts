// AI 小窗跟随「界面缩放」的接线判据。
//
// 缺陷形状（#166 续，2026-09-29 用户拍板要做的）：小窗挂在 `</main>` 之外，
// 而 `--app-zoom` 原先只作用在 `.zoom-content` 上 ⇒ 主窗放大、小窗不放大。
// 接上缩放只是加一个 class，**真正会错的是位置**：CSS `zoom` 会连元素自己的
// left/top/width/height 一起乘（真机量过：`left:100 width:200 zoom:1.5` → rect x=150 w=300），
// 所以几何按视觉像素存、写样式时除回去。
//
// 除法必须在 **CSS** 里，不能在 JS 里 —— 这是本轮真机撞出来的第二条：
// 第一版在 effect 里 `getComputedStyle(el).zoom` 除一次，换档位后 rect 从
// 40,40,460,520 变成 57.1,57.1,657.1,742.9（style 一直是旧系数除出的 38.0952px）。
// 根因是 `lib/useZoom.ts` 在**被动 effect** 里写 `--app-zoom`，而 React 的子组件
// effect 先于父组件跑 ⇒ 小窗读到的是上一档的数字，而且之后再换档位也没人重算。
// 写成 `calc(<视觉px> / var(--app-zoom))` 之后档位一变浏览器自己重算（同一页真机
// 1.05 / 1.5 / 0.9 三档 rect 恒等）。所以下面既钉"接上了"，也钉"没在 JS 里读档位"。
//
// 单位换算的数字本身在 `miniWindowGeometry.test.ts` 里测；这里钉**接线** ——
// 本仓反复出现的病是"实现了但没接上"（#142/#125/#128）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8");

const win = read("modules/ai/components/AiMiniWindow.tsx");
const hook = read("modules/ai/lib/useMiniWindowGeometry.ts");
const geom = read("modules/ai/lib/miniWindowGeometry.ts");
const css = read("styles/globals.css");

describe("AI 小窗接上界面缩放", () => {
  it("小窗根节点带 .zoom-content（内容随档位放大）", () => {
    expect(win).toMatch(/"zoom-content"/);
  });

  it("四轴都经 toLayoutExpr 换算，漏一个就是「位置对、尺寸错」的半吊子", () => {
    expect(hook).toMatch(/el\.style\.left = toLayoutExpr\(g\.x\)/);
    expect(hook).toMatch(/el\.style\.top = toLayoutExpr\(g\.y\)/);
    expect(hook).toMatch(/el\.style\.width = toLayoutExpr\(g\.w\)/);
    expect(hook).toMatch(/el\.style\.height = toLayoutExpr\(g\.h\)/);
    // 负向：不许绕过换算直接裸写 px
    expect(hook).not.toMatch(/el\.style\.width = `\$\{g\.w\}px`/);
  });

  it("除法在 CSS 里，JS 不读档位（装回 getComputedStyle 那一版就红）", () => {
    expect(hook).not.toMatch(/getComputedStyle/);
    expect(hook).not.toMatch(/zoomLevel/);
    expect(geom).toMatch(/calc\(\$\{px\}px \/ var\(--app-zoom\)\)/);
  });

  it("除的那个 var 与放大用的那个 var 是同一个（两名分家＝静默失效）", () => {
    // 正向配对：`.zoom-content` 确实用 --app-zoom 放大；否则上面那条除法就除在空气上
    expect(css).toMatch(/\.zoom-content\s*\{\s*zoom:\s*var\(--app-zoom\)/);
    expect(css).toMatch(/:root[^}]*--app-zoom:\s*1;/s);
  });
});
