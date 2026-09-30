/**
 * 源代码管理面板"没内容可显示"时到底该说什么 —— 唯一主人。
 *
 * 为什么单独一个文件（#166 真机看图轮，2026-09-29）：开始页上切到「源码」这一格，
 * 屏幕上写着「非 Git 仓库 / 当前工作区不在 Git 仓库内。」—— 可此刻**根本没有工作区**
 * （`activeId` 恒 null，#61-A 的设计）。面板拿的是回退路径（launchCwd），
 * 却把结论说成"你的工作区不是仓库"：**这是假事实**，和 #127（状态栏在开始页挂出服务器地址）、
 * #123（欢迎页说"没有自动连上"）同一族 —— 展示层漏了"没有活跃工作区"这一臂。
 *
 * 所以判据不能只看"有没有仓库"，要先回答"有没有工作区可谈"。
 */
export type SourceControlEmptyCopy = { title: string; body: string };

/** @param hasWorkspace 当前有没有活跃工作区（口径与 `App.tsx` 的 `hasWorkspace` 同一个） */
export function sourceControlEmptyCopy(
  hasWorkspace: boolean,
): SourceControlEmptyCopy {
  if (!hasWorkspace) {
    return {
      title: "还没有进入工作区",
      body: "源代码管理跟着工作区走；先从开始页或顶栏「选择工作区」进入一个。",
    };
  }
  return { title: "非 Git 仓库", body: "当前工作区不在 Git 仓库内。" };
}
