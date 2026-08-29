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

// TDSF 魔改 2026-08-29: 分组浏览测试数据
const DOC_HIT = {
  id: "doc-1",
  source: "builtin-docs",
  title: "文件权限基础",
  content: "chmod 用于修改文件权限。",
  url: "docs/linux-basics.md",
  tags: [],
};

const CRAWL_HIT = {
  id: "crawl-1",
  source: "nginx-docs",
  title: "nginx 配置入门",
  content: "nginx 配置说明。",
  url: "",
  tags: [],
};

const CASE_HIT = {
  id: "case-1",
  source: "case-20260801-boot-repair",
  title: "修复启动失败案例",
  content: "grub 修复步骤。",
  url: "",
  tags: [],
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

  // TDSF 魔改 2026-08-29: 按来源分组浏览
  it("按来源分组渲染中文组头与条数 badge", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({
      results: [HIT, DOC_HIT, CRAWL_HIT, CASE_HIT],
    });
    render(<KnowledgePanel />);

    // 组头：映射中文名（*-docs → 前缀+文档；case- → 会话沉淀）
    expect(await screen.findByText("内置命令卡片")).toBeTruthy();
    expect(screen.getByText("内置教学文档")).toBeTruthy();
    expect(screen.getByText("nginx文档")).toBeTruthy();
    expect(screen.getByText("会话沉淀")).toBeTruthy();
    // 组内条目仍在
    expect(screen.getByText("nginx 配置入门")).toBeTruthy();
  });

  it("builtin-docs 组从 url 提取文件名显示为组内小标题", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({ results: [DOC_HIT] });
    render(<KnowledgePanel />);

    expect(await screen.findByText("linux-basics.md")).toBeTruthy();
    expect(screen.getByText("文件权限基础")).toBeTruthy();
  });

  it("点击组头折叠该组（条目隐藏），再点展开恢复", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({ results: [HIT, DOC_HIT] });
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    // 折叠「内置命令卡片」组
    fireEvent.click(screen.getByText("内置命令卡片"));
    expect(screen.queryByText("ls — 列出目录内容")).toBeNull();
    // 另一组不受影响
    expect(screen.getByText("文件权限基础")).toBeTruthy();

    // 再点展开恢复
    fireEvent.click(screen.getByText("内置命令卡片"));
    expect(screen.getByText("ls — 列出目录内容")).toBeTruthy();
  });
});
