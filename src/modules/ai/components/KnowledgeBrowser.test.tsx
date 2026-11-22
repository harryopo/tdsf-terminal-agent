/**
 * KnowledgeBrowser.test.tsx — 知识库文档浏览与搜索回归
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   文档分页、分类筛选、详情读取与缓存
 *     5. get_doc 失败 → 弹窗内错误态（fail-closed）
 *     6. get_doc 缓存：弹窗重复打开同一文档不重复请求
 *   搜索模式
 *     7. 搜索调用 knowledge.search RPC 并渲染结果
 *     8. 搜索命中按文档元数据显示
 *   通用
 *    10. 点击无 url 条目加载详情（knowledge.get）并渲染
 *    11. 详情弹窗返回按钮回到列表
 *    12. 搜索无结果 / 知识库为空空态
 *    13. 分类组、未分类归「其他」、固定顺序与原生分类筛选
 *   导入 md（TDSF 2026-08-30）
 *    14. 选择 .md 文件 → knowledge.import_docs({files}) → 清缓存刷新列表
 *    15. 非 .md 文件 → 错误提示且不调导入 RPC（fail-closed）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { KnowledgePanel } from "./KnowledgeBrowser";
import { clearKnowledgeCaches, docCache } from "@/modules/ai/lib/knowledge-cache";

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("./KnowledgeReader", () => ({
  KnowledgeReader: ({ doc }: { doc: { content?: string; content_zh?: string; source?: string; library?: string } }) => <div data-testid="reader" data-source={doc.source} data-library={doc.library} data-has-translation={Boolean(doc.content_zh)}>{doc.content_zh || doc.content}</div>,
}));

import { invokeRpc } from "@/lib/sidecar-bridge";
import { toast } from "sonner";

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

// 无 URL 的文档元数据（无 category → 归「其他」组）
const HIT = {
  id: "cmd-ls",
  url: "",
  title0: "ls — 列出目录内容",
  title_zh: "",
  summary_zh: "ls 是 Linux 最常用的命令，用于列出目录内容。",
  source: "builtin-corpus",
  category: "",
  chunks: 1,
  total_chars: 40,
  library: "builtin",
};

// imported-docs 文档行
const DOC_CHUNK_HIT = {
  id: "doc-abc123-2",
  title0: "修改文件权限",
  title_zh: "",
  summary_zh: "chmod 用于修改文件权限。",
  source: "imported-docs",
  url: "linux-basics.md",
  category: "",
  chunks: 3,
  total_chars: 1234,
  library: "builtin",
};

// knowledge.get_doc 返回的完整文档
const DOC_FULL = {
  ok: true,
  url: "linux-basics.md",
  filename: "linux-basics.md",
  source: "imported-docs",
  title: "文件权限基础",
  content: "# 文件权限基础\n\nchmod 完整讲解，覆盖数字法与符号法。",
  content_zh: "# 文件权限基础\n\nchmod 完整讲解，覆盖数字法与符号法。",
  chunks: 3,
  total_chars: 1234,
  library: "builtin",
};

// 官方源条目：nginx-docs → category=services（服务部署）
const CRAWL_HIT = {
  id: "crawl-1",
  url: "",
  title0: "nginx 配置入门",
  title_zh: "",
  summary_zh: "nginx 配置说明。",
  source: "nginx-docs",
  category: "services",
  chunks: 1,
  total_chars: 20,
  library: "builtin",
};

const OFFICIAL_CHUNK_HIT = {
  id: "doc-k8s-1",
  title0: "Concepts",
  title_zh: "核心概念",
  summary_zh: "Kubernetes concepts body text.",
  source: "kubernetes-docs",
  url: "https://kubernetes.io/docs/concepts/",
  category: "services",
  chunks: 4,
  total_chars: 2048,
  library: "builtin",
};

// ssh-docs 条目（category=net-remote，网络与远程——多分类排序测试用）
const SSH_CHUNK_HIT = {
  id: "doc-ssh-0",
  title0: "ssh(1)", title_zh: "", summary_zh: "OpenSSH remote login client.",
  source: "ssh-docs",
  url: "https://man.openbsd.org/ssh",
  category: "net-remote",
  chunks: 2, total_chars: 100, library: "builtin",
};

// philosophy 条目（category=linux-philosophy，第 7 分类——排序置顶）
const PHILOSOPHY_HIT = {
  id: "phil-abc-0",
  url: "", title0: "Linux 设计哲学 · 一切皆文件", title_zh: "", summary_zh: "键盘、硬盘、进程、网络连接……全都当成文件来操作。",
  source: "philosophy",
  category: "linux-philosophy",
  chunks: 1, total_chars: 50, library: "builtin",
};

const CASE_HIT = {
  id: "case-1",
  url: "", title0: "修复启动失败案例", title_zh: "", summary_zh: "grub 修复步骤。",
  source: "case-20260801-boot-repair",
  category: "", chunks: 1, total_chars: 10, library: "builtin",
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
  it("挂载即浏览内置文档，标题和分类来自文档元数据", async () => {
    mockRpc((method) =>
      method === "knowledge.documents" ? { documents: [HIT], total: 1, groups: [] } : {},
    );
    render(<KnowledgePanel />);

    expect(await screen.findByText("ls — 列出目录内容")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", {
      limit: 30,
      offset: 0,
      library: "builtin",
    });
  });

  it("文档行展示元数据标题摘要和分类，不再请求分块列表", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [DOC_CHUNK_HIT, CRAWL_HIT], total: 2, groups: [] } : {});
    render(<KnowledgePanel />);

    expect(await screen.findByText("修改文件权限")).toBeTruthy();
    expect(screen.getByText("chmod 用于修改文件权限。")).toBeTruthy();
    expect(screen.getByText("修改文件权限")).toBeTruthy();
    expect(invokeRpc).not.toHaveBeenCalledWith("knowledge.list_files", expect.anything());
  });

  it("分类组可折叠再展开，视图内不额外请求文档", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [DOC_CHUNK_HIT], total: 1, groups: [] } : {});
    render(<KnowledgePanel />);
    await screen.findByText("修改文件权限");

    // 折叠「其他」组（未分类条目归「其他」）再展开
    fireEvent.click(screen.getByText("其他"));
    expect(screen.queryByText("修改文件权限")).toBeNull();
    fireEvent.click(screen.getByText("其他"));
    expect(await screen.findByText("修改文件权限")).toBeTruthy();

    const calls = vi.mocked(invokeRpc).mock.calls as unknown as [
      string,
      Record<string, unknown>?,
    ][];
    expect(calls.filter(([m]) => m === "knowledge.documents")).toHaveLength(1);
  });

  it("点击文档读取完整内容并使用真实中文标题", async () => {
    mockRpc((method) => {
      if (method === "knowledge.documents") return { documents: [DOC_CHUNK_HIT], total: 1, groups: [] };
      if (method === "knowledge.get_doc") return DOC_FULL;
      return {};
    });
    render(<KnowledgePanel />);

    // 点文件行 → 打开完整文档
    fireEvent.click(await screen.findByText("修改文件权限"));

    expect(await screen.findByText(/chmod 完整讲解，覆盖数字法与符号法/)).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", {
      url: "linux-basics.md",
      library: "builtin",
    });
    expect(screen.getByRole("heading", { name: "文件权限基础" })).toBeTruthy();
    expect(screen.getByTestId("reader").getAttribute("data-source")).toBe("imported-docs");
    expect(screen.getByTestId("reader").getAttribute("data-has-translation")).toBe("true");
  });

  it("sorts unordered document categories with uncategorized material last", async () => {
    mockRpc((method) => method === "knowledge.documents" ? {
      documents: [
        { ...HIT, id: "uncategorized", title0: "未分类笔记", category: "" },
        { ...HIT, id: "services", title0: "部署笔记", category: "services" },
        { ...HIT, id: "security", title0: "安全笔记", category: "security" },
      ], total: 3, groups: [],
    } : {});
    const { container } = render(<KnowledgePanel />);
    await screen.findByText("安全笔记");
    const categories = Array.from(container.querySelectorAll("section > button[aria-expanded]")).map((button) => button.textContent);
    expect(categories).toEqual(["安全加固", "服务部署", "其他"]);
  });

  it("get_doc 失败（ok=false）→ 弹窗内错误态（fail-closed）", async () => {
    mockRpc((method) => {
      if (method === "knowledge.documents") return { documents: [DOC_CHUNK_HIT], total: 1, groups: [] };
      if (method === "knowledge.get_doc")
        return {
          ok: false,
          error: "document not found: linux-basics.md",
        };
      return {};
    });
    render(<KnowledgePanel />);

    fireEvent.click(await screen.findByText("修改文件权限"));
    expect(await screen.findByText(/文档加载失败/)).toBeTruthy();
    expect(screen.getByText(/document not found/)).toBeTruthy();
  });

  it("详情读取失败后重试同一文档请求", async () => {
    let attempts = 0;
    mockRpc((method) => {
      if (method === "knowledge.documents") return { documents: [DOC_CHUNK_HIT], total: 1, groups: [] };
      if (method === "knowledge.get_doc") {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: "temporarily unavailable" } : DOC_FULL;
      }
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("修改文件权限"));
    fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    expect(await screen.findByText(/chmod 完整讲解，覆盖数字法与符号法/)).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("get_doc 缓存：弹窗重复打开同一文档不重复请求", async () => {
    mockRpc((method) => {
      if (method === "knowledge.documents") return { documents: [DOC_CHUNK_HIT], total: 1, groups: [] };
      if (method === "knowledge.get_doc") return DOC_FULL;
      return {};
    });
    render(<KnowledgePanel />);

    // 第一次打开
    fireEvent.click(await screen.findByText("修改文件权限"));
    await screen.findByText(/chmod 完整讲解，覆盖数字法与符号法/);
    // 关闭（返回）
    fireEvent.click(screen.getByText("返回"));
    // 第二次打开
    fireEvent.click(screen.getByText("修改文件权限"));
    expect(await screen.findByText(/chmod 完整讲解，覆盖数字法与符号法/)).toBeTruthy();

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
      method === "knowledge.documents"
        ? { documents: [HIT], total: 1, groups: [] }
        : method === "knowledge.search"
          ? { results: [{ ...HIT, title: HIT.title0, content: HIT.summary_zh }] }
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
      library: "builtin",
    });
  });

  it("搜索命中显示文档元数据标题并显式指定当前知识库", async () => {
    mockRpc((method) =>
      method === "knowledge.documents"
        ? { documents: [HIT], total: 1, groups: [] }
        : method === "knowledge.search"
          ? { results: [{ ...DOC_CHUNK_HIT, title: DOC_CHUNK_HIT.title0, content: DOC_CHUNK_HIT.summary_zh }] }
          : {},
    );
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "chmod" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText("修改文件权限")).toBeTruthy();
    expect(screen.getByText("导入文档")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.search", { query: "chmod", limit: 30, method: "hybrid", library: "builtin" });
  });

  it("点击带 URL 搜索结果按当前知识库读取完整文档", async () => {
    mockRpc((method) =>
      method === "knowledge.documents"
        ? { documents: [HIT], total: 1, groups: [] }
        : method === "knowledge.search"
          ? { results: [{ ...DOC_CHUNK_HIT, title: DOC_CHUNK_HIT.title0, content: DOC_CHUNK_HIT.summary_zh }] }
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

    expect(await screen.findByText(/chmod 完整讲解，覆盖数字法与符号法/)).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", { url: "linux-basics.md", library: "builtin" });
  });
});

// ---------------------------------------------------------------------------
// 通用（条目详情 / 空态）
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 条目详情与空态", () => {
  it("点击无 url 条目加载详情（knowledge.get）并渲染 md", async () => {
    mockRpc((method) =>
      method === "knowledge.documents"
        ? { documents: [HIT], total: 1, groups: [] }
        : method === "knowledge.search"
          ? { results: [{ ...HIT, title: HIT.title0, content: HIT.summary_zh }] }
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

    await screen.findByTestId("reader");
    expect(screen.getByTestId("reader").textContent).toContain("ls 的详细讲解……");
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "cmd-ls", library: "builtin" });
  });

  it("详情弹窗返回按钮回到列表", async () => {
    mockRpc((method) =>
      method === "knowledge.documents"
        ? { documents: [HIT], total: 1, groups: [] }
        : method === "knowledge.search"
          ? { results: [{ ...HIT, title: HIT.title0, content: HIT.summary_zh }] }
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
      method === "knowledge.documents"
        ? { documents: [HIT], total: 1, groups: [] }
        : method === "knowledge.search"
          ? { results: [] }
          : {},
    );
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "qqxxzz" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/未找到相关内容/)).toBeTruthy();
  });

  it("清空搜索输入返回当前知识库浏览列表", async () => {
    mockRpc((method) => method === "knowledge.documents"
      ? { documents: [HIT], total: 1, groups: [] }
      : method === "knowledge.search" ? { results: [] } : {});
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");
    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    await screen.findByText(/未找到相关内容/);
    fireEvent.change(input, { target: { value: "" } });
    expect(await screen.findByText("ls — 列出目录内容")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", { library: "builtin", limit: 30, offset: 0 });
  });

  it("原始参考入口默认折叠，打开和关闭时保留之前的主知识库", async () => {
    mockRpc((method, params) => method === "knowledge.documents"
      ? { documents: [{ ...HIT, title0: `${params.library} document` }], total: 1, groups: [] }
      : {});
    render(<KnowledgePanel />);
    await screen.findByText("builtin document");
    const reference = screen.getByRole("button", { name: /原始参考/ });
    expect(reference.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(reference);
    expect(await screen.findByText("reference document")).toBeTruthy();
    expect(screen.getByRole("button", { name: /收起原始参考/ }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /收起原始参考/ }));
    expect(await screen.findByText("builtin document")).toBeTruthy();
  });

  it("知识库为空时显示空态", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [], total: 0, groups: [] } : {});
    render(<KnowledgePanel />);
    expect(await screen.findByText(/内置资料暂不可用/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6+1 分类分组（TDSF 2026-08-30：按 category 分组，source 名作副行）
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 分类分组", () => {
  it("按文档分类分组，并用组统计填充主题筛选", async () => {
    mockRpc((method, params) => method === "knowledge.documents"
      ? params.category === "services"
        ? { documents: [CRAWL_HIT, OFFICIAL_CHUNK_HIT], total: 2, groups: [{ category: "services", source: "nginx-docs", entries: 2, files: 2 }] }
        : { documents: [CRAWL_HIT, OFFICIAL_CHUNK_HIT, PHILOSOPHY_HIT], total: 3, groups: [{ category: "services", source: "nginx-docs", entries: 2, files: 2 }, { category: "linux-philosophy", source: "philosophy", entries: 1, files: 1 }] }
      : {});
    render(<KnowledgePanel />);

    expect(await screen.findByText("Linux 哲学与命令对照")).toBeTruthy();
    expect(screen.getByText("服务部署")).toBeTruthy();
    expect(screen.getByText("nginx 配置入门")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("按主题筛选"), { key: "ArrowDown" });
    const services = await screen.findByRole("option", { name: "服务部署 · 2 篇" });
    services.focus();
    fireEvent.keyDown(services, { key: "Enter" });
    expect(await screen.findByText("nginx 配置入门")).toBeTruthy();
    expect(screen.queryByText("Linux 设计哲学 · 一切皆文件")).toBeNull();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", { library: "builtin", limit: 30, offset: 0, category: "services" });
  });

  it("无 category 的条目归「其他」组（组头固定沉底）", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [HIT, CASE_HIT, CRAWL_HIT], total: 3, groups: [] } : {});
    render(<KnowledgePanel />);

    expect(await screen.findByText("其他")).toBeTruthy();
    expect(screen.getByText("ls — 列出目录内容")).toBeTruthy();
    // 有分类的组也在
    expect(screen.getByText("服务部署")).toBeTruthy();
  });

  it("分类固定顺序：linux-philosophy → … → services → 其他（未分类沉底）", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [PHILOSOPHY_HIT, SSH_CHUNK_HIT, CRAWL_HIT, CASE_HIT], total: 4, groups: [] } : {});
    render(<KnowledgePanel />);

    await screen.findByText("Linux 哲学与命令对照");
    const allText = document.body.textContent ?? "";
    const idxPhilosophy = allText.indexOf("Linux 哲学与命令对照");
    const idxNet = allText.indexOf("网络与远程");
    const idxServices = allText.indexOf("服务部署");
    const idxOther = allText.indexOf("其他");
    expect(idxPhilosophy).toBeGreaterThanOrEqual(0);
    expect(idxNet).toBeGreaterThan(idxPhilosophy);
    expect(idxServices).toBeGreaterThan(idxNet);
    expect(idxOther).toBeGreaterThan(idxServices);
  });

  it("点击组头折叠该组（内容隐藏），再点展开恢复", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [HIT, CRAWL_HIT], total: 2, groups: [] } : {});
    render(<KnowledgePanel />);
    await screen.findByText("ls — 列出目录内容");

    // 折叠「服务部署」组（nginx-docs 无 url 条目在组内）
    fireEvent.click(screen.getByText("服务部署"));
    expect(screen.queryByText("nginx 配置入门")).toBeNull();
    // 另一组不受影响
    expect(screen.getByText("ls — 列出目录内容")).toBeTruthy();

    // 再点展开恢复
    fireEvent.click(screen.getByText("服务部署"));
    expect(screen.getByText("nginx 配置入门")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 导入 md（TDSF 2026-08-30：个人语料手动导入）
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 导入 md", () => {
  /** 把文件列表塞进隐藏的 file input（happy-dom 下 FileList 只读，用 defineProperty） */
  function pickFiles(container: HTMLElement, files: File[]) {
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    Object.defineProperty(input, "files", { value: files });
    fireEvent.change(input);
  }

  it("选择 .md 文件 → knowledge.import_docs({files}) → 清缓存刷新列表", async () => {
    let documentCalls = 0;
    mockRpc((method, params) => {
      if (method === "knowledge.documents") {
        documentCalls += 1;
        const documents = params.library === "personal" && documentCalls > 1
          ? [{ id: "doc-xyz", url: "my-notes.md", title0: "My notes", title_zh: "我的笔记 · 概述", summary_zh: "导入的文档内容", source: "imported-docs", category: "", chunks: 1, total_chars: 12, library: "personal" }]
          : [];
        return { documents, total: documents.length, groups: [] };
      }
      if (method === "knowledge.import_docs") {
        expect(params).toEqual({
          files: [{ name: "my-notes.md", content: "# 我的笔记\n\n概述内容" }],
          library: "personal",
        });
        return { imported: 1, skipped: 0, errors: 0, rejected: [] };
      }
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/内置资料暂不可用/);

    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    docCache.set("builtin:old.md", { ok: true, content: "old" });
    pickFiles(container, [
      new File(["# 我的笔记\n\n概述内容"], "my-notes.md", {
        type: "text/markdown",
      }),
    ]);

    // 导入成功 → toast + 列表刷新（导入文档带 url，浏览模式显示为文件行）
    expect(await screen.findByText("我的笔记 · 概述")).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("已导入 1 篇文档");
    expect(documentCalls).toBe(2); // 首次内置列表 + 导入后个人库刷新
    expect(docCache.size).toBe(0);
  });

  it("混合选择：非 .md 被拒绝并提示，.md 正常导入", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return { documents: [], total: 0, groups: [] };
      if (method === "knowledge.import_docs") {
        expect(params).toEqual({
          files: [{ name: "ok.md", content: "内容" }],
          library: "personal",
        });
        return {
          imported: 1,
          skipped: 0,
          errors: 0,
          rejected: [],
        };
      }
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/内置资料暂不可用/);

    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickFiles(container, [
      new File(["内容"], "ok.md", { type: "text/markdown" }),
      new File(["二进制"], "pic.png", { type: "image/png" }),
    ]);

    // 导入为异步流（读内容 → RPC → toast），等待完成
    await vi.waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith("只导入 Markdown 文件，其他格式已跳过。");
    });
  });

  it("全部为非 .md → 错误提示且不调导入 RPC（fail-closed）", async () => {
    mockRpc((method) => (method === "knowledge.documents" ? { documents: [], total: 0, groups: [] } : {}));
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/内置资料暂不可用/);

    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickFiles(container, [
      new File(["纯文本"], "notes.txt", { type: "text/plain" }),
    ]);

    expect(toast.warning).toHaveBeenCalledWith("只导入 Markdown 文件，其他格式已跳过。");
    const calls = vi.mocked(invokeRpc).mock.calls as unknown as [string][];
    expect(calls.filter(([m]) => m === "knowledge.import_docs")).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// 文档标题内嵌在分页元数据，不再发送独立 titles_zh 请求
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 中文预览标题", () => {
  it("使用分页元数据中的中文标题，不请求独立标题映射", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [OFFICIAL_CHUNK_HIT], total: 1, groups: [] } : {});
    render(<KnowledgePanel />);

    expect(await screen.findByText("服务部署")).toBeTruthy();
    expect(await screen.findByText("核心概念")).toBeTruthy();
    expect(screen.queryByText("concepts")).toBeNull();
    expect(invokeRpc).not.toHaveBeenCalledWith("knowledge.titles_zh", expect.anything());
  });

  it("没有中文标题时显示原文标题，不用文件名或块数作主视觉", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [{ ...OFFICIAL_CHUNK_HIT, title_zh: "", title0: "Concepts" }], total: 1, groups: [] } : {});
    render(<KnowledgePanel />);

    expect(await screen.findByText("Concepts")).toBeTruthy();
    expect(screen.queryByText("核心概念")).toBeNull();
  });

  it("分页标题字段缺失时仍能用原文标题回退", async () => {
    mockRpc((method) => method === "knowledge.documents" ? { documents: [{ ...OFFICIAL_CHUNK_HIT, title_zh: undefined, title0: "Concepts" }], total: 1, groups: [] } : {});
    render(<KnowledgePanel />);

    expect(await screen.findByText("Concepts")).toBeTruthy();
  });

  it("搜索命中条目：中文主行 + 来源副行 + 英文原标题再降级", async () => {
    mockRpc((method) => {
      if (method === "knowledge.documents") return { documents: [], total: 0, groups: [] };
      if (method === "knowledge.search")
        return { results: [{ ...OFFICIAL_CHUNK_HIT, title: "Concepts", content: OFFICIAL_CHUNK_HIT.summary_zh }] };
      return {};
    });
    render(<KnowledgePanel />);
    await screen.findByText(/内置资料暂不可用/);

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "concepts" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText("核心概念")).toBeTruthy();
    expect(screen.getByText("Kubernetes 官方文档")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.search", { query: "concepts", limit: 30, method: "hybrid", library: "builtin" });
  });
});
