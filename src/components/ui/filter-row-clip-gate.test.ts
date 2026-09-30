// #166 真机看图轮：窄侧栏里的筛选标签行不许把选项甩到屏幕外。
//
// 为什么这条只能静态判：happy-dom 不做布局，`getBoundingClientRect()` 全是 0，
// "被裁掉 103px"这种事在单测里量不出来 —— 真机读数在 `outputs/measure_chip_row_clip.py`
// （它从 data-testid 反查父行，所以改样式也认得路；变异回旧写法当场报 3 个标签被裁）。
// 这里挡的是"以后有人为了省垂直空间又把它改回不换行 + 横向滚"。
//
// 两条负向必须配正向：把整行删掉同样"没有裁切"，所以还要断言标签行和它的 testid 都还在。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 去掉注释再匹配：文本级扫描分不清代码和说明文字（#159 那条教训，本仓已犯三次）。 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SITES = [
  { name: "技能面板", file: "src/modules/skills/SkillsPanel.tsx", testid: "skills-tab-" },
  { name: "片段面板", file: "src/modules/snippets/SnippetsPanel.tsx", testid: "snippets-tab-" },
] as const;

describe("#166 筛选标签行必须换行，不许横向滚掉选项", () => {
  for (const site of SITES) {
    it(`${site.name}：标签行换行，且没有横向滚动`, () => {
      const src = codeOnly(readFileSync(join(process.cwd(), site.file), "utf8"));
      // 标签行 = 承载这些 testid 的那个 div；从 testid 反查，不靠样式认路
      const idx = src.indexOf(site.testid);
      expect(idx, `${site.name} 里找不到 ${site.testid} —— 标签行被删了？`).toBeGreaterThan(-1);
      const start = src.lastIndexOf("<div", idx);
      const row = src.slice(start, start + 320);
      expect(row).toContain("flex-wrap");
      expect(row).not.toContain("overflow-x-auto");
    });
  }

  it("正向配对：标签确实是 button、行还在渲染（负向断言不许靠「东西没了」通过）", () => {
    for (const site of SITES) {
      const src = codeOnly(readFileSync(join(process.cwd(), site.file), "utf8"));
      expect(src).toContain(`data-testid={\`${site.testid}`);
    }
  });
});
