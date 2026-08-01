/**
 * SelectionAskAi.test.tsx — 选中浮层测试（P2 重构）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 默认渲染 Ask TDSF 按钮
 *   2. showTranslate 时渲染「翻译」按钮，点击触发 onTranslate(x, y)
 *   3. 翻译按钮隐藏时不渲染
 *   4. Ask 点击触发 onAsk
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SelectionAskAi } from "./SelectionAskAi";

const baseProps = {
  state: "open" as const,
  x: 100,
  y: 200,
  onAsk: () => {},
  onDismiss: () => {},
};

describe("SelectionAskAi — 选中浮层（P2）", () => {
  it("渲染 Ask TDSF 按钮", () => {
    render(<SelectionAskAi {...baseProps} />);
    expect(screen.getByTestId("selection-ask-ai")).toBeTruthy();
  });

  it("showTranslate 时渲染翻译按钮，点击触发 onTranslate(x, y)", () => {
    const onTranslate = vi.fn();
    render(
      <SelectionAskAi
        {...baseProps}
        showTranslate
        onTranslate={onTranslate}
      />,
    );
    const btn = screen.getByTestId("selection-translate");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onTranslate).toHaveBeenCalledWith(100, 200);
  });

  it("showTranslate=false 时不渲染翻译按钮", () => {
    render(<SelectionAskAi {...baseProps} showTranslate={false} />);
    expect(screen.queryByTestId("selection-translate")).toBeNull();
  });

  it("点击 Ask 触发 onAsk", () => {
    const onAsk = vi.fn();
    render(<SelectionAskAi {...baseProps} onAsk={onAsk} />);
    fireEvent.click(screen.getByTestId("selection-ask-ai"));
    expect(onAsk).toHaveBeenCalled();
  });
});
