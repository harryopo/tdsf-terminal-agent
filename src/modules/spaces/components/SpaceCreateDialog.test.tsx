/**
 * SpaceCreateDialog.test.tsx —— #111：「测试连接」的失败原因不许撑破弹窗
 * -----------------------------------------------------------------------------
 * 用户 2026-09-22 截图：新建工作区 → SSH 服务器，点「测试连接」后那行红字
 * **画到了弹窗外面**，而且内容是 russh 的 Rust Debug 结构体。
 *
 * 两条各管一头：
 * ① 布局 —— 失败文本原来和按钮挤在同一行 `flex` 里、用 `min-w-0 flex-1 truncate`。
 *   实测（Edge 无头，弹窗 max-w-md=448px）：那行字右边界**超出弹窗 296px**，
 *   而且 `truncate` 根本没生效（父层是 grid 项、自动最小尺寸按内容算）。
 *   所以判据不是"有没有 truncate"，而是**这段文本不许待在按钮那一行里**、
 *   必须是自己一行、允许换行断词（另两种写法量出来：只补 min-w-0 会截断读不全）。
 * ② 文案 —— 中文由 store 的 testConnection 统一给（见 sshStore.testConnection.test.ts），
 *   这里只验"屏幕上看到的是中文、原文只在 title 里"。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// vi.mock 会被提到文件最顶，夹具必须一起 hoisted（普通 const 会"初始化前访问"）
const { sshState, spacesState, workspaceState } = vi.hoisted(() => ({
  sshState: {
    connect: vi.fn(),
    saveConnection: vi.fn(),
    testConnection: vi.fn(),
    savedConnections: [] as unknown[],
    loadSavedConnections: vi.fn().mockResolvedValue(undefined),
  },
  spacesState: {
    spaces: [] as unknown[],
    create: vi.fn(),
    remove: vi.fn(),
    setEnv: vi.fn(),
  },
  workspaceState: {
    distros: [] as unknown[],
    loading: false,
    error: null,
    refreshDistros: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../ssh-explorer/sshStore", () => ({
  useSshStore: (sel: (s: typeof sshState) => unknown) => sel(sshState),
}));
vi.mock("../lib/useSpaces", () => {
  const useSpaces = (sel: (s: typeof spacesState) => unknown) => sel(spacesState);
  // 组件里也按 `useSpaces.getState()` 用（静态面），mock 得一起给
  useSpaces.getState = () => spacesState;
  return { useSpaces };
});
vi.mock("@/modules/workspace", () => {
  const useWorkspaceEnvStore = (sel: (s: typeof workspaceState) => unknown) =>
    sel(workspaceState);
  useWorkspaceEnvStore.getState = () => workspaceState;
  return { useWorkspaceEnvStore, LOCAL_WORKSPACE: { kind: "local" } };
});
vi.mock("@/lib/ssh-bridge", () => ({
  sshCredentialsGetSecret: vi.fn().mockResolvedValue("pw"),
}));

import { SpaceCreateDialog } from "./SpaceCreateDialog";

/** russh 的 Debug 原文（真机截图里那一条） */
const RAW =
  "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey]), partial_success: false }";
const HUMAN = "服务器不接受密码登录：这台 sshd 现在只接受 PublicKey。";

function renderSshDialog() {
  render(
    <SpaceCreateDialog
      open
      onOpenChange={() => {}}
      initialMode="ssh"
      defaultRoot={null}
      onCreated={() => {}}
    />,
  );
}

/** 填必填三项，让「测试连接」按钮可点 */
function fillHostAndUser() {
  const host = document.getElementById("ssh-host") as HTMLInputElement;
  const user = document.getElementById("ssh-user") as HTMLInputElement;
  fireEvent.change(host, { target: { value: "192.168.45.128" } });
  fireEvent.change(user, { target: { value: "root" } });
}

async function clickTest() {
  fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
  await vi.waitFor(() => expect(sshState.testConnection).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  sshState.savedConnections = [];
  sshState.loadSavedConnections.mockResolvedValue(undefined);
});

describe("SpaceCreateDialog — 测试连接的失败呈现", () => {
  it("失败文本自己一行、允许换行，不许挤在按钮那一行里（撑破弹窗的那条路）", async () => {
    sshState.testConnection.mockResolvedValue({ ok: false, message: HUMAN, raw: RAW });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();

    const msg = await vi.waitFor(() => {
      const el = screen.getByTestId("space-create-test-result");
      expect(el.textContent).toContain("服务器不接受密码登录");
      return el;
    });

    // ① 不在按钮那一行内 —— 在里面的话长文本会把整行撑出弹窗
    const buttonRow = screen
      .getByRole("button", { name: /测试连接/ })
      .closest("div") as HTMLElement;
    expect(buttonRow.contains(msg)).toBe(false);
    // ② 允许换行断词，不靠截断（截断会读不全，"方便检查"就反了）
    expect(msg.className).toContain("break-words");
    expect(msg.className).not.toContain("truncate");
  });

  it("屏幕上只出中文，Rust 原文留在 title 里供排查", async () => {
    sshState.testConnection.mockResolvedValue({ ok: false, message: HUMAN, raw: RAW });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();

    await vi.waitFor(() =>
      expect(screen.getByTestId("space-create-test-result")).toBeTruthy(),
    );
    const msg = screen.getByTestId("space-create-test-result");
    expect(msg.textContent).not.toContain("MethodSet");
    expect(msg.getAttribute("title")).toContain("MethodSet");
  });

  // 正向配对：上面两条"不含原文"的断言，必须建立在"这一行确实会渲染出来"之上
  it("成功 → 同一处显示连接成功（不是永远空白）", async () => {
    sshState.testConnection.mockResolvedValue({ ok: true, message: "ok" });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();

    await vi.waitFor(() =>
      expect(screen.getByTestId("space-create-test-result")).toBeTruthy(),
    );
    expect(screen.getByTestId("space-create-test-result").textContent).toContain(
      "连接成功",
    );
    expect(screen.getByRole("button", { name: /测试连接/ })).toBeTruthy();
  });
});
