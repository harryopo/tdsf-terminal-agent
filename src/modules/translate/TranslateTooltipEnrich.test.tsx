/**
 * 翻译卡片未命中分支的「AI 补全」入口（P6 的唯一 UI 触点）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TranslateTooltip } from "./TranslateTooltip";
import { translateText } from "./translateApi";
import { clearEnrichments, putEnrichment } from "./enrichmentStore";
import { useTranslateStore } from "./translateStore";

const enrichTerm = vi.fn();

vi.mock("./enrichClient", () => ({
  enrichTerm: (term: string) => enrichTerm(term),
  enrichQuotaLeft: () => 5,
}));

beforeEach(() => {
  enrichTerm.mockReset();
  clearEnrichments();
  useTranslateStore.getState().hideTooltip();
});

describe("TranslateTooltip 未命中态", () => {
  it("给出「AI 补全释义」按钮，点击后才调模型并把释义换成命中卡片", async () => {
    // 真实客户端会把结果写进增量词库；这里照同样的契约模拟，才能验证"下次本地命中"
    enrichTerm.mockImplementation(async (term: string) => {
      putEnrichment({ word: term, zh: "本地补出来的释义" });
      return [{ word: term, zh: "本地补出来的释义", exact: true }];
    });
    useTranslateStore.getState().showMissing("glorp", 10, 10);

    render(<TranslateTooltip />);
    const button = screen.getByTestId("translate-enrich");
    expect(button.textContent).toContain("AI 补全释义");

    fireEvent.click(button);
    await vi.waitFor(() => {
      expect(screen.getByTestId("translate-tooltip")).toBeTruthy();
    });
    expect(enrichTerm).toHaveBeenCalledWith("glorp");
    expect(useTranslateStore.getState().missing).toBeNull();
    expect(translateText("glorp").entries[0].zh).toBe("本地补出来的释义");
  });

  it("模型没给结果时保持未命中态，只把按钮变成可重试", async () => {
    enrichTerm.mockResolvedValue(null);
    useTranslateStore.getState().showMissing("glorp2", 10, 10);

    render(<TranslateTooltip />);
    fireEvent.click(screen.getByTestId("translate-enrich"));
    // 点击后先是「AI 补全中…」，异步失败后才换成可重试文案，
    // 所以两个断言都要放在 waitFor 里等状态稳定。
    await vi.waitFor(() => {
      const text = screen.getByTestId("translate-enrich").textContent ?? "";
      expect(text).toContain("可再试");
      expect(screen.getByTestId("translate-tooltip-missing")).toBeTruthy();
    });
    expect(enrichTerm).toHaveBeenCalledWith("glorp2");
  });
});
