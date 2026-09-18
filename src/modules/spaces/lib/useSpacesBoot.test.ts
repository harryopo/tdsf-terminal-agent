/**
 * useSpacesBoot.test.ts — 启动引导：注册表留存 + 不自动进入（ROADMAP #61 方案 A）
 * -----------------------------------------------------------------------------
 * 钉住用户 2026-09-18 的决策：
 *  - 持久化的工作区清单要读回来（旧实现 `hydrate([], null)` 会让第一次新建
 *    整键覆盖掉上一轮的注册表，历史 workspace 作用域会话从此在列表里消失）；
 *  - 但 activeId 必须为 null —— 首屏仍是欢迎页，也不带上一次的幽灵 SSH sessionId；
 *  - 于是"新建"是追加而不是覆盖。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { SpaceMeta } from "./store";
import { useSpaces } from "./useSpaces";
import { useSpacesBoot } from "./useSpacesBoot";

const persisted: SpaceMeta[] = [
  {
    id: "sp-old",
    name: "上轮留下的工作区",
    root: "D:/proj",
    env: { kind: "local" },
    createdAt: 1,
    updatedAt: 1,
  },
];

const loadAll = vi.fn(async (): Promise<{
  spaces: SpaceMeta[];
  activeId: string | null;
  states: Map<string, { tabs: never[]; activeTabIndex: number }>;
}> => ({ spaces: [], activeId: null, states: new Map() }));
const saveSpacesList = vi.fn(async (_spaces: SpaceMeta[]) => {});

vi.mock("./store", () => ({
  loadAll: () => loadAll(),
  saveSpacesList: (spaces: SpaceMeta[]) => saveSpacesList(spaces),
  saveActiveId: vi.fn(async () => {}),
  deleteSpaceData: vi.fn(async () => {}),
  newSpaceId: () => "sp-new",
}));

beforeEach(() => {
  vi.clearAllMocks();
  // 重置 store（persist 未启用，直接 setState 即可回到初始态）
  useSpaces.setState({
    spaces: [],
    activeId: null,
    hydrated: false,
    initialActiveIndex: {},
  });
  loadAll.mockResolvedValue({
    spaces: persisted,
    activeId: "sp-old",
    states: new Map([["sp-old", { tabs: [], activeTabIndex: 2 }]]),
  });
});

describe("useSpacesBoot", () => {
  it("读回持久化注册表，但 activeId 强制为 null（首屏仍是欢迎页）", async () => {
    const markBooted = vi.fn();
    renderHook(() => useSpacesBoot({ ready: true, markBooted }));

    await waitFor(() => expect(markBooted).toHaveBeenCalled());
    const s = useSpaces.getState();
    expect(s.spaces.map((x) => x.id)).toEqual(["sp-old"]);
    expect(s.activeId).toBeNull();
    expect(s.hydrated).toBe(true);
    // 持久化里存的 activeId 被刻意忽略（幽灵 SSH sessionId 的来路）
    expect(loadAll).toHaveBeenCalled();
  });

  it("把每个 Space 上次的活跃标签下标交给持久化层，避免首次落盘归零", async () => {
    renderHook(() => useSpacesBoot({ ready: true, markBooted: () => {} }));
    await waitFor(() => expect(useSpaces.getState().hydrated).toBe(true));
    expect(useSpaces.getState().initialActiveIndex).toEqual({ "sp-old": 2 });
  });

  it("注册表留存后，新建是追加而不是覆盖", async () => {
    renderHook(() => useSpacesBoot({ ready: true, markBooted: () => {} }));
    await waitFor(() => expect(useSpaces.getState().hydrated).toBe(true));

    useSpaces.getState().create({ name: "新工作区", root: "D:/new", env: { kind: "local" } });

    const ids = useSpaces.getState().spaces.map((x) => x.id);
    expect(ids).toEqual(["sp-old", "sp-new"]);
    expect(saveSpacesList.mock.lastCall?.[0].map((x) => x.id)).toEqual([
      "sp-old",
      "sp-new",
    ]);
  });

  it("读取失败也要照常启动（按空清单，不卡首屏）", async () => {
    loadAll.mockRejectedValue(new Error("store unreadable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const markBooted = vi.fn();
    renderHook(() => useSpacesBoot({ ready: true, markBooted }));

    await waitFor(() => expect(markBooted).toHaveBeenCalled());
    expect(useSpaces.getState().spaces).toEqual([]);
    expect(useSpaces.getState().activeId).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
