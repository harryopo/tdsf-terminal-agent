/**
 * TunnelPanel.test.tsx — SSH 隧道面板组件测试
 * -----------------------------------------------------------------------------
 * 覆盖（P2 SSH 隧道）:
 *   1. 无已连接 SSH 会话 → 引导提示 + 新建按钮禁用
 *   2. 有会话无隧道 → 空状态 + 新建按钮
 *   3. 有隧道 → 渲染名称 + 状态 badge + 端点映射
 *   4. 点击停止 → 调用 tunnel_stop
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSshStore, type SshSessionInfo } from "@/modules/ssh-explorer";
import { TunnelPanel } from "./TunnelPanel";
import { useTunnelsStore } from "./lib/tunnelStore";
import type { TunnelInfo } from "@/lib/tunnel-bridge";

// 模拟 Tauri 运行时（refresh 走 invoke 拉取）
vi.mock("@/lib/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
// ssh-explorer 模块副作用（agentActivity 等）会调用 listen，
// 必须一并 mock，否则 transformCallback 报错污染测试文件
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

function makeSession(over: Partial<SshSessionInfo> = {}): SshSessionInfo {
  return {
    id: "sess-1",
    rustSessionId: 1,
    params: {
      host: "192.168.1.100",
      port: 22,
      user: "root",
      auth: { type: "password", password: "x" },
    },
    state: "connected",
    connectedAt: Date.now(),
    handle: null,
    ...over,
  };
}

function makeTunnel(over: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 1,
    name: "远程数据库",
    sessionId: 1,
    kind: "local",
    localHost: "127.0.0.1",
    localPort: 5432,
    remoteHost: "db.internal",
    remotePort: 5432,
    bindAddress: "127.0.0.1",
    state: "running",
    connections: 2,
    createdAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  mockInvoke.mockReset();
  useSshStore.setState({
    sessions: [],
    activeSessionId: null,
  });
  // store 为模块级单例，loaded/busy 跨测试保留会导致 refresh 被跳过，
  // 必须重置才能让每个用例重新走 mount → refresh 流程
  useTunnelsStore.setState({ tunnels: [], loaded: false, busy: false });
});

describe("TunnelPanel — 无 SSH 会话", () => {
  it("显示引导提示且新建按钮禁用", async () => {
    mockInvoke.mockResolvedValue([]);
    render(<TunnelPanel />);
    expect(screen.getByText("需要 SSH 会话")).toBeTruthy();
    const newBtn = screen.getByTitle("新建隧道") as HTMLButtonElement;
    expect(newBtn.disabled).toBe(true);
    // 等待 refresh 异步 setState 完成，避免 act warning
    await waitFor(() => expect(useTunnelsStore.getState().loaded).toBe(true));
  });
});

describe("TunnelPanel — 有会话无隧道", () => {
  it("显示空状态引导新建", async () => {
    mockInvoke.mockResolvedValue([]);
    useSshStore.setState({ sessions: [makeSession()] });
    render(<TunnelPanel />);
    expect(await screen.findByText("还没有隧道")).toBeTruthy();
    expect(screen.getByText("新建隧道")).toBeTruthy();
  });
});

describe("TunnelPanel — 隧道列表", () => {
  it("渲染名称 + 运行中 badge + 端点映射", async () => {
    mockInvoke.mockResolvedValue([makeTunnel()]);
    useSshStore.setState({ sessions: [makeSession()] });
    render(<TunnelPanel />);
    expect(await screen.findByText("远程数据库")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("127.0.0.1:5432 → db.internal:5432")).toBeTruthy();
    expect(screen.getByText(/连接 2/)).toBeTruthy();
  });

  it("failed 状态显示失败 badge", async () => {
    mockInvoke.mockResolvedValue([
      makeTunnel({ id: 9, name: "坏隧道", state: "failed" }),
    ]);
    useSshStore.setState({ sessions: [makeSession()] });
    render(<TunnelPanel />);
    expect(await screen.findByText("坏隧道")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
  });

  it("点击停止 → 调用 tunnel_stop 并刷新列表", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "tunnel_list") {
        return Promise.resolve([makeTunnel()]);
      }
      if (cmd === "tunnel_stop") return Promise.resolve(null);
      return Promise.resolve(null);
    });
    useSshStore.setState({ sessions: [makeSession()] });
    render(<TunnelPanel />);
    await screen.findByText("远程数据库");
    fireEvent.click(screen.getByTestId("tunnel-stop-1"));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("tunnel_stop", { tunnelId: 1 });
    });
  });
});
