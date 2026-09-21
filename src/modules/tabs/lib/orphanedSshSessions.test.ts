/**
 * orphanedSshSessions.test.ts —— #89 的连带账：关掉标签页要释放它独占的连接
 *
 * #89 之前一个 SSH 工作区只有一条会话，"关标签页不断开"是有意的；#89 之后每个
 * 标签页可能各连一条，不回收就是攒连接 —— MaxSessions 小的服务器会被自己的历史
 * 标签页挡在门外。规则保守：工作区当前那条会话（重连锚点，状态栏/资源管理器还在用）
 * 永不回收。
 */
import { describe, expect, it } from "vitest";
import type { Tab, TerminalTab } from "./useTabs";
import { orphanedSshSessions } from "./useTabs";

function term(id: number, ssh: string | null | undefined, extra?: Partial<TerminalTab>): Tab {
  return {
    id,
    kind: "terminal",
    spaceId: "sp-1",
    title: "shell",
    sshSessionId: ssh,
    paneTree: { kind: "leaf", id: id * 10 },
    activeLeafId: id * 10,
    ...extra,
  } as Tab;
}

describe("orphanedSshSessions", () => {
  it("关掉独占会话的标签页 → 该会话被回收", () => {
    expect(orphanedSshSessions([term(2, null)], term(1, "s-a"), null)).toEqual([
      "s-a",
    ]);
  });

  it("别的标签页还在用同一条会话 → 不回收", () => {
    expect(
      orphanedSshSessions([term(2, "s-a")], term(1, "s-a"), null),
    ).toEqual([]);
  });

  it("工作区当前那条会话永不回收（它是重连锚点，不是这个 tab 的私有连接）", () => {
    expect(orphanedSshSessions([], term(1, "s-space"), "s-space")).toEqual([]);
  });

  it("分屏里 leaf 显式绑定的会话也算这个 tab 的（未绑定=继承 tab，不重复计）", () => {
    const closed = term(1, "s-a", {
      paneTree: {
        kind: "split",
        id: 90,
        dir: "row",
        children: [
          { kind: "leaf", id: 11 },
          { kind: "leaf", id: 12, sshSessionId: "s-leaf" },
          { kind: "leaf", id: 13, sshSessionId: null },
        ],
      },
    });
    expect(orphanedSshSessions([], closed, "s-space")).toEqual([
      "s-a",
      "s-leaf",
    ]);
  });

  it("本地标签页（没绑会话）与编辑器标签页 → 什么都不回收", () => {
    expect(orphanedSshSessions([], term(1, null), null)).toEqual([]);
    const editor = { id: 3, kind: "editor", spaceId: "sp-1" } as unknown as Tab;
    expect(orphanedSshSessions([], editor, null)).toEqual([]);
  });
});
