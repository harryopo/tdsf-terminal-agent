import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(async () => undefined),
  stopSidecar: vi.fn(async () => undefined),
  cancelTurn: vi.fn(),
  editorCount: 0,
  dirtyOnFirstCleanup: false,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: m.check }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/modules/agents/lib/notify", () => ({ osNotify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getAllWindows: async () => [{ label: "main" }],
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/sidecar-bridge", () => ({ stop: m.stopSidecar }));
vi.mock("@/modules/ai/store/chatStore", () => ({
  stopGeneration: (...args: unknown[]) => {
    m.cancelTurn(...args);
    if (m.dirtyOnFirstCleanup) {
      m.dirtyOnFirstCleanup = false;
      m.editorCount = 1;
    }
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
      disconnect: vi.fn(),
    }),
  },
}));
vi.mock("@/modules/terminal/lib/terminalBlocksStore", () => ({
  useTerminalBlocksStore: { getState: () => ({ agentPending: {} }) },
}));

function update() {
  return {
    available: true,
    version: "1.0.4",
    body: null,
    close: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
  };
}

let UpdateChip: (typeof import("./UpdateChip"))["UpdateChip"];
let checkUpdate: typeof import("@/modules/update/checkUpdate");
let store: (typeof import("@/modules/update/updateStore"))["useUpdateStore"];
let held: ReturnType<typeof update>;

beforeEach(async () => {
  vi.clearAllMocks();
  m.editorCount = 0;
  m.dirtyOnFirstCleanup = false;
  window.localStorage.clear();
  vi.resetModules();
  held = update();
  m.check.mockResolvedValue(held);
  checkUpdate = await import("@/modules/update/checkUpdate");
  store = (await import("@/modules/update/updateStore")).useUpdateStore;
  UpdateChip = (await import("./UpdateChip")).UpdateChip;
  await checkUpdate.runUpdateCheck({ force: true });
  await checkUpdate.downloadHeldUpdate();
});

function openInstallDialog() {
  render(<UpdateChip getUnsavedEditors={() => m.editorCount} />);
  fireEvent.click(screen.getByTestId("update-chip"));
  fireEvent.click(screen.getByRole("button", { name: "重启并安装" }));
}

describe("更新安装前的未保存编辑保护", () => {
  it("有未保存编辑器时用中文阻止安装，保持 ready 且不开始五步收尾", async () => {
    m.editorCount = 2;
    openInstallDialog();

    expect(await screen.findByText(/未保存/)).toBeTruthy();
    expect(store.getState().phase).toBe("ready");
    expect(m.cancelTurn).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
    expect(m.stopSidecar).not.toHaveBeenCalled();
    expect(held.install).not.toHaveBeenCalled();
    expect(checkUpdate.getHeldUpdate()).toBe(held);
  });

  it("初始无未保存编辑但收尾中出现时不安装，保存后可重试完成", async () => {
    m.dirtyOnFirstCleanup = true;
    openInstallDialog();

    expect(await screen.findByText(/未保存/)).toBeTruthy();
    expect(store.getState().phase).toBe("ready");
    expect(held.install).not.toHaveBeenCalled();
    expect(checkUpdate.getHeldUpdate()).toBe(held);

    m.editorCount = 0;
    fireEvent.click(screen.getByRole("button", { name: "重启并安装" }));
    await waitFor(() => expect(held.install).toHaveBeenCalledTimes(1));
    expect(store.getState().phase).toBe("installing");
  });
});
