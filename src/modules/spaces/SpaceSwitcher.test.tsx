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
import { useSshStore } from "@/modules/ssh-explorer/sshStore";

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

/**
 * 名字后的小字副标（2026-09-20 用户实测：服务器工作区被标成「本地」，
 * 且 SSH 徽章把 `user@host` 与工作区名抄了两遍）
 * -----------------------------------------------------------------------------
 * 判据：小字说的是"这个工作区现在落在哪儿 / 还需不需要重连"，任何情况下都
 * 不得是工作区名的重复。SSH 行的已连接/未连接必须跟着 sshStore 的真实会话
 * 状态走（判据与 isSessionConnected 一致：connected 且拿到 Rust 句柄）。
 */
/** 打开总览面板（Popover 内容渲染在 portal 里，用 findByText 断言） */
function renderOpen() {
  const noop = () => {};
  return render(
    <SpaceSwitcher
      open
      onOpenChange={noop}
      tabs={[]}
      onNewSpace={noop}
      onDeleteSpace={noop}
      onNewTabInSpace={noop}
      onJumpTab={noop}
      onCloseTab={noop}
      onMoveTabToSpace={noop}
      onReorderTab={noop}
      onReorderSpaces={noop}
    />,
  );
}

describe("SpaceSwitcher — 小字副标不重复工作区名", () => {
  beforeEach(() => {
    useSshStore.setState({ sessions: [] });
  });

  it("SSH 工作区无活会话：显示「SSH · 未连接」，不再显示 user@host", async () => {
    useSpaces.setState({
      spaces: [
        {
          id: "sp-ssh",
          name: "root@10.0.0.8",
          root: "/root",
          env: {
            kind: "ssh",
            host: "10.0.0.8",
            user: "root",
            port: 22,
            sessionId: "sess-gone",
            label: "root@10.0.0.8",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    renderOpen();
    await screen.findByText("root@10.0.0.8");
    expect(await screen.findByText("SSH · 未连接")).toBeTruthy();
    // 名字 + 小字合起来只出现一次标识符
    expect(screen.getAllByText(/10\.0\.0\.8/).length).toBe(1);
  });

  it("SSH 工作区有活会话：显示「SSH · 已连接」", async () => {
    useSshStore.setState({
      sessions: [
        {
          id: "sess-live",
          rustSessionId: 7,
          state: "connected",
        } as never,
      ],
    });
    useSpaces.setState({
      spaces: [
        {
          id: "sp-ssh",
          name: "生产机",
          root: "/srv",
          env: {
            kind: "ssh",
            host: "10.0.0.8",
            user: "root",
            port: 22,
            sessionId: "sess-live",
            label: "生产机",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    renderOpen();
    expect(await screen.findByText("SSH · 已连接")).toBeTruthy();
  });

  it("connected 但没拿到 Rust 句柄：不算已连接（判据同 isSessionConnected）", async () => {
    useSshStore.setState({
      sessions: [{ id: "sess-x", rustSessionId: null, state: "connected" } as never],
    });
    useSpaces.setState({
      spaces: [
        {
          id: "sp-ssh",
          name: "生产机",
          root: null,
          env: {
            kind: "ssh",
            host: "h",
            user: "u",
            port: 22,
            sessionId: "sess-x",
            label: "生产机",
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    renderOpen();
    expect(await screen.findByText("SSH · 未连接")).toBeTruthy();
  });

  it("本地工作区名即目录名：小字只写「本地」，不重复目录名", async () => {
    useSpaces.setState({
      spaces: [{ ...spaceA, name: "a", root: "D:/proj/a" }],
    });
    renderOpen();
    expect(await screen.findByText("本地")).toBeTruthy();
    expect(screen.queryByText(/本地 · /)).toBeNull();
  });

  it("本地工作区名与目录不重合：小字给出目录末段作为落点", async () => {
    useSpaces.setState({
      spaces: [{ ...spaceA, name: "我的项目", root: "D:/proj/api" }],
    });
    renderOpen();
    expect(await screen.findByText("本地 · api")).toBeTruthy();
  });
});
