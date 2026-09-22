import { describe, expect, it } from "vitest";
import type { PaneNode } from "./panes";
import { leafCwdOf } from "./leafCwd";

/**
 * #91① —— "这块终端现在在哪个目录"必须本地/SSH 一个入口答对。
 *
 * 远端 shell 的 OSC7 cwd 只落在 sshStore（按会话存），paneTree 的 leaf.cwd
 * 对 SSH leaf 恒是建 leaf 时的初值。旧代码各处直接读槽位，于是 SSH 标签页里
 * 拿到的是本地盘路径（代码片段面板把它当 `cd` 的目标打进取）。
 */

const REMOTE = { "sess-1": "/var/log", "sess-2": "/etc/nginx" };

function leaf(over: Partial<Extract<PaneNode, { kind: "leaf" }>> = {}) {
  return { kind: "leaf", id: 11, ...over } as PaneNode;
}

describe("leafCwdOf", () => {
  it("SSH leaf 取它那条会话的远端 cwd，不是 paneTree 里的本地初值", () => {
    const tab = {
      paneTree: leaf({ cwd: "D:\\repo" }),
      sshSessionId: "sess-1",
      cwd: "D:\\repo",
    };
    expect(leafCwdOf(tab, 11, REMOTE)).toBe("/var/log");
  });

  it("远端路径还没解析出来时返回 null，不拿本地初值冒充远端目录", () => {
    const tab = {
      paneTree: leaf({ cwd: "D:\\repo" }),
      sshSessionId: "sess-unknown",
      cwd: "D:\\repo",
    };
    expect(leafCwdOf(tab, 11, REMOTE)).toBeNull();
  });

  it("本地 leaf 读 paneTree 槽位，退回 tab.cwd", () => {
    const withSlot = { paneTree: leaf({ cwd: "D:\\repo\\src" }), cwd: "D:\\repo" };
    expect(leafCwdOf(withSlot, 11, REMOTE)).toBe("D:\\repo\\src");
    expect(leafCwdOf({ paneTree: leaf(), cwd: "D:\\repo" }, 11, REMOTE)).toBe(
      "D:\\repo",
    );
  });

  it("SSH 工作区里显式强制本地的 leaf（sshSessionId=null）读槽位", () => {
    const tab = {
      paneTree: leaf({ sshSessionId: null, cwd: "C:\\Users\\ops" }),
      sshSessionId: "sess-1",
      cwd: "/var/log",
    };
    expect(leafCwdOf(tab, 11, REMOTE)).toBe("C:\\Users\\ops");
  });

  it("同一 tab 分屏两块 SSH leaf 各绑各的会话时互不串台（#89 之后可能）", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 1,
      dir: "row",
      children: [
        { kind: "leaf", id: 11, sshSessionId: "sess-1" },
        { kind: "leaf", id: 12, sshSessionId: "sess-2" },
      ],
    };
    const tab = { paneTree: tree, cwd: "D:\\repo" };
    expect(leafCwdOf(tab, 11, REMOTE)).toBe("/var/log");
    expect(leafCwdOf(tab, 12, REMOTE)).toBe("/etc/nginx");
  });
});
