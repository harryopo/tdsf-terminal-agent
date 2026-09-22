/**
 * live 上报给 agent 的"终端目标"取值口径（#91 第⑤条 + #107）。
 *
 * 守卫只在"它报的终端 == 注入真正会打的终端"时才有意义。这条用例钉的就是口径：
 * 必须跟着**可见 leaf 自己绑的那条会话**走，绝不能退回 `sshStore.activeSessionId`
 * —— 那是代码审查 H3 的老坑（在 SSH 面板里点一下另一台服务器就会改它）。
 *
 * #107：同一个坑还留在 `getSshRustSessionId()` 上，而它喂的是 agent 的
 * `ssh_command` 目标会话号与可见终端执行的归属校验，所以症状不一样：
 * 逐字模式下字节按"全局那条会话"的 PTY 写出、等待却挂在可见 leaf 上 →
 * 用户看不到回显 + 拿不到结果 → `[indeterminate] 可见终端在命令提交后等待超时`。
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

/**
 * #107：agent 的 SSH 目标会话号必须与"命令实际打进去的那块终端"同源。
 *
 * 旧实现只认 `sshStore.activeSessionId`（外加"随便挑一条已连接的"兜底），
 * #89 之后可见 leaf 与全局活跃会话**可以是两条不同机器的连接**，于是
 * 工具报给后端的 sessionId 与真正注入的 PTY 分家。
 */
describe("getSshRustSessionId（#107）", () => {
  it("可见 leaf 绑着另一条会话时，报 leaf 那条而不是全局那条", () => {
    // 全局活跃 = s-b(rust 8)，可见 leaf 11 绑 rust 7（#89 之后完全合法）
    setLeafSshSession(11, 7);
    const live = publish({ activeId: 1, tabs: [termTab()] });
    expect(useSshStore.getState().activeSessionId).toBe("s-b");
    expect(live.getSshRustSessionId()).toBe(7);
  });

  it("getSshLeafId 指定别的 leaf 时按它算（与 getActiveTerminalTarget 同一口径）", () => {
    // 三条线索彼此不同：全局活跃=rust 8、leaf 11=rust 8、可见 leaf 12=rust 7。
    // 只有"按 getSshLeafId 报的那块 leaf 算"才可能得到 7 —— 吃全局或吃
    // tab.activeLeafId 都会得 8，这条用例就不会假绿。
    setLeafSshSession(11, 8);
    setLeafSshSession(12, 7);
    const live = publish({
      activeId: 1,
      tabs: [termTab()],
      getSshLeafId: () => 12,
    });
    expect(useSshStore.getState().activeSessionId).toBe("s-b");
    expect(live.getSshRustSessionId()).toBe(7);
  });

  it("可见 leaf 是终端 tab 自己的 activeLeafId 时也按它算", () => {
    // getSshLeafId 缺省（本地壳/未接管）→ 退回 tab.activeLeafId 的绑定，
    // 与 getActiveTerminalTarget 的 `sshLeafId ?? tab.activeLeafId` 一字不差。
    setLeafSshSession(11, 7);
    const live = publish({ activeId: 1, tabs: [termTab()] });
    expect(live.getSshRustSessionId()).toBe(7);
  });

  it("可见终端是本地壳（leaf 没绑会话）→ 保持旧行为回落到全局，不新增拒绝", () => {
    // 这条是"该发生的确实发生了"的配对：leaf 派生不能把本地终端在 SSH 工作区里
    // 变成"agent 没有 SSH 可用"，那会是一类新功能故障而不是修复。
    const live = publish({ activeId: 1, tabs: [termTab()] });
    expect(live.getSshRustSessionId()).toBe(8);
  });

  it("没有终端标签页（编辑器/无 tab）→ 同样回落全局", () => {
    const editor = { id: 3, kind: "editor", spaceId: "sp-1" } as unknown as Tab;
    expect(publish({ activeId: 3, tabs: [editor] }).getSshRustSessionId()).toBe(8);
    expect(publish({ activeId: 99, tabs: [] }).getSshRustSessionId()).toBe(8);
  });
});
