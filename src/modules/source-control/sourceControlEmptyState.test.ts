// 源代码管理面板的空态文案：先答"有没有工作区可谈"，再答"是不是仓库"。
//
// 缺陷现场（#166 真机看图轮，开始页切到「源码」那一格）：屏幕上写着
// 「非 Git 仓库 / 当前工作区不在 Git 仓库内。」，而此刻 `activeId` 是 null ——
// **根本没有工作区**，这句话断言了一个不存在的对象的属性（#127 / #123 同族）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceControlEmptyCopy } from "./lib/sourceControlEmptyState";

describe("sourceControlEmptyCopy — 空态要说真话", () => {
  it("没有活跃工作区时，不许说「当前工作区不在 Git 仓库内」", () => {
    const copy = sourceControlEmptyCopy(false);
    expect(copy.body).not.toContain("当前工作区");
    expect(copy.title).toContain("还没有进入工作区");
    // 还要给出路，不能只否定
    expect(copy.body).toContain("选择工作区");
  });

  it("配对：确实进了工作区但不是仓库时，才说「非 Git 仓库」", () => {
    const copy = sourceControlEmptyCopy(true);
    expect(copy.title).toBe("非 Git 仓库");
    expect(copy.body).toContain("当前工作区");
    // 两档必须真的不一样：只写一档、另一档复用，等于这条判据没立
    expect(copy.body).not.toBe(sourceControlEmptyCopy(false).body);
  });
});

describe("接线：面板真的按这条口径说话（实现了没接上等于没有）", () => {
  const panel = readFileSync(
    join(process.cwd(), "src/modules/source-control/SourceControlPanel.tsx"),
    "utf8",
  );
  const app = readFileSync(join(process.cwd(), "src/app/App.tsx"), "utf8");

  it("面板 import 并调用唯一主人，且把 hasWorkspace 传进来", () => {
    expect(panel).toContain("sourceControlEmptyCopy");
    expect(panel).toMatch(/hasWorkspace/);
  });

  it("面板没有活跃工作区时整格早退（分支名与变更列表都不许画出来）", () => {
    // 早退必须在读 scm 之前：面板那时量的是回退路径，
    // 只把空态文案换掉而留着分支/提交图/领先落后，等于半个假事实还挂在屏上。
    const early = panel.indexOf("if (!hasWorkspace)");
    expect(early).toBeGreaterThan(-1);
    const header = panel.indexOf("<BranchDropdown");
    expect(header).toBeGreaterThan(early);
  });

  it("App 把 hasWorkspace 传给面板（不是又写一份 !!activeSpace）", () => {
    expect(app).toMatch(
      /<SourceControlPanel[\s\S]{0,400}hasWorkspace=\{hasWorkspace\}/,
    );
  });

  it("轨道角标也过同一张闸：没有工作区时不报变更数", () => {
    // #127 那张"展示层四臂"表漏的第五臂 —— 角标数的是回退路径的变更
    expect(app).toMatch(
      /changedCount=\{hasWorkspace \? sourceControl\.changedCount : 0\}/,
    );
  });
});
