// #166 ⑦ 剩下的那一半：「光标选中做的也很丑，有重叠」。
//
// 先量再改：两个面板里 61 + 99 个文本叶子做两两矩形求交（排除祖先/后代），
// **重叠 0 处** ⇒ "重叠"不是布局压字。真正的机制在别处：
// 全站以前**根本没有 `::selection`**，拖选时落在 WebView2 的系统默认高亮上 ——
// 深色主题里那层半透明蓝压在 `bg-primary/10` 的标签与卡片底色上，
// 看着就是"两块颜色互相叠住"。真机读数（outputs/check_selection_style.py）：
// 改后 `::selection` 解析成 rgb(144,144,144) / rgb(26,26,26) = 主题的 primary / primary-foreground。
//
// 这条判据挡的是"以后又有人把 ::selection 删掉或改成第三种选中色"。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(process.cwd(), "src", "styles", "globals.css"), "utf8");

describe("#166 ⑦ 选中态用主题那一对 token，不用浏览器默认高亮", () => {
  it("globals.css 里有显式 ::selection，且底色与文字色都取主题变量", () => {
    const rule = CSS.match(/::selection\s*\{([^}]*)\}/);
    expect(rule, "找不到 ::selection 规则（删掉了？那深色主题又会长回系统默认那层蓝）").toBeTruthy();
    expect(rule![1]).toContain("background: var(--primary)");
    expect(rule![1]).toContain("color: var(--primary-foreground)");
  });

  it("正向配对：全站默认不可选、靠白名单开选区 —— 所以这条规则只在真能选中的地方生效", () => {
    expect(CSS).toMatch(/body\s*\{[^}]*user-select:\s*none/);
    expect(CSS).toMatch(/\.select-text[^{]*\{[^}]*user-select:\s*text/);
    // 界面里确实有挂了 .select-text 的地方（否则这条 ::selection 就是死样式）
    const msg = readFileSync(
      join(process.cwd(), "src/components/ai-elements/message.tsx"),
      "utf8",
    );
    expect(msg).toContain("select-text");
  });
});
