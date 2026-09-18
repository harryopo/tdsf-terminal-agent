/**
 * WelcomeScreen.test.tsx — 欢迎页带着旧注册表出现时，必须有「回去」的入口
 * -----------------------------------------------------------------------------
 * ROADMAP #61 方案 A（用户 2026-09-18 钦定）：注册表跨重启留存，但启动不自动进入。
 * 只留存不给入口 = 用户只会看到三个「新建」按钮，然后重复建同名工作区。
 */
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
      <WelcomeScreen {...base} existingCount={0} onOpenExisting={() => {}} />,
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
      <WelcomeScreen {...base} existingCount={0} onOpenExisting={() => {}} />,
    );
    expect(screen.queryByTestId("welcome-open-existing")).toBeNull();
    // 三个新建入口仍在
    expect(screen.getByTestId("welcome-local")).toBeTruthy();
    expect(screen.getByTestId("welcome-wsl")).toBeTruthy();
    expect(screen.getByTestId("welcome-ssh")).toBeTruthy();
  });
});
