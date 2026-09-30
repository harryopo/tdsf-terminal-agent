/**
 * WelcomeScreen.test.tsx — 欢迎页带着旧注册表出现时，必须有「回去」的入口，
 * 而且**关于"连没连上"的那句话必须是实话**
 * -----------------------------------------------------------------------------
 * ROADMAP #61 方案 A（用户 2026-09-18 钦定）：注册表跨重启留存，但启动不自动进入。
 * 只留存不给入口 = 用户只会看到三个「新建」按钮，然后重复建同名工作区。
 *
 * ROADMAP #123 的另一半（2026-09-24 真机量到）：文案以前只按 `existingCount` 断言
 * 「没有自动连上」，而 #61-A 之后启动自动连接照样会把服务器拨通 —— 实测会话是
 * connected、窗口标题写着 `root@…:/root`，欢迎页还在说没连上。**假事实**
 * （同 #113② 那条「不许报假事实」）。所以连接状态要作为输入传进来，两条分支各自钉死。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WelcomeScreen } from "./WelcomeScreen";

const base = {
  onCreateLocal: () => {},
  onCreateSsh: () => {},
  onCreateWsl: () => {},
};

describe("WelcomeScreen — 已有工作区的回程入口", () => {
  it("中央标识用同一份 logo.svg，不再用 ⬡ 字符占位", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={0}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    const logo = document.querySelector('img[src="/logo.svg"]');
    expect(logo).toBeTruthy();
    expect(logo?.getAttribute("alt")).toBe("TDSF");
    expect(document.body.textContent).not.toContain("⬡");
  });

  it("existingCount>0：显示「打开已有工作区（N）」并回调 onOpenExisting", () => {
    const onOpenExisting = vi.fn();
    render(
      <WelcomeScreen
        {...base}
        existingCount={2}
        connectedCount={0}
        onOpenExisting={onOpenExisting}
      />,
    );
    const btn = screen.getByTestId("welcome-open-existing");
    expect(btn.textContent).toContain("打开已有工作区（2）");
    fireEvent.click(btn);
    expect(onOpenExisting).toHaveBeenCalledTimes(1);
    // 不再谎报"自动恢复"——#61-A 之后首屏是欢迎页，需要用户自己进去
    expect(document.body.textContent).not.toContain("已有工作区将自动恢复");
  });

  it("existingCount=0（首次安装 / 全删）：不显示回程按钮，也不出现计数", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={0}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    expect(screen.queryByTestId("welcome-open-existing")).toBeNull();
    // 三个新建入口仍在
    expect(screen.getByTestId("welcome-local")).toBeTruthy();
    expect(screen.getByTestId("welcome-wsl")).toBeTruthy();
    expect(screen.getByTestId("welcome-ssh")).toBeTruthy();
  });

  // #166 ⑧（2026-09-28 用户实测）：「主页不要写本地终端，直接只保留
  // 终端优先的 linux 运维 AI 工作台，然后暂无工作区内容也写简单点，保持那种大气的风格」
  it("首次进入只留一句定位语，不再把三个按钮的内容列一遍", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={0}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("终端优先的 Linux 运维 AI 工作台");
    // 列举式的那句（"本地终端、WSL 或连接 SSH 服务器"）删掉了：
    // 按钮已经说了三遍，正文再列一遍既不大气也挡了读
    expect(text).not.toContain("本地终端、WSL 或连接 SSH 服务器");
    // 没有旧工作区就没有"重启会不会丢东西"要解释，脚注整条不出现
    expect(text).not.toContain("不会自动进入工作区");
  });
});

describe("WelcomeScreen — 「连没连上」必须是实话（#123 另一半）", () => {
  it("服务器连着时，不许说「没连上」", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={1}
        connectedCount={1}
        onOpenExisting={() => {}}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("已连上");
    expect(text).not.toContain("没有自动连上");
    expect(text).not.toContain("尚未连上");
    // 配对：不能只靠"删掉一句话"通过——回程入口必须还在
    expect(screen.getByTestId("welcome-open-existing")).toBeTruthy();
  });

  it("服务器没连着时，不许反过来吹成「已连上」", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={1}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("自动重连");
    // #166 ⑧ 改的是措辞，不是这条底线：没连着就一个字都不能说成连着
    expect(text).not.toContain("已连上");
  });

  it("两种情况都说清「不自动进入工作区」以及从哪里回去（不许只说没连上就完事）", () => {
    for (const connectedCount of [0, 1]) {
      const { unmount } = render(
        <WelcomeScreen
          {...base}
          existingCount={1}
          connectedCount={connectedCount}
          onOpenExisting={() => {}}
        />,
      );
      const text = document.body.textContent ?? "";
      expect(text).toContain("不会自动进入工作区");
      expect(text).toContain("顶栏「选择工作区」");
      unmount();
    }
  });

  it("接线：App.tsx 必须把真实连接数传进来（实现了没接上等于没有）", () => {
    // 路径按本仓既有静态扫描用例的写法（join(process.cwd(), "src/…")）
    const app = readFileSync(
      join(process.cwd(), "src/app/App.tsx"),
      "utf8",
    );
    expect(app).toContain("connectedCount={connectedSpaceCount}");
    // 订阅的是会话表本身，不是长度/布尔快照——否则连接状态变了文案不会跟着改
    expect(app).toMatch(
      /useSshStore\(\(s\) => s\.sessions\)[\s\S]{0,240}connectedSshSpaceCount\(/,
    );
  });
});

describe("#166 真机看图轮 — 主次与「同一句话说两遍」", () => {
  /** 实心主按钮 = Button 的 default 变体（bg-primary）；描边按钮 = outline。 */
  const isSolid = (el: HTMLElement) => el.className.includes("bg-primary");

  it("有旧工作区时，实心那颗必须是「打开已有工作区」，不是「新建本地工作区」", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={1}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    // 真机截图上看到的：唯一那颗实心灰按钮写着「新建本地工作区」——
    // 一个带着已存服务器回来的人，界面却在喊"再建一个"。主次反了。
    expect(isSolid(screen.getByTestId("welcome-open-existing"))).toBe(true);
    expect(isSolid(screen.getByTestId("welcome-local"))).toBe(false);
  });

  it("配对：首次启动（没有旧工作区）时实心仍给「新建本地工作区」", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={0}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    expect(isSolid(screen.getByTestId("welcome-local"))).toBe(true);
    expect(screen.queryByTestId("welcome-open-existing")).toBeNull();
  });

  it("脚注不许把正文已经说过的「自动重连」再讲一遍", () => {
    render(
      <WelcomeScreen
        {...base}
        existingCount={1}
        connectedCount={0}
        onOpenExisting={() => {}}
      />,
    );
    const text = document.body.textContent ?? "";
    // 「重连」在整页只许出现一次（正文那句）；同义重复就是漏臂的温床（#127 那条）
    expect(text.match(/重连/g)?.length).toBe(1);
    // 但脚注仍然要说清它自己那件事：为什么停在这里 + 从哪里回去
    expect(text).toContain("不会自动进入工作区");
    expect(text).toContain("顶栏「选择工作区」");
  });
});
