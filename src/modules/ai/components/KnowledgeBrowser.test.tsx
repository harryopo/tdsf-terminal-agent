/**
 * KnowledgeBrowser.test.tsx — 知识库浏览器测试（P2-4 + 两级文件视图）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   浏览模式（默认）
 *     1. 挂载即浏览：调用 knowledge.list 渲染条目（无 url 来源保持条目式）
 *     2. 含文档来源组内列文件（knowledge.list_files：filename/title0/块数/字数）
 *     3. list_files 懒加载缓存：折叠再展开同组不重复请求
 *     4. 分组 → 文件 → 完整文档链路（knowledge.get_doc：标题=filename、
 *        「共 N 块 · 约 X 字」元信息、完整 md 渲染）
 *     5. get_doc 失败 → 弹窗内错误态（fail-closed）
 *     6. get_doc 缓存：弹窗重复打开同一文档不重复请求
 *   搜索模式
 *     7. 搜索调用 knowledge.search RPC 并渲染结果
 *     8. 搜索命中条目显示所属文件名（从 hit.url 提取）
 *     9. 点击带 url 命中 → get_doc 完整文档 + 「来自搜索命中，第 N 块」
 *   通用
 *    10. 点击无 url 条目加载详情（knowledge.get）并渲染
 *    11. 详情弹窗返回按钮回到列表
 *    12. 搜索无结果 / 知识库为空空态
 *    13. 分组中文组头渲染 + 折叠展开
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { KnowledgePanel } from "./KnowledgeBrowser";
import { clearKnowledgeCaches } from "@/modules/ai/lib/knowledge-cache";

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
}));

import { invokeRpc } from "@/lib/sidecar-bridge";

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown;

/** 按 method 分发 mock（各用例只声明自己关心的 RPC，未声明的返回空结果） */
function mockRpc(handler: RpcHandler) {
  vi.mocked(invokeRpc).mockImplementation(
    (async (method: string, params?: Record<string, unknown>) =>
      handler(method, params ?? {})) as typeof invokeRpc,
  );
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

// builtin-corpus 命令卡片：无 url，保持条目式
const HIT = {
  id: "cmd-ls",
  source: "builtin-corpus",
  title: "ls — 列出目录内容",
  content: "ls 是 Linux 最常用的命令，用于列出目录内容。",
  url: "",
  tags: ["命令", "入门"],
  match_type: "fts",
};

// builtin-docs 文件级条目（knowledge.list_files 返回）
const DOC_FILE = {
  url: "docs/linux-basics.md",
  filename: "linux-basics.md",
  title0: "文件权限基础",
  chunks: 3,
  total_chars: 1234,
  source: "builtin-docs",
};

// builtin-docs 分块条目（knowledge.list / search 返回；id 尾部序号 = 块序号，从 0 起）
const DOC_CHUNK_HIT = {
  id: "doc-abc123-2",
  source: "builtin-docs",
  title: "修改文件权限",
  content: "chmod 用于修改文件权限。",
  url: "docs/linux-basics.md",
  tags: [],
};

// knowledge.get_doc 返回的完整文档
const DOC_FULL = {
  ok: true,
  url: "docs/linux-basics.md",
  filename: "linux-basics.md",
  source: "builtin-docs",
  title: "文件权限基础",
  content: "# 文件权限基础\n\nchmod 完整讲解，覆盖数字法与符号法。",
  chunks: 3,
  total_chars: 1234,
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
  // 模块级浏览缓存跨用例清空，避免串扰
  clearKnowledgeCaches();
});

// ---------------------------------------------------------------------------
// 浏览模式
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 浏览模式", () => {
  it("挂载即浏览模式：调用 knowledge.list 渲染条目（像文件列表）", async () => {
    mockRpc((method) =>
      method === "knowledge.list" ? { results: [HIT] } : {},
    );
    render(<KnowledgePanel />);

    expect(await screen.findByText("ls — 列出目录内容")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.list", {
      limit: 50,
      offset: 0,
    });
  });

  it("含文档来源组内列文件：显示 filename/title0/块数/字数（knowledge.list_files）", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.list") return { results: [DOC_CHUNK_HIT] };
      if (method === "knowledge.list_files") {
        expect(params).toEqual({ source: "builtin-docs" });
        return { files: [DOC_FILE], total: 1 };
      }
      return {};
    });
    render(<KnowledgePanel />);

    expect(await screen.findByText("linux-basics.md")).toBeTruthy();
    expect(screen.getByText("文件权限基础")).toBeTruthy(); // title0 副行
    expect(screen.getByText(/3 块 · 1234 字/)).toBeTruthy(); // 块数/字数徽章
    // 组内不再平铺分块条目
    expect(screen.queryByText("修改文件权限")).toBeNull();
  });

  it("list_files 懒加载缓存：折叠再展开同组不重复请求", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [DOC_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [DOC_FILE], total: 1 };
      return {};
    });
    render(<KnowledgePanel />);
    await screen.findByText("linux-basics.md");

    // 折叠「内置教学文档」组再展开
    fireEvent.click(screen.getByText("内置教学文档"));
    expect(screen.queryByText("linux-basics.md")).toBeNull();
    fireEvent.click(screen.getByText("内置教学文档"));
    expect(await screen.findByText("linux-basics.md")).toBeTruthy();

    const calls = vi.mocked(invokeRpc).mock.calls as unknown as [
      string,
      Record<string, unknown>?,
    ][];
    expect(calls.filter(([m]) => m === "knowledge.list_files")).toHaveLength(1);
  });

  it("分组 → 文件 → 完整文档链路：get_doc 渲染完整 md + filename 标题 + 块/字元信息", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [DOC_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [DOC_FILE], total: 1 };
      if (method === "knowledge.get_doc") return DOC_FULL;
      return {};
    });
    render(<KnowledgePanel />);

    // 点文件行 → 打开完整文档
    fireEvent.click(await screen.findByText("linux-basics.md"));

    expect(await screen.findByText("chmod 完整讲解，覆盖数字法与符号法。")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", {
      url: "docs/linux-basics.md",
    });
    expect(screen.getByText(/共 3 块 · 约 1234 字/)).toBeTruthy();
    // 弹窗标题=filename（面板文件行文本重复，用 DialogTitle 的 heading 角色定位）
    expect(
      screen.getByRole("heading", { name: /linux-basics\.md/ }),
    ).toBeTruthy();
  });

  it("get_doc 失败（ok=false）→ 弹窗内错误态（fail-closed）", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [DOC_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [DOC_FILE], total: 1 };
      if (method === "knowledge.get_doc")
        return {
          ok: false,
          error: "document not found: docs/linux-basics.md",
        };
      return {};
    });
    render(<KnowledgePanel />);

    fireEvent.click(await screen.findByText("linux-basics.md"));
    expect(await screen.findByText(/文档加载失败/)).toBeTruthy();
    expect(screen.getByText(/document not found/)).toBeTruthy();
  });

  it("get_doc 缓存：弹窗重复打开同一文档不重复请求", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [DOC_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [DOC_FILE], total: 1 };
      if (method === "knowledge.get_doc") return DOC_FULL;
      return {};
    });
    render(<KnowledgePanel />);

    // 第一次打开
    fireEvent.click(await screen.findByText("linux-basics.md"));
    await screen.findByText("chmod 完整讲解，覆盖数字法与符号法。");
    // 关闭（返回）
    fireEvent.click(screen.getByText("返回"));
    // 第二次打开
    fireEvent.click(screen.getByText("linux-basics.md"));
    expect(await screen.findByText("chmod 完整讲解，覆盖数字法与符号法。")).toBeTruthy();

    const calls = vi.mocked(invokeRpc).mock.calls as unknown as [
      string,
      Record<string, unknown>?,
    ][];
    expect(calls.filter(([m]) => m === "knowledge.get_doc")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 搜索模式
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 搜索模式", () => {
  it("搜索调用 knowledge.search RPC 并渲染结果", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT] }
        : method === "knowledge.search"
          ? { results: [HIT] }
          : {},
    );
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

  it("搜索命中条目显示所属文件名（从 hit.url 提取）", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT] }
        : method === "knowledge.search"
          ? { results: [DOC_CHUNK_HIT] }
          : {},
    );
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "chmod" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    // 命中条目 + 所属文件名 badge
    expect(await screen.findByText("修改文件权限")).toBeTruthy();
    expect(screen.getByText("linux-basics.md")).toBeTruthy();
  });

  it("点击带 url 命中 → get_doc 完整文档 + 「来自搜索命中，第 N 块」", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT] }
        : method === "knowledge.search"
          ? { results: [DOC_CHUNK_HIT] }
          : method === "knowledge.get_doc"
            ? DOC_FULL
            : {},
    );
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "chmod" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    fireEvent.click(await screen.findByText("修改文件权限"));

    // doc-abc123-2 → 块序号 2（从 0 起）→ 第 3 块
    expect(await screen.findByText(/来自搜索命中，第 3 块/)).toBeTruthy();
    expect(await screen.findByText("chmod 完整讲解，覆盖数字法与符号法。")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 通用（条目详情 / 空态 / 分组交互）
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 条目详情与空态", () => {
  it("点击无 url 条目加载详情（knowledge.get）并渲染 md", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT] }
        : method === "knowledge.search"
          ? { results: [HIT] }
          : method === "knowledge.get"
            ? { entry: { ...HIT, content: "## 详细内容\nls 的详细讲解……" } }
            : {},
    );
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
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT] }
        : method === "knowledge.search"
          ? { results: [HIT] }
          : method === "knowledge.get"
            ? { entry: { ...HIT, content: "详细内容" } }
            : {},
    );
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
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT] }
        : method === "knowledge.search"
          ? { results: [] }
          : {},
    );
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "qqxxzz" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/未找到相关条目/)).toBeTruthy();
  });

  it("知识库为空时显示空态", async () => {
    mockRpc(() => ({ results: [] }));
    render(<KnowledgePanel />);
    expect(await screen.findByText(/知识库为空/)).toBeTruthy();
  });
});

describe("KnowledgePanel — 来源分组", () => {
  it("按来源分组渲染中文组头与条数 badge", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT, DOC_CHUNK_HIT, CRAWL_HIT, CASE_HIT] }
        : method === "knowledge.list_files"
          ? { files: [DOC_FILE], total: 1 }
          : {},
    );
    render(<KnowledgePanel />);

    // 组头：映射中文名（*-docs → 前缀+文档；case- → 会话沉淀）
    expect(await screen.findByText("内置命令卡片")).toBeTruthy();
    expect(screen.getByText("内置教学文档")).toBeTruthy();
    expect(screen.getByText("nginx文档")).toBeTruthy();
    expect(screen.getByText("会话沉淀")).toBeTruthy();
    // 无 url 来源组内条目仍在
    expect(screen.getByText("nginx 配置入门")).toBeTruthy();
    // 文件来源组内是文件行
    expect(screen.getByText("linux-basics.md")).toBeTruthy();
  });

  it("点击组头折叠该组（内容隐藏），再点展开恢复", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT, DOC_CHUNK_HIT] }
        : method === "knowledge.list_files"
          ? { files: [DOC_FILE], total: 1 }
          : {},
    );
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    // 折叠「内置命令卡片」组
    fireEvent.click(screen.getByText("内置命令卡片"));
    expect(screen.queryByText("ls — 列出目录内容")).toBeNull();
    // 另一组不受影响
    expect(screen.getByText("linux-basics.md")).toBeTruthy();

    // 再点展开恢复
    fireEvent.click(screen.getByText("内置命令卡片"));
    expect(screen.getByText("ls — 列出目录内容")).toBeTruthy();
  });
});
