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
 * 自绘圆角的平台必须真的 transparent 且不再刷不透明底色；以及**CSS 那侧真的还在画弧**
 * （否则前三条会因为"没人画圆角"而假绿）。
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

describe("Tauri 窗口配置 —— 平台覆盖不得丢字段、自绘圆角必须真透明", () => {
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

  it("自绘圆角的平台（Windows/Linux + dev）必须 transparent，且不刷不透明底色", () => {
    for (const file of OVERRIDES) {
      const main = (read(file).app?.windows ?? []).find((w) => w.label === "main")!;
      expect(main.decorations, `${file} 应当无边框`).toBe(false);
      expect(main.transparent, `${file} 没开 transparent ⇒ CSS 画的弧只是装饰`).toBe(true);
      const bg = main.backgroundColor as string | undefined;
      // tao 的 WM_ERASEBKGND 只取 RGB、忽略 alpha，所以"写个带 00 的颜色"不算不刷；
      // 必须整条不给，弧外才会真的透出桌面。
      expect(bg, `${file} 还带着 backgroundColor=${bg} ⇒ 四个角会被刷成方色`).toBeUndefined();
    }
  });

  it("macOS 不在覆盖文件里被改成透明无边框（它用原生标题栏 + Overlay）", () => {
    const windows = baseWindow ? [baseWindow] : [];
    for (const w of windows) {
      expect(w.transparent, "基线配置（macOS 走这份）不该开 transparent").toBeUndefined();
      expect(w.decorations, "基线配置不该关原生边框").toBeUndefined();
    }
  });

  // 正向配对：CSS 那侧真的还在"透明 + 画弧"。它一旦被删，上面几条会因为
  // "再没人指望透明窗"而集体假绿。
  it("CSS 仍然按『窗口是透明的』这个前提画圆角", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/globals.css"), "utf-8");
    expect(css).toContain('html[data-chrome="borderless"]');
    expect(css).toMatch(/html\[data-chrome="borderless"\][^{]*\{[^}]*background:\s*transparent/);
    // 半径走 --window-radius（用户 2026-09-24 要求对齐 AI 对话面板的 rounded-2xl），
    // 所以字面值和变量都认 —— 但变量必须真的定义过，删掉定义同样会红。
    expect(css).toMatch(/--window-radius:\s*\d+px/);
    expect(css).toMatch(
      /html\[data-chrome="borderless"\][^{]*#root[^{]*\{[^}]*border-radius:\s*(?:var\(--window-radius\)|\d+px)/,
    );
  });
});
