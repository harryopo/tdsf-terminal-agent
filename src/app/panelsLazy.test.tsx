/**
 * `panelsLazy.tsx` 的行为配对：懒加载边界**真的能通向能用的界面**。
 *
 * 为什么单独要这一条：`eager-budget.test.ts` 那两条钉的是"图在哪"（静态分析），
 * 它抓不到"改完懒加载之后，用户点开侧栏那一格其实什么都渲染不出来"。
 * 懒边界最容易坏的地方恰恰是运行时那一下 —— 动态 import 的导出名写错、
 * 面板默认导出/具名导出对不上，静态图全都看不出来。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SkillsPanelLazy,
  SnippetsPanelLazy,
  TunnelPanelLazy,
} from "./panelsLazy";

describe("#94 §6-B 懒包装仍然渲染得出真面板", () => {
  // 认面板根节点的 data-testid，不认文案（文案会改，判据不该跟着漂）。
  // 超时给到 5 秒：单跑 0.3 秒就过，全量套件并发时动态 import 的 resolve 会被排到后面 ——
  // 第一版用默认 1 秒，在全量里偶发红（判据自己 flakes 就等于给下一手留了个"可以忽略的红"）。
  const waitFor = { timeout: 5000, interval: 50 };

  it("技能面板：动态 import 之后渲染出来", async () => {
    render(<SkillsPanelLazy />);
    expect(await screen.findByTestId("skills-panel", {}, waitFor)).toBeTruthy();
  });

  it("片段面板：动态 import 之后渲染出来", async () => {
    render(<SnippetsPanelLazy onInsertCommand={() => true} />);
    expect(await screen.findByTestId("snippets-panel", {}, waitFor)).toBeTruthy();
  });

  it("隧道面板：动态 import 之后渲染出来", async () => {
    render(<TunnelPanelLazy />);
    expect(await screen.findByTestId("tunnel-panel", {}, waitFor)).toBeTruthy();
  });
});
