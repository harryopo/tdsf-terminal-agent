/**
 * src/lib/tauri-window-config.test.ts —— 窗口配置：平台覆盖文件不许把主窗配置"换没了"
 * -----------------------------------------------------------------------------
 * 两条真事，都是这一类问题：
 *
 * ① 「假圆角」（用户 2026-09-24 图3）：`globals.css` 里 `html[data-chrome="borderless"]`
 *    把 html/body 刷成 transparent、给 #root 画 12px 弧 + 1px 边框，注释写得很清楚
 *    "the OS gives us a transparent borderless window"。**但主窗从来没透明过** ——
 *    三个窗口配置里都没有 `transparent`，还带着 `backgroundColor:"#1a1a1a"`
 *    （tao 的 WM_ERASEBKGND 按 RGB 刷整个客户区，alpha 直接被忽略）。
 *    于是弧是画在一张不透明方窗上的，四个角露出方角 = 他说的"假圆角"。
 *    （设置窗反而是对的：`lib.rs` 建它时写了 `.transparent(true)`。）
 *
 * ② 顺手撞出来的更大的账：`tauri.windows.conf.json` / `tauri.linux.conf.json` 里只写了
 *    `{label, decorations}`。Tauri 合并平台覆盖文件走 `json_patch::merge`（RFC 7386），
 *    **数组整体替换**，所以发布版的主窗配置被这一条替换成了"只有 label + decorations"，
 *    `additionalBrowserArgs`（`--disable-gpu`，黑屏缓解）、title、尺寸、backgroundColor
 *    全丢。实测证据：`target/release/*.exe` 里搜不到 `--disable-gpu`，而 dev 的
 *    `target/debug/*.exe` 里有（dev 配置文件把整份窗口对象重抄了一遍，所以没踩到这个坑）。
 *
 * 所以这里钉四件事：覆盖文件必须自带完整窗口对象；`--disable-gpu` 必须在每一份里都在；
 * 主窗必须**不透明 + 深色底**，圆角交给系统裁（下面 #148 那段解释了为什么反转口径）；
 * 以及**CSS 那侧真的不再自绘弧**（两套半径会叠出一道月牙）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type WindowConfig = Record<string, unknown> & { label?: string };
type TauriConfig = { app?: { windows?: WindowConfig[] } };

const read = (file: string): TauriConfig =>
  JSON.parse(readFileSync(join(process.cwd(), "src-tauri", file), "utf-8")) as TauriConfig;

const BASE = read("tauri.conf.json");
const baseWindow = BASE.app?.windows?.[0];

// 平台覆盖文件（数组整体替换 ⇒ 每一个都必须自带完整对象）
const OVERRIDES = ["tauri.windows.conf.json", "tauri.linux.conf.json", "tauri.dev.conf.json"];

// 丢了就当场出事（黑屏 / 尺寸 / 标题）或静默变样的字段
const MUST_SURVIVE = [
  "title",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "visible",
  "center",
  "dragDropEnabled",
  "devtools",
  "additionalBrowserArgs",
] as const;

describe("Tauri 窗口配置 —— 平台覆盖不得丢字段、窗口不透明且圆角交给系统", () => {
  it("基线主窗配置存在（这条测试的前提）", () => {
    expect(baseWindow).toBeTruthy();
  });

  it.each(OVERRIDES)("%s 的 app.windows 覆盖必须自带完整窗口对象", (file) => {
    const cfg = read(file);
    const windows = cfg.app?.windows;
    expect(Array.isArray(windows), `${file} 没有 app.windows`).toBe(true);
    const main = windows!.find((w) => w.label === "main");
    expect(main, `${file} 的 windows 里没有 label=main`).toBeTruthy();
    const missing = MUST_SURVIVE.filter((k) => main![k] === undefined);
    expect(missing, `${file} 覆盖后丢掉了这些主窗字段：${missing.join(", ")}`).toEqual([]);
  });

  it("每一份配置都带着 --disable-gpu（WebView2 黑屏缓解，丢了你看不见但会黑）", () => {
    for (const file of ["tauri.conf.json", ...OVERRIDES]) {
      const windows = read(file).app?.windows ?? [];
      for (const w of windows) {
        expect(
          String(w.additionalBrowserArgs ?? ""),
          `${file} 的 ${w.label} 少了 --disable-gpu`,
        ).toContain("--disable-gpu");
      }
    }
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * #148 口径反转（用户 2026-09-25 实测后拍板「让系统裁圆角」）
   * 9-24 那版为了修"假圆角"把窗口改成真透明 + CSS 自绘 16px 弧。代价当场没看清：
   * **弧外那块必然透出后面的东西**。真机读数（屏幕取样 + CDP alpha）：
   *   · 页面在圆角外 alpha=0（什么都没画）；
   *   · 那块白的颜色 == 窗口外紧邻像素的颜色 ⇒ 是**透过去的**，不是画上去的。
   * 他桌面上正开着白色的资源管理器窗口 ⇒ 圆角看着就是"多了一块白"。
   * 改成：**不透明深底 + 让 DWM 裁圆角**（和微信/VS Code 同一做法），CSS 不再自绘弧
   * —— 两套半径叠在一起还会多出一道月牙。
   * ⚠️ 深色 backgroundColor 同时把 2026-08-09 那条"CSS 加载前闪白屏"的防护带回来了。
   * ───────────────────────────────────────────────────────────────────────── */
  it("主窗必须不透明且带深色底（弧外不再透出背景，冷启动也不闪白）", () => {
    for (const file of OVERRIDES) {
      const main = (read(file).app?.windows ?? []).find((w) => w.label === "main")!;
      expect(main.decorations, `${file} 应当无边框（标题栏我们自己画）`).toBe(false);
      expect(
        main.transparent ?? false,
        `${file} 还开着 transparent ⇒ 圆角外必然透出后面的窗口/桌面`,
      ).toBe(false);
      expect(
        main.backgroundColor,
        `${file} 少了深色 backgroundColor ⇒ 弧外会透出底色、冷启动还会闪白`,
      ).toBe("#1a1a1a");
    }
  });

  it("Windows 侧要真的向 DWM 请求裁圆角（不请求就变成方角，等于把圆角删了没补）", () => {
    const rs = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf-8");
    // 验**调用形状**而不是"名字出现过"（#147 的教训：只留 import 也能骗过存在性断言）
    expect(rs).toMatch(
      /DwmSetWindowAttribute\([\s\S]{0,240}DWMWA_WINDOW_CORNER_PREFERENCE/,
    );
    expect(rs).toMatch(/DWMWCP_ROUND/);
    // 必须作用在**主窗**上，不能只给设置窗（他报的就是主窗的角）
    const at = rs.indexOf("fn apply_dwm_rounded_corners");
    expect(at).toBeGreaterThan(-1);
    expect(rs).toMatch(/apply_dwm_rounded_corners\(&main\)/);
  });

  it("macOS 不在覆盖文件里被改成无边框（它用原生标题栏 + Overlay）", () => {
    const windows = baseWindow ? [baseWindow] : [];
    for (const w of windows) {
      expect(w.transparent, "基线配置（macOS 走这份）不该开 transparent").toBeUndefined();
      expect(w.decorations, "基线配置不该关原生边框").toBeUndefined();
    }
  });

  // 正向配对：CSS 那侧确实不再自绘弧了。上面几条"不透明"的断言在 CSS 还画着弧时
  // 会一起成立而看不出月牙，所以这里单独钉半径归零。
  it("CSS 不再自绘窗口弧（两套半径会叠出一道月牙）", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/globals.css"), "utf-8");
    expect(css).toContain('html[data-chrome="borderless"]');
    expect(css).toMatch(/--window-radius:\s*0px/);
    // 变量还在、规则还在（Linux 没有 DWM，将来要恢复自绘只改这一个数），
    // 但**当前值必须是 0**，否则弧外又透出背景。
    expect(css).toMatch(/border-radius:\s*var\(--window-radius\)/);
  });
});
