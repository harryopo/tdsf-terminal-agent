/**
 * closeTab 会回收这个标签页独占的 SSH 会话（#89 的连带账）。
 *
 * 单独测纯函数 `orphanedSshSessions` 只能证明"算得对"，证明不了"关标签页时真的调了
 * disconnect" —— 而后者才是用户可感的行为（不回收就是攒连接，MaxSessions 小的服务器
 * 会被自己的历史标签页挡在门外）。这条用例盯的就是接线。
 *
 * 每条用例都在工作区里先铺一个**留存的本地标签页**：closeTab 在"这个工作区只剩一条
 * 标签页"时会早退（不许把工作区清空），那样 disconnect 断言会因为"压根没关成"而假绿。
 * 所以三条用例都额外断言标签页真的从列表里消失了。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import { useTabs } from "./useTabs";

const sshSpace: SpaceMeta = {
  id: "sp-ssh",
  name: "服务器",
  root: null,
  env: {
    kind: "ssh",
    host: "10.0.0.8",
    user: "root",
    port: 22,
    sessionId: "s-space",
    label: "root@10.0.0.8",
  },
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  useSpaces.setState({
    spaces: [sshSpace],
    activeId: "sp-ssh",
    hydrated: true,
  });
  useSshStore.setState({
    sessions: [
      { id: "s-space", rustSessionId: 1, state: "connected" },
      { id: "s-tab2", rustSessionId: 2, state: "connected" },
    ] as never,
    activeSessionId: "s-tab2",
  });
});

/** 找到绑定了指定会话的 terminal tab id（act() 不透传返回值，只能从 state 里取）。 */
function tabIdOf(tabs: ReturnType<typeof useTabs>["tabs"], sessionId: string): number | null {
  const hit = tabs.find((t) => t.kind === "terminal" && t.sshSessionId === sessionId);
  return hit ? hit.id : null;
}

/** 换掉 sshStore 的 disconnect，返回 spy。 */
function spyOnDisconnect() {
  const disconnect = vi.fn(async (_sessionId: string) => {});
  useSshStore.setState({ disconnect } as never);
  return disconnect;
}

/**
 * 在 SSH 工作区里起一个 hook。
 *
 * 新标签页落在哪个工作区由调用方显式指定（App 切工作区时调 setActiveSpaceForNewTabs），
 * hook 内部 ref 的默认值是 "default"。不显式指定就会落在一个注册表里查不到的工作区上，
 * 下面第二条用例的"工作区主会话保护"规则根本没有机会生效。
 */
function renderInSshSpace() {
  const { result } = renderHook(() => useTabs());
  act(() => result.current.setActiveSpaceForNewTabs("sp-ssh"));
  // 留存标签页：保证被测标签页关掉后工作区还剩一条，closeTab 不会早退
  act(() => {
    result.current.newTab(undefined, { sshSessionId: null });
  });
  return { result };
}

describe("closeTab 回收独占会话", () => {
  it("关掉绑着独占会话的标签页 → disconnect 被调用", () => {
    const disconnect = spyOnDisconnect();

    const { result } = renderInSshSpace();
    // act() 不透传返回值，标签页 id 从结果里取
    act(() => {
      result.current.newTab(undefined, { sshSessionId: "s-tab2" });
    });
    const tabId = tabIdOf(result.current.tabs, "s-tab2");
    expect(tabId).not.toBeNull();
    expect(disconnect).not.toHaveBeenCalled();

    act(() => {
      result.current.closeTab(tabId!);
    });
    expect(result.current.tabs.some((t) => t.id === tabId)).toBe(false);
    expect(disconnect.mock.calls.map((c) => c[0])).toEqual(["s-tab2"]);
  });

  it("关掉的正是工作区主会话所在标签页 → 不断开（它是重连锚点）", () => {
    const disconnect = spyOnDisconnect();

    const { result } = renderInSshSpace();
    act(() => {
      result.current.newTab(undefined, { sshSessionId: "s-space" });
    });
    const tabId = tabIdOf(result.current.tabs, "s-space");
    expect(tabId).not.toBeNull();

    act(() => {
      result.current.closeTab(tabId!);
    });
    // 真的关掉了（不是早退），但那条会话留着
    expect(result.current.tabs.some((t) => t.id === tabId)).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("同一条会话还被别的标签页用着 → 不断开", () => {
    const disconnect = spyOnDisconnect();

    const { result } = renderInSshSpace();
    act(() => {
      result.current.newTab(undefined, { sshSessionId: "s-tab2" });
    });
    act(() => {
      result.current.newTab(undefined, { sshSessionId: "s-tab2" });
    });
    const ids = result.current.tabs
      .filter((t) => t.kind === "terminal" && t.sshSessionId === "s-tab2")
      .map((t) => t.id);
    expect(ids).toHaveLength(2);

    act(() => {
      result.current.closeTab(ids[0]);
    });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("本地标签页（没绑会话）关掉 → 不碰任何 SSH 会话", () => {
    const disconnect = spyOnDisconnect();

    const { result } = renderInSshSpace();
    act(() => {
      result.current.newTab(undefined, { sshSessionId: null });
    });
    // 工作区里有两条本地标签页：铺的那条留着，关掉刚建的那条
    const locals = result.current.tabs.filter(
      (t) => t.kind === "terminal" && !t.sshSessionId && t.cold !== true,
    );
    expect(locals).toHaveLength(2);
    const victim = locals[1].id;

    act(() => {
      result.current.closeTab(victim);
    });
    expect(result.current.tabs.some((t) => t.id === victim)).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });
});
