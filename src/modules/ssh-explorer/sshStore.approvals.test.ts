/**
 * #91④ —— 主机审批（TOFU / 密钥变更）请求队列。
 *
 * 旧实现把事件直接 `setState({ pendingApproval: req })`：第二条请求会顶掉第一条，
 * 用户从没见过第一条就问什么，而 Rust 侧那条连接正挂在那儿等回执（最长 5 分钟
 * 超时按"拒绝"处理）。并发连接两台新主机时必然踩到（自动连接 + 手动新建工作区）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostApprovalRequest } from "@/lib/ssh-bridge";

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sshApproveHost: vi.fn(async () => undefined) };
});

import { sshApproveHost } from "@/lib/ssh-bridge";
import { useSshStore } from "./sshStore";

function req(approvalId: string, host: string): HostApprovalRequest {
  return {
    approvalId,
    host,
    port: 22,
    fingerprint: `SHA256:${approvalId}`,
    isMismatch: false,
    keyType: "ssh-ed25519",
  };
}

const approveHostMock = vi.mocked(sshApproveHost);

beforeEach(() => {
  approveHostMock.mockClear();
  useSshStore.setState({ pendingApprovals: [] });
});

describe("主机审批队列", () => {
  it("两条不同主机的请求排队，不互相顶掉", () => {
    useSshStore.getState().pushApproval(req("ap-1", "10.0.0.1"));
    useSshStore.getState().pushApproval(req("ap-2", "10.0.0.2"));
    expect(useSshStore.getState().pendingApprovals.map((r) => r.host)).toEqual([
      "10.0.0.1",
      "10.0.0.2",
    ]);
  });

  it("同一个 approvalId 重复推送只留一条（否则用户要答两次）", () => {
    useSshStore.getState().pushApproval(req("ap-1", "10.0.0.1"));
    useSshStore.getState().pushApproval(req("ap-1", "10.0.0.1"));
    expect(useSshStore.getState().pendingApprovals).toHaveLength(1);
  });

  it("应答队首时只发队首那个 approvalId，答完下一条顶上来", async () => {
    useSshStore.getState().pushApproval(req("ap-1", "10.0.0.1"));
    useSshStore.getState().pushApproval(req("ap-2", "10.0.0.2"));

    await useSshStore.getState().resolveApproval(true);

    expect(approveHostMock.mock.calls).toEqual([["ap-1", true]]);
    expect(
      useSshStore.getState().pendingApprovals.map((r) => r.approvalId),
    ).toEqual(["ap-2"]);
  });

  it("两条依次答完，顺序与到达顺序一致", async () => {
    useSshStore.getState().pushApproval(req("ap-1", "10.0.0.1"));
    useSshStore.getState().pushApproval(req("ap-2", "10.0.0.2"));

    await useSshStore.getState().resolveApproval(true);
    await useSshStore.getState().resolveApproval(false);

    expect(approveHostMock.mock.calls).toEqual([
      ["ap-1", true],
      ["ap-2", false],
    ]);
    expect(useSshStore.getState().pendingApprovals).toEqual([]);
  });

  it("队列空时应答不发任何后端请求", async () => {
    await useSshStore.getState().resolveApproval(true);
    expect(approveHostMock).not.toHaveBeenCalled();
  });

  it("后端回执失败也要出队，否则整条审批链卡死在答不上的队首", async () => {
    approveHostMock.mockRejectedValueOnce(new Error("approval_id not found"));
    useSshStore.getState().pushApproval(req("ap-dead", "10.0.0.1"));
    useSshStore.getState().pushApproval(req("ap-2", "10.0.0.2"));

    await useSshStore.getState().resolveApproval(true);

    expect(
      useSshStore.getState().pendingApprovals.map((r) => r.approvalId),
    ).toEqual(["ap-2"]);
  });
});
