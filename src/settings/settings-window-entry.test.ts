/**
 * settings-window-entry.test.ts —— 2026-09-28 装机实测①：点「设置」弹出的窗口画的是欢迎页。
 * -----------------------------------------------------------------------------
 * 根因不在窗口代码里，在**构建配置**里：Rust 用 `WebviewUrl::App("settings.html")` 开设置窗，
 * 而 `vite.config.ts` 只声明了 `index.html` 一个入口 ⇒ 发布构建的 `dist/` 里压根没有
 * `settings.html`，WebView2 落回 SPA 首页，于是设置窗里画着欢迎页。
 * dev 窗看不出来是因为 Vite 开发服务器按路径直接把根目录的 html 给了出去。
 *
 * 这类"一端要产物、另一端没产出"的错编译器与单测都抓不到，所以判据写成两侧的对账：
 * Rust 引用的每个 html，必须能由构建产出（声明为入口，或作为 public/ 静态文件被复制）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const LIB_RS = join(process.cwd(), "src-tauri/src/lib.rs");
const VITE_CONFIG = join(process.cwd(), "vite.config.ts");
const PUBLIC_DIR = join(process.cwd(), "public");
const SETTINGS_HTML = join(process.cwd(), "settings.html");

/** Rust 源码里出现的 `xxx.html` 字面量（去掉行注释，注释里的例子不算引用） */
function htmlFilesReferencedByRust(): string[] {
  const code = readFileSync(LIB_RS, "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return [
    ...new Set(
      [...code.matchAll(/["'`]([\w./-]+\.html)/g)].map(
        (m) => m[1].split("?")[0].replace(/^\//, ""),
      ),
    ),
  ].sort();
}

/** 构建声明的 html 入口（rollupOptions.input 里 resolve(..., 'x.html')） */
function declaredBuildInputs(): string[] {
  const cfg = readFileSync(VITE_CONFIG, "utf8");
  return [...cfg.matchAll(/path\.resolve\([^)]*['"]([\w./-]+\.html)['"]/g)].map(
    (m) => m[1].replace(/^\//, ""),
  );
}

function staticPublicHtml(): string[] {
  if (!existsSync(PUBLIC_DIR)) return [];
  return readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".html"));
}

describe("设置窗的入口文件必须由构建产出", () => {
  it("Rust 确实引用了 settings.html（判据不是靠引用清单为空而通过）", () => {
    expect(htmlFilesReferencedByRust()).toContain("settings.html");
  });

  it("每一个被 Rust 引用的 html 都有产出路径：构建入口或 public/ 静态文件", () => {
    const produced = new Set([...declaredBuildInputs(), ...staticPublicHtml()]);
    const missing = htmlFilesReferencedByRust().filter((f) => !produced.has(f));
    // 报"文件不存在"时顺手指出真实症状：窗口会落回 SPA 首页，而不是白屏
    expect(missing, `这些 html 不会出现在 dist/ 里：${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("settings.html 挂的是设置页自己的入口脚本，不是主窗的 main.tsx", () => {
    const html = readFileSync(SETTINGS_HTML, "utf8");
    expect(html).toContain("src/settings/main.tsx");
    expect(html).not.toMatch(/src\/main\.tsx/);
  });
});
