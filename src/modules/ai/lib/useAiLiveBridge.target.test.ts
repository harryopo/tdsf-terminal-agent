/**
 * live.getActiveTerminalTarget() 的取值口径（#91 第⑤条）。
 *
 * 守卫只在"它报的终端 == 注入真正会打的终端"时才有意义。这条用例钉的就是口径：
 * 必须跟着**可见 leaf 自己绑的那条会话**走，绝不能退回 `sshStore.activeSessionId`
 * —— 那是代码审查 H3 的老坑（在 SSH 面板里点一下另一台服务器就会改它）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { setLeafSshSession } from "@/lib/param-complete-client";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { Tab } from "@/modules/tabs";
import type { Live } from "../store/chatStore";
import { useAiLiveBridge } from "./useAiLiveBridge";

function termTab(over?: Partial<Extract<Tab, { kind: "terminal" }>>): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "sp-1",
    title: "shell",
    cwd: "/srv/app",
    paneTree: { kind: "leaf", id: 11, cwd: "/srv/app" },
    activeLeafId: 11,
    ...over,
  } as Tab;
}

/** 挂载 bridge 并返回它发布出去的 live。 */
function publish(params: {
  activeId: number;
  tabs: Tab[];
  getSshLeafId?: () => number | null;
}): Live {
  const captured: { live: Live | null } = { live: null };
  renderHook(() =>
    useAiLiveBridge({
      setLive: (l) => {
        captured.live = l;
      },
      activeId: params.activeId,
      tabs: params.tabs,
      explorerRoot: null,
      launchCwd: null,
      home: null,
      wslDistro: null,
      openPreviewTab: () => {},
      newAgentTab: () => ({ tabId: 0, leafId: 0 }),
      terminalRefs: { current: new Map() },
      getSshLeafId: params.getSshLeafId,
    }),
  );
  if (!captured.live) throw new Error("bridge 挂载后没有发布 live");
  return captured.live;
}

beforeEach(() => {
  setLeafSshSession(11, null);
  setLeafSshSession(12, null);
  useSshStore.setState({
    sessions: [
      {
        id: "s-a",
        rustSessionId: 7,
        state: "connected",
        params: { host: "10.0.0.8", user: "root", port: 22 },
      },
      {
        id: "s-b",
        rustSessionId: 8,
        state: "connected",
        params: { host: "10.0.0.9", user: "ops", port: 22 },
      },
    ] as never,
    activeSessionId: "s-b",
  });
});

describe("getActiveTerminalTarget", () => {
  it("本地终端：报 tab/leaf + 目录末段当名字", () => {
    const live = publish({ activeId: 1, tabs: [termTab()] });
    expect(live.getActiveTerminalTarget()).toEqual({
      tabId: 1,
      leafId: 11,
      sshRustSessionId: null,
      label: "app",
    });
  });

  it("SSH 终端：报这条 leaf 自己绑的会话号与 user@host", () => {
    setLeafSshSession(11, 7);
    const live = publish({ activeId: 1, tabs: [termTab()] });
    const target = live.getActiveTerminalTarget();
    expect(target?.sshRustSessionId).toBe(7);
    expect(target?.label).toBe("root@10.0.0.8");
  });

  it("⚠️ 不许跟着 sshStore.activeSessionId 走（H3 同源的坑）", () => {
    // 全局"当前会话"是 s-b(rust 8)，但可见 leaf 绑的是 7 —— 必须报 7。
    setLeafSshSession(11, 7);
    const live = publish({ activeId: 1, tabs: [termTab()] });
    expect(useSshStore.getState().activeSessionId).toBe("s-b");
    expect(live.getActiveTerminalTarget()?.sshRustSessionId).toBe(7);
  });

  it("可见 leaf 由 getSshLeafId 指定时按它算（与注入路径同一口径）", () => {
    setLeafSshSession(12, 8);
    const live = publish({
      activeId: 1,
      tabs: [termTab()],
      getSshLeafId: () => 12,
    });
    const target = live.getActiveTerminalTarget();
    expect(target?.leafId).toBe(12);
    expect(target?.sshRustSessionId).toBe(8);
    expect(target?.label).toBe("ops@10.0.0.9");
  });

  it("活动标签页不是终端（编辑器 / 没有标签页）→ null", () => {
    const editor = { id: 3, kind: "editor", spaceId: "sp-1" } as unknown as Tab;
    expect(
      publish({ activeId: 3, tabs: [editor] }).getActiveTerminalTarget(),
    ).toBeNull();
    expect(publish({ activeId: 99, tabs: [] }).getActiveTerminalTarget()).toBeNull();
  });
});
