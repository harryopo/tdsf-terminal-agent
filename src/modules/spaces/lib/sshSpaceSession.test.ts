/**
 * sshSpaceSession.test.ts —— #93：SSH 身份留着、会话引用摘掉之后，"算不算已连接"的唯一判据
 *
 * 背景（用户 2026-09-20 实测）：服务器工作区在下拉里被标成"本地"，真因是断连时
 * `App.tsx` 把整个 `env` 改写成 `{ kind: "local" }`，host/user/port 一起没了。
 * 改成"只清 sessionId"之后，`env.kind === "ssh"` 不再蕴含"有活着的会话"，
 * 所以"要不要按远端处理"必须集中到这三个函数上，判据不能各写一份。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useSshStore, type SshSessionInfo } from "@/modules/ssh-explorer/sshStore";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  detachSshSession,
  isSshEnvConnected,
  staleSshSpaceIds,
} from "./sshSpaceSession";

const sshEnv: WorkspaceEnv = {
  kind: "ssh",
  host: "10.0.0.8",
  user: "root",
  port: 22,
  sessionId: "sess-1",
  label: "root@10.0.0.8",
};

function session(over: Partial<SshSessionInfo>): SshSessionInfo {
  return {
    id: "sess-1",
    rustSessionId: 7,
    state: "connected",
    params: {} as never,
    connectedAt: 0,
    handle: null,
    ...over,
  } as SshSessionInfo;
}

beforeEach(() => {
  useSshStore.setState({ sessions: [] });
});

describe("detachSshSession：只摘引用，不抹身份", () => {
  it("SSH env 去掉 sessionId，host/user/port/label 一个不少", () => {
    expect(detachSshSession(sshEnv)).toEqual({
      kind: "ssh",
      host: "10.0.0.8",
      user: "root",
      port: 22,
      label: "root@10.0.0.8",
    });
  });

  it("幂等：已经摘过一次的原样返回（同一对象，不制造无谓的写入）", () => {
    const once = detachSshSession(sshEnv);
    expect(detachSshSession(once)).toBe(once);
  });

  it("本地 / WSL env 绝不被改", () => {
    const local: WorkspaceEnv = { kind: "local" };
    const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
    expect(detachSshSession(local)).toBe(local);
    expect(detachSshSession(wsl)).toBe(wsl);
  });
});

describe("isSshEnvConnected：判据同 sshStore.isSessionConnected", () => {
  it("没有 sessionId 的 SSH env 一律算未连接", () => {
    useSshStore.setState({ sessions: [session({})] });
    expect(isSshEnvConnected(detachSshSession(sshEnv))).toBe(false);
  });

  it("sessionId 指向的会话不存在（幽灵 id）算未连接", () => {
    expect(isSshEnvConnected(sshEnv)).toBe(false);
  });

  it("connected 但还没拿到 Rust 句柄不算已连接", () => {
    useSshStore.setState({
      sessions: [session({ rustSessionId: null })],
    });
    expect(isSshEnvConnected(sshEnv)).toBe(false);
  });

  it("会话存在但状态不是 connected 不算已连接", () => {
    useSshStore.setState({ sessions: [session({ state: "closed" })] });
    expect(isSshEnvConnected(sshEnv)).toBe(false);
  });

  it("真活着才算已连接", () => {
    useSshStore.setState({ sessions: [session({})] });
    expect(isSshEnvConnected(sshEnv)).toBe(true);
  });
});

describe("staleSshSpaceIds：启动清理与断线降级共用的那一个判据", () => {
  const spaces = [
    { id: "sp-ghost", env: sshEnv },
    { id: "sp-live", env: { ...sshEnv, sessionId: "sess-live" } },
    { id: "sp-closed", env: { ...sshEnv, sessionId: "sess-closed" } },
    { id: "sp-nohandle", env: { ...sshEnv, sessionId: "sess-nohandle" } },
    { id: "sp-plain", env: { kind: "local" } as WorkspaceEnv },
    { id: "sp-already", env: detachSshSession(sshEnv) },
  ];
  const sessions = [
    session({ id: "sess-live", rustSessionId: 1, state: "connected" }),
    session({ id: "sess-closed", rustSessionId: 2, state: "closed" }),
    session({ id: "sess-nohandle", rustSessionId: null, state: "connected" }),
  ];

  it("幽灵 id / 已断开 / 没句柄 三种都算该清理，活着的与本地工作区不算", () => {
    expect(staleSshSpaceIds(spaces, sessions)).toEqual([
      "sp-ghost",
      "sp-closed",
      "sp-nohandle",
    ]);
  });

  it("已经没有 sessionId 的 SSH 工作区不再被反复写（幂等，避免每次启动都动 store）", () => {
    expect(staleSshSpaceIds([spaces[5]], [])).toEqual([]);
  });
});
