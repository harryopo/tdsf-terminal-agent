/**
 * SpaceSwitcher.test.tsx — 顶栏工作区触发器在「有注册表但未进入任何工作区」时必须存在
 * -----------------------------------------------------------------------------
 * 背景（2026-09-18 真机复验 #61-A 时抓到的缺口）：启动不再自动进入工作区
 * （activeId 恒为 null），而旧实现是 `if (!current) return null` —— 顶栏触发器
 * 整个不渲染，于是"留存注册表"在 UI 上没有任何入口，用户只能重复新建。
 * 现在：只要注册表非空就渲染触发器，文案「选择工作区」。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { SpaceSwitcher } from "./SpaceSwitcher";
import type { SpaceMeta } from "./lib/store";
import { useSpaces } from "./lib/useSpaces";

const spaceA: SpaceMeta = {
  id: "sp-a",
  name: "工作区甲",
  root: "D:/a",
  env: { kind: "local" },
  createdAt: 1,
  updatedAt: 1,
};

function renderSwitcher() {
  return render(
    <SpaceSwitcher
      open={false}
      onOpenChange={() => {}}
      tabs={[]}
      onNewSpace={() => {}}
      onDeleteSpace={() => {}}
      onNewTabInSpace={() => {}}
      onJumpTab={() => {}}
      onCloseTab={() => {}}
      onMoveTabToSpace={() => {}}
      onReorderTab={() => {}}
      onReorderSpaces={() => {}}
    />,
  );
}

beforeEach(() => {
  useSpaces.setState({
    spaces: [],
    activeId: null,
    hydrated: true,
    initialActiveIndex: {},
  });
});

describe("SpaceSwitcher — 未选择工作区时的可达性", () => {
  it("注册表非空但 activeId=null：触发器仍渲染，文案为「选择工作区」", () => {
    useSpaces.setState({ spaces: [spaceA] });
    renderSwitcher();
    const trigger = screen.getByTestId("space-trigger");
    expect(trigger.textContent).toContain("选择工作区");
  });

  it("弹总览时列出历史工作区（且不会顺手把 activeId 改掉）", async () => {
    useSpaces.setState({ spaces: [spaceA] });
    const noop = () => {};
    const props: ComponentProps<typeof SpaceSwitcher> = {
      open: false,
      onOpenChange: noop,
      tabs: [],
      onNewSpace: noop,
      onDeleteSpace: noop,
      onNewTabInSpace: noop,
      onJumpTab: noop,
      onCloseTab: noop,
      onMoveTabToSpace: noop,
      onReorderTab: noop,
      onReorderSpaces: noop,
    };
    const { rerender } = render(<SpaceSwitcher {...props} />);
    rerender(<SpaceSwitcher {...props} open />);
    await screen.findByText("工作区甲");
    expect(useSpaces.getState().activeId).toBeNull();
  });

  it("注册表为空（真的是零个工作区）：不渲染触发器", () => {
    const { container } = renderSwitcher();
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("space-trigger")).toBeNull();
  });

  it("已有活跃工作区：触发器显示当前工作区名（原行为不回退）", () => {
    useSpaces.setState({ spaces: [spaceA], activeId: "sp-a" });
    renderSwitcher();
    expect(screen.getByTestId("space-trigger").textContent).toContain(
      "工作区甲",
    );
  });
});
