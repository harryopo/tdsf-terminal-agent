// 侧栏面板工具栏标题：一律中文、不加大写转换，且与轨道那一格的全名说同一句话。
//
// 缺陷现场（#166 真机看图轮，2026-09-29 横扫六格）：切到「隧道」那一格，
// 面板顶部写着英文 `TUNNELS`（原文 "Tunnels" + `uppercase`），而下面整片界面、
// 以及左边轨道上的字都是中文 —— 用户点了「SSH 隧道」进来却看到另一个名字。
// ⑦ 那轮已经中文化过「技能管理」「代码片段」，这一格是漏掉的第三格，
// 所以这条不写"隧道必须叫 SSH 隧道"，写成**整类**的闸：以后加第四格也过同一张表。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 工具栏标题那只 span 的形状（三格面板共用，见下方正向配对断言） */
const TITLE_RE =
  /<span className="([^"]*flex-1 truncate text-\[12px\] font-medium[^"]*tracking-wide[^"]*)">([\s\S]*?)<\/span>/g;

const CJK = /[\u4e00-\u9fff]/;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsxFiles(p));
    } else if (name.endsWith(".tsx") && !name.includes(".test.")) {
      out.push(p);
    }
  }
  return out;
}

type TitleHit = { file: string; className: string; text: string };

function collectTitles(): TitleHit[] {
  const hits: TitleHit[] = [];
  for (const file of tsxFiles(join(process.cwd(), "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(TITLE_RE)) {
      hits.push({
        file,
        className: m[1],
        // JSX 里的注释与表达式不进标题文本；留着会让判据把注释里的英文字算进去
        text: m[2]
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
          .replace(/\{[^}]*\}/g, "")
          .trim(),
      });
    }
  }
  return hits;
}

describe("侧栏面板工具栏标题（整类闸）", () => {
  const hits = collectTitles();

  it("正向配对：这条判据量的确实存在（三格面板各一处），不是靠消失而通过", () => {
    expect(hits.length).toBeGreaterThanOrEqual(3);
    // 每一处都必须真读到标题文字，读不到=判据空转
    for (const h of hits) expect(h.text.length).toBeGreaterThan(0);
  });

  it("标题不带 uppercase：中文没有大小写，只会把夹带的拉丁字母变成大写喊话", () => {
    for (const h of hits) {
      expect(
        h.className.includes("uppercase"),
        `${h.file} 的标题带 uppercase`,
      ).toBe(false);
    }
  });

  it("标题含中文：侧栏界面不许出现纯英文分区名", () => {
    for (const h of hits) {
      expect(CJK.test(h.text), `${h.file} 的标题是「${h.text}」`).toBe(true);
    }
  });
});

describe("轨道全名与面板标题一致（点了才认得出对应关系）", () => {
  // 真源 = SidebarRail 的 items：轨道那一格悬停/读屏拿到的全名
  const rail = readFileSync(
    join(process.cwd(), "src/modules/sidebar/SidebarRail.tsx"),
    "utf8",
  );
  const labels = new Map<string, string>();
  for (const m of rail.matchAll(
    /id:\s*"([a-z-]+)"[^{}]*?fullLabel:\s*"([^"]+)"/g,
  )) {
    labels.set(m[1], m[2]);
  }

  it("正向配对：六格轨道都解析出全名", () => {
    expect([...labels.keys()].sort()).toEqual([
      "explorer",
      "knowledge",
      "skills",
      "snippets",
      "source-control",
      "tunnels",
    ]);
  });

  it("有工具栏标题的面板，标题就是轨道那一格的全名", () => {
    // 只比对确实有工具栏标题的那几格（源代码管理面板与文件树没有标题栏）
    const all = collectTitles();
    for (const [rel, viewId] of [
      [join("src", "modules", "skills", "SkillsPanel.tsx"), "skills"],
      [join("src", "modules", "snippets", "SnippetsPanel.tsx"), "snippets"],
      [join("src", "modules", "tunnels", "TunnelPanel.tsx"), "tunnels"],
    ] as const) {
      const expected = labels.get(viewId);
      expect(expected, `轨道里没有 ${viewId}`).toBeTruthy();
      const mine = all.filter((h) => h.file.endsWith(rel));
      // 正向配对：这一格必须真量到一处标题，量到 0 处等于这条判据没跑
      expect(mine.length, `${viewId} 面板没解析出工具栏标题`).toBe(1);
      expect(mine[0].text).toBe(expected);
    }
  });
});
