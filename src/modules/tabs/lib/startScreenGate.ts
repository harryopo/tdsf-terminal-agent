// 开始页（没有活跃工作区）的新建闸门 —— #166 ⑨（2026-09-28 用户实测）
// -----------------------------------------------------------------------------
// 用户原话：「开始界面就不要出现＋号，不然建立的东西这是在哪都不知道，
// 开始界面只有开始窗口」。
//
// 量出来的因果链（不是猜的）：
//   `App.tsx` 里 `spaceTabs = tabs.filter(t => t.spaceId === (activeSpaceId ?? DEFAULT_SPACE_ID))`，
//   而 `activeSpaceId` 在开始页恒为 null（#61-A 的口径），于是顶栏画的是 default 空间那一组
//   标签页；主区域此刻画的是 `<WelcomeScreen>`（`!hasWorkspace` 分支）。
//   在开始页点 + → `openNewTab()` 建一条 default 空间的标签页 ⇒ **顶栏多出一个 chip，
//   主区域纹丝不动**，而那条 cold 标签一被点亮就真的起了一个 shell。
//   用户看到的就是"东西建出来了，但不知道在哪"。
//
// 所以两件事一起做，缺一不可：
//   ① 顶栏的 + 在开始页直接不给（界面不许提供一个没有作用的入口 —— #103 同族）；
//   ② 键盘（tab.new / tab.newEditor）与命令面板这些"看不见入口"的路径统一挡下并说清，
//      否则按 Ctrl+T 会静默复现同一个 bug。
// 这里只管 ② 的判据与那句话；① 在 TabBar 里按同一个 `hasWorkspace` 收。

import { toast } from "sonner";

/** 挡下时要说的那句：给出下一步能点的按钮，而不是只说"不行" */
export const START_SCREEN_CREATE_HINT =
  "还没有进入工作区。先在开始页创建一个工作区（本地 / WSL / SSH），再新建终端或编辑器。";

/**
 * 有活跃工作区 → 返回 false，放行。
 * 没有 → 提示一句并返回 true（调用方直接 return，不要继续建标签页）。
 */
export function blockedOnStartScreen(hasWorkspace: boolean): boolean {
  if (hasWorkspace) return false;
  toast.info(START_SCREEN_CREATE_HINT);
  return true;
}
