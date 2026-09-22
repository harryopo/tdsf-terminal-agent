/**
 * explorerSshGate.test.ts —— #102 收尾：服务器工作区在会话失效时，左侧该显示什么
 *
 * 现场（用户 2026-09-21 起的三条抱怨里"资源管理器没修好/串台"那一类）：SSH 工作区的
 * 身份跨断线留着（#93），而 `App.tsx` 的 `explorerSource` 只问"当前视图那条会话活着
 * 吗"，否 → 直接回退 `"local"` → **在服务器工作区里静默列出本地 Windows 文件**，
 * 界面上没有任何地方说"这是服务器、它现在没连上"，也没有重连入口
 * （`reconnectSshSpace` 只在进入工作区那一刻自动跑一次，失败只弹 toast）。
 *
 * 判据要同时守住两个相反的方向，所以四条分支都得有反例：
 * - 会话死了 → 不能拿本地树冒充服务器（offline）
 * - #89 之后 SSH 工作区里**故意**开的本地壳标签页 → 本地树是对的，不能被离线面板顶掉
 */
import { describe, expect, it } from "vitest";
import { explorerSshGate } from "./explorerSshGate";

describe("explorerSshGate：左侧文件树的数据源三态", () => {
  it("SSH 工作区 + 主会话已失效 + 当前也没在渲染远端 → offline", () => {
    expect(
      explorerSshGate({
        isSshSpace: true,
        remoteViewLive: false,
        spaceSessionAlive: false,
      }),
    ).toBe("offline");
  });

  it("配对正向：远端会话活着就照常渲染远端树（离线面板不许抢活着的视图）", () => {
    expect(
      explorerSshGate({
        isSshSpace: true,
        remoteViewLive: true,
        spaceSessionAlive: true,
      }),
    ).toBe("remote");
  });

  it("#89：SSH 工作区里活动标签页是本地壳（主会话仍活着）→ local，不是 offline", () => {
    // 这条是"离线面板"最容易越界的地方：Space 是服务器，但用户在这个 tab 里要的就是
    // 本地目录。此时工作区主会话还连着，所以不算失效。
    expect(
      explorerSshGate({
        isSshSpace: true,
        remoteViewLive: false,
        spaceSessionAlive: true,
      }),
    ).toBe("local");
  });

  it("远端视图活着但工作区主会话已换掉（每个标签页各连一条）→ 仍按 remote", () => {
    expect(
      explorerSshGate({
        isSshSpace: true,
        remoteViewLive: true,
        spaceSessionAlive: false,
      }),
    ).toBe("remote");
  });

  it("本地 / WSL 工作区 → local，即使会话表里有 SSH 在连", () => {
    expect(
      explorerSshGate({
        isSshSpace: false,
        remoteViewLive: false,
        spaceSessionAlive: false,
      }),
    ).toBe("local");
  });
});
