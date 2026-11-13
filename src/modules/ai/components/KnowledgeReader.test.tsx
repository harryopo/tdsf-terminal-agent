import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeReader } from "./KnowledgeReader";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc: vi.fn() }));
import { invokeRpc } from "@/lib/sidecar-bridge";

beforeEach(() => { vi.mocked(invokeRpc).mockReset(); });

describe("static knowledge reader", () => {
  it("reads by chapter without putting the whole long document on screen", () => {
    render(<KnowledgeReader doc={{ ok: true, content: "# 第一章\n\n当前章节正文\n\n## 第二章\n\n下一章节正文" }} />);
    expect(screen.getByText("当前章节正文")).toBeTruthy();
    expect(screen.queryByText("下一章节正文")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下一章" }));
    expect(screen.getByText("下一章节正文")).toBeTruthy();
    expect(screen.queryByText("当前章节正文")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "上一章" }));
    expect(screen.getByText("当前章节正文")).toBeTruthy();
  });

  it("prefers existing translation and labels partial translations honestly", () => {
    render(<KnowledgeReader doc={{ ok: true, content: "Original complete document", content_zh: "已有中文译文", translation_complete: false }} />);
    expect(screen.getByText("已有中文译文")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("仅部分片段");
    fireEvent.click(screen.getByRole("button", { name: "原文" }));
    expect(screen.getByText("Original complete document")).toBeTruthy();
    expect(screen.queryByText("已有中文译文")).toBeNull();
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it("keeps shell samples static and offers copying without terminal calls", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<KnowledgeReader doc={{ ok: true, content: "```bash\nsystemctl status nginx\n```" }} />);
    const copy = await screen.findByRole("button", { name: "复制代码" });
    expect(screen.queryByRole("button", { name: /Run|运行|插入终端/ })).toBeNull();
    fireEvent.click(copy);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain("systemctl status nginx");
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it("does not auto-load external images embedded in imported documents", () => {
    const { container } = render(<KnowledgeReader doc={{ ok: true, content: "![远端图片](https://example.invalid/pixel.png)" }} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText("[图片：远端图片]")).toBeTruthy();
  });

  it("resolves a reference defined in a later chapter without displaying that chapter", () => {
    render(<KnowledgeReader doc={{ ok: true, content: '# First\n\nSee [manual][ref].\n\n# Second\n\nOther chapter body.\n\n[ref]: https://example.invalid/guide\n  "Official reference"' }} />);
    expect(screen.getByRole("button", { name: "manual" })).toBeTruthy();
    expect(screen.queryByText("Other chapter body.")).toBeNull();
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it("shows tables and warnings and does not invent a missing translation", () => {
    render(<KnowledgeReader doc={{ ok: true, library: "reference", possibly_truncated: true, content: "| Option | Meaning |\n| --- | --- |\n| --check | Read only |\n\n> Back up before changes." }} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("--check")).toBeTruthy();
    expect(screen.getByText("Back up before changes.")).toBeTruthy();
    expect(screen.getByText(/未提供中文译文/)).toBeTruthy();
    expect(screen.getByText(/可能曾被截断/)).toBeTruthy();
    expect(invokeRpc).not.toHaveBeenCalled();
  });
});
