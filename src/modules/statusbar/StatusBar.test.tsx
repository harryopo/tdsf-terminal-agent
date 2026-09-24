/**
 * StatusBar.test.tsx — 工作区上下文在状态栏的呈现（2026-09-18 用户实测修复）
 * -----------------------------------------------------------------------------
 * 背景：开机时 useTabs() 会先建一个绑隐式 default 空间的冷终端，其 cwd 落在启动/
 * 家目录。状态栏面包屑直接吃这个 cwd，于是"还没建工作区就已经显示 Home"。
 * 修法：StatusBar 只认活跃工作区 —— hasWorkspace=false 时不渲染路径面包屑。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StatusBar } from "./StatusBar";

const base = {
  home: "C:/Users/Administrator",
  onCd: () => {},
  onWorkspaceChange: () => {},
  hasComposer: false,
  privateActive: false,
};

/** StatusBar 内的 Private / RemoteOs 徽标用了 Tooltip，必须在 TooltipProvider 下渲染 */
function renderBar(props: {
  cwd: string | null;
  hasWorkspace: boolean;
  filePath?: string | null;
  terminalAddress?: string | null;
}) {
  return render(
    <TooltipProvider>
      <StatusBar {...base} {...props} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StatusBar — 工作区上下文", () => {
  it("未选择工作区：冷终端 cwd 就是家目录也不显示路径，改显「未选择工作区」", () => {
    // 这正是用户实测的场景：欢迎页那个隐式 default 空间冷终端的 cwd = 家目录，
    // 若直接把 cwd 交给面包屑，状态栏就会显示 "Home"。
    renderBar({ cwd: base.home, hasWorkspace: false });
    expect(screen.getByTestId("statusbar-no-workspace").textContent).toContain(
      "未选择工作区",
    );
    expect(screen.queryByText("Home")).toBeNull();
    expect(screen.queryByText("Administrator")).toBeNull();
  });

  it("已有工作区：正常渲染 cwd 面包屑，不出现「未选择工作区」", () => {
    renderBar({ cwd: "C:/Users/Administrator/proj", hasWorkspace: true });
    expect(screen.queryByTestId("statusbar-no-workspace")).toBeNull();
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("已有工作区但 cwd 尚未解析：保留原「no directory」提示，不误报成未选工作区", () => {
    renderBar({ cwd: null, hasWorkspace: true });
    expect(screen.queryByTestId("statusbar-no-workspace")).toBeNull();
    expect(screen.getByText("no directory")).toBeTruthy();
  });

  /** 基线取证：证明"泄漏"确实来自 cwd 本身（修复前 hasWorkspace 不存在，
   *  走的就是这一条路径 —— 家目录 cwd 会渲染成 Home）。 */
  it("基线：同一个家目录 cwd，有工作区时确实渲染成 Home", () => {
    renderBar({ cwd: base.home, hasWorkspace: true });
    expect(screen.getByText("Home")).toBeTruthy();
  });
});

/**
 * #127（2026-09-24 真机抓到）：欢迎页挂着的同时，状态栏左边那格写着
 * `root@192.168.45.128`，右边一格写着「未选择工作区」—— 同一栏自己打自己。
 * 那格还是「切换工作区环境」的下拉入口，没有工作区时点它没有作用对象。
 * 所以口径是：**这一格属于工作区，没有活跃工作区就整格不渲染**，
 * 而不是只把地址抹掉留一个 "Windows"（那仍是在宣称一个不存在的工作区环境）。
 */
describe("StatusBar — #127 未选工作区时不挂环境格", () => {
  it("已连着 SSH 但没有活跃工作区：地址不出现，环境格整体不渲染", () => {
    renderBar({
      cwd: base.home,
      hasWorkspace: false,
      terminalAddress: "root@10.0.0.5",
    });
    expect(screen.queryByText("root@10.0.0.5")).toBeNull();
    // 那一格的 tooltip 口径是"当前终端命令执行于 …"，没有工作区时不许出现
    expect(
      document.querySelector('[title*="当前终端命令执行于"]'),
    ).toBeNull();
    expect(screen.getByTestId("statusbar-no-workspace")).toBeTruthy();
  });

  /** 正向配对：证明上一条消失的是**闸**而不是地址本身（否则判据会因为
   *  "地址压根没渲染出来"而假绿 —— 本仓踩过多次的那类假绿）。 */
  it("基线：同一个地址，有活跃工作区时确实渲染出来", () => {
    renderBar({ cwd: "/root", hasWorkspace: true, terminalAddress: "root@10.0.0.5" });
    expect(screen.getByText("root@10.0.0.5")).toBeTruthy();
  });
});
