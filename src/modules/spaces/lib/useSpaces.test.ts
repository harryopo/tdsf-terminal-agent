import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceMeta } from "./store";

/**
 * #64：一个进程里可以同时开多扇主窗，它们共用同一份 spaces 清单。
 * 这些用例把 store 换成一个"另一个窗口也在写"的假实现，检查每个动作只施加
 * 自己那一条改动，而不是把本窗口的整份内存数组盖回去（那正是"工作区自己消失
 * 了"的成因）。
 */
const remote = vi.hoisted(() => ({ spaces: [] as SpaceMeta[] }));
const mocks = vi.hoisted(() => ({ saveActiveId: vi.fn(async () => {}) }));

vi.mock("./store", () => ({
  readSpaces: async () => remote.spaces,
  saveSpacesList: async (list: SpaceMeta[]) => {
    remote.spaces = list;
  },
  deleteSpaceData: async () => {},
  saveActiveId: mocks.saveActiveId,
  newSpaceId: () => `sp-test-${Math.random().toString(36).slice(2, 8)}`,
}));

const { useSpaces } = await import("./useSpaces");

function space(id: string, over: Partial<SpaceMeta> = {}): SpaceMeta {
  return {
    id,
    name: id,
    root: `/w/${id}`,
    env: { kind: "local" } as unknown as SpaceMeta["env"],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** 等 commit 队列排空（每次 commit 是 read → write → setState 三段）。 */
async function settled() {
  await vi.waitFor(() =>
    expect(useSpaces.getState().spaces).toEqual(remote.spaces),
  );
}

beforeEach(() => {
  remote.spaces = [];
  useSpaces.setState({ spaces: [], activeId: null, hydrated: false });
});

describe("useSpaces 的多窗口写入", () => {
  it("重命名不会丢掉别的窗口刚建好的工作区", async () => {
    remote.spaces = [space("a")];
    useSpaces.getState().hydrate([space("a")], "a");
    // 另一扇窗在这扇窗 boot 之后建了 b
    remote.spaces = [space("a"), space("b")];

    useSpaces.getState().rename("a", "renamed");
    await settled();

    expect(remote.spaces.map((s) => s.id)).toEqual(["a", "b"]);
    expect(remote.spaces[0].name).toBe("renamed");
  });

  it("删除只去掉自己那一条，远端新增的留下", async () => {
    remote.spaces = [space("a"), space("b")];
    useSpaces.getState().hydrate([space("a"), space("b")], "a");

    useSpaces.getState().remove("a");
    await settled();

    expect(remote.spaces.map((s) => s.id)).toEqual(["b"]);
  });

  it("本窗口不知道某工作区已被别处删除时，不会把它写回去", async () => {
    remote.spaces = [space("a"), space("b")];
    useSpaces.getState().hydrate([space("a"), space("b")], "a");
    // 另一扇窗删掉了 a
    remote.spaces = [space("b")];

    useSpaces.getState().rename("b", "still here");
    await settled();

    expect(remote.spaces.map((s) => s.id)).toEqual(["b"]);
    expect(remote.spaces[0].name).toBe("still here");
  });

  it("新建是追加，不覆盖远端已有条目", async () => {
    remote.spaces = [space("a")];
    useSpaces.getState().hydrate([space("a")], null);
    remote.spaces = [space("a"), space("other")];

    const env = { kind: "local" } as unknown as SpaceMeta["env"];
    const meta = useSpaces
      .getState()
      .create({ name: "new", root: "/w/new", env });
    await settled();

    expect(remote.spaces.map((s) => s.id)).toEqual(["a", "other", meta.id]);
  });

  it("同一窗口连着改两个名字，两次都进清单", async () => {
    remote.spaces = [space("a"), space("b")];
    useSpaces.getState().hydrate([space("a"), space("b")], "a");

    useSpaces.getState().rename("a", "A!");
    useSpaces.getState().rename("b", "B!");
    await settled();

    expect(remote.spaces.map((s) => s.name)).toEqual(["A!", "B!"]);
  });

  it("拖拽排序保留本窗口没见过的工作区，排在末尾", async () => {
    remote.spaces = [space("a"), space("b"), space("late")];
    useSpaces.getState().hydrate([space("a"), space("b")], "a");

    useSpaces.getState().reorder(["b", "a"]);
    await settled();

    expect(remote.spaces.map((s) => s.id)).toEqual(["b", "a", "late"]);
  });
});

// ============================================================================
// #103（2026-09-21 用户钦定）：「回到工作区选择页」= setActive(null)
// ----------------------------------------------------------------------------
// 顶栏 × 是真退出（Rust 侧没有 close→hide），所以"回主页"必须能只把视图切回
// 欢迎页、工作区与连接全部保留。落盘的 activeId 也要是 null，否则重启又被
// 自动带进上次那个工作区，等于入口白做。
// ============================================================================
describe("useSpaces.setActive — 回到工作区选择页", () => {
  it("传 null：activeId 清空并落盘 null，工作区列表一个不少", async () => {
    remote.spaces = [space("a"), space("b")];
    useSpaces.getState().hydrate([space("a"), space("b")], "a");
    mocks.saveActiveId.mockClear();

    useSpaces.getState().setActive(null);

    expect(useSpaces.getState().activeId).toBeNull();
    await vi.waitFor(() => expect(mocks.saveActiveId).toHaveBeenCalledWith(null));
    expect(useSpaces.getState().spaces.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("配对正向断言：传 id 仍然切得进去（同一函数不能只会清空）", () => {
    useSpaces.getState().hydrate([space("a"), space("b")], "a");
    useSpaces.getState().setActive("b");
    expect(useSpaces.getState().activeId).toBe("b");
  });
});
