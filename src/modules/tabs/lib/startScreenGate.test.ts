/**
 * startScreenGate.test.ts —— #166 ⑨
 * 闸门本身：挡与放，以及挡下的那句话说得清"下一步做什么"。
 * （界面入口那条在 TabBar.test.tsx；快捷键/命令面板走的是这里，因为它们没有"入口可见性"可收。）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

import {
  blockedOnStartScreen,
  START_SCREEN_CREATE_HINT,
} from "./startScreenGate";

/** 读源码用绝对路径（happy-dom 下 import.meta.url 不是 file:，本仓惯例） */
const src = (rel: string) =>
  readFileSync(join(process.cwd(), "src", rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

beforeEach(() => toastInfo.mockClear());

describe("blockedOnStartScreen", () => {
  it("有活跃工作区：放行且一声不响", () => {
    expect(blockedOnStartScreen(true)).toBe(false);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("开始页：挡下并提示一次", () => {
    expect(blockedOnStartScreen(false)).toBe(true);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  /** 提示必须给出下一步能点的按钮（#118 那条口径：拒绝要说清怎么办） */
  it("那句话点名了工作区与三种入口，不是光说「不行」", () => {
    expect(START_SCREEN_CREATE_HINT).toContain("工作区");
    expect(START_SCREEN_CREATE_HINT).toContain("本地");
    expect(START_SCREEN_CREATE_HINT).toContain("WSL");
    expect(START_SCREEN_CREATE_HINT).toContain("SSH");
  });
});

// -----------------------------------------------------------------------------
// 接线断言：闸门的价值在于**每条能建出标签页的路径都过它**。
// App.tsx 没法在测试里整体渲染（它挂着 Tauri/终端/侧栏一大片），所以这里读源码钉住
// 调用点数量与位置 —— 少接一条，那条路径就会在开始页静默复现"建出来却看不见"。
// -----------------------------------------------------------------------------
describe("startScreenGate — 接线（App.tsx 每条建标签页的路径）", () => {
  const app = src("app/App.tsx");

  /** 正向配对：先证明闸门真的被三条路径各调一次，否则下面的"路径存在"断言毫无意义 */
  it("openNewTab / openNewEditorTab / 拆屏 三条路径各自挡一次", () => {
    const calls = app.match(/blockedOnStartScreen\(hasWorkspace\)/g) ?? [];
    expect(calls).toHaveLength(3);
    for (const fn of ["openNewTab", "openNewEditorTab", "splitActivePaneInActiveTab"]) {
      const body = app.slice(app.indexOf(`const ${fn} = useCallback`));
      expect(body.slice(0, 1200)).toContain("blockedOnStartScreen");
    }
  });

  it("快捷键与命令面板不许绕过这两个函数自己开（它们只认 openNewTab / openNewEditorTab）", () => {
    // setNewEditorOpen(true) 只许出现在 openNewEditorTab 内部一处
    expect(app.match(/setNewEditorOpen\(true\)/g) ?? []).toHaveLength(1);
    expect(app).toContain('"tab.newEditor": openNewEditorTab');
    expect(app).toContain("openNewEditor: openNewEditorTab");
  });

  it("hasWorkspace 一路透到 TabBar（+ 号那一半的判据来源）", () => {
    expect(app).toContain("hasWorkspace={hasWorkspace}");
    const header = src("modules/header/Header.tsx");
    expect(header).toContain("hasWorkspace={hasWorkspace}");
    const bar = src("modules/tabs/TabBar.tsx");
    expect(bar).toContain("{hasWorkspace ? (");
    expect(bar).toContain("<NewTabMenu");
  });
});
