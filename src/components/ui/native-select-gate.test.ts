/**
 * 界面里不许再有原生 <select> —— #166 ④（2026-09-28 用户实测）
 * -----------------------------------------------------------------------------
 * 用户原话：「选择 wsl 的发行版的抽屉窗口优化一下，改为圆角，不要这种太生硬的选择抽屉」。
 * 生硬的不是圆角数值，是**原生 select 弹的是操作系统画的方角列表**，跟全应用那套
 * 圆角控件（Button rounded-4xl / Select rounded-3xl）根本不是一个东西。
 *
 * 以一次为例横扫：仓里原本两处原生 select —— WSL 发行版、设置页编辑器配色，两处都换成了
 * 同一只 `@/components/ui/select`。这条判据钉住整类，防止以后图省事又写回原生。
 *
 * 匹配口径：`<select` 后必须紧跟空白 / `>` / `/`，所以 `<selection ...>` 这种
 * 出现在正则与模板字符串里的词不会被误伤（AiChat.tsx / composer.tsx 各一处）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsx(full));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/**
 * 注释里解释"为什么不用原生 select"是好事，但不该被横扫当成活缺陷
 * （#159 的漂移闸踩过同一个坑：文本级判断分不清代码与注释）。
 */
const codeOnly = (text: string) =>
  text.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("原生 select 已整类换掉", () => {
  it("src 下不再有 <select 元素", () => {
    const hits: string[] = [];
    for (const file of listTsx(join(process.cwd(), "src"))) {
      const lines = codeOnly(readFileSync(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (/<select[\s>/]/.test(line)) {
          hits.push(`${relative(process.cwd(), file)}:${i + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  /** 正向配对：判据抓得住真实形状（正则写错会让上一条永远绿） */
  it("判据认得元素写法，不误伤 <selection 这种文本", () => {
    expect(/<select[\s>/]/.test('  <select id="a" value={x}>')).toBe(true);
    expect(/<select[\s>/]/.test("  <Select value={x}>")).toBe(false);
    expect(
      /<select[\s>/]/.test('  /<selection\\s+source="(terminal|editor)">/g;'),
    ).toBe(false);
  });
});
