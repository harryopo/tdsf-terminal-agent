/**
 * KnowledgeBrowser.test.tsx — 知识库浏览器测试（P2-4）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 打开时渲染搜索框
 *   2. 搜索调用 knowledge.search RPC 并渲染结果列表
 *   3. 点击结果加载详情（knowledge.get）并渲染 md 标题
 *   4. 返回按钮回到列表
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { KnowledgePanel } from "./KnowledgeBrowser";

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
}));

import { invokeRpc } from "@/lib/sidecar-bridge";

const HIT = {
  id: "cmd-ls",
  source: "builtin-corpus",
  title: "ls — 列出目录内容",
  content: "ls 是 Linux 最常用的命令，用于列出目录内容。",
  url: "",
  tags: ["命令", "入门"],
  match_type: "fts",
};

beforeEach(() => {
  vi.mocked(invokeRpc).mockReset();
});

describe("KnowledgeBrowser — 知识库浏览器", () => {
  it("打开时渲染搜索框与提示", () => {
    render(<KnowledgePanel />);
    expect(screen.getByPlaceholderText(/搜索命令/)).toBeTruthy();
  });

  it("搜索调用 RPC 并渲染结果列表", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({ results: [HIT] });
    render(<KnowledgePanel />);

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText("ls — 列出目录内容")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.search", {
      query: "ls",
      limit: 30,
      method: "hybrid",
    });
  });

  it("点击结果加载详情（knowledge.get）", async () => {
    vi.mocked(invokeRpc).mockResolvedValueOnce({ results: [HIT] });
    vi.mocked(invokeRpc).mockResolvedValueOnce({
      entry: { ...HIT, content: "## 详细内容\nls 的详细讲解……" },
    });
    render(<KnowledgePanel />);

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    fireEvent.click(await screen.findByText("ls — 列出目录内容"));

    expect(await screen.findByText("ls — 列出目录内容")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "cmd-ls" });
  });

  it("详情页返回按钮回到列表", async () => {
    vi.mocked(invokeRpc).mockResolvedValueOnce({ results: [HIT] });
    vi.mocked(invokeRpc).mockResolvedValueOnce({
      entry: { ...HIT, content: "详细内容" },
    });
    render(<KnowledgePanel />);

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    fireEvent.click(await screen.findByText("ls — 列出目录内容"));
    await screen.findByText("详细内容");

    fireEvent.click(screen.getByText("返回"));
    expect(screen.getByPlaceholderText(/搜索命令/)).toBeTruthy();
  });

  it("无结果时显示空态", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({ results: [] });
    render(<KnowledgePanel />);

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "qqxxzz" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/未找到相关条目/)).toBeTruthy();
  });
});
