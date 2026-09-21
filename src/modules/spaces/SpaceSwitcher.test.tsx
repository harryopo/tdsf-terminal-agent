/**
 * SpaceSwitcher.test.tsx — 顶栏工作区触发器在「有注册表但未进入任何工作区」时必须存在
 * -----------------------------------------------------------------------------
 * 背景（2026-09-18 真机复验 #61-A 时抓到的缺口）：启动不再自动进入工作区
 * （activeId 恒为 null），而旧实现是 `if (!current) return null` —— 顶栏触发器
 * 整个不渲染，于是"留存注册表"在 UI 上没有任何入口，用户只能重复新建。
 * 现在：只要注册表非空就渲染触发器，文案「选择工作区」。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { Tab } from "@/modules/tabs";
import { SpaceSwitcher } from "./SpaceSwitcher";
import type { SpaceMeta } from "./lib/store";
import { useSpaces } from "./lib/useSpaces";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";

// 本文件用 SpaceSwitcher 会连带加载 spaces store（@tauri-apps/plugin-store）。
// jsdom 里没有 Tauri 运行时，任何真写盘都会变成未处理拒绝把整个 run 弄脏。
// （setActive 的用例尤其如此：它落盘 activeId。）
vi.mock("./lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/store")>();
  return {
    ...actual,
    saveActiveId: vi.fn(async () => {}),
    saveSpacesList: vi.fn(async () => {}),
  };
});

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
function renderOpen(tabs: Tab[] = []) {
  const noop = () => {};
  return render(
    <SpaceSwitcher
      open
      onOpenChange={noop}
      tabs={tabs}
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

/**
 * 标签页那一行的小字 = **实时**落点（2026-09-21 用户实测：「工作区下拉的终端的地址
 * 不会自动更新，第二个 shell 在 /usr/bin，下拉里不显示」）
 * -----------------------------------------------------------------------------
 * 旧实现读 `tab.cwd`，那是建 tab 那一刻的快照、之后没人再写，所以永远停在初始目录。
 * 判据（口径与状态栏/资源管理器一致）：
 * - SSH 跟**这个 tab 自己那条会话**的 OSC7 路径（#89 之后一 tab 一条会话）；
 * - 本地跟可见 leaf 的 cwd；
 * - 拿不到就不写（宁缺勿撒谎）。
 * tab 行只在展开的工作区里渲染，所以三个用例都把工作区设为 activeId。
 */
function sshSpaceMeta(sessionId: string): SpaceMeta {
  return {
    id: "sp-ssh",
    name: "生产机",
    root: "/root",
    env: {
      kind: "ssh",
      host: "10.0.0.8",
      user: "root",
      port: 22,
      sessionId,
      label: "生产机",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 终端 tab：`cwd` 故意留成建 tab 时的旧快照，用来证明小字不再读它 */
function termTab(
  id: number,
  spaceId: string,
  sshSessionId: string | null,
  leafCwd?: string,
): Tab {
  return {
    id,
    kind: "terminal",
    spaceId,
    title: "shell",
    customTitle: `shell-${id}`,
    cwd: "/old-snapshot",
    sshSessionId,
    paneTree: { kind: "leaf", id: id * 10, cwd: leafCwd },
    activeLeafId: id * 10,
  } as Tab;
}

describe("SpaceSwitcher — 标签页小字跟随实时地址", () => {
  beforeEach(() => {
    useSshStore.setState({ sessions: [], currentPathBySession: {} });
  });

  it("SSH：每个 tab 读自己那条会话的路径，不是 tab.cwd", async () => {
    useSpaces.setState({
      spaces: [sshSpaceMeta("s-a")],
      activeId: "sp-ssh",
    });
    useSshStore.setState({
      currentPathBySession: { "s-a": "/root", "s-b": "/usr/bin" },
    });
    renderOpen([
      termTab(1, "sp-ssh", "s-a"),
      termTab(2, "sp-ssh", "s-b"),
    ]);
    // 两条 tab 各自的小字（旧实现会两行都写成 /old-snapshot → 这里取到的就是快照）
    expect(await screen.findByText("root")).toBeTruthy();
    expect(screen.getByText("usr/bin")).toBeTruthy();
    expect(screen.queryByText("old-snapshot")).toBeNull();
  });

  it("SSH：会话路径变了，已打开的面板立刻跟着改（不需要重开）", async () => {
    useSpaces.setState({
      spaces: [sshSpaceMeta("s-a")],
      activeId: "sp-ssh",
    });
    useSshStore.setState({ currentPathBySession: { "s-b": "/var/log" } });
    renderOpen([termTab(2, "sp-ssh", "s-b")]);
    expect(await screen.findByText("var/log")).toBeTruthy();

    // 用户在 tab2 里 cd：store 一写，小字就得跟着换。这是「不会自动更新」的正身。
    act(() => {
      useSshStore.setState({ currentPathBySession: { "s-b": "/etc/nginx" } });
    });
    expect(screen.getByText("etc/nginx")).toBeTruthy();
    expect(screen.queryByText("var/log")).toBeNull();
  });

  it("本地：小字读可见 leaf 的 cwd，不是 tab.cwd", async () => {
    useSpaces.setState({ spaces: [spaceA], activeId: "sp-a" });
    renderOpen([termTab(3, "sp-a", null, "/projects/api")]);
    expect(await screen.findByText("projects/api")).toBeTruthy();
    expect(screen.queryByText("old-snapshot")).toBeNull();
  });

  it("会话还没记录路径：宁可不写，也不拿别处的地址冒充", async () => {
    useSpaces.setState({
      spaces: [sshSpaceMeta("s-a")],
      activeId: "sp-ssh",
    });
    // 正向配对：同一次渲染里 s-b 有路径 → 它的小字确实出来了，证明 tab 行在渲染，
    // 下面那条「没有小字」不是因为整块没渲染而假绿。
    useSshStore.setState({ currentPathBySession: { "s-b": "/usr/bin" } });
    renderOpen([
      termTab(4, "sp-ssh", "s-pending"),
      termTab(5, "sp-ssh", "s-b"),
    ]);
    expect(await screen.findByText("usr/bin")).toBeTruthy();
    expect(screen.getByText("shell-4")).toBeTruthy();
    expect(screen.queryByText("old-snapshot")).toBeNull();
  });
});

// ============================================================================
// #103（2026-09-21 用户钦定"在工作区哪里新添一个回到主页的小选项"）
// ----------------------------------------------------------------------------
// 顶栏那个 × 是真退出（Rust 侧没有 close→hide），所以"回到工作区选择页"必须
// 有入口。口径：**纯换视图** —— 只把 activeId 置空，标签页/连接一律不动。
// 负向断言（不碰 spaces）必须配正向断言（activeId 真的清空了），否则"什么都没发生"
// 也会让它假绿。
// ============================================================================
describe("SpaceSwitcher — 回到工作区选择页", () => {
  it("点「回到工作区选择页」：activeId 清空、工作区与标签页都还在、面板关闭", async () => {
    const onOpenChange = vi.fn();
    useSpaces.setState({ spaces: [spaceA], activeId: "sp-a" });
    const tab: Tab = {
      id: 7,
      kind: "terminal",
      spaceId: "sp-a",
      title: "shell",
      customTitle: "shell-7",
      cwd: "/root",
      sshSessionId: null,
      paneTree: { kind: "leaf", id: 70, cwd: "/root" },
      activeLeafId: 70,
    } as unknown as Tab;
    render(
      <SpaceSwitcher
        open
        onOpenChange={onOpenChange}
        tabs={[tab]}
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
    fireEvent.click(await screen.findByTestId("space-switcher-home"));
    expect(useSpaces.getState().activeId).toBeNull();
    // 配对正向断言：这是"只换视图"，工作区注册表不许被清掉
    expect(useSpaces.getState().spaces.map((s) => s.id)).toEqual(["sp-a"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
