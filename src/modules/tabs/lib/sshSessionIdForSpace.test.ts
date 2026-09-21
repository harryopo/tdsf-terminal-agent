/**
 * sshSessionIdForSpace.test.ts — 幽灵 SSH sessionId 守卫（#61-A 后的常规路径）
 * -----------------------------------------------------------------------------
 * 2026-08-07 的钦定是"重启回到选择/新建工作区界面"，因为 Space.env.sessionId 是
 * **运行时态**被持久化下来的：服务器关了就失效，直接绑上去会让终端显示本地、
 * 资源管理器不接管。#61 方案 A 之后启动不再自动进入任何 Space，但用户会在欢迎页
 * 上**手点**旧 SSH 工作区进去 —— 这条"失效会话必须回退成不绑定"的守卫从边缘路径
 * 变成主路径，所以钉成单测。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { sshSessionIdForSpace } from "./useTabs";

const sshSpace: SpaceMeta = {
  id: "sp-ssh",
  name: "旧 SSH 工作区",
  root: null,
  env: {
    kind: "ssh",
    host: "10.0.0.8",
    user: "ops",
    port: 22,
    label: "ops@10.0.0.8",
    sessionId: "s-stale",
  },
  createdAt: 1,
  updatedAt: 1,
};

const localSpace: SpaceMeta = {
  id: "sp-local",
  name: "本地工作区",
  root: "D:/proj",
  env: { kind: "local" },
  createdAt: 1,
  updatedAt: 1,
};

/**
 * 造会话表。**默认造"活着的"**（connected + 已拿到 Rust 句柄）——
 * #93（2026-09-21）之后"会话存在"不再够格，判据收紧成 `sshStore.isSessionConnected`，
 * 所以想表达"接管"必须给真会话，想表达"不接管"要么不给、要么给一条死的。
 */
function setSessions(
  ids: string[],
  over: { state?: string; rustSessionId?: number | null } = {},
) {
  const { state = "connected", rustSessionId = 1 } = over;
  useSshStore.setState({
    sessions: ids.map((id) => ({ id, state, rustSessionId })) as never,
  });
}

beforeEach(() => {
  useSpaces.setState({
    spaces: [sshSpace, localSpace],
    activeId: null,
    hydrated: true,
    initialActiveIndex: {},
  });
  setSessions([]);
});

describe("sshSessionIdForSpace", () => {
  it("env 里的 sessionId 在本次运行里不存在（重启后 / 服务器已关）→ 不绑定", () => {
    expect(sshSessionIdForSpace("sp-ssh")).toBeUndefined();
  });

  it("会话仍在本次运行的 sessions 里 → 正常接管", () => {
    setSessions(["s-other", "s-stale"]);
    expect(sshSessionIdForSpace("sp-ssh")).toBe("s-stale");
  });

  // #93（2026-09-21）之后 SSH 工作区身份跨断线留着，"存在"这一条不再够格。
  it("会话在本次运行里但已断开 → 不接管（此前只看存在，会把 tab 接到死流上）", () => {
    setSessions(["s-stale"], { state: "closed" });
    expect(sshSessionIdForSpace("sp-ssh")).toBeUndefined();
  });

  it("状态 connected 却还没拿到 Rust 句柄 → 不接管（判据同 isSessionConnected）", () => {
    setSessions(["s-stale"], { rustSessionId: null });
    expect(sshSessionIdForSpace("sp-ssh")).toBeUndefined();
  });

  it("本地工作区 / 未知 space / null → 一律 undefined", () => {
    setSessions(["s-stale"]);
    expect(sshSessionIdForSpace("sp-local")).toBeUndefined();
    expect(sshSessionIdForSpace("sp-nope")).toBeUndefined();
    expect(sshSessionIdForSpace(null)).toBeUndefined();
  });

  it("SSH 工作区尚未绑定过会话（首次进入）→ undefined", () => {
    useSpaces.setState({
      spaces: [
        {
          ...sshSpace,
          env: {
            kind: "ssh",
            host: "10.0.0.8",
            user: "ops",
            port: 22,
            label: "ops@10.0.0.8",
          },
        },
      ],
    });
    setSessions(["s-stale"]);
    expect(sshSessionIdForSpace("sp-ssh")).toBeUndefined();
  });
});
