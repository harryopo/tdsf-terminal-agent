/**
 * TranslateTooltip.test.tsx — 翻译卡片测试（P2 重构）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 命中：显示原文 + 释义 + 词典 tag
 *   2. 命中卡片「Ask TDSF」按钮 → onAsk(原文) 且隐藏卡片
 *   3. 未命中：显示提示 + Ask 按钮
 *   4. 无状态不渲染
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TranslateTooltip } from "./TranslateTooltip";
import { useTranslateStore } from "./translateStore";

const hitResult = {
  source: "grep",
  target: "grep",
  success: true,
  entries: [
    {
      word: "grep",
      zh: "文本搜索工具",
      pos: "命令",
      tag: "linux",
      exact: true,
    },
  ],
};

afterEach(() => {
  useTranslateStore.getState().hideTooltip();
});

describe("TranslateTooltip — 翻译卡片（P2）", () => {
  it("命中：显示原文 + 释义 + 词典 tag", () => {
    useTranslateStore.getState().showTooltip(hitResult, 100, 200);
    render(<TranslateTooltip />);
    expect(screen.getByTestId("translate-tooltip")).toBeTruthy();
    expect(screen.getByText("grep")).toBeTruthy();
    expect(screen.getByText("文本搜索工具")).toBeTruthy();
    expect(screen.getByText("linux")).toBeTruthy();
  });

  it("命中卡片 Ask 按钮 → onAsk(原文) 且隐藏", () => {
    const onAsk = vi.fn();
    useTranslateStore.getState().showTooltip(hitResult, 100, 200);
    render(<TranslateTooltip onAsk={onAsk} />);
    fireEvent.click(screen.getByTestId("translate-ask"));
    expect(onAsk).toHaveBeenCalledWith("grep");
    expect(useTranslateStore.getState().result).toBeNull();
  });

  it("未命中：提示 + Ask 按钮", () => {
    const onAsk = vi.fn();
    useTranslateStore.getState().showMissing("kubelet", 100, 200);
    render(<TranslateTooltip onAsk={onAsk} />);
    expect(screen.getByTestId("translate-tooltip-missing")).toBeTruthy();
    fireEvent.click(screen.getByTestId("translate-ask"));
    expect(onAsk).toHaveBeenCalledWith("kubelet");
  });

  it("无状态不渲染", () => {
    render(<TranslateTooltip />);
    expect(screen.queryByTestId("translate-tooltip")).toBeNull();
    expect(screen.queryByTestId("translate-tooltip-missing")).toBeNull();
  });

  it("底部空间不足：卡片翻转到选中点上方（slide-in-from-top）", () => {
    const { container } = render(<TranslateTooltip />);
    act(() => {
      // y 超出视口底部 → 下方放不下 → 应翻转到上方
      useTranslateStore.getState().showTooltip(hitResult, 100, window.innerHeight + 200);
    });
    const card = container.querySelector("[data-translate-tooltip]");
    expect(card).toBeTruthy();
    expect(card!.className).toContain("slide-in-from-top-1");
    expect(card!.className).not.toContain("slide-in-from-bottom-1");
  });

  it("中部区域：卡片默认在选中点下方（slide-in-from-bottom）", () => {
    const { container } = render(<TranslateTooltip />);
    act(() => {
      useTranslateStore.getState().showTooltip(hitResult, 100, 200);
    });
    const card = container.querySelector("[data-translate-tooltip]");
    expect(card).toBeTruthy();
    expect(card!.className).toContain("slide-in-from-bottom-1");
    expect(card!.className).not.toContain("slide-in-from-top-1");
  });
});
