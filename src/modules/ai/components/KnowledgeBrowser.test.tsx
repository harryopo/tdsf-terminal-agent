/**
 * KnowledgeBrowser.test.tsx — 知识库浏览器测试（P2-4 + 两级文件视图 + 6+1 分类）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   浏览模式（默认）
 *     1. 挂载即浏览：调用 knowledge.list 渲染条目（无 url 来源保持条目式）
 *     2. 含文档分类组内列文件（knowledge.list_files 按 {group: category}：
 *        filename + 来源副行 + 「N 块」徽章）
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
 *    13. 6+1 分类分组（TDSF 2026-08-30）：分类中文组头 + 来源副行 +
 *        未分类归「其他」+ 固定顺序 + source 中文映射保留在文件行副行
 *   导入 md（TDSF 魔改 2026-08-30）
 *    14. 选择 .md 文件 → knowledge.import_docs({files}) → 清缓存刷新列表
 *    15. 非 .md 文件 → 错误提示且不调导入 RPC（fail-closed）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { KnowledgePanel } from "./KnowledgeBrowser";
import {
  clearKnowledgeCaches,
  docCache,
  filesCache,
} from "@/modules/ai/lib/knowledge-cache";

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

// 未知 source 的无 url 条目（无 category → 归「其他」组；source 原样显示在副行）
const HIT = {
  id: "cmd-ls",
  source: "builtin-corpus",
  title: "ls — 列出目录内容",
  content: "ls 是 Linux 最常用的命令，用于列出目录内容。",
  url: "",
  tags: ["命令", "入门"],
  match_type: "fts",
};

// imported-docs 文件级条目（knowledge.list_files 返回；导入文档无分类）
const DOC_FILE = {
  url: "linux-basics.md",
  filename: "linux-basics.md",
  title0: "文件权限基础",
  chunks: 3,
  total_chars: 1234,
  source: "imported-docs",
  category: "",
};

// imported-docs 分块条目（knowledge.list / search 返回；id 尾部序号 = 块序号，从 0 起）
const DOC_CHUNK_HIT = {
  id: "doc-abc123-2",
  source: "imported-docs",
  title: "修改文件权限",
  content: "chmod 用于修改文件权限。",
  url: "linux-basics.md",
  tags: [],
};

// knowledge.get_doc 返回的完整文档
const DOC_FULL = {
  ok: true,
  url: "linux-basics.md",
  filename: "linux-basics.md",
  source: "imported-docs",
  title: "文件权限基础",
  content: "# 文件权限基础\n\nchmod 完整讲解，覆盖数字法与符号法。",
  chunks: 3,
  total_chars: 1234,
};

// 官方源条目：nginx-docs → category=services（服务部署）
const CRAWL_HIT = {
  id: "crawl-1",
  source: "nginx-docs",
  title: "nginx 配置入门",
  content: "nginx 配置说明。",
  url: "",
  tags: [],
  category: "services",
};

// kubernetes-docs 文件级条目（category=services；官方源中文标题映射测试用）
const OFFICIAL_FILE = {
  url: "https://kubernetes.io/docs/concepts/",
  filename: "concepts",
  title0: "Concepts",
  chunks: 4,
  total_chars: 2048,
  source: "kubernetes-docs",
  category: "services",
};

const OFFICIAL_CHUNK_HIT = {
  id: "doc-k8s-1",
  source: "kubernetes-docs",
  title: "Concepts",
  content: "Kubernetes concepts body text.",
  url: "https://kubernetes.io/docs/concepts/",
  tags: [],
  category: "services",
};

// ssh-docs 条目（category=net-remote，网络与远程——多分类排序测试用）
const SSH_CHUNK_HIT = {
  id: "doc-ssh-0",
  source: "ssh-docs",
  title: "ssh(1)",
  content: "OpenSSH remote login client.",
  url: "https://man.openbsd.org/ssh",
  tags: [],
  category: "net-remote",
};

// philosophy 条目（category=linux-philosophy，第 7 分类——排序置顶）
const PHILOSOPHY_HIT = {
  id: "phil-abc-0",
  source: "philosophy",
  title: "Linux 设计哲学 · 一切皆文件",
  content: "键盘、硬盘、进程、网络连接……全都当成文件来操作。",
  url: "",
  tags: ["Linux 哲学"],
  category: "linux-philosophy",
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

  it("含文档分类组内列文件：filename 主行 + 来源副行 + 「N 块」徽章", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.list")
        return { results: [DOC_CHUNK_HIT, CRAWL_HIT] };
      if (method === "knowledge.list_files") {
        // 6+1 分类分组：list_files 按 {group: category} 拉取（未分类 group=""）
        if (params.group === "") {
          expect(params).toEqual({ group: "" });
          return { files: [DOC_FILE], total: 1 };
        }
        return { files: [], total: 0 };
      }
      return {};
    });
    render(<KnowledgePanel />);

    expect(await screen.findByText("linux-basics.md")).toBeTruthy();
    expect(screen.getByText("3 块")).toBeTruthy(); // 块数徽章
    // 副行显示 source 中文名（6+1 分组后保留来源辨识度；组头副行 +
    // 文件行副行两处出现）
    expect(screen.getAllByText("导入文档").length).toBe(2);
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

    // 折叠「其他」组（未分类条目归「其他」）再展开
    fireEvent.click(screen.getByText("其他"));
    expect(screen.queryByText("linux-basics.md")).toBeNull();
    fireEvent.click(screen.getByText("其他"));
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
      url: "linux-basics.md",
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
          error: "document not found: linux-basics.md",
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
// 通用（条目详情 / 空态）
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

// ---------------------------------------------------------------------------
// 6+1 分类分组（TDSF 2026-08-30：按 category 分组，source 名作副行）
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 分类分组", () => {
  it("按 category 分组：中文组头 + 来源副行 + 条数 badge", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [CRAWL_HIT, OFFICIAL_CHUNK_HIT, PHILOSOPHY_HIT] }
        : method === "knowledge.list_files"
          ? { files: [], total: 0 }
          : {},
    );
    render(<KnowledgePanel />);

    // 组头 = 分类中文名；副行 = 组内来源中文名（多个合并显示）
    expect(await screen.findByText("Linux 哲学与命令对照")).toBeTruthy();
    expect(screen.getByText("服务部署")).toBeTruthy();
    // 服务部署组副行：Nginx 官方文档 · Kubernetes 官方文档
    expect(screen.getByText("Nginx 官方文档 · Kubernetes 官方文档")).toBeTruthy();
    // 哲学组副行：教学语料（组头副行 + 组内条目副行两处出现）
    expect(screen.getAllByText("教学语料").length).toBeGreaterThanOrEqual(1);
    // 无 url 条目在组内保留条目式
    expect(screen.getByText("nginx 配置入门")).toBeTruthy();
  });

  it("无 category 的条目归「其他」组（组头固定沉底）", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT, CASE_HIT, CRAWL_HIT] }
        : {},
    );
    render(<KnowledgePanel />);

    expect(await screen.findByText("其他")).toBeTruthy();
    // 「其他」组副行合并来源（≤2 个全显）：builtin-corpus · 会话沉淀
    expect(screen.getByText("builtin-corpus · 会话沉淀")).toBeTruthy();
    // 有分类的组也在
    expect(screen.getByText("服务部署")).toBeTruthy();
  });

  it("分类固定顺序：linux-philosophy → … → services → 其他（未分类沉底）", async () => {
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [CRAWL_HIT, SSH_CHUNK_HIT, PHILOSOPHY_HIT, CASE_HIT] }
        : {},
    );
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
    mockRpc((method) =>
      method === "knowledge.list"
        ? { results: [HIT, CRAWL_HIT] }
        : method === "knowledge.list_files"
          ? { files: [], total: 0 }
          : {},
    );
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
// 导入 md（TDSF 魔改 2026-08-30：个人语料手动导入）
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
    let listCalls = 0;
    mockRpc((method, params) => {
      if (method === "knowledge.list") {
        listCalls += 1;
        return {
          results:
            listCalls > 1
              ? [
                  {
                    id: "doc-xyz-0",
                    source: "imported-docs",
                    title: "我的笔记 · 概述",
                    content: "导入的文档内容",
                    url: "my-notes.md",
                    tags: [],
                  },
                ]
              : [],
        };
      }
      if (method === "knowledge.import_docs") {
        expect(params).toEqual({
          files: [{ name: "my-notes.md", content: "# 我的笔记\n\n概述内容" }],
        });
        return { imported: 1, skipped: 0, errors: 0, rejected: [] };
      }
      // 导入后组内懒加载 list_files（按 group）：返回导入的文件行
      if (method === "knowledge.list_files") {
        expect(params.group).toBe("");
        return {
          files: [
            {
              url: "my-notes.md",
              filename: "my-notes.md",
              title0: "我的笔记 · 概述",
              chunks: 1,
              total_chars: 12,
              source: "imported-docs",
              category: "",
            },
          ],
          total: 1,
        };
      }
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/知识库为空/);

    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickFiles(container, [
      new File(["# 我的笔记\n\n概述内容"], "my-notes.md", {
        type: "text/markdown",
      }),
    ]);

    // 导入成功 → toast + 列表刷新（导入文档带 url，浏览模式显示为文件行）
    expect(await screen.findByText("my-notes.md")).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("已导入 1 个文档");
    expect(listCalls).toBe(2); // 挂载 + 导入后刷新
    // 浏览缓存被清理后随刷新重建（新文件进入缓存，旧缓存条目不存在；
    // 缓存 key = category 分组 key，导入文档无分类 → ""）
    expect(filesCache.get("")?.[0]?.filename).toBe("my-notes.md");
    expect(docCache.size).toBe(0);
  });

  it("混合选择：非 .md 被拒绝并提示，.md 正常导入", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.list") return { results: [] };
      if (method === "knowledge.import_docs") {
        expect(params).toEqual({
          files: [{ name: "ok.md", content: "内容" }],
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
    await screen.findByText(/知识库为空/);

    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickFiles(container, [
      new File(["内容"], "ok.md", { type: "text/markdown" }),
      new File(["二进制"], "pic.png", { type: "image/png" }),
    ]);

    // 导入为异步流（读内容 → RPC → toast），等待完成
    await vi.waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        "已导入 1 个文档，非 .md 文件被拒绝：pic.png",
      );
    });
  });

  it("全部为非 .md → 错误提示且不调导入 RPC（fail-closed）", async () => {
    mockRpc((method) => (method === "knowledge.list" ? { results: [] } : {}));
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/知识库为空/);

    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickFiles(container, [
      new File(["纯文本"], "notes.txt", { type: "text/plain" }),
    ]);

    expect(toast.error).toHaveBeenCalledWith("仅支持导入 .md 文件");
    const calls = vi.mocked(invokeRpc).mock.calls as unknown as [string][];
    expect(calls.filter(([m]) => m === "knowledge.import_docs")).toHaveLength(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// 中文预览标题（TDSF 魔改 2026-08-30：knowledge.titles_zh 映射）
// ---------------------------------------------------------------------------

describe("KnowledgePanel — 中文预览标题", () => {
  it("文件行：中文主行 + 来源与英文 filename 副行（titles_zh 有映射）", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [OFFICIAL_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [OFFICIAL_FILE], total: 1 };
      if (method === "knowledge.titles_zh") {
        return {
          titles: [{ url: OFFICIAL_FILE.url, zh: "核心概念" }],
          total: 1,
        };
      }
      return {};
    });
    render(<KnowledgePanel />);

    // 组头 = 分类中文名（服务部署），来源中文名在组头副行/文件行副行
    expect(await screen.findByText("服务部署")).toBeTruthy();
    expect(await screen.findByText("核心概念")).toBeTruthy(); // 中文主行
    expect(screen.getByText("concepts")).toBeTruthy(); // 英文 filename 副行
    // 来源副行：组头副行 + 文件行副行两处出现
    expect(screen.getAllByText("Kubernetes 官方文档").length).toBe(2);
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.titles_zh", {
      source: "kubernetes-docs",
    });
  });

  it("无中文映射 → 只显示英文 filename 主行（回退，不报错）", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [OFFICIAL_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [OFFICIAL_FILE], total: 1 };
      if (method === "knowledge.titles_zh") return { titles: [], total: 0 };
      return {};
    });
    render(<KnowledgePanel />);

    expect(await screen.findByText("concepts")).toBeTruthy();
    expect(screen.queryByText("核心概念")).toBeNull();
  });

  it("titles_zh RPC 异常 → 吞错回退英文标题（列表仍渲染）", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [OFFICIAL_CHUNK_HIT] };
      if (method === "knowledge.list_files")
        return { files: [OFFICIAL_FILE], total: 1 };
      if (method === "knowledge.titles_zh") throw new Error("rpc down");
      return {};
    });
    render(<KnowledgePanel />);

    expect(await screen.findByText("concepts")).toBeTruthy();
  });

  it("搜索命中条目：中文主行 + 来源副行 + 英文原标题再降级", async () => {
    mockRpc((method) => {
      if (method === "knowledge.list") return { results: [] };
      if (method === "knowledge.search")
        return { results: [OFFICIAL_CHUNK_HIT] };
      if (method === "knowledge.titles_zh")
        return {
          titles: [{ url: OFFICIAL_FILE.url, zh: "核心概念" }],
          total: 1,
        };
      return {};
    });
    render(<KnowledgePanel />);
    await screen.findByText(/知识库为空/);

    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "concepts" } });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText("核心概念")).toBeTruthy();
    // 来源副行：组头副行 + 条目副行两处出现
    expect(screen.getAllByText("Kubernetes 官方文档").length).toBe(2);
    expect(screen.getByText("Concepts")).toBeTruthy(); // 英文原标题再降级
  });
});
