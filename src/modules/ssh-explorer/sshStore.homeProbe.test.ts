/**
 * sshStore.homeProbe.test.ts — 连上之后远端 shell 的起点目录（#104 同类）
 * -----------------------------------------------------------------------------
 * 实测服务器（192.168.45.128）连**非交互 exec** 都会先吐一段欢迎横幅，
 * `echo $HOME` 因此返回 1802 字节而真实 $HOME 只有 5 字节，且横幅末尾不带换行
 * —— 横幅尾巴和值粘在同一行。旧实现取"第一行"，拿到的就是横幅，于是
 * `startsWith('/')` 判失败、文件树起点降级成根目录。
 *
 * 这里钉两件事：① 发出去的命令必须带哨兵（否则改动只是看起来对）；
 * ② 带横幅的输出要解析出 /root，而**没有哨兵**时必须降级到 '/'
 *    （绝不能把横幅当路径导航进去）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sshConnect: vi.fn(),
  sshCommand: vi.fn(),
}));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-bridge")>();
  return {
    ...actual,
    sshConnect: mocks.sshConnect,
    sshCommand: mocks.sshCommand,
  };
});

import { PROBE_MARK } from "@/lib/ssh-bridge";
import type { SshCommandResult, SshConnectParams } from "@/lib/ssh-bridge";
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

/** 真机形状：多行横幅，末尾**没有**换行，值紧跟在横幅后面 */
const BANNER = [
  "Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-88-generic x86_64)",
  "*************************************************************",
  "*  提示：本服务器已开启防火墙，请联系管理员开放端口          *",
  "Last login: Mon Sep 21 19:37:24 2026 from 192.168.45.1",
].join("\n");

function result(output: string): SshCommandResult {
  return { ok: true, output, stderr: "", exitCode: 0, duration: 0 };
}

/**
 * 按**发来的命令**逐条模拟远端 stdout，而不是无条件返回正确答案 ——
 * 否则"忘了打哨兵"这种改动也能测绿，守住的就只剩字面量了。
 * 横幅由服务器自己在任何 exec 前面吐一次，末尾不带换行。
 */
function fakeExec(home: string) {
  mocks.sshCommand.mockImplementation(async (_sid: number, cmd: unknown) => {
    const command = String(cmd);
    if (!command.includes("echo $HOME")) return result("");
    let out = BANNER;
    for (const piece of command.split(";")) {
      const p = piece.trim();
      if (p === `echo ${PROBE_MARK}`) out += `${PROBE_MARK}\n`;
      else if (p === "echo $HOME") out += `${home}\n`;
    }
    return result(out);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSshStore.setState({ sessions: [], activeSessionId: null });
  mocks.sshConnect.mockResolvedValue({
    id: 85,
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  });
});

/** 解析完之后 store 里那条会话的远端 cwd（#91② 之后这是唯一的落点，没有第二棵树要刷） */
function seededPath(sessionId: string | null) {
  const path = sessionId
    ? useSshStore.getState().currentPathBySession[sessionId]
    : undefined;
  expect(path).toBeDefined();
  return path;
}

describe("sshStore — 连接后的家目录落点（横幅污染）", () => {
  it("带横幅的 exec 输出 → 起点是 /root，不是 /", async () => {
    fakeExec("/root");

    const sessionId = await useSshStore.getState().connect(params);
    await vi.waitFor(() =>
      expect(useSshStore.getState().currentPathBySession[sessionId!]).toBeDefined(),
    );

    expect(seededPath(sessionId)).toBe("/root");
  });

  it("发出去的探测命令必须带哨兵（否则上一条只是碰巧绿）", async () => {
    fakeExec("/root");
    const sessionId = await useSshStore.getState().connect(params);
    await vi.waitFor(() =>
      expect(useSshStore.getState().currentPathBySession[sessionId!]).toBeDefined(),
    );

    const homeCmd = mocks.sshCommand.mock.calls
      .map((c) => String(c[1]))
      .find((c) => c.includes("echo $HOME"));
    expect(homeCmd).toContain(PROBE_MARK);
  });

  it("远端没照我们的命令输出（哨兵缺失）→ 降级到 /，绝不把横幅当路径", async () => {
    // ForceCommand / 被改写的 shell 会让探测拿不到哨兵 —— 这时宁可退回根目录。
    mocks.sshCommand.mockResolvedValue(result(`${BANNER}/root\n`));

    const sessionId = await useSshStore.getState().connect(params);
    await vi.waitFor(() =>
      expect(useSshStore.getState().currentPathBySession[sessionId!]).toBeDefined(),
    );

    expect(seededPath(sessionId)).toBe("/");
  });
});
