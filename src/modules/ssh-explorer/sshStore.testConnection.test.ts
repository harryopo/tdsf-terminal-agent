/**
 * sshStore.testConnection.test.ts —— #111：「测试连接」的失败原因必须是中文，原文另存。
 *
 * 用户 2026-09-22 实测：新建工作区 → SSH 服务器 → 点「测试连接」，红字直接是
 * `authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]) … }`。
 * #110 只把**自动连接**那条链路的报错翻了人话，测试连接走的是 `testConnection()`，
 * 它把 Rust 的 `SshTestResult.message` 原样返回，所以两处口径不一致。
 *
 * 口径：翻译收在 store 这一处（两个对话框都调它），`message` 给人看、`raw` 留给 tooltip 排查。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sshTest: vi.fn() }));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sshTest: mocks.sshTest };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import type { SshConnectParams } from "@/lib/ssh-bridge";
import { useSshStore } from "./sshStore";

const params: SshConnectParams = {
  host: "192.168.45.128",
  port: 22,
  user: "root",
  auth: { type: "password", password: "pw" },
  cols: 80,
  rows: 24,
  term: "xterm-256color",
};

/** 真机弹窗里那行原文（russh 的 Debug 结构体） */
const KEY_ONLY =
  "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("testConnection() 的失败文案", () => {
  it("Rust 回 ok:false + 英文 Debug → message 讲人话，raw 留住原文", async () => {
    mocks.sshTest.mockResolvedValue({ ok: false, message: KEY_ONLY });

    const r = await useSshStore.getState().testConnection(params);

    expect(r.ok).toBe(false);
    expect(r.message).toContain("服务器不接受密码登录");
    expect(r.message).not.toContain("MethodSet");
    expect(r.raw).toBe(KEY_ONLY);
  });

  it("Rust 直接抛异常（连不上）→ 同样翻成人话，不把异常原文糊上去", async () => {
    mocks.sshTest.mockRejectedValue(new Error("Connection refused (os error 10061)"));

    const r = await useSshStore.getState().testConnection(params);

    expect(r.message).toContain("连不上这台服务器");
    expect(r.raw).toBe("Connection refused (os error 10061)");
  });

  // 正向配对：成功路径**不许**被改写，否则上面两条会因为"永远返回同一句话"而假绿
  it("成功 → 原样返回，不塞 raw、不套失败文案", async () => {
    mocks.sshTest.mockResolvedValue({ ok: true, message: "SSH connection test ok" });

    const r = await useSshStore.getState().testConnection(params);

    expect(r.ok).toBe(true);
    expect(r.message).toBe("SSH connection test ok");
    expect(r.raw).toBeUndefined();
  });
});
