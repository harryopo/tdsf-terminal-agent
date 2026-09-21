/**
 * sshStore.origin.test.ts — #101 出身标记必须一路活到会话对象上
 * -----------------------------------------------------------------------------
 * `App.tsx` 的连接成功订阅靠 `session.origin === "tab"` 决定"这条连接不参与
 * 工作区/标签页安置"。这个判断埋在 2400 行组件里测不到，所以链路中间任何一环
 * 掉字段（connectWithSaved 没转发、connect 建会话时没写进 store），都不会有
 * 类型错误、也不会有测试红 —— 只会让用户重新看到"一条会话两条 tab"。
 * 这里把「传进去的 origin 出现在 store 的会话对象上」钉死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sshConnect: vi.fn(),
  sshCommand: vi.fn(),
  getSecret: vi.fn(),
  touch: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ssh-bridge")>();
  return {
    ...actual,
    sshConnect: mocks.sshConnect,
    sshCommand: mocks.sshCommand,
    sshCredentialsGetSecret: mocks.getSecret,
    sshCredentialsTouch: mocks.touch,
    sshCredentialsList: mocks.list,
  };
});

import type { SshConnectParams, SshCredentialProfile } from "@/lib/ssh-bridge";
import { useSshStore } from "./sshStore";

const params: SshConnectParams = {
  host: "10.0.0.8",
  port: 22,
  user: "root",
  auth: { type: "password", password: "pw" },
  cols: 80,
  rows: 24,
  term: "xterm-256color",
};

const profile: SshCredentialProfile = {
  id: "pf-1",
  alias: "lab",
  host: "10.0.0.8",
  port: 22,
  user: "root",
  auth: { type: "password" },
  lastUsed: 1,
  createdAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  useSshStore.setState({ sessions: [], activeSessionId: null });
  mocks.sshConnect.mockResolvedValue({
    id: 7,
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  });
  mocks.sshCommand.mockResolvedValue({ stdout: "/root", stderr: "", exitCode: 0 });
  mocks.getSecret.mockResolvedValue("pw");
  // connectWithSaved 里是 `void touch(id).catch(...)`：返回 undefined 会当场
  // TypeError 把整条连接判成失败，必须给个真 Promise。
  mocks.touch.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue([]);
});

describe("sshStore — 连接出身（origin）", () => {
  it("connect 带 origin=tab → 会话对象上留着这个标记", async () => {
    const id = await useSshStore.getState().connect(params, { origin: "tab" });
    const session = useSshStore.getState().sessions.find((s) => s.id === id);
    expect(session?.origin).toBe("tab");
  });

  it("不带 origin（工作区级连接：对话框 / 开机自动）→ 留空，按工作区级处理", async () => {
    const id = await useSshStore.getState().connect(params);
    const session = useSshStore.getState().sessions.find((s) => s.id === id);
    expect(session?.origin).toBeUndefined();
  });

  it("connectWithSaved 把 origin 透传给 connect（少转发一次就退回旧 bug）", async () => {
    const id = await useSshStore
      .getState()
      .connectWithSaved(profile, { origin: "tab" });
    const session = useSshStore.getState().sessions.find((s) => s.id === id);
    expect(session?.origin).toBe("tab");
    expect(mocks.sshConnect).toHaveBeenCalledTimes(1);
  });
});
