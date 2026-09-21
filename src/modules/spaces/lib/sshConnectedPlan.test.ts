/**
 * sshConnectedPlan.test.ts — 连接成功后的终端落点（#101 根因）
 * -----------------------------------------------------------------------------
 * 每条负向断言都配一条"同样布局下工作区级连接确实动了"的正向断言，
 * 防止判据靠"链路整个坏了没人动"而假绿。
 */
import { describe, expect, it } from "vitest";

import { planSshTabTarget, type SshTabTargetInput } from "./sshConnectedPlan";

const SESSION = "sess-new";
const SPACE = "space-ssh";

/** store 里活着的会话：只有这几个（其余按幽灵绑定处理，允许重绑）。 */
const LIVE = new Set([SESSION, "sess-space-main", "sess-other-tab"]);

function plan(
  tabs: SshTabTargetInput["tabs"],
  opts: { origin?: "space" | "tab"; activeTabId?: number | null } = {},
) {
  return planSshTabTarget({
    origin: opts.origin,
    sessionId: SESSION,
    targetSpaceId: SPACE,
    activeTabId: opts.activeTabId ?? null,
    tabs,
    sessionExists: (id) => !!id && LIVE.has(id),
  });
}

function term(id: number, sshSessionId: string | null, spaceId = SPACE) {
  return { id, spaceId, kind: "terminal" as const, sshSessionId };
}

describe("planSshTabTarget — 为标签页开的连接（origin=tab）没有落点", () => {
  it("工作区里所有 tab 都绑着各自活会话 → 不补建（#101：补了就是一条会话两条 tab）", () => {
    expect(
      plan([term(1, "sess-space-main"), term(2, "sess-other-tab")], {
        origin: "tab",
        activeTabId: 1,
      }),
    ).toEqual({ action: "none" });
  });

  it("同样的布局，工作区级连接确实会补建（配对正向断言）", () => {
    expect(
      plan([term(1, "sess-space-main"), term(2, "sess-other-tab")], {
        origin: "space",
        activeTabId: 1,
      }),
    ).toEqual({ action: "create" });
  });

  it("活动 tab 是本地壳 → 不许把它抢成这条 tab 专用会话", () => {
    expect(plan([term(1, null)], { origin: "tab", activeTabId: 1 })).toEqual({
      action: "none",
    });
  });

  it("同样的布局，工作区级连接会把这个本地壳 tab 绑上（配对正向断言）", () => {
    expect(plan([term(1, null)], { origin: "space", activeTabId: 1 })).toEqual({
      action: "bind",
      tabId: 1,
    });
  });

  it("origin 缺省（老数据 / 手动连接 / 开机自动）按工作区级处理", () => {
    expect(plan([term(1, "sess-space-main")])).toEqual({ action: "create" });
  });
});

describe("planSshTabTarget — 工作区级连接的三级查找", () => {
  it("① 已有 tab 预绑这条会话 → 绑它，不补建", () => {
    expect(plan([term(1, null), term(2, SESSION)], { activeTabId: 1 })).toEqual({
      action: "bind",
      tabId: 2,
    });
  });

  it("② 活动 tab 是终端且未绑会话 → 用它", () => {
    expect(
      plan([term(1, null), term(2, "sess-other-tab")], { activeTabId: 1 }),
    ).toEqual({ action: "bind", tabId: 1 });
  });

  it("活动 tab 是编辑器时不许抢，落到③找别的终端 tab", () => {
    expect(
      plan(
        [
          { id: 1, spaceId: SPACE, kind: "editor", sshSessionId: null },
          term(2, null),
        ],
        { activeTabId: 1 },
      ),
    ).toEqual({ action: "bind", tabId: 2 });
  });

  it("③ 绑着幽灵会话（store 里已不存在）的 tab 允许被重绑", () => {
    expect(plan([term(1, "sess-dead-from-last-run")], { activeTabId: 1 })).toEqual(
      { action: "bind", tabId: 1 },
    );
  });

  it("④ 工作区里一个终端都没有 → 补建（连上了却没有终端）", () => {
    expect(
      plan([{ id: 1, spaceId: SPACE, kind: "editor", sshSessionId: null }]),
    ).toEqual({ action: "create" });
  });

  it("别的工作区的本地 tab 不许被改成 SSH（跨工作区不抢占）", () => {
    expect(plan([term(1, null, "space-local")])).toEqual({ action: "create" });
  });
});
