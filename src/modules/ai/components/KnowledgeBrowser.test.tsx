/**
 * KnowledgeBrowser.test.tsx — 知识库浏览器测试（P2-4）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. 挂载即浏览：调用 knowledge.list 渲染条目列表（像文件列表）
 *   2. 搜索调用 knowledge.search RPC
 *   3. 点击结果加载详情（knowledge.get）并渲染
 *   4. 详情弹窗返回按钮回到列表
 *   5. 搜索无结果显示空态
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

describe("KnowledgePanel — 知识库浏览器", () => {
  it("挂载即浏览模式：调用 knowledge.list 渲染条目（像文件列表）", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({ results: [HIT] });
    render(<KnowledgePanel />);

    expect(await screen.findByText("ls — 列出目录内容")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.list", {
      limit: 50,
      offset: 0,
    });
  });

  it("搜索调用 knowledge.search RPC 并渲染结果", async () => {
    vi.mocked(invokeRpc)
      .mockResolvedValueOnce({ results: [HIT] }) // 挂载 list
      .mockResolvedValueOnce({ results: [HIT] }); // search
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

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

  it("点击结果加载详情（knowledge.get）并渲染 md", async () => {
    vi.mocked(invokeRpc)
      .mockResolvedValueOnce({ results: [HIT] }) // 挂载 list
      .mockResolvedValueOnce({ results: [HIT] }) // search
      .mockResolvedValueOnce({
        entry: { ...HIT, content: "## 详细内容\nls 的详细讲解……" },
      }); // get
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    fireEvent.click(await screen.findByText("ls — 列出目录内容"));

    expect(await screen.findByText("ls 的详细讲解……")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "cmd-ls" });
  });

  it("详情弹窗返回按钮回到列表", async () => {
    vi.mocked(invokeRpc)
      .mockResolvedValueOnce({ results: [HIT] }) // 挂载 list
      .mockResolvedValueOnce({ results: [HIT] }) // search
      .mockResolvedValueOnce({ entry: { ...HIT, content: "详细内容" } }); // get
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    fireEvent.click(await screen.findByText("ls — 列出目录内容"));
    await screen.findByText("详细内容");

    fireEvent.click(screen.getByText("返回"));
    expect(screen.getByPlaceholderText(/搜索命令/)).toBeTruthy();
  });

  it("搜索无结果显示空态", async () => {
    vi.mocked(invokeRpc)
      .mockResolvedValueOnce({ results: [HIT] }) // 挂载 list
      .mockResolvedValueOnce({ results: [] }); // search 无结果
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "qqxxzz" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/未找到相关条目/)).toBeTruthy();
  });

  it("知识库为空时显示空态", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({ results: [] });
    render(<KnowledgePanel />);
    expect(await screen.findByText(/知识库为空/)).toBeTruthy();
  });
});
