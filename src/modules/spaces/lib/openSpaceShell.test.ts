/**
 * openSpaceShell.test.ts —— #89：SSH 工作区里"每个标签页各开一条连接"的入口
 *
 * 用户决策 1 原话："连接后可以新建多个 shell 终端，而且相互独立不影响"。
 * 此前新标签页复用 `space.env.sessionId`（同一条远端 shell），两条 tab 互相镜像。
 * 这里钉住三件事：① 只有**真连着**的 SSH 工作区才走这条路；② 凭据按
 * host/user/port 精确匹配已保存项，命中就走 `connectWithSaved` 开新连接；
 * ③ 没有保存凭据时**必须明示**（toast），绝不静默降级成本地 shell。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { WorkspaceEnv } from "@/modules/workspace";
import { toast } from "sonner";
import {
  __resetReconnectGuard,
  openSshShellForEnv,
  reconnectSshSpace,
  wantsPerTabSshShell,
} from "./openSpaceShell";
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

const env: WorkspaceEnv = {
  kind: "ssh",
  host: "10.0.0.8",
  user: "root",
  port: 22,
  sessionId: "s-live",
  label: "root@10.0.0.8",
};

const profile = {
  id: "pf-1",
  alias: "root@10.0.0.8",
  host: "10.0.0.8",
  port: 22,
  user: "root",
  auth: { type: "publickey", privateKeyPath: "/k/id_ed25519" },
  lastUsed: 0,
  createdAt: 0,
};

const connectWithSaved = vi.fn();
const loadSavedConnections = vi.fn(async () => {});

beforeEach(() => {
  connectWithSaved.mockReset();
  loadSavedConnections.mockReset();
  loadSavedConnections.mockResolvedValue(undefined);
  vi.mocked(toast.warning).mockClear();
  useSshStore.setState({
    sessions: [
      { id: "s-live", rustSessionId: 1, state: "connected" },
    ] as never,
    savedConnections: [profile] as never,
    connectWithSaved,
    loadSavedConnections,
  });
});

describe("wantsPerTabSshShell", () => {
  it("本地 / WSL / 未连接的 SSH 工作区都不走这条路", () => {
    expect(wantsPerTabSshShell({ kind: "local" })).toBe(false);
    expect(wantsPerTabSshShell({ kind: "wsl", distro: "Ubuntu" })).toBe(false);
    const { sessionId: _gone, ...detached } = env;
    expect(wantsPerTabSshShell(detached)).toBe(false);
    expect(wantsPerTabSshShell(undefined)).toBe(false);
  });

  it("会话真活着才算", () => {
    expect(wantsPerTabSshShell(env)).toBe(true);
  });
});

describe("openSshShellForEnv", () => {
  it("按 host/user/port 精确命中已保存凭据 → 开一条新连接", async () => {
    connectWithSaved.mockResolvedValue("s-new");
    expect(await openSshShellForEnv(env)).toBe("s-new");
    expect(connectWithSaved).toHaveBeenCalledTimes(1);
    expect(connectWithSaved.mock.calls[0][0]).toMatchObject({
      id: "pf-1",
      host: "10.0.0.8",
      user: "root",
      port: 22,
    });
    // #101：必须标成"为这个标签页开的连接"。少了它，连接成功订阅会当成工作区
    // 级连接处理——再补建一条 tab 并改写工作区主会话，用户看到"像复制了一份 shell"。
    expect(connectWithSaved.mock.calls[0][1]).toMatchObject({ origin: "tab" });
  });

  it("端口不同就不算同一台机器（不许拿错凭据去连）", async () => {
    connectWithSaved.mockResolvedValue("s-new");
    const otherPort = { ...env, port: 2222 };
    expect(await openSshShellForEnv(otherPort)).toBeNull();
    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
  });

  it("凭据列表还没加载过 → 先补拉一次再判（否则刚连上就新建标签页会被误判）", async () => {
    useSshStore.setState({ savedConnections: [] as never });
    loadSavedConnections.mockImplementation(async () => {
      useSshStore.setState({ savedConnections: [profile] as never });
    });
    connectWithSaved.mockResolvedValue("s-new");
    expect(await openSshShellForEnv(env)).toBe("s-new");
    expect(loadSavedConnections).toHaveBeenCalledTimes(1);
  });

  it("补拉之后仍然没有保存凭据 → null + 明示，不静默开本地壳", async () => {
    useSshStore.setState({ savedConnections: [] as never });
    expect(await openSshShellForEnv(env)).toBeNull();
    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const desc = vi.mocked(toast.warning).mock.calls[0][1] as {
      description: string;
    };
    expect(desc.description).toContain("root@10.0.0.8:22");
  });

  it("连接失败（connectWithSaved 返回 null）也如实返回 null", async () => {
    connectWithSaved.mockResolvedValue(null);
    expect(await openSshShellForEnv(env)).toBeNull();
  });

  it("非 SSH env 直接 null，不碰 store", async () => {
    expect(await openSshShellForEnv({ kind: "local" })).toBeNull();
    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(loadSavedConnections).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #102（2026-09-21 用户实测"点击打开已有工作区的时候，显示 sftp time out"）
// ----------------------------------------------------------------------------
// SSH 工作区的身份跨重启留着（#93），会话却随上个生命周期没了；启动自动连接只覆盖
// "最近使用的那一台"。进这种工作区不重连，界面就按 SSH 渲染、左侧文件树拿着失效的
// 会话号去开 SFTP，握手 10 秒后整块面板报 `[fsb] sftp session error: Timeout`。
// 判据：① 命中保存凭据 → 以**工作区重连**身份连（autoConnect，不带 origin:"tab"，
// 否则 #101 的闸门会让它没有落点）；② 连不上必须说话，不许静默显示成本地文件树；
// ③ 同一个工作区重复触发只连一次。
// ============================================================================
describe("reconnectSshSpace — 进入失效的 SSH 工作区要主动重连", () => {
  beforeEach(() => {
    __resetReconnectGuard();
  });

  it("命中保存凭据 → 以 autoConnect 重连，且**不**标成标签页专用", async () => {
    connectWithSaved.mockResolvedValue("s-reconnected");
    const id = await reconnectSshSpace("space-1", env);
    expect(id).toBe("s-reconnected");
    expect(connectWithSaved).toHaveBeenCalledTimes(1);
    expect(connectWithSaved.mock.calls[0][1]).toEqual({ autoConnect: true });
  });

  it("没有保存凭据 → null + 说清是哪台，不静默", async () => {
    useSshStore.setState({ savedConnections: [] as never });
    expect(await reconnectSshSpace("space-1", env)).toBeNull();
    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const desc = vi.mocked(toast.warning).mock.calls[0][1] as {
      description: string;
    };
    expect(desc.description).toContain("root@10.0.0.8:22");
  });

  // #110：这里**不再**自己弹第二条。旧行为是 connect() 弹一条英文 Debug、
  // 这里再弹一条"可在 SSH 面板手动重试"（那个面板早已没入口），两条叠在屏幕上。
  // "不许静默"这条保证换了归属：connect() 按翻译后的原因弹一条（见
  // sshStore.connectToast.test.ts），左侧离线面板就地显示失败（见 SshExplorerOffline.test.tsx）。
  it("连不上时不重复弹 toast，避免一次失败两条通知", async () => {
    connectWithSaved.mockResolvedValue(null);
    expect(await reconnectSshSpace("space-1", env)).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("同一个工作区并发触发只连一次（切进切出 / 重复渲染）", async () => {
    let release: (v: string) => void = () => {};
    connectWithSaved.mockImplementation(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const first = reconnectSshSpace("space-1", env);
    const second = reconnectSshSpace("space-1", env);
    // 取凭据是异步的，等第一次真发起连接后再放行
    await vi.waitFor(() => expect(connectWithSaved).toHaveBeenCalledTimes(1));
    release("s-x");
    expect(await second).toBeNull();
    expect(await first).toBe("s-x");
    expect(connectWithSaved).toHaveBeenCalledTimes(1);
  });

  it("不同工作区各连各的（配对正向断言：闸门不许把别人也挡住）", async () => {
    connectWithSaved.mockResolvedValue("s-x");
    await Promise.all([
      reconnectSshSpace("space-1", env),
      reconnectSshSpace("space-2", env),
    ]);
    expect(connectWithSaved).toHaveBeenCalledTimes(2);
  });

  it("非 SSH 工作区不碰 store", async () => {
    expect(await reconnectSshSpace("space-1", { kind: "local" })).toBeNull();
    expect(connectWithSaved).not.toHaveBeenCalled();
  });
});
