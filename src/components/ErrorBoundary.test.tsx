/**
 * ErrorBoundary.test.tsx —— #125：一块崩不许带走整窗
 *
 * 起因是用户 2026-09-24 实测「窗口卡住了」，量出来是白屏：挂在 App 顶层的弹窗抛错，
 * 而那时**只有侧栏那一格有边界**，React 18 没有边界覆盖时把整棵树卸载 ⇒ `#root` 子节点 0。
 * 边界组件其实早就存在，缺的是**接线**。所以这里两类判据都要有：
 * A. 行为：隔离范围、提示内容（哪一块 + 原始消息）、恢复动作；
 * B. 结构：`main.tsx` 必须真的用边界包住 `<App />`、`App.tsx` 必须有三道分区边界
 *    —— 这类"实现了但没接上"的缺口编译器永远发现不了，只能靠读源码钉住。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, vi } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

/** 可开关的炸弹：重试之后要能真的恢复正常，否则"能恢复"这条判据无从成立 */
let boom = true;
function Boom() {
  if (boom) throw new Error("模拟渲染期崩溃");
  return <p>这块界面好了</p>;
}

// React 自己也会往 console 打组件栈，这里只关心边界那一条
let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  boom = true;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("ErrorBoundary — 一块崩不许带走整窗", () => {
  it("子组件抛错时，兄弟区域照常渲染（白屏那条路必须堵死）", () => {
    render(
      <div>
        <p>外面的世界</p>
        <ErrorBoundary label="工作区">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    // 核心不变量：崩溃被隔离在边界内，边界之外一个字都没少
    expect(screen.getByText("外面的世界")).toBeTruthy();
    expect(screen.getByTestId("error-boundary")).toBeTruthy();
  });

  it("提示要说清是哪一块、原始错误是什么（不许糊成一句「出错了」）", () => {
    render(
      <ErrorBoundary label="工作区">
        <Boom />
      </ErrorBoundary>,
    );
    const box = screen.getByTestId("error-boundary");
    expect(box.textContent).toContain("工作区渲染出错");
    expect(box.textContent).toContain("模拟渲染期崩溃");
    // 书面语口径（#124 定的）：界面按纯文本渲染，不许出现 markdown 反引号
    expect(box.textContent).not.toContain("`");
  });

  it("「重试该区域」清状态重渲染：一次性故障不必刷新整页就能恢复", () => {
    render(
      <ErrorBoundary label="工作区">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("工作区渲染出错")).toBeTruthy();

    boom = false; // 故障消失（对应 HMR 推了个中间态、代码本身是好的那种情况）
    fireEvent.click(screen.getByRole("button", { name: "重试工作区" }));

    expect(screen.queryByTestId("error-boundary")).toBeNull();
    // 配对：不是"什么都没渲染"造成的消失
    expect(screen.getByText("这块界面好了")).toBeTruthy();
  });

  it("原始错误仍然进 console（不许为了界面干净吞掉线索）", () => {
    render(
      <ErrorBoundary label="弹窗">
        <Boom />
      </ErrorBoundary>,
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[ErrorBoundary] caught:"),
      expect.any(Error),
      expect.anything(),
    );
  });

  it("弹窗层那道必须浮起来：就地渲染会被壳层 overflow-hidden 裁掉", () => {
    const { rerender } = render(
      <ErrorBoundary label="弹窗" overlay>
        <Boom />
      </ErrorBoundary>,
    );
    const box = screen.getByTestId("error-boundary");
    expect(box.getAttribute("data-overlay")).toBe("true");
    expect(box.className).toContain("fixed");

    // 正向配对：没标 overlay 的区域边界是就地填充，不是 fixed
    rerender(
      <ErrorBoundary label="工作区">
        <Boom />
      </ErrorBoundary>,
    );
    const inPlace = screen.getByTestId("error-boundary");
    expect(inPlace.getAttribute("data-overlay")).toBe("false");
    expect(inPlace.className).not.toContain("fixed");
  });
});

describe("接线（结构门禁）—— 实现了但没接上等于没有", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("main.tsx 用 ErrorBoundary 包住 <App />：根节点这一道是最后的兜底", () => {
    const main = read("../main.tsx");
    expect(main).toMatch(/<ErrorBoundary[\s\S]*?<App\s*\/>[\s\S]*?<\/ErrorBoundary>/);
  });

  it("App.tsx 有工作区与弹窗两道分区边界，且弹窗那道是 overlay", () => {
    const app = read("../app/App.tsx");
    expect(app).toContain('<ErrorBoundary label="工作区">');
    expect(app).toContain('<ErrorBoundary label="弹窗" overlay>');
    // 侧栏那道（2026-07-28 就有）不许被顺手删掉
    expect(app).toContain("<ErrorBoundary>");
  });
});
