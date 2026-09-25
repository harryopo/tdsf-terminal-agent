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
  connectedSshSpaceCount,
  detachSshSession,
  isSshEnvConnected,
  sshEnvIsConnecting,
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

// ============================================================================
// #102 收尾（2026-09-22）：离线面板要把"没人管"和"重连已经在跑"分开
// ----------------------------------------------------------------------------
// 分不清的两种坏结果都在这条链上：把已在重连显示成可点的「重新连接」，用户重复点会被
// reconnectSshSpace 的并发闸门吞掉（返回 null），面板于是谎报"重连失败"；反过来把没人管
// 显示成"正在重连…"，用户就只能干等一块再也不会动的面板。
// 匹配必须按 host/user/port —— 同一次会话表里别的服务器在连，不算这台在重连。
// ============================================================================
describe("sshEnvIsConnecting：只认这台服务器的连接进度", () => {
  const params = { host: "10.0.0.8", port: 22, user: "root" };

  it("同一台服务器有会话正在建立 → true", () => {
    expect(
      sshEnvIsConnecting(sshEnv, [
        session({ rustSessionId: null, state: "connecting", params } as never),
      ]),
    ).toBe(true);
  });

  it("另一台机器在连 → false（两个 SSH 工作区各说各的）", () => {
    expect(
      sshEnvIsConnecting(sshEnv, [
        session({
          rustSessionId: null,
          state: "connecting",
          params: { ...params, host: "10.0.0.9" },
        } as never),
      ]),
    ).toBe(false);
  });

  it("同主机同用户但端口不同 → false（那是另一台机器）", () => {
    expect(
      sshEnvIsConnecting(sshEnv, [
        session({
          rustSessionId: null,
          state: "connecting",
          params: { ...params, port: 2222 },
        } as never),
      ]),
    ).toBe(false);
  });

  it("已经连上 → false（那时左侧走远端树，不该再显示重连提示）", () => {
    expect(
      sshEnvIsConnecting(sshEnv, [session({ params } as never)]),
    ).toBe(false);
  });

  it("自动重连中的会话也算这台在连接", () => {
    expect(
      sshEnvIsConnecting(sshEnv, [
        session({ rustSessionId: 7, state: "reconnecting", params } as never),
      ]),
    ).toBe(true);
  });

  it("本地工作区 → false，即使会话表里有 SSH 在连", () => {
    expect(
      sshEnvIsConnecting({ kind: "local" } as WorkspaceEnv, [
        session({ rustSessionId: null, state: "connecting", params } as never),
      ]),
    ).toBe(false);
  });

  it("不传 sessions 时读 store 当前值（渲染期之外的调用点也能判）", () => {
    useSshStore.setState({
      sessions: [
        session({
          id: "sess-1",
          rustSessionId: null,
          state: "authenticating",
          params,
        } as never),
      ],
    });
    expect(sshEnvIsConnecting(sshEnv)).toBe(true);
  });
});

describe("connectedSshSpaceCount：欢迎页那句「连没连上」的唯一来源（#123 另一半）", () => {
  const localEnv = { kind: "local" } as unknown as WorkspaceEnv;
  const wslEnv = { kind: "wsl", distro: "Ubuntu" } as unknown as WorkspaceEnv;
  const detached = { ...sshEnv, sessionId: undefined } as WorkspaceEnv;

  it("只数会话真活着的那台：本地/WSL/身份在但会话没了的都不算", () => {
    const spaces = [
      { env: sshEnv }, // 连着
      { env: detached }, // #93 之后常见：身份在、会话引用被摘
      { env: localEnv },
      { env: wslEnv },
    ];
    expect(connectedSshSpaceCount(spaces, [session({})])).toBe(1);
  });

  it("「正在连」不许吹成「已连上」（authenticating 不计）", () => {
    const busy = session({ state: "authenticating" as never });
    expect(connectedSshSpaceCount([{ env: sshEnv }], [busy])).toBe(0);
  });

  it("幽灵 sessionId（会话表里查不到这条）不计", () => {
    const other = session({ id: "sess-999" });
    expect(connectedSshSpaceCount([{ env: sshEnv }], [other])).toBe(0);
  });

  it("正向配对：会话补回来之后必须真的变 1，不是永远返回 0", () => {
    const spaces = [{ env: sshEnv }];
    expect(connectedSshSpaceCount(spaces, [])).toBe(0);
    expect(connectedSshSpaceCount(spaces, [session({})])).toBe(1);
  });

  it("两台都连着就是 2（计数不许只回布尔）", () => {
    const second: WorkspaceEnv = {
      kind: "ssh",
      host: "10.0.0.9",
      user: "root",
      port: 22,
      sessionId: "sess-2",
      label: "root@10.0.0.9",
    };
    const sessions = [session({}), session({ id: "sess-2", rustSessionId: 8 })];
    expect(connectedSshSpaceCount([{ env: sshEnv }, { env: second }], sessions)).toBe(
      2,
    );
  });
});
