import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(async () => undefined),
  stopSidecar: vi.fn(async () => undefined),
  cancelTurn: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  windows: [{ label: "main" }],
  currentLabel: "main",
  windowError: false,
  addMainOnCancel: false,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: m.check }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/modules/agents/lib/notify", () => ({ osNotify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: () =>
    m.windowError
      ? Promise.reject(new Error("window query failed"))
      : Promise.resolve(m.windows),
  getCurrentWindow: () => ({ label: m.currentLabel }),
}));
vi.mock("@/lib/sidecar-bridge", () => ({ stop: m.stopSidecar }));
vi.mock("@/modules/ai/store/chatStore", () => ({
  stopGeneration: () => {
    m.cancelTurn();
    if (m.addMainOnCancel) m.windows = [{ label: "main" }, { label: "main-2" }];
  },
  useChatStore: {
    getState: () => ({ agentMeta: { status: "idle" }, activeSessionId: "s1" }),
  },
}));
vi.mock("@/modules/ai/store/needsYouWaitStore", () => ({
  useNeedsYouWait: { getState: () => ({ pending: [] }) },
}));
vi.mock("@/modules/ssh-explorer/sshStore", () => ({
  useSshStore: {
    getState: () => ({
      pendingApprovals: [],
      sessions: [],
      disconnect: m.disconnect,
    }),
  },
}));
vi.mock("@/modules/terminal/lib/terminalBlocksStore", () => ({
  useTerminalBlocksStore: { getState: () => ({ agentPending: {} }) },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

function update(version = "1.0.4") {
  return {
    available: true,
    version,
    body: null,
    close: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
  };
}

function deps(order: string[], over: Record<string, unknown> = {}) {
  return {
    blockers: () => [],
    cancelTurn: () => order.push("cancel"),
    disconnectSsh: async () => void order.push("ssh"),
    closePty: async () => void order.push("pty"),
    killLsp: async () => void order.push("lsp"),
    stopSidecar: async () => void order.push("sidecar"),
    install: async () => void order.push("install"),
    ...over,
  };
}

let checkUpdate: typeof import("./checkUpdate");
let installUpdate: typeof import("./installUpdate");
let store: (typeof import("./updateStore"))["useUpdateStore"];
let held: ReturnType<typeof update>;

beforeEach(async () => {
  vi.clearAllMocks();
  m.windows = [{ label: "main" }];
  m.currentLabel = "main";
  m.windowError = false;
  m.addMainOnCancel = false;
  window.localStorage.clear();
  vi.resetModules();
  checkUpdate = await import("./checkUpdate");
  installUpdate = await import("./installUpdate");
  store = (await import("./updateStore")).useUpdateStore;
  held = update();
  m.check.mockResolvedValue(held);
  await checkUpdate.runUpdateCheck({ force: true });
  await checkUpdate.downloadHeldUpdate();
});

describe("安装生命周期", () => {
  it("只有 ready 更新可安装；downloading 阶段不开始清理或安装", async () => {
    store.setState({ phase: "downloading" });
    const order: string[] = [];
    const result = await installUpdate.installHeldUpdate(deps(order));
    expect(result.ok).toBe(false);
    expect(order).toEqual([]);
    expect(checkUpdate.getHeldUpdate()).not.toBeNull();
  });

  it("并发 install 只允许一组收尾和一次安装", async () => {
    const order: string[] = [];
    const waiting = deferred<void>();
    const first = installUpdate.installHeldUpdate(
      deps(order, { disconnectSsh: () => waiting.promise }),
    );
    await vi.waitFor(() => expect(store.getState().phase).toBe("installing"));
    const second = await installUpdate.installHeldUpdate(deps(order));
    expect(second.ok).toBe(false);
    waiting.resolve();
    expect((await first).ok).toBe(true);
    expect(order).toEqual(["cancel", "pty", "lsp", "sidecar", "install"]);
  });

  it("异步 blockers 尚未完成时占用安装状态，第二次调用不得进入收尾", async () => {
    const order: string[] = [];
    const waiting = deferred<import("./updateFacts").InstallBlocker[]>();
    let blockersStarted = false;
    const first = installUpdate.installHeldUpdate({
      ...deps(order),
      blockers: () => {
        blockersStarted = true;
        return waiting.promise;
      },
    });
    await vi.waitFor(() => expect(blockersStarted).toBe(true));

    const second = await installUpdate.installHeldUpdate(deps(order));
    const orderBeforeRelease = [...order];
    waiting.resolve([]);
    const firstResult = await first;

    expect(second.ok).toBe(false);
    expect(orderBeforeRelease).toEqual([]);
    expect(firstResult.ok).toBe(true);
    expect(order.filter((step) => step === "install")).toHaveLength(1);
  });

  it("收尾期间出现新阻断时，最终检查拦住安装", async () => {
    const order: string[] = [];
    const waiting = deferred<void>();
    let cleanupStarted = false;
    let blocked = false;
    const pendingInstall = installUpdate.installHeldUpdate(
      deps(order, {
        blockers: () =>
          blocked
            ? [{ key: "agent-running", text: "智能体正在运行，请等待结束。" }]
            : [],
        stopSidecar: () => {
          cleanupStarted = true;
          return waiting.promise;
        },
      }),
    );
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    blocked = true;
    waiting.resolve();
    const result = await pendingInstall;

    expect(result.ok).toBe(false);
    expect(order).not.toContain("install");
    expect(store.getState()).toMatchObject({
      phase: "ready",
      blockers: [expect.objectContaining({ key: "agent-running" })],
    });
  });

  it("另一个 main 窗口存在时初次检查阻止安装且不开始清理", async () => {
    m.windows = [{ label: "main" }, { label: "main-2" }];
    const result = await installUpdate.installHeldUpdate(
      installUpdate.liveInstallDeps,
    );

    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    if (!result.ok && result.reason === "blocked") {
      expect(
        result.blockers.some((blocker) =>
          /先保存并关闭其他主窗/.test(blocker.text),
        ),
      ).toBe(true);
    }
    expect(m.cancelTurn).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
    expect(m.stopSidecar).not.toHaveBeenCalled();
    expect(held.install).not.toHaveBeenCalled();
  });

  it("从 main-2 发起时，main 仍作为另一个主窗阻止安装", async () => {
    m.windows = [{ label: "main" }, { label: "main-2" }];
    m.currentLabel = "main-2";
    const result = await installUpdate.installHeldUpdate(
      installUpdate.liveInstallDeps,
    );

    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    if (!result.ok && result.reason === "blocked") {
      expect(
        result.blockers.some((blocker) =>
          /先保存并关闭其他主窗/.test(blocker.text),
        ),
      ).toBe(true);
    }
    expect(m.cancelTurn).not.toHaveBeenCalled();
    expect(held.install).not.toHaveBeenCalled();
  });

  it("只有当前主窗和 settings 窗口时仍允许安装", async () => {
    m.windows = [{ label: "main" }, { label: "settings" }];

    expect(await installUpdate.liveInstallDeps.blockers()).toEqual([]);
    const result = await installUpdate.installHeldUpdate(
      installUpdate.liveInstallDeps,
    );

    expect(result.ok).toBe(true);
    expect(held.install).toHaveBeenCalledTimes(1);
  });

  it("窗口清单读取失败时保守阻止安装且不开始清理", async () => {
    m.windowError = true;
    const result = await installUpdate.installHeldUpdate(
      installUpdate.liveInstallDeps,
    );

    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    expect(m.cancelTurn).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
    expect(m.stopSidecar).not.toHaveBeenCalled();
    expect(held.install).not.toHaveBeenCalled();
  });

  it("窗口清单没有当前主窗时保守阻止安装", async () => {
    m.windows = [{ label: "main-2" }];
    const result = await installUpdate.installHeldUpdate(
      installUpdate.liveInstallDeps,
    );

    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    expect(m.cancelTurn).not.toHaveBeenCalled();
    expect(held.install).not.toHaveBeenCalled();
  });

  it("五步收尾期间新主窗出现时，最终窗口检查阻止安装", async () => {
    m.addMainOnCancel = true;
    const result = await installUpdate.installHeldUpdate(
      installUpdate.liveInstallDeps,
    );

    expect(result).toMatchObject({ ok: false, reason: "blocked" });
    expect(m.cancelTurn).toHaveBeenCalledTimes(1);
    expect(held.install).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe("ready");
  });
});
