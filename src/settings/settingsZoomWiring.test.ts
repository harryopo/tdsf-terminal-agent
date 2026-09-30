// 设置窗必须跟主窗用同一个「界面缩放」主人。
//
// 缺陷现场（#166 看图轮续，2026-09-29 真机对账 `outputs/measure_zoom_per_window.py`）：
// 主窗 `--app-zoom: 1.05`、`.zoom-content` 实际 zoom 1.05；设置窗 `--app-zoom: 1`、
// 连 `.zoom-content` 都没有 —— 而**「界面缩放 · 当前 105%。调整后立即生效。」这句话就写在设置窗里**。
// 一句话所在的窗自己没在生效（#123/#127 那一族：界面说了一件没发生的事）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(p);
  }
  return out;
}

const settings = readFileSync(
  join(process.cwd(), "src/settings/SettingsApp.tsx"),
  "utf8",
);
const app = readFileSync(join(process.cwd(), "src/app/App.tsx"), "utf8");

describe("设置窗接上界面缩放", () => {
  it("设置窗调用同一个主人 lib/useZoom.ts（不许再写第二份 applyToDom）", () => {
    expect(settings).toContain('from "@/lib/useZoom"');
    expect(settings).toMatch(/useZoom\(\)/);
  });

  it("全仓只有一个文件写 `--app-zoom`（注释不算代码 —— 文本级判断分不清两者）", () => {
    const writers: string[] = [];
    for (const rel of walk(join(process.cwd(), "src"))) {
      const code = readFileSync(rel, "utf8")
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, ""))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      if (code.includes('"--app-zoom"') || code.includes("'--app-zoom'")) {
        writers.push(relative(process.cwd(), rel));
      }
    }
    expect(writers).toEqual([join("src", "lib", "useZoom.ts")]);
  });

  it("内容层挂 .zoom-content，与主窗同一口径（顶栏/标签条不缩）", () => {
    expect(settings).toMatch(/<main className="zoom-content/);
    // 正向配对：主窗那条口径必须还在，否则这条判据是在跟一个不存在的东西对齐
    expect(app).toMatch(/<main className="zoom-content/);
  });
});
