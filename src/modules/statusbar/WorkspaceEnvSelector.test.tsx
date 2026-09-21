/**
 * WorkspaceEnvSelector.test.tsx — 状态栏环境标签取值优先级
 * -----------------------------------------------------------------------------
 * 覆盖 2026-09-18 修复（dev-state §37.160）：标签必须以「当前终端命令实际跑在
 * 哪台机器」为准。旧口径只读 Space 绑定的 env，本地 Space 里开 SSH 终端 tab 时
 * env 仍是 local → 恒显 "Windows"。
 *   1. 无 Space、无 terminalAddress → 回退本地标签
 *   2. terminalAddress 存在 → 优先显示 user@host（即使 Space env 仍是 local）
 *   3. Space env 为 ssh 但**没有活着的会话** → 地址照常显示 + 标「未连接」
 *      （#93 之后 SSH 身份跨断线留着，"是 ssh"不再蕴含"命令在远端"）
 *   4. ssh 会话真活着 → 只显示 user@host，tooltip 说命令落在远端
 *   5. terminalAddress 同样优先于 ssh Space env
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// jsdom 下 @tauri-apps/plugin-os 的 platform() 抛错 → IS_WINDOWS=false，
// 选择器会整体隐藏。本测试只关心标签取值，仅覆盖 IS_WINDOWS（其余导出保留，
// shortcuts 等传递依赖要用 MOD_PROP/MOD_KEY）。
vi.mock("@/lib/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform")>();
  return { ...actual, IS_WINDOWS: true };
});

import { useSpaces } from "@/modules/spaces";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useWorkspaceEnvStore, type WorkspaceEnv } from "@/modules/workspace";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

const SSH_ENV: WorkspaceEnv = {
  kind: "ssh",
  host: "192.168.45.200",
  user: "root",
  port: 22,
  label: "root@192.168.45.200",
};

beforeEach(() => {
  useSpaces.setState({ spaces: [], activeId: null });
  useWorkspaceEnvStore.setState({ env: { kind: "local" } });
  useSshStore.setState({ sessions: [] });
});

function label(): string {
  const el = screen.getByRole("button");
  return (el.textContent ?? "").trim();
}

/** 直接构造 SpaceMeta 并 hydrate：useSpaces.create() 会写 Tauri store，
 *  jsdom 下 invoke 未定义会抛未捕获拒绝，测试只用内存态。 */
function seedSpace(name: string, env: WorkspaceEnv) {
  const now = Date.now();
  useSpaces.getState().hydrate(
    [{ id: `sp-${name}`, name, root: null, env, createdAt: now, updatedAt: now }],
    `sp-${name}`,
  );
}

describe("WorkspaceEnvSelector — 标签取值优先级", () => {
  it("无 Space 且无 terminalAddress → 回退本地标签", () => {
    render(<WorkspaceEnvSelector onSelect={() => {}} />);
    expect(label()).toBe("Windows");
  });

  it("本地 Space 里开 SSH 终端 → terminalAddress 优先，不再显示 Windows", () => {
    seedSpace("local-space", { kind: "local" });
    render(
      <WorkspaceEnvSelector
        onSelect={() => {}}
        terminalAddress="root@10.0.0.5"
      />,
    );
    expect(label()).toBe("root@10.0.0.5");
    expect(screen.getByRole("button").getAttribute("title")).toContain(
      "root@10.0.0.5",
    );
  });

  it("Space env 为 ssh 但没有活着的会话 → 地址照常显示，并如实标「未连接」", () => {
    // #93（2026-09-21）：SSH 身份跨断线留着，"是 ssh"不再等于"命令在远端跑"。
    // tooltip 若还说"当前终端命令执行于 root@…"就是说谎，所以标签要带状态。
    seedSpace("ssh-space", SSH_ENV);
    render(<WorkspaceEnvSelector onSelect={() => {}} />);
    expect(label()).toBe("root@192.168.45.200 · 未连接");
    expect(screen.getByRole("button").getAttribute("title")).toBe(
      "切换工作区环境",
    );
  });

  it("ssh 会话真活着 → 只显示 user@host，且 tooltip 说命令落在远端", () => {
    seedSpace("ssh-space", { ...SSH_ENV, sessionId: "s-live" });
    useSshStore.setState({
      sessions: [
        { id: "s-live", state: "connected", rustSessionId: 3 },
      ] as never,
    });
    render(<WorkspaceEnvSelector onSelect={() => {}} />);
    expect(label()).toBe("root@192.168.45.200");
    expect(screen.getByRole("button").getAttribute("title")).toContain(
      "当前终端命令执行于 root@192.168.45.200",
    );
  });

  it("terminalAddress 优先于 ssh Space env（跨机器的 tab 才是真相）", () => {
    seedSpace("ssh-space", SSH_ENV);
    render(
      <WorkspaceEnvSelector
        onSelect={() => {}}
        terminalAddress="ops@10.9.9.9"
      />,
    );
    expect(label()).toBe("ops@10.9.9.9");
  });
});
