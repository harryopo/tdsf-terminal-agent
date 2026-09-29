// #166 真机看图轮：顶栏是全 app 每一屏都在的位置，占位符不许留着英文单词。
//
// 用户报的 ⑦ 是「面板里夹英文」，量完发现最显眼的那一处不在面板而在顶栏 ——
// 屏幕上写着 "Search"，旁边每一个词都是中文。
//
// 判据读源码而不是渲染：SearchInline 要真拿到 target/addon 才能挂载，
// 为一个文案去搭整套终端夹具不划算；这里挡的是"改回英文 / 把标签删掉"。
// 所以负向（不许出现英文标签）配了正向（中文标签必须还在），
// 免得整行被删也报"没有英文了"。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SRC = codeOnly(
  readFileSync(join(process.cwd(), "src", "modules", "header", "SearchInline.tsx"), "utf8"),
);

describe("#166 顶栏搜索框的界面文字是中文", () => {
  it("不许再出现英文的 Search / Git search / Clear search 标签", () => {
    expect(SRC).not.toMatch(/"Search"/);
    expect(SRC).not.toMatch(/"Git search"/);
    expect(SRC).not.toMatch(/aria-label="Clear search"/);
  });

  it("正向配对：中文标签确实挂在 placeholder 与 aria-label 上", () => {
    expect(SRC).toMatch(/const baseLabel = target\?\.kind === "git-history" \? "搜索提交记录" : "搜索";/);
    expect(SRC).toMatch(/placeholder=\{placeholder\}/);
    expect(SRC).toMatch(/aria-label=\{tooltipTitle\}/);
    expect(SRC).toMatch(/aria-label="清空搜索"/);
  });
});
