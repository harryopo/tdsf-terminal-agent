/**
 * tunnelStore.test.ts — SSH 隧道 store 测试
 * -----------------------------------------------------------------------------
 * 覆盖（P2 SSH 隧道）:
 *   1. Tauri 模式：refresh 拉取列表 / startTunnel 成功调用 + 刷新 / 失败返回错误
 *   2. dev 模式（无 Tauri 运行时）：refresh 降级为空、startTunnel 返回提示错误
 *   3. types 纯函数：isValidPort / isValidTunnelName
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock Tauri invoke（tunnelStore → tunnel-bridge → @tauri-apps/api/core）
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useTunnelsStore } from "./tunnelStore";
import { isValidPort, isValidTunnelName } from "../types";
import type { TunnelInfo } from "@/lib/tunnel-bridge";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function makeTunnel(over: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 1,
    name: "远程数据库",
    sessionId: 1,
    localHost: "127.0.0.1",
    localPort: 5432,
    remoteHost: "db.internal",
    remotePort: 5432,
    state: "running",
    connections: 2,
    createdAt: 1000,
    ...over,
  };
}

/** 模拟 Tauri 运行时存在/不存在 */
function setTauriRuntime(present: boolean) {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (present) {
    w.__TAURI_INTERNALS__ = {};
  } else {
    delete w.__TAURI_INTERNALS__;
  }
}

describe("tunnelStore — Tauri 模式", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    setTauriRuntime(true);
    useTunnelsStore.setState({ tunnels: [], loaded: false, busy: false });
  });

  it("refresh 从 tunnel_list 拉取列表并标记 loaded", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tunnel_list") {
        return Promise.resolve([
          makeTunnel({ id: 2 }),
          makeTunnel({ id: 1 }),
        ]);
      }
      return Promise.resolve(null);
    });
    await useTunnelsStore.getState().refresh();
    expect(useTunnelsStore.getState().loaded).toBe(true);
    expect(useTunnelsStore.getState().tunnels.map((t) => t.id)).toEqual([2, 1]);
  });

  it("refresh 失败时标记 loaded 并保留空列表", async () => {
    mockInvoke.mockRejectedValue(new Error("ipc error"));
    await useTunnelsStore.getState().refresh();
    expect(useTunnelsStore.getState().loaded).toBe(true);
    expect(useTunnelsStore.getState().tunnels).toEqual([]);
  });

  it("startTunnel 成功后自动刷新列表并返回 ok", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tunnel_start") return Promise.resolve(1);
      if (cmd === "tunnel_list") {
        return Promise.resolve([makeTunnel({ id: 1, state: "running" })]);
      }
      return Promise.resolve(null);
    });
    const result = await useTunnelsStore.getState().startTunnel({
      name: "t1",
      sessionId: 1,
      localPort: 5432,
      remoteHost: "db.internal",
      remotePort: 5432,
    });
    expect(result).toEqual({ ok: true });
    // tunnel_start 参数 camelCase（localHost 省略时补默认值）
    expect(mockInvoke).toHaveBeenCalledWith("tunnel_start", {
      spec: {
        name: "t1",
        sessionId: 1,
        localHost: "127.0.0.1",
        localPort: 5432,
        remoteHost: "db.internal",
        remotePort: 5432,
      },
    });
    // 刷新后列表同步
    expect(useTunnelsStore.getState().tunnels).toHaveLength(1);
  });

  it("startTunnel 失败时返回错误信息且不改列表", async () => {
    mockInvoke.mockRejectedValue(new Error("端口已被占用"));
    const result = await useTunnelsStore.getState().startTunnel({
      name: "t1",
      sessionId: 1,
      localPort: 5432,
      remoteHost: "db.internal",
      remotePort: 5432,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("端口已被占用");
    expect(useTunnelsStore.getState().tunnels).toEqual([]);
  });

  it("stopTunnel 成功后自动刷新并返回 ok", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tunnel_stop") return Promise.resolve(null);
      if (cmd === "tunnel_list") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    const result = await useTunnelsStore.getState().stopTunnel(1);
    expect(result).toEqual({ ok: true });
    expect(mockInvoke).toHaveBeenCalledWith("tunnel_stop", { tunnelId: 1 });
    expect(useTunnelsStore.getState().tunnels).toEqual([]);
  });

  it("busy 状态在操作期间置 true，结束后复位", async () => {
    let release: () => void = () => {};
    let first = true;
    mockInvoke.mockImplementation(() => {
      // 第一次调用 = tunnel_start（挂起，等 release）
      if (first) {
        first = false;
        return new Promise<void>((res) => {
          release = res;
        });
      }
      // 之后 = refresh 的 tunnel_list
      return Promise.resolve([]);
    });
    const pending = useTunnelsStore.getState().startTunnel({
      name: "t1", sessionId: 1, localPort: 5432,
      remoteHost: "db", remotePort: 5432,
    });
    expect(useTunnelsStore.getState().busy).toBe(true);
    release();
    await pending;
    expect(useTunnelsStore.getState().busy).toBe(false);
    expect(useTunnelsStore.getState().tunnels).toEqual([]);
  });
});

describe("tunnelStore — dev 模式降级", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    setTauriRuntime(false);
    useTunnelsStore.setState({ tunnels: [], loaded: false, busy: false });
  });

  it("refresh 置空列表且不调用 invoke", async () => {
    await useTunnelsStore.getState().refresh();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(useTunnelsStore.getState().loaded).toBe(true);
    expect(useTunnelsStore.getState().tunnels).toEqual([]);
  });

  it("startTunnel / stopTunnel 返回提示错误", async () => {
    const start = await useTunnelsStore.getState().startTunnel({
      name: "t1", sessionId: 1, localPort: 5432,
      remoteHost: "db", remotePort: 5432,
    });
    expect(start.ok).toBe(false);
    expect(start.error).toContain("桌面应用");
    const stop = await useTunnelsStore.getState().stopTunnel(1);
    expect(stop.ok).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("types 纯函数", () => {
  it("isValidPort 接受 1-65535 整数", () => {
    expect(isValidPort("1")).toBe(true);
    expect(isValidPort("65535")).toBe(true);
    expect(isValidPort("5432")).toBe(true);
  });

  it("isValidPort 拒绝非法值", () => {
    expect(isValidPort("0")).toBe(false);
    expect(isValidPort("65536")).toBe(false);
    expect(isValidPort("-1")).toBe(false);
    expect(isValidPort("abc")).toBe(false);
    expect(isValidPort("")).toBe(false);
    expect(isValidPort("54.5")).toBe(false);
  });

  it("isValidTunnelName 拒绝空白", () => {
    expect(isValidTunnelName("远程数据库")).toBe(true);
    expect(isValidTunnelName("  ")).toBe(false);
    expect(isValidTunnelName("")).toBe(false);
  });
});
