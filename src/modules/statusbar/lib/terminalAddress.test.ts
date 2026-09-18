/**
 * terminalAddress.test.ts — 状态栏地址口径（#63，用户 2026-09-18 决策）
 * -----------------------------------------------------------------------------
 * 钉住一件事：右下角只反映"命令实际跑在哪台机器"。
 * 旧实现在活动 tab 没绑 SSH 会话时回退到 Space 的 SSH 会话，
 * 于是 SSH 工作区里开一个本地终端标签，右下角仍写 user@host —— 谎报。
 */
import { describe, expect, it } from "vitest";
import type { SshSessionInfo } from "@/modules/ssh-explorer/sshStore";
import { terminalAddressOf } from "./terminalAddress";

const session = (over: Partial<SshSessionInfo>): SshSessionInfo =>
  ({
    id: "ssh-1",
    state: "connected",
    rustSessionId: 7,
    params: { user: "root", host: "192.168.45.200" },
    ...over,
  }) as SshSessionInfo;

describe("terminalAddressOf", () => {
  it("已连接的会话 → user@host", () => {
    expect(terminalAddressOf(session({}))).toBe("root@192.168.45.200");
  });

  it("未连接（失败 / 已关闭 / 连接中）→ null，不报已经不在的主机", () => {
    expect(terminalAddressOf(session({ state: "failed" }))).toBeNull();
    expect(terminalAddressOf(session({ state: "closed" }))).toBeNull();
    expect(terminalAddressOf(session({ state: "connecting" }))).toBeNull();
    expect(terminalAddressOf(session({ rustSessionId: null }))).toBeNull();
  });

  it("活动 tab 是本地/WSL 终端（没有 SSH 会话）→ null，如实显示本地", () => {
    // 这正是 #63 的场景：Space 是 SSH，但当前 tab 跑在本地
    expect(terminalAddressOf(null)).toBeNull();
    expect(terminalAddressOf(undefined)).toBeNull();
  });
});
