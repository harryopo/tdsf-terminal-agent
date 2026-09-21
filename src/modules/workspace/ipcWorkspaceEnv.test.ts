/**
 * ipcWorkspaceEnv —— 本地命令的环境参数不许带 ssh 身份（#97）
 *
 * 起因（2026-09-21 用户实测）：切到本地工作区后左侧资源管理器不刷新，界面里留着
 * `invalid args 'workspace' for command 'fs_read_dir': unknown variant 'ssh',
 * expected 'local' or 'wsl'`。Rust 侧 `WorkspaceEnv` 只有 `Local` / `Wsl` 两个变体，
 * 而前端的 `currentWorkspaceEnv()` 会返回 `{kind:'ssh'}`（#93 之后 SSH 身份跨断线留着，
 * 命中的窗口更宽）。
 *
 * 这不是 `fs_read_dir` 一个命令的病：全仓有 44 个命令收 `workspace: Option<WorkspaceEnv>`，
 * 前端 60 多处直接裸传。2026-07-31 修 `pty_open` 时只在 `pty-bridge.ts` 里补了一份
 * 局部 fallback —— **补了一处，漏了一类**。所以这里同时钉三件事：
 * ① 映射本身对不对；② 全仓不许再出现 `workspace: currentWorkspaceEnv()`；
 * ③ Rust 侧枚举要是新增了 `Ssh` 变体，这条扫描要当场提醒重新审（否则判据会因为
 *    "前提消失"而悄悄失去意义）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ipcWorkspaceEnv, useWorkspaceEnvStore } from "./env";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKSPACE_RS = resolve(REPO_ROOT, "src-tauri/src/modules/workspace.rs");

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SSH_ENV = {
  kind: "ssh",
  host: "10.0.0.8",
  user: "root",
  port: 22,
  label: "root@10.0.0.8",
} as const;

describe("ipcWorkspaceEnv", () => {
  it("ssh 身份降级成 local（本地盘命令按本地盘处理）", () => {
    useWorkspaceEnvStore.setState({ env: SSH_ENV } as never);
    expect(ipcWorkspaceEnv()).toEqual({ kind: "local" });
  });

  it("local / wsl 原样透传（Rust 认这两个变体，WSL 不能被抹平）", () => {
    useWorkspaceEnvStore.setState({ env: { kind: "local" } } as never);
    expect(ipcWorkspaceEnv()).toEqual({ kind: "local" });
    useWorkspaceEnvStore.setState({
      env: { kind: "wsl", distro: "Ubuntu-24.04" },
    } as never);
    expect(ipcWorkspaceEnv()).toEqual({ kind: "wsl", distro: "Ubuntu-24.04" });
  });

  it("currentWorkspaceEnv() 仍然报真实身份（scope key 与「是不是远端」靠它）", () => {
    useWorkspaceEnvStore.setState({ env: SSH_ENV } as never);
    expect(useWorkspaceEnvStore.getState().env.kind).toBe("ssh");
    expect(ipcWorkspaceEnv().kind).toBe("local");
  });
});

describe("全仓扫描：本地命令不许裸传带 ssh 的环境", () => {
  const files = Object.keys(SOURCES).filter((p) => !p.includes(".test."));

  it("没有任何一处写 `workspace: currentWorkspaceEnv()`", () => {
    const offenders = files.filter((p) =>
      SOURCES[p].includes("workspace: currentWorkspaceEnv()"),
    );
    expect(offenders).toEqual([]);
  });

  /** 正向断言：判据不能靠"大家都没写"通过，得证明正确的入口真的在用。 */
  it("`ipcWorkspaceEnv()` 至少被 15 个源文件引用", () => {
    const users = files.filter(
      (p) =>
        !p.endsWith("modules/workspace/env.ts") &&
        SOURCES[p].includes("ipcWorkspaceEnv()"),
    );
    expect(users.length).toBeGreaterThanOrEqual(15);
  });

  it("Rust 侧 WorkspaceEnv 仍然只有 Local / Wsl（变了就要重审这条 fallback）", () => {
    const rs = readFileSync(WORKSPACE_RS, "utf8");
    const start = rs.indexOf("pub enum WorkspaceEnv");
    expect(start).toBeGreaterThan(-1);
    const block = rs.slice(start, rs.indexOf("}", start));
    expect(block).toContain("Local");
    expect(block).toContain("Wsl");
    expect(block).not.toMatch(/Ssh|Sftp/i);
  });
});
