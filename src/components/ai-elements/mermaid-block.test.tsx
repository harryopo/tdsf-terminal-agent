/**
 * mermaid-block.test.tsx — ```mermaid 代码块 SVG 渲染测试（TDSF 2026-08-30）
 * -----------------------------------------------------------------------------
 * mock mermaid 模块（happy-dom 下真实渲染依赖布局测量，不可靠）：
 *  1. 渲染成功 → 注入 SVG（dangerouslySetInnerHTML）
 *  2. render 抛错 → 回退显示源码 pre（不白屏）
 *  3. MarkdownCode 对 language-mermaid 分派到 MermaidBlock（不再走代码高亮）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mockRender = vi.fn();
const mockInitialize = vi.fn();

vi.mock("mermaid", () => ({
  default: {
    initialize: (cfg: unknown) => mockInitialize(cfg),
    render: (id: string, code: string) => mockRender(id, code),
  },
}));

import { MarkdownCode } from "./markdown-code";
import { MermaidBlock } from "./mermaid-block";

beforeEach(() => {
  mockRender.mockReset();
  mockInitialize.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MermaidBlock", () => {
  it("渲染成功：mermaid.render 的 SVG 注入容器", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="mm">graph TD</svg>' });
    render(<MermaidBlock code={"graph TD;\nA-->B;"} />);

    await waitFor(() => {
      expect(document.querySelector('svg[data-testid="mm"]')).toBeTruthy();
    });
    expect(mockRender).toHaveBeenCalledTimes(1);
    expect(mockRender.mock.calls[0][1]).toBe("graph TD;\nA-->B;");
    // initialize 配置：strict 安全等级 + 非自动启动
    const cfg = mockInitialize.mock.calls[0][0] as Record<string, unknown>;
    expect(cfg.securityLevel).toBe("strict");
    expect(cfg.startOnLoad).toBe(false);
  });

  it("render 抛错 → 回退显示源码（不白屏）", async () => {
    mockRender.mockRejectedValue(new Error("parse error"));
    render(<MermaidBlock code={"graph TD; broken(("} />);

    expect(await screen.findByText(/图表渲染失败/)).toBeTruthy();
    expect(screen.getByText("graph TD; broken((")).toBeTruthy();
  });
});

describe("MarkdownCode — mermaid 分派", () => {
  it("language-mermaid 围栏走 MermaidBlock（SVG），不走代码高亮", async () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="mm2" />' });
    render(
      <MarkdownCode className="language-mermaid">
        {"graph LR;\nA-->B;\n"}
      </MarkdownCode>,
    );

    await waitFor(() => {
      expect(document.querySelector('svg[data-testid="mm2"]')).toBeTruthy();
    });
  });

  it("非 mermaid 语言不受影响（无 mermaid.render 调用）", async () => {
    render(
      <MarkdownCode className="language-bash">{"echo hi\n"}</MarkdownCode>,
    );
    expect(await screen.findByText("echo hi")).toBeTruthy();
    expect(mockRender).not.toHaveBeenCalled();
  });
});
