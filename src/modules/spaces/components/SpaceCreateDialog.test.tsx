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
    lastConnectFailure: null as {
      raw: string;
      host: string;
      port?: number;
      user: string;
    } | null,
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

vi.mock("../../ssh-explorer/sshStore", () => {
  const useSshStore = (sel: (s: typeof sshState) => unknown) => sel(sshState);
  // 「连接并创建」失败后组件按 `useSshStore.getState()` 读 lastConnectFailure（静态面）
  useSshStore.getState = () => sshState;
  return { useSshStore };
});
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
  sshState.lastConnectFailure = null;
  sshState.loadSavedConnections.mockResolvedValue(undefined);
});

describe("SpaceCreateDialog — 测试连接的失败呈现", () => {
  it("失败文本自己一行、允许换行，不许挤在按钮那一行里（撑破弹窗的那条路）", async () => {
    sshState.testConnection.mockResolvedValue({ ok: false, message: HUMAN, raw: RAW });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();

    await vi.waitFor(() => {
      const el = screen.getByTestId("space-create-test-result");
      expect(el.textContent).toContain("服务器不接受密码登录");
    });

    // ① 不在按钮那一行内 —— 在里面的话长文本会把整行撑出弹窗
    // 失败现在会自动弹诊断窗（2026-09-28 实测⑤），窗开着时底层弹窗被 Radix 标成
    // inert、a11y 树里查不到按钮，所以要量排版的这一条先关窗
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    const buttonRow = screen
      .getByRole("button", { name: /测试连接/ })
      .closest("div") as HTMLElement;
    // 2026-09-28：这一行右边多了「查看诊断」按钮，所以断言落在**装文字的那个元素**上，
    // 而不是外层容器（外层本来就是 flex 行，文字在它里面的 span 里）。
    const text = screen.getByTestId("space-create-test-result-text");
    expect(buttonRow.contains(text)).toBe(false);
    // ② 允许换行断词，不靠截断（截断会读不全，"方便检查"就反了）
    expect(text.className).toContain("break-words");
    expect(text.className).not.toContain("truncate");
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

describe("SpaceCreateDialog — 已保存的服务器：选中 / 眼睛 / 删除", () => {
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

  const field = (id: string) =>
    document.getElementById(id) as HTMLInputElement;
  const selectSaved = () => fireEvent.click(screen.getByTestId("saved-server-row"));

  it("点一行回填右侧表单（两栏重排不许把这个旧行为弄丢）", () => {
    renderSshDialog();
    selectSaved();
    expect(field("ssh-host").value).toBe("10.0.0.1");
    expect(field("ssh-user").value).toBe("root");
    expect(field("ssh-port").value).toBe("22");
    // 配对：这一行确实被认成"当前选中"，不是只填了表单而列表毫无反馈
    expect(screen.getByTestId("saved-server-row").getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("选中态是派生的：手改过主机之后高亮自己消失", () => {
    renderSshDialog();
    selectSaved();
    fireEvent.change(field("ssh-host"), { target: { value: "10.0.0.99" } });
    expect(screen.getByTestId("saved-server-row").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("选中一条不会自己去碰密钥库，密码框保持为空", () => {
    renderSshDialog();
    selectSaved();
    expect(field("ssh-password").value).toBe("");
    expect(sshCredentialsGetSecret).not.toHaveBeenCalled();
  });

  it("点「显示已保存的密码」才取明文，再点即从界面消失", async () => {
    renderSshDialog();
    selectSaved();
    fireEvent.click(screen.getByLabelText("显示已保存的密码"));
    // 等界面真的出现明文，而不是等"函数被调用过"
    await vi.waitFor(() => expect(field("ssh-password").value).toBe("pw"));
    expect(sshCredentialsGetSecret).toHaveBeenCalledWith("root@10.0.0.1:22");

    fireEvent.click(screen.getByLabelText("隐藏已保存的密码"));
    await vi.waitFor(() => expect(field("ssh-password").value).toBe(""));
  });

  it("隐藏后再显示必须重新点、重新取一次——明文不许自己回来", async () => {
    renderSshDialog();
    selectSaved();
    fireEvent.click(screen.getByLabelText("显示已保存的密码"));
    await vi.waitFor(() => expect(field("ssh-password").value).toBe("pw"));
    expect(sshCredentialsGetSecret).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("隐藏已保存的密码"));
    await vi.waitFor(() => expect(field("ssh-password").value).toBe(""));
    // 取密钥这件事只能由"点眼睛"触发：隐藏本身不许留着缓存
    expect(sshCredentialsGetSecret).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("显示已保存的密码"));
    await vi.waitFor(() => expect(field("ssh-password").value).toBe("pw"));
    expect(sshCredentialsGetSecret).toHaveBeenCalledTimes(2);
  });

  it("删除要二次确认：第一下只出确认条，确认后才调 store", async () => {
    renderSshDialog();
    fireEvent.click(screen.getByLabelText(/删除 root@10\.0\.0\.1:22/));
    expect(sshState.deleteSavedConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("删除这条本机凭据");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await vi.waitFor(() =>
      expect(sshState.deleteSavedConnection).toHaveBeenCalledWith(
        "root@10.0.0.1:22",
      ),
    );
  });
});

// 2026-09-28 用户实测④：「如果我在 ssh 那里测试连接，失败的内容会显示到本地工作区，wsl」
describe("SpaceCreateDialog — 测试结果只属于 SSH 那一档", () => {
  /** 先证明它在 SSH 档确实渲染出来了，否则"切走后没了"会因为"压根没出现过"而假绿 */
  async function failOnce() {
    sshState.testConnection.mockResolvedValue({
      ok: false,
      message: HUMAN,
      raw: RAW,
    });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();
    await vi.waitFor(() =>
      expect(screen.getByTestId("space-create-test-result")).toBeTruthy(),
    );
    expect(screen.getByTestId("space-create-test-result").textContent).toContain(
      "服务器不接受密码登录",
    );
    // 诊断窗是失败后自动弹的，切档前先关掉，免得把"弹窗还在"混进这条判据
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  }

  it.each([
    ["本地工作区", "本地工作区"],
    ["WSL", "WSL"],
  ])("测试失败后切到「%s」，那条红字不许还挂在弹窗里", async (_label, name) => {
    await failOnce();

    fireEvent.click(screen.getByRole("button", { name }));

    expect(screen.queryByTestId("space-create-test-result")).toBeNull();
  });
});

// 2026-09-28 用户实测⑤：「失败的话弹出来一个详细窗口（就像指纹验证一样），
// 分析到底是那一步有问题，是服务器没开密码登录，还是什么原因」
describe("SpaceCreateDialog — 失败的分步诊断窗", () => {
  /** 他真机 rust.log 16:58:26 那条原文（服务器接受 PublicKey + Password） */
  const RAW_PWD_REJECTED =
    "authentication failed for user root: Failure { remaining_methods: MethodSet([PublicKey, Password]), partial_success: false }";

  it("测试连接失败 → 自动弹诊断窗：前三步已通过，第四步卡住", async () => {
    sshState.testConnection.mockResolvedValue({
      ok: false,
      message: HUMAN,
      raw: RAW_PWD_REJECTED,
    });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();

    await vi.waitFor(() =>
      expect(screen.getByTestId("ssh-diagnose-stages")).toBeTruthy(),
    );
    for (const key of ["network", "handshake", "hostKey"]) {
      expect(
        screen.getByTestId(`ssh-diagnose-stage-${key}`).getAttribute("data-state"),
      ).toBe("passed");
    }
    const auth = screen.getByTestId("ssh-diagnose-stage-auth");
    expect(auth.getAttribute("data-state")).toBe("failed");
    expect(auth.textContent).toContain("卡在这里");
    // 他问的"是不是服务器没开密码登录"就靠这一行回答
    expect(screen.getByTestId("ssh-diagnose-methods").textContent).toContain(
      "PublicKey / Password",
    );
    expect(screen.getByTestId("ssh-diagnose-raw").textContent).toContain(
      "MethodSet",
    );
  });

  it("关掉后可以从状态行「查看诊断」再打开；成功那一档不许有这个按钮", async () => {
    sshState.testConnection.mockResolvedValue({
      ok: false,
      message: HUMAN,
      raw: RAW_PWD_REJECTED,
    });
    renderSshDialog();
    fillHostAndUser();
    await clickTest();
    await vi.waitFor(() =>
      expect(screen.getByTestId("ssh-diagnose-stages")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByTestId("ssh-diagnose-stages")).toBeNull();

    fireEvent.click(screen.getByTestId("space-create-diagnose"));
    expect(screen.getByTestId("ssh-diagnose-stages")).toBeTruthy();
    // 关窗再点下一次「测试连接」：诊断窗开着时底层被 Radix 标成 inert，查不到按钮
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    // 负向配正向：换成成功，红字那行还在（说明这一档确实渲染了），但诊断入口必须没有
    sshState.testConnection.mockResolvedValue({ ok: true, message: "ok" });
    fireEvent.click(screen.getByRole("button", { name: /测试连接/ }));
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("space-create-test-result").textContent,
      ).toContain("连接成功"),
    );
    expect(screen.queryByTestId("space-create-diagnose")).toBeNull();
  });

  it("本地校验就拦下的失败（没走到网络）不弹诊断窗，也不给入口", async () => {
    renderSshDialog();
    fillHostAndUser();
    const port = document.getElementById("ssh-port") as HTMLInputElement;
    fireEvent.change(port, { target: { value: "99999" } });
    fireEvent.click(screen.getByRole("button", { name: /连接并创建/ }));

    await vi.waitFor(() =>
      expect(
        screen.getByTestId("space-create-test-result").textContent,
      ).toContain("端口必须是 1-65535"),
    );
    expect(screen.queryByTestId("space-create-diagnose")).toBeNull();
    expect(screen.queryByTestId("ssh-diagnose-stages")).toBeNull();
  });

  it("「连接并创建」失败不自动弹（toast 已说过一次），但状态行给入口并写明原因", async () => {
    sshState.connect.mockResolvedValue(null);
    sshState.saveConnection.mockResolvedValue(undefined);
    sshState.lastConnectFailure = {
      raw: RAW_PWD_REJECTED,
      host: "192.168.45.128",
      port: 22,
      user: "root",
    };
    spacesState.create.mockReturnValue({ id: "sp-new" });
    renderSshDialog();
    fillHostAndUser();
    fireEvent.click(screen.getByRole("button", { name: /连接并创建/ }));

    // 旧行为这里只写"SSH 连接失败, 请检查参数或网络"——Rust 明明报了认证失败，界面等于没说
    await vi.waitFor(() =>
      expect(
        screen.getByTestId("space-create-test-result").textContent,
      ).toContain("用户名或密码不对"),
    );
    expect(screen.queryByTestId("ssh-diagnose-stages")).toBeNull();
    expect(spacesState.remove).toHaveBeenCalledWith("sp-new");

    fireEvent.click(screen.getByTestId("space-create-diagnose"));
    expect(screen.getByTestId("ssh-diagnose-stage-auth").textContent).toContain(
      "root",
    );
  });
});
