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
import { openSshShellForEnv, wantsPerTabSshShell } from "./openSpaceShell";

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
