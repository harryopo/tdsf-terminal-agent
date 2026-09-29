// #166 真机看图轮：侧栏底部那一排的标签必须整词看得见。
//
// 现场（252px 侧栏）：图标 14 + 间距 6 + 「文件」25 = 45px，一格只有 36px
// ⇒ **六个标签每个都被切剩一个字**，屏幕上是一排看不懂的半截词。
// 上一手知道它长，处理方式却是给那一行挂 `data-allow-truncate`，
// 让真机 UI 探针别看这里 —— 缺陷被登记成了"设计意图"。
//
// 所以这里钉三件事：① 不许再出现裁切类名；② 全仓不许再有裁切豁免；
// ③ 正向配对 —— 六个入口都还在、全名还在 aria-label 上（缩字不许缩信息，
//    也不许靠"把整排删了"来通过前两条）。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const RAIL = join(process.cwd(), "src/modules/sidebar/SidebarRail.tsx");

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function listFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, out);
    // 排除测试文件：本文件自己就要写出这个词才能挡住它（否则判据抓到的是自己）
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(full);
  }
  return out;
}

describe("#166 侧栏那一排的标签不许被切", () => {
  const src = codeOnly(readFileSync(RAIL, "utf8"));

  it("rail 里不许有 truncate / whitespace-nowrap（那是在藏裁切，不是解决裁切）", () => {
    expect(src).not.toMatch(/\btruncate\b/);
    expect(src).not.toMatch(/whitespace-nowrap/);
  });

  it("全仓不许再有 data-allow-truncate（探针的豁免口子已经拆了）", () => {
    const hits: string[] = [];
    for (const file of listFiles(join(process.cwd(), "src"))) {
      if (codeOnly(readFileSync(file, "utf8")).includes("data-allow-truncate")) {
        hits.push(relative(process.cwd(), file));
      }
    }
    expect(hits).toEqual([]);
  });

  it("正向配对：六个入口都在，全名挂在 aria-label 与 title 上", () => {
    for (const id of [
      "explorer",
      "source-control",
      "skills",
      "knowledge",
      "snippets",
      "tunnels",
    ]) {
      expect(src, `侧栏少了 ${id} 入口`).toContain(`id: "${id}"`);
    }
    expect(src).toContain('fullLabel: "源代码管理"');
    expect(src).toContain("aria-label={item.fullLabel}");
    expect(src).toContain("title={item.fullLabel}");
    // 界面上那两个字必须短到一格装得下（两个字 ≤ 2 字符）
    // 前置断言：`(?<![A-Za-z])` 是必需的 —— 少了它 `fullLabel: "…"` 里的
    // `label: "` 也会被匹配上，数量立刻翻倍，判据就成了假的。
    const labels = [...src.matchAll(/(?<![A-Za-z])label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels.length).toBe(6);
    for (const l of labels) expect(l.length, `「${l}」在 36px 一格里装不下`).toBeLessThanOrEqual(2);
  });
});
