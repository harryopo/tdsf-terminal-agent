/**
 * sshStore.connectToast.test.ts —— #110：连接失败必须**只**由 connect() 说一次，
 * 而且说的是人话。
 *
 * 用户 2026-09-22 实测截图：点进已有 SSH 工作区，屏幕上叠两条 toast ——
 * 一条正文是 russh 的 Rust Debug（`Failure { remaining_methods: MethodSet([PublicKey]) … }`），
 * 一条是 `reconnectSshSpace` 补的"可在 SSH 面板手动重试"（那个面板没入口，见 #109）。
 * 现在把"说清原因"这一件事收在 connect() 一处：文案来自 `describeSshFailure`，
 * 且**一次失败只有一条**。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sshConnect: vi.fn() }));

vi.mock("@/lib/ssh-bridge", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, sshConnect: mocks.sshConnect };
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
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

/** 真机日志里的原文（那台 VM 关掉了密码登录） */
const KEY_ONLY =
  "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }";

beforeEach(() => {
  vi.clearAllMocks();
  useSshStore.setState({ sessions: [], activeSessionId: null });
  mocks.sshConnect.mockRejectedValue(new Error(KEY_ONLY));
});

describe("connect() 失败时的通知", () => {
  it("只弹一条，且标题是翻译过的人话", async () => {
    const id = await useSshStore.getState().connect(params);

    expect(id).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [headline, opts] = vi.mocked(toast.error).mock.calls[0];
    expect(headline).toBe("服务器不接受密码登录");
    expect((opts as { description: string }).description).toContain("公钥");
  });

  it("原始报错仍然留得住 —— 存在会话的 error 字段里，没被文案顶掉", async () => {
    await useSshStore.getState().connect(params);

    const failed = useSshStore
      .getState()
      .sessions.find((s) => s.state === "failed");
    expect(failed?.error).toBe(KEY_ONLY);
  });
});
