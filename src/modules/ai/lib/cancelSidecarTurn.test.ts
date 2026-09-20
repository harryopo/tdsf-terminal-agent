// TDSF #69（用户决策 4）: 点「停止」必须真的通知 sidecar 停下来
// -----------------------------------------------------------------------------
// 旧行为：stop() 只 abort 前端事件流，Python 里的 Strands 循环还在跑 —— 还在烧
// token、auto 档还会继续派发命令、挂着待批的审批卡还压在会话队列头上。
// 现在 stop 走 stopGeneration()：掐流 + 发 agent.cancel。
//
// 这里钉两件事：
//   1. agent.cancel 的 RPC 形状（method / params.session_id）—— #67 白名单以
//      sidecar ready 快照为真源，形状写错就是运行时被拒，vitest 之外的探针也能撞见；
//   2. 送达失败必须出声（console.error），不能静默假装"已经停了"。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockRejectedValue(new Error("not in tauri")),
}));
vi.mock("@/lib/tauriRuntime", () => ({
  isTauriRuntime: vi.fn(() => true),
}));

import { invoke } from "@tauri-apps/api/core";
import { cancelSidecarTurn } from "./sidecar-adapter";
import { stopGeneration } from "../store/chatStore";
import { isTauriRuntime } from "@/lib/tauriRuntime";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const mockIsTauri = isTauriRuntime as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
  mockIsTauri.mockReset();
  mockIsTauri.mockReturnValue(true);
});

describe("cancelSidecarTurn", () => {
  it("按 ipc_invoke 的白名单形状发出 agent.cancel", async () => {
    await cancelSidecarTurn("sess-1");

    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.cancel",
      params: { session_id: "sess-1", reason: "用户点击停止" },
      timeoutMs: 10_000,
    });
  });

  it("空 sessionId 不发无主请求", async () => {
    await cancelSidecarTurn("");

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("非桌面运行时（纯浏览器 dev / vitest）不发 ipc_invoke", async () => {
    mockIsTauri.mockReturnValue(false);

    await cancelSidecarTurn("sess-1");

    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("stopGeneration", () => {
  it("停止 = 掐前端事件流 + 通知 sidecar，两者都做", () => {
    stopGeneration("sess-9");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][1].method).toBe("agent.cancel");
    expect(mockInvoke.mock.calls[0][1].params.session_id).toBe("sess-9");
  });

  it("没有活动会话时什么都不发", () => {
    stopGeneration(undefined);
    stopGeneration(null);

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("cancel 送不出去时要出声，不能静默假装已停", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockInvoke.mockRejectedValue(new Error("Command not found"));

    stopGeneration("sess-9");
    await Promise.resolve();
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalled();
    expect(
      errorSpy.mock.calls.some((args) =>
        args.join(" ").includes("agent.cancel"),
      ),
    ).toBe(true);
    errorSpy.mockRestore();
  });
});
