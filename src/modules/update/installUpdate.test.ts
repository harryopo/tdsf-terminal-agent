import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installHeldUpdate,
  liveInstallDeps,
  type InstallDeps,
} from "./installUpdate";
import { useUpdateStore } from "./updateStore";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  sidecarStop: vi.fn(),
  getHeldUpdate: vi.fn(),
  releaseHeldUpdate: vi.fn(),
  stopGeneration: vi.fn(),
  disconnect: vi.fn(),
  chatState: {
    agentMeta: { status: "idle" as string },
    activeSessionId: "s-1" as string | null,
  },
  needsYou: { pending: [] as Array<{ reqId: string; sessionId: string | null }> },
  sshState: {
    pendingApprovals: [] as unknown[],
    sessions: [] as Array<{ id: string }>,
  },
  blocksState: { agentPending: {} as Record<number, number | undefined> },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@/lib/sidecar-bridge", () => ({ stop: m.sidecarStop }));
vi.mock("./checkUpdate", () => ({
  getHeldUpdate: m.getHeldUpdate,
  releaseHeldUpdate: m.releaseHeldUpdate,
}));
vi.mock("@/modules/ai/store/chatStore", () => ({
  stopGeneration: m.stopGeneration,
  useChatStore: { getState: () => m.chatState },
}));
vi.mock("@/modules/ai/store/needsYouWaitStore", () => ({
  useNeedsYouWait: { getState: () => m.needsYou },
}));
vi.mock("@/modules/ssh-explorer/sshStore", () => ({
  useSshStore: {
    getState: () => ({
      ...m.sshState,
      disconnect: m.disconnect,
    }),
  },
}));
vi.mock("@/modules/terminal/lib/terminalBlocksStore", () => ({
  useTerminalBlocksStore: { getState: () => m.blocksState },
}));

function fakeDeps(order: string[], over: Partial<InstallDeps> = {}): InstallDeps {
  const step = (name: string) => async () => {
    order.push(name);
  };
  return {
    blockers: () => [],
    cancelTurn: () => order.push("cancelTurn"),
    disconnectSsh: step("disconnectSsh"),
    closePty: step("closePty"),
    killLsp: step("killLsp"),
    stopSidecar: step("stopSidecar"),
    install: step("install"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.sshState.sessions = [];
  m.sshState.pendingApprovals = [];
  m.needsYou.pending = [];
  m.blocksState.agentPending = {};
  m.chatState.agentMeta = { status: "idle" };
  m.chatState.activeSessionId = "s-1";
  m.getHeldUpdate.mockReturnValue({ version: "1.0.2" });
  useUpdateStore.setState({
    phase: "ready",
    version: "1.0.2",
    bytes: null,
    received: 0,
    error: null,
    blockers: [],
  });
});

describe("安装必须先把这个窗口自己的现场收干净", () => {
  it("五步收尾全做完，且顺序是：取消本轮 → 断 SSH → 关 PTY → 杀 LSP → 停 sidecar → 安装", async () => {
    const order: string[] = [];
    const got = await installHeldUpdate(fakeDeps(order));
    expect(got.ok).toBe(true);
    expect(order).toEqual([
      "cancelTurn",
      "disconnectSsh",
      "closePty",
      "killLsp",
      "stopSidecar",
      "install",
    ]);
  });

  it("某一步失败不许挡住安装（断不开一条 SSH ≠ 永远更新不了）", async () => {
    const order: string[] = [];
    await installHeldUpdate(
      fakeDeps(order, {
        disconnectSsh: async () => {
          throw new Error("断开失败");
        },
      }),
    );
    expect(order).toContain("install");
  });

  it("安装失败要出声，不许停在'正在安装'那个样子", async () => {
    await installHeldUpdate(
      fakeDeps([], {
        install: async () => {
          throw new Error("installer exited with code 1");
        },
      }),
    );
    const s = useUpdateStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toContain("installer exited with code 1");
  });

  it("手上没有更新对象时不许硬装（正向配对：上一条用例证明正常路径真会装）", async () => {
    const order: string[] = [];
    m.getHeldUpdate.mockReturnValue(null);
    const got = await installHeldUpdate(fakeDeps(order));
    expect(got.ok).toBe(false);
    expect(order).toEqual([]);
    expect(useUpdateStore.getState().phase).toBe("error");
  });
});

describe("该拒装的四类现场", () => {
  it("挂着待答审批 ⇒ 拒装，而且一条都不许提前断（拒装不该改变用户现场）", async () => {
    const order: string[] = [];
    const got = await installHeldUpdate(
      fakeDeps(order, {
        blockers: () => [
          { key: "sidecar-approvals", text: "有 1 条命令在等你确认，先答完再更新。" },
        ],
      }),
    );
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("blocked");
    expect(order).toEqual([]);
    expect(useUpdateStore.getState().blockers).toHaveLength(1);
    expect(useUpdateStore.getState().phase).toBe("ready");
  });

  it("liveInstallDeps 真的读那四个来源（少一个就会漏判一种现场）", () => {
    m.needsYou.pending = [{ reqId: "r1", sessionId: null }];
    m.sshState.pendingApprovals = [{ approvalId: "a1" }];
    m.chatState.agentMeta = { status: "thinking" };
    m.blocksState.agentPending = { 7: 1234 };
    const keys = liveInstallDeps.blockers().map((b) => b.key);
    expect(keys).toEqual([
      "sidecar-approvals",
      "host-approvals",
      "agent-running",
      "pending-executions",
    ]);
  });

  it("四个来源都空 ⇒ 一条都不报（否则每次安装都会被自己拦住）", () => {
    expect(liveInstallDeps.blockers()).toEqual([]);
  });
});

describe("收尾步骤接的是真命令，不是同名的另一个东西", () => {
  it("关 PTY / 杀 LSP 走这两个已注册命令", async () => {
    m.invoke.mockResolvedValue(0);
    await liveInstallDeps.closePty();
    await liveInstallDeps.killLsp();
    expect(m.invoke).toHaveBeenNthCalledWith(1, "pty_close_all");
    expect(m.invoke).toHaveBeenNthCalledWith(2, "lsp_kill_all");
  });

  it("停 sidecar 走 sidecar-bridge 的 stop（它会等优雅退出再按 PID 强杀）", async () => {
    await liveInstallDeps.stopSidecar();
    expect(m.sidecarStop).toHaveBeenCalledTimes(1);
  });

  it("取消本轮用当前会话 id 走 stopGeneration（#69 那条真取消）", () => {
    liveInstallDeps.cancelTurn();
    expect(m.stopGeneration).toHaveBeenCalledWith("s-1");
  });

  it("断 SSH 逐条断掉本窗引用的每一条会话", async () => {
    m.sshState.sessions = [{ id: "a" }, { id: "b" }];
    await liveInstallDeps.disconnectSsh();
    expect(m.disconnect).toHaveBeenNthCalledWith(1, "a");
    expect(m.disconnect).toHaveBeenNthCalledWith(2, "b");
  });
});
