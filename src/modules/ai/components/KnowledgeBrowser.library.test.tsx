import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePanel } from "./KnowledgeBrowser";
import { clearKnowledgeCaches, docCache, type KnowledgeDocument } from "@/modules/ai/lib/knowledge-cache";

vi.mock("@/lib/sidecar-bridge", () => ({ invokeRpc: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { invokeRpc } from "@/lib/sidecar-bridge";
import { toast } from "sonner";

type Rpc = (method: string, params: Record<string, unknown>) => unknown;
function mockRpc(handler: Rpc) {
  vi.mocked(invokeRpc).mockImplementation(
    (async (method: string, params?: Record<string, unknown>) =>
      handler(method, params ?? {})) as typeof invokeRpc,
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const hit = (id: string, title = id, url = "", category = "services"): KnowledgeDocument & { title: string } => ({
  id, url, title, title0: title, title_zh: undefined, summary_zh: `${title} 摘要`, source: "sample", category, chunks: 2, total_chars: 42, library: "builtin",
});
const page = (documents: ReturnType<typeof hit>[], groups = [{ category: "services", source: "sample", entries: documents.length, files: new Set(documents.filter((row) => row.url).map((row) => row.url)).size }]) => ({
  documents, total: documents.length, groups,
});
const chooseLibrary = (name: "内置知识" | "我的知识") =>
  (() => {
    fireEvent.click(screen.getByRole("button", { name }));
  })();
function pickMarkdown(container: HTMLElement, name = "note.md") {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", {
    value: [new File(["# Note\nBody"], name, { type: "text/markdown" })],
  });
  fireEvent.change(input);
}

beforeEach(() => {
  vi.mocked(invokeRpc).mockReset();
  clearKnowledgeCaches();
});

describe("KnowledgePanel library ownership", () => {
  it("defaults to builtin and switches document requests explicitly to personal", async () => {
    mockRpc((method, params) => method === "knowledge.documents" ? page([hit(`${params.library}-row`, `${params.library}-row` , "", "")]) : {});
    render(<KnowledgePanel />);
    expect(await screen.findByText("builtin-row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "内置知识" }).getAttribute("aria-pressed")).toBe("true");
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", { limit: 30, offset: 0, library: "builtin" });
    chooseLibrary("我的知识");
    expect(await screen.findByText("personal-row")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", { limit: 30, offset: 0, library: "personal" });
  });

  it("keeps category totals and appends the next page by raw offset without duplicate URLs", async () => {
    const first = Array.from({ length: 30 }, (_, i) => hit(`row-${i}`, `row-${i}`, i < 2 ? `doc-${i}.md` : i === 29 ? "duplicate-url.md" : ""));
    const groups = [
      { category: "services", source: "sample", entries: 52, files: 2 },
      { category: "security", source: "other", entries: 4, files: 1 },
    ];
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return params.offset === 0
        ? { ...page(first, groups), total: 36 }
        : { ...page([hit("different-id", "duplicate title", "duplicate-url.md"), ...Array.from({ length: 6 }, (_, i) => hit(`row-${30 + i}`))], groups), total: 36 };
      return {};
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("row-2")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("按主题筛选"), { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "安全加固 · 1 篇" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("option", { name: "安全加固 · 1 篇" }), { key: "Escape" });
    expect(screen.getByText(/30.*36/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("row-35")).toBeTruthy();
    expect(screen.getAllByText("row-29")).toHaveLength(1);
    const listCalls = vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "knowledge.documents");
    expect(listCalls[1]).toEqual(["knowledge.documents", { limit: 30, offset: 30, library: "builtin" }]);
    expect(screen.getByText(/36.*36/)).toBeTruthy();
  });

  it("uses embedded document titles and category metadata without legacy file/title RPCs", async () => {
    const classified = { ...hit("classified-hit", "classified entry", "classified.md"), category: "services" };
    const unclassified = { ...hit("unclassified-hit", "unclassified entry", "uncategorized.md"), category: "" };
    mockRpc((method) => {
      if (method === "knowledge.documents") return {
        ...page([classified, unclassified], [
          { category: "services", source: "sample", entries: 1, files: 1 },
          { category: "", source: "sample", entries: 1, files: 1 },
        ]),
        total: 2,
      };
      return {};
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("unclassified entry")).toBeTruthy();
    expect(screen.getByText("服务部署")).toBeTruthy();
    expect(screen.getByText("classified entry")).toBeTruthy();
    expect(invokeRpc).not.toHaveBeenCalledWith("knowledge.list_files", expect.anything());
    expect(invokeRpc).not.toHaveBeenCalledWith("knowledge.titles_zh", expect.anything());
  });

  it("shows load-more failure and can retry the same offset", async () => {
    let attempts = 0;
    mockRpc((method, params) => {
      if (method !== "knowledge.documents") return {};
      if (params.offset === 0) return { ...page(Array.from({ length: 30 }, (_, i) => hit(`first-${i}`))), total: 31 };
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      return { ...page([hit("last")]), total: 31 };
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("first-0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText(/加载失败/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("last")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("does not append a pending next page after switching libraries", async () => {
    const pendingPage = deferred<unknown>();
    const first = Array.from({ length: 30 }, (_, i) => hit(`builtin-${i}`));
    mockRpc((method, params) => {
      if (method !== "knowledge.documents") return {};
      if (params.library === "builtin" && params.offset === 30) return pendingPage.promise;
      if (params.library === "builtin") return { ...page(first), total: 36 };
      return { ...page([hit("personal-view", "personal-view", "", "")]), total: 1 };
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("builtin-0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", {
      limit: 30, offset: 30, library: "builtin",
    }));
    chooseLibrary("我的知识");
    expect(await screen.findByText("personal-view")).toBeTruthy();
    await act(async () => {
      pendingPage.resolve({ ...page([hit("stale-page-row")]), total: 36 });
      await pendingPage.promise;
    });
    expect(screen.getByText("personal-view")).toBeTruthy();
    expect(screen.queryByText("stale-page-row")).toBeNull();
  });

  it("keeps embedded titles isolated when an old library page resolves late", async () => {
    const pendingBuiltin = deferred<unknown>();
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return params.library === "builtin"
        ? pendingBuiltin.promise
        : page([{ ...hit("same-hit", "personal title", "same.md"), title_zh: "个人标题" }]);
      return {};
    });
    render(<KnowledgePanel />);
    chooseLibrary("我的知识");
    expect(await screen.findByText("个人标题")).toBeTruthy();
    await act(async () => { pendingBuiltin.resolve(page([hit("same-hit", "builtin title", "same.md")])); await pendingBuiltin.promise; });
    expect(screen.getByText("个人标题")).toBeTruthy();
    expect(screen.queryByText("builtin title")).toBeNull();
    expect(invokeRpc).not.toHaveBeenCalledWith("knowledge.list_files", expect.anything());
    expect(invokeRpc).not.toHaveBeenCalledWith("knowledge.titles_zh", expect.anything());
  });

  it("loads no-URL entry details from the selected library even when IDs match", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return page([hit("shared-id", "Shared entry", "", "")]);
      if (method === "knowledge.get") return { entry: { ...hit("shared-id", "Shared entry", ""), content: `${params.library} body` } };
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("Shared entry"));
    expect(await screen.findByText("builtin body")).toBeTruthy();
    fireEvent.click(screen.getByText("返回"));
    chooseLibrary("我的知识");
    fireEvent.click(await screen.findByText("Shared entry"));
    expect(await screen.findByText("personal body")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "shared-id", library: "builtin" });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "shared-id", library: "personal" });
  });

  it("does not let a late builtin page replace the selected personal library", async () => {
    const pending = deferred<unknown>();
    mockRpc((method, params) => {
      if (method !== "knowledge.documents") return {};
      return params.library === "builtin" ? pending.promise : Promise.resolve(page([hit("personal-row", "personal-row", "", "")]));
    });
    render(<KnowledgePanel />);
    chooseLibrary("我的知识");
    expect(await screen.findByText("personal-row")).toBeTruthy();
    await act(async () => { pending.resolve(page([hit("late-builtin")])); await pending.promise; });
    expect(screen.getByText("personal-row")).toBeTruthy();
    expect(screen.queryByText("late-builtin")).toBeNull();
  });

  it("uses hybrid search explicitly for both libraries and discards late results after switching", async () => {
    const pending = deferred<unknown>();
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return page([hit("personal-initial-row", "personal-initial-row", "", "")]);
      if (method === "knowledge.search" && params.library === "personal") return pending.promise;
      if (method === "knowledge.search") return { results: [hit("builtin-search")] };
      return {};
    });
    render(<KnowledgePanel />);
    chooseLibrary("我的知识");
    expect(await screen.findByText("personal-initial-row")).toBeTruthy();
    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "needle" } });
    const searchButton = screen.getByRole("button", { name: "检索" });
    fireEvent.click(searchButton);
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.search", { query: "needle", limit: 30, method: "hybrid", library: "personal" }));
    chooseLibrary("内置知识");
    expect(await screen.findByText("builtin-search")).toBeTruthy();
    await act(async () => { pending.resolve({ results: [hit("late-full-search")] }); await pending.promise; });
    expect(screen.queryByText("late-full-search")).toBeNull();
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.search", { query: "needle", limit: 30, method: "hybrid", library: "builtin" }));
  });

  it("isolates same-URL documents by library and fetches each library body", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return { ...page([hit(`${params.library}-hit`, `${params.library}-title`, "same.md")]), total: 1 };
      if (method === "knowledge.get_doc") return { ok: true, url: "same.md", filename: "same.md", title: "same", content: `${params.library} body`, chunks: 1, total_chars: 4 };
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("builtin-title"));
    expect(await screen.findByText("builtin body")).toBeTruthy();
    fireEvent.click(screen.getByText("返回"));
    chooseLibrary("我的知识");
    fireEvent.click(await screen.findByText("personal-title"));
    expect(await screen.findByText("personal body")).toBeTruthy();
    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "knowledge.get_doc")).toHaveLength(2);
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", { url: "same.md", library: "builtin" });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", { url: "same.md", library: "personal" });
  });

  it("does not show an old document response after opening another document", async () => {
    const oldDoc = deferred<unknown>();
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return page([hit("a", "doc-a", "a.md"), hit("b", "doc-b", "b.md")]);
      if (method === "knowledge.get_doc") return params.url === "a.md" ? oldDoc.promise : { ok: true, url: "b.md", filename: "b.md", title: "b", content: "new document", chunks: 1, total_chars: 1 };
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("doc-a"));
    fireEvent.click(screen.getByText("返回"));
    fireEvent.click(screen.getByText("doc-b"));
    expect(await screen.findByText("new document")).toBeTruthy();
    await act(async () => { oldDoc.resolve({ ok: true, url: "a.md", filename: "a.md", title: "a", content: "stale document", chunks: 1, total_chars: 1 }); await oldDoc.promise; });
    expect(screen.getByText("new document")).toBeTruthy();
    expect(screen.queryByText("stale document")).toBeNull();
  });

  it("renders a list error instead of claiming the library is empty", async () => {
    mockRpc((method) => method === "knowledge.documents" ? Promise.reject(new Error("offline")) : {});
    render(<KnowledgePanel />);
    expect(await screen.findByText(/加载失败/)).toBeTruthy();
    expect(screen.queryByText(/知识库为空/)).toBeNull();
  });

  it("switches to personal after a successful import when the user stays in the current view", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return params.library === "personal"
        ? page([hit("imported-note", "Imported note", "", "")])
        : page([]);
      if (method === "knowledge.import_docs") return { imported: 1, skipped: 0, errors: 0, rejected: [] };
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/内置资料暂不可用/);
    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickMarkdown(container);
    expect(await screen.findByText("Imported note")).toBeTruthy();
    expect(screen.getByRole("button", { name: "我的知识" }).getAttribute("aria-pressed")).toBe("true");
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.import_docs", { files: [{ name: "note.md", content: "# Note\nBody" }], library: "personal" });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.documents", { limit: 30, offset: 0, library: "personal" });
    expect(toast.success).toHaveBeenCalled();
  });

  it("does not let a pending import completion take back a library the user switched to", async () => {
    const pendingImport = deferred<unknown>();
    mockRpc((method, params) => {
      if (method === "knowledge.documents") return page([hit(`${params.library}-row`, `${params.library}-row`, "", "")]);
      if (method === "knowledge.import_docs") return pendingImport.promise;
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    expect(await screen.findByText("builtin-row")).toBeTruthy();
    chooseLibrary("我的知识");
    expect(await screen.findByText("personal-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickMarkdown(container);
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.import_docs", {
      files: [{ name: "note.md", content: "# Note\nBody" }], library: "personal",
    }));
    chooseLibrary("内置知识");
    expect(await screen.findByText("builtin-row")).toBeTruthy();
    await act(async () => {
      pendingImport.resolve({ imported: 1, skipped: 0, errors: 0, rejected: [] });
      await pendingImport.promise;
    });
    expect(screen.getByRole("button", { name: "内置知识" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("builtin-row")).toBeTruthy();
  });

  it("reports duplicate and conflicting imports without replacing personal documents", async () => {
    mockRpc((method) => {
      if (method === "knowledge.documents") return page([hit("existing", "Existing note", "existing.md", "")]);
      if (method === "knowledge.import_docs") return { imported: 0, skipped: 1, errors: 0, rejected: [], conflicts: 1 };
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    await screen.findByText("Existing note");
    chooseLibrary("我的知识");
    await screen.findByText("Existing note");
    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickMarkdown(container, "existing.md");
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledWith("1 篇同名文档有冲突，未覆盖原内容。"));
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.import_docs", { files: [{ name: "existing.md", content: "# Note\nBody" }], library: "personal" });
    expect(screen.getByText("Existing note")).toBeTruthy();
    expect(docCache.size).toBe(0);
  });
});
