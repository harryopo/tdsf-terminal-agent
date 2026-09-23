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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// vi.mock 会被提到文件最顶，夹具必须一起 hoisted（普通 const 会"初始化前访问"）
const { sshState, spacesState, workspaceState } = vi.hoisted(() => ({
  sshState: {
    connect: vi.fn(),
    saveConnection: vi.fn(),
    testConnection: vi.fn(),
    deleteSavedConnection: vi.fn().mockResolvedValue(undefined),
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
// 已被 vi.mock 成返回 "pw" 的假密钥库；这里拿它断言"什么时候真的去取"
import { sshCredentialsGetSecret } from "@/lib/ssh-bridge";

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

describe("SpaceCreateDialog — 状态只有一槽", () => {
  // 用户 2026-09-23 截图：绿色"连接成功"和红色"SSH 连接失败"同屏。
  // 根因是 testResult 与 error 两块互不清除的独立区域。
  it("测试成功后再失败，屏上只剩失败那一条，旧的绿色不许留着", async () => {
    sshState.testConnection.mockResolvedValueOnce({
      ok: true,
      message: "连接成功: root@h:22",
    });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();
    expect(
      screen.getByTestId("space-create-test-result").textContent,
    ).toContain("连接成功");

    sshState.testConnection.mockResolvedValueOnce({
      ok: false,
      message: "连不上这台服务器",
      raw: "transport error",
    });
    fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
    // 等的是"界面换成这一条"，不是"函数被调用过"——后者在第一次点完就恒真，会把断言架空
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("space-create-test-result").textContent,
      ).toContain("连不上这台服务器"),
    );
    const blocks = screen.getAllByTestId("space-create-test-result");
    expect(blocks).toHaveLength(1);
    // 配对：不是"两块都没渲染"造成的长度为 1
    expect(blocks[0].textContent).not.toContain("连接成功");
  });

  it("校验错误也走同一个槽，不再另起第二块红字", async () => {
    renderSshDialog();
    fillHostAndUser();
    const port = document.getElementById("ssh-port") as HTMLInputElement;
    fireEvent.change(port, { target: { value: "99999" } });
    fireEvent.click(screen.getByRole("button", { name: /连接并创建/ }));

    const blocks = await screen.findAllByTestId("space-create-test-result");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toContain("端口必须是 1-65535");
  });
});

describe("SpaceCreateDialog — 已保存的服务器：详情 / 眼睛 / 删除", () => {
  const profile = {
    id: "root@10.0.0.1:22",
    alias: "root@10.0.0.1:22",
    host: "10.0.0.1",
    port: 22,
    user: "root",
    auth: { type: "password" },
    lastUsed: 1790000000000,
    createdAt: 1789000000000,
  };

  beforeEach(() => {
    sshState.savedConnections = [profile];
  });
  afterEach(() => {
    sshState.savedConnections = [];
  });

  function openDetail() {
    fireEvent.click(screen.getByLabelText(/查看 root@10\.0\.0\.1:22 详情/));
  }

  it("详情默认不渲染；点开后密码是掩码，且不会自己去碰密钥库", async () => {
    renderSshDialog();
    expect(
      screen.queryByTestId("saved-server-detail"),
    ).toBeNull();

    openDetail();
    const detail = await screen.findByTestId("saved-server-detail");
    expect(detail.textContent).toContain("10.0.0.1");
    expect(detail.textContent).toContain("••••••••");
    expect(detail.textContent).not.toContain("pw");
    expect(sshCredentialsGetSecret).not.toHaveBeenCalled();
  });

  it("点眼睛才去密钥库取明文，再点收起就从界面消失", async () => {
    renderSshDialog();
    openDetail();
    await screen.findByTestId("saved-server-detail");

    fireEvent.click(screen.getByLabelText("显示密码"));
    // 等界面出现明文，而不是等"函数被调用"
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("saved-server-detail").textContent,
      ).toContain("pw"),
    );
    expect(sshCredentialsGetSecret).toHaveBeenCalledWith("root@10.0.0.1:22");

    fireEvent.click(screen.getByLabelText("隐藏密码"));
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("saved-server-detail").textContent,
      ).not.toContain("pw"),
    );
  });

  it("收起再展开，明文不许自己回来——必须重新点眼睛、重新取一次", async () => {
    renderSshDialog();
    openDetail();
    await screen.findByTestId("saved-server-detail");
    fireEvent.click(screen.getByLabelText("显示密码"));
    // 先证明明文真的上过屏，否则后面的"没回来"是假绿
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("saved-server-detail").textContent,
      ).toContain("pw"),
    );
    expect(sshCredentialsGetSecret).toHaveBeenCalledTimes(1);

    openDetail(); // 收起
    await vi.waitFor(() =>
      expect(screen.queryByTestId("saved-server-detail")).toBeNull(),
    );

    openDetail(); // 再展开同一台
    const detail = await screen.findByTestId("saved-server-detail");
    expect(detail.textContent).not.toContain("pw");
    // 取密钥这件事只能由"点眼睛"触发，展开本身不许顺手取
    expect(sshCredentialsGetSecret).toHaveBeenCalledTimes(1);
  });

  it("删除要二次确认：第一下只出确认条，确认后才调 store", async () => {
    renderSshDialog();
    fireEvent.click(screen.getByLabelText(/删除 root@10\.0\.0\.1:22/));
    expect(sshState.deleteSavedConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("删除本机保存的这条凭据");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await vi.waitFor(() =>
      expect(sshState.deleteSavedConnection).toHaveBeenCalledWith(
        "root@10.0.0.1:22",
      ),
    );
  });

  it("点整行仍然回填表单（两栏重排不许把旧行为弄丢）", () => {
    renderSshDialog();
    fireEvent.click(
      screen.getByText("root@10.0.0.1:22").closest("button") as HTMLElement,
    );
    expect(
      (document.getElementById("ssh-host") as HTMLInputElement).value,
    ).toBe("10.0.0.1");
    expect(
      (document.getElementById("ssh-user") as HTMLInputElement).value,
    ).toBe("root");
  });
});
