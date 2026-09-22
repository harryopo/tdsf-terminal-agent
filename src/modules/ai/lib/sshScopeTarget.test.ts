import { describe, expect, it } from "vitest";
import type { SshSessionInfo } from "@/modules/ssh-explorer/sshStore";
import { resolveScopedSshSession, type SshServerBinding } from "./sshScopeTarget";

/**
 * #91⑨ —— 一段对话绑定的是"哪台服务器"，而 #89 之后同一台服务器上可以并着
 * 好几条各开各的连接（每个标签页一条）。旧口径 `sessions.find(按 host/user/port)`
 * 拿的是数组里的第一条，于是出现"标签写着 A 机的 shell、命令打进 B 机那条连接"。
 * 判据必须与注入路径同源：**用户正看着的那条**优先。
 */

const BINDING: SshServerBinding = { host: "10.0.0.8", user: "root", port: 22 };

function session(
  id: string,
  rustSessionId: number | null,
  over: Partial<SshSessionInfo> = {},
): SshSessionInfo {
  return {
    id,
    rustSessionId,
    params: { host: "10.0.0.8", user: "root", port: 22 },
    state: "connected",
    connectedAt: 0,
    handle: null,
    ...over,
  } as unknown as SshSessionInfo;
}

const tabA = session("sess-a", 7);
const tabB = session("sess-b", 8);

describe("resolveScopedSshSession", () => {
  it("同主机多条连接时取可见的那条，不是数组里的第一条", () => {
    expect(resolveScopedSshSession([tabA, tabB], BINDING, 8)?.id).toBe("sess-b");
  });

  it("可见会话是另一台机器时不吃它，退回本服务器活着的那条", () => {
    expect(resolveScopedSshSession([tabA, tabB], BINDING, 99)?.id).toBe("sess-a");
  });

  it("同主机一条已断一条还活着时取活着的（旧口径可能挑到断的）", () => {
    const dead = session("sess-dead", null, { state: "closed" });
    expect(resolveScopedSshSession([dead, tabA], BINDING, null)?.id).toBe(
      "sess-a",
    );
  });

  it("可见但那头断了时不优先它 —— 活的排在前", () => {
    const visibleButDead = session("sess-b", 8, { state: "closed" });
    expect(
      resolveScopedSshSession([visibleButDead, tabA], BINDING, 8)?.id,
    ).toBe("sess-a");
  });

  it("一台服务器一条连接都没活时仍返回它（对话归属要说得出服务器，connected=false）", () => {
    const deadA = session("sess-a", null, { state: "closed" });
    const deadB = session("sess-b", null, { state: "failed" });
    expect(resolveScopedSshSession([deadA, deadB], BINDING, null)?.id).toBe(
      "sess-a",
    );
  });

  it("没有这台服务器的会话就是 null，不拿别的服务器顶", () => {
    const other = session("sess-x", 7, {
      params: { host: "10.0.0.9", user: "root", port: 22 },
    });
    expect(resolveScopedSshSession([other], BINDING, 7)).toBeNull();
  });

  it("端口缺省按 22 归一，用户名不同算不同服务器", () => {
    const noPort = { ...tabA, params: { host: "10.0.0.8", user: "root" } };
    expect(
      resolveScopedSshSession([noPort as SshSessionInfo], BINDING, null)?.id,
    ).toBe("sess-a");
    // 对话侧的 binding 自己也可能缺 port（老数据落盘的 Space env）
    expect(
      resolveScopedSshSession(
        [tabA],
        { host: "10.0.0.8", user: "root" },
        null,
      )?.id,
    ).toBe("sess-a");
    const otherUser = {
      ...tabA,
      params: { host: "10.0.0.8", user: "ops", port: 22 },
    };
    expect(
      resolveScopedSshSession([otherUser as SshSessionInfo], BINDING, null),
    ).toBeNull();
  });
});
