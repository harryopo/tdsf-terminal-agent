/**
 * terminalAddress.test.ts — 状态栏地址口径（#63，用户 2026-09-18 决策）
 * -----------------------------------------------------------------------------
 * 钉住一件事：右下角只反映"命令实际跑在哪台机器"。
 * 旧实现在活动 tab 没绑 SSH 会话时回退到 Space 的 SSH 会话，
 * 于是 SSH 工作区里开一个本地终端标签，右下角仍写 user@host —— 谎报。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SshSessionInfo } from "@/modules/ssh-explorer/sshStore";
import { terminalAddressOf } from "./terminalAddress";

const session = (over: Partial<SshSessionInfo>): SshSessionInfo =>
  ({
    id: "ssh-1",
    state: "connected",
    rustSessionId: 7,
    params: { user: "root", host: "192.168.45.200" },
    ...over,
  }) as SshSessionInfo;

describe("terminalAddressOf", () => {
  it("已连接的会话 → user@host", () => {
    expect(terminalAddressOf(session({}))).toBe("root@192.168.45.200");
  });

  it("未连接（失败 / 已关闭 / 连接中）→ null，不报已经不在的主机", () => {
    expect(terminalAddressOf(session({ state: "failed" }))).toBeNull();
    expect(terminalAddressOf(session({ state: "closed" }))).toBeNull();
    expect(terminalAddressOf(session({ state: "connecting" }))).toBeNull();
    expect(terminalAddressOf(session({ rustSessionId: null }))).toBeNull();
  });

  it("活动 tab 是本地/WSL 终端（没有 SSH 会话）→ null，如实显示本地", () => {
    // 这正是 #63 的场景：Space 是 SSH，但当前 tab 跑在本地
    expect(terminalAddressOf(null)).toBeNull();
    expect(terminalAddressOf(undefined)).toBeNull();
  });
});

/**
 * #127 接线（2026-09-24 真机抓到）：欢迎页挂着、`.xterm` 数为 0 的同时，
 * 状态栏地址格写 `root@192.168.45.128`、窗口标题写 `root@192.168.45.128:/root`，
 * 而同一格里另有一句「未选择工作区」。
 * 根因不在 `terminalAddressOf`（它没错），在**两臂的取值都走 useTabs 的活动 tab**，
 * 而 tab store 不看活跃工作区 —— 2026-09-18 那条「没有活跃工作区时展示层不冒充任何
 * 目录」的口径（App.tsx 原注释）只给本地路径那臂加了闸。
 * 这类"实现了但没接上"的缺口编译器与单测都看不见，只能读源码钉（照 #125 的手法）。
 */
describe("#127 接线：两条 SSH 标签都必须过工作区闸", () => {
  const appSrc = readFileSync(join(process.cwd(), "src", "app", "App.tsx"), "utf8");

  /** 取一条 const 声明的右值开头若干字符（够覆盖三元判断的条件即可） */
  const initializer = (decl: string): string => {
    const at = appSrc.indexOf(decl);
    expect(at, `App.tsx 里找不到 ${decl}（改名了就要同步这条判据）`).toBeGreaterThanOrEqual(0);
    return appSrc.slice(appSrc.indexOf("=", at), appSrc.indexOf("=", at) + 220);
  };

  it("状态栏地址：terminalAddressOf 的调用被工作区闸包着", () => {
    expect(initializer("const activeTerminalAddress")).toMatch(/hasWorkspace\s*\?/);
  });

  it("窗口标题：sshLocationLabel 的条件里有工作区闸", () => {
    expect(initializer("const sshLocationLabel")).toContain("hasWorkspace");
  });

  it("窗口标题第三臂：喂给 useWindowTitle 的 tab 也过闸（只堵两臂标题会退化成 `/`）", () => {
    expect(initializer("const titleTab")).toMatch(/hasWorkspace\s*\?/);
    const call = appSrc.slice(appSrc.indexOf("useWindowTitle("));
    expect(call.slice(0, 80)).toContain("titleTab");
    expect(call.slice(0, 80)).not.toMatch(/useWindowTitle\(\s*activeTab/);
  });

  it("闸只有一个名字：`!!activeSpace` 只定义一次（两个同义谓词早晚各漏一处）", () => {
    const defs = appSrc.match(/const has(Active)?Workspace = !!activeSpace/g) ?? [];
    expect(defs).toHaveLength(1);
  });
});
