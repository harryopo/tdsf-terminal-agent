import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  planSshReapAtBoot,
  type SshSessionOwnership,
} from "./sshGenerationReap";

/**
 * #117（2026-09-23）：整页重载会往服务器上泄漏 SSH 连接。
 *
 * 真机复现（一次 Page.reload，CDP 实测）：Rust `ssh_status()` 的存活会话
 * 从 `[1]` 变成 `[1, 2]`，而新页面只引用 `2` —— 会话 1 是上一代页面建的，
 * 页面已经不存在了，没人会去断开它，Rust 只在进程退出时清。
 * dev 机上攒过 14 条（其中 10 条当前 UI 永远达不到）。
 *
 * 回收判据只有一条来源：**这条会话是哪个 webview 建的**。所以这里钉的不变量是
 * ① 我這個窗口自己那一代留下的要收；② 别的**还活着**的窗口的一条都不许碰
 * （#89：每个标签页各一条独立 shell，跨窗口镜像会退回用户报过的缺陷）；
 * ③ 认不出出身的宁可留着也不能误杀。
 */

function s(sessionId: number, ownerWindow: string | null): SshSessionOwnership {
  return { sessionId, ownerWindow };
}

/** 页面这一代自己已经握着 rustSessionId 的那几条 —— 一律不许动。 */
const NONE_REFERENCED = [] as const;

describe("planSshReapAtBoot —— 上一代页面留下的会话", () => {
  it("主人是我这个窗口 label、而我没在用的，回收", () => {
    expect(
      planSshReapAtBoot({
        sessions: [s(1, "main")],
        selfWindowLabel: "main",
        liveWindowLabels: ["main"],
        referencedSessionIds: NONE_REFERENCED,
      }),
    ).toEqual([1]);
  });

  it("我自己 store 里正在用的那条即使 owner 是我也不许动（误杀比留着糟）", () => {
    expect(
      planSshReapAtBoot({
        sessions: [s(1, "main"), s(2, "main")],
        selfWindowLabel: "main",
        liveWindowLabels: ["main"],
        referencedSessionIds: [2],
      }),
    ).toEqual([1]);
  });

  it("别的还活着的窗口的会话一条都不动（多窗口各自独立）", () => {
    expect(
      planSshReapAtBoot({
        sessions: [s(1, "main"), s(2, "main-2")],
        selfWindowLabel: "main-3",
        liveWindowLabels: ["main", "main-2", "main-3"],
        referencedSessionIds: NONE_REFERENCED,
      }),
    ).toEqual([]);
  });

  it("主人窗口已经不在世上的，回收（关窗泄漏同一个根）", () => {
    expect(
      planSshReapAtBoot({
        sessions: [s(3, "main-3")],
        selfWindowLabel: "main",
        liveWindowLabels: ["main"],
        referencedSessionIds: NONE_REFERENCED,
      }),
    ).toEqual([3]);
  });

  it("出身认不出来（null / 空串）的宁可留着 —— 不许误杀", () => {
    expect(
      planSshReapAtBoot({
        sessions: [s(4, null), s(5, "")],
        selfWindowLabel: "main",
        liveWindowLabels: ["main"],
        referencedSessionIds: NONE_REFERENCED,
      }),
    ).toEqual([]);
  });

  it("混合现场：只报该收的那几条，且按会话号升序（日志可对账）", () => {
    expect(
      planSshReapAtBoot({
        sessions: [
          s(9, "main-2"), // 别的活窗口 → 留
          s(7, "main"), // 我的上一代 → 收
          s(3, "gone-window"), // 窗口没了 → 收
          s(11, null), // 出身不明 → 留
        ],
        selfWindowLabel: "main",
        liveWindowLabels: ["main", "main-2"],
        referencedSessionIds: NONE_REFERENCED,
      }),
    ).toEqual([3, 7]);
  });

  it("没有会话时返回空，不抛", () => {
    expect(
      planSshReapAtBoot({
        sessions: [],
        selfWindowLabel: "main",
        liveWindowLabels: ["main"],
        referencedSessionIds: NONE_REFERENCED,
      }),
    ).toEqual([]);
  });
});

describe("接线 —— 对账必须跑在自动连接之前", () => {
  /**
   * 顺序就是正确性的一部分：先回收再拨号，连接数才不会一边涨一边删。
   * 这条静态扫描钉住调用点还在、且排在 connectWithSaved 前面
   * （判据同 #116 的 rebind-before-getOrCreateChat）。
   */
  it("App.tsx 的启动自动连接里，先 reap 后 connect", () => {
    const src = readFileSync(join(process.cwd(), "src/app/App.tsx"), "utf8");
    const start = src.indexOf('if (!launchCwdResolved || !spacesHydrated) return;');
    expect(start, "找不到启动自动连接的 effect，门禁失效").toBeGreaterThan(-1);
    const connect = src.indexOf(".connectWithSaved(", start);
    expect(connect, "启动自动连接调用点没了，门禁失效").toBeGreaterThan(-1);
    const segment = src.slice(start, connect);
    expect(
      segment.includes("reapStaleSshSessionsAtBoot("),
      "启动时不再回收上一代页面留下的 SSH 会话 —— #117 会复发",
    ).toBe(true);
  });
});
