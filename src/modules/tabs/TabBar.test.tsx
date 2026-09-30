// -----------------------------------------------------------------------------
// #166 ⑨（2026-09-28 用户实测）：「开始界面就不要出现＋号，不然建立的东西
// 这是在哪都不知道，开始界面只有开始窗口」。
//
// 量出来的因果：开始页 `activeSpaceId` 为 null，顶栏画的是 default 空间那一组标签页，
// 而主区域画的是 `<WelcomeScreen>` ⇒ 点 + 建出来的标签页只多出一个 chip，屏幕不变，
// shell 却在后台起了。所以入口按 `hasWorkspace` 收掉（键盘/命令面板那条闸见
// `lib/startScreenGate.ts`）。
//
// 两条互为配对：只留"开始页没有 +"这一条负向判据，`hasWorkspace` 写反或整条菜单
// 没渲染都会让它假绿 —— 必须同时证明有工作区时它确实在。
// -----------------------------------------------------------------------------
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { Tab } from "./lib/useTabs";
import { TabBar } from "./TabBar";

const coldStartTab: Tab = {
  id: 1,
  kind: "terminal",
  spaceId: "default",
  cold: true,
  title: "shell",
  paneTree: { kind: "leaf", id: 2 },
  activeLeafId: 2,
};

function renderBar(hasWorkspace: boolean) {
  const noop = () => {};
  return render(
    <TabBar
      tabs={[coldStartTab]}
      activeId={1}
      onSelect={noop}
      onNew={noop}
      onNewEditor={noop}
      onClose={noop}
      onPin={noop}
      onRename={noop}
      onReorder={noop}
      hasWorkspace={hasWorkspace}
    />,
  );
}

afterEach(cleanup);

describe("TabBar — 开始页不给新建标签页的 + 号", () => {
  it("有活跃工作区时 + 在（正向配对，缺了它下一条会假绿）", () => {
    renderBar(true);
    expect(screen.getByTitle("New tab")).toBeTruthy();
    // 标签页本身照旧画出来
    expect(screen.getByText("开始")).toBeTruthy();
  });

  it("开始页（没有活跃工作区）不画 + 号，但开始这一格还在", () => {
    renderBar(false);
    expect(screen.queryByTitle("New tab")).toBeNull();
    expect(screen.getByText("开始")).toBeTruthy();
  });
});
