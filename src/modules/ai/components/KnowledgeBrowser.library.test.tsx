import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePanel } from "./KnowledgeBrowser";
import { clearKnowledgeCaches } from "@/modules/ai/lib/knowledge-cache";

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
const hit = (id: string, title = id, url = "") => ({
  id, title, source: "sample", content: `${title} excerpt`, url, tags: [], category: "services",
});
const page = (results: ReturnType<typeof hit>[], groups = [{ category: "services", source: "sample", entries: results.length, files: new Set(results.filter((row) => row.url).map((row) => row.url)).size }]) => ({
  results, total: results.length, limit: 50, offset: 0, groups,
});
const chooseLibrary = (name: "内置知识" | "我的知识") =>
  (() => {
    const tab = screen.getByRole("tab", { name });
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
    fireEvent.click(tab);
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
  it("defaults to slim and switches list requests explicitly to full", async () => {
    mockRpc((method, params) => method === "knowledge.list" ? page([hit(`${params.library}-row`)]) : {});
    render(<KnowledgePanel />);
    expect(await screen.findByText("slim-row")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.list", { limit: 50, offset: 0, library: "slim" });
    chooseLibrary("我的知识");
    expect(await screen.findByText("full-row")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.list", { limit: 50, offset: 0, library: "full" });
  });

  it("keeps full category totals and appends a 50+ page without duplicate IDs", async () => {
    const first = Array.from({ length: 50 }, (_, i) => hit(`row-${i}`, `row-${i}`, i < 2 ? `doc-${i}.md` : ""));
    const groups = [
      { category: "services", source: "sample", entries: 52, files: 2 },
      { category: "security", source: "other", entries: 4, files: 1 },
    ];
    mockRpc((method, params) => {
      if (method === "knowledge.list") return params.offset === 0
        ? { ...page(first, groups), total: 56 }
        : { ...page([hit("row-49"), ...Array.from({ length: 6 }, (_, i) => hit(`row-${50 + i}`))], groups), total: 56, offset: 50 };
      return {};
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("row-2")).toBeTruthy();
    expect(screen.getByText("安全加固")).toBeTruthy();
    expect(screen.getByText(/50.*56/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(await screen.findByText("row-55")).toBeTruthy();
    expect(screen.getAllByText("row-49")).toHaveLength(1);
    const listCalls = vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "knowledge.list");
    expect(listCalls[1]).toEqual(["knowledge.list", { limit: 50, offset: 50, library: "slim" }]);
    expect(screen.getByText(/56.*56/)).toBeTruthy();
  });

  it("filters categorized files out of the empty-category all-files response", async () => {
    const classified = { ...hit("classified-hit", "classified entry", "classified.md"), category: "services" };
    const unclassified = { ...hit("unclassified-hit", "unclassified entry", "uncategorized.md"), category: "" };
    const classifiedFile = { url: "classified.md", filename: "classified.md", title0: "classified", chunks: 1, total_chars: 8, source: "sample", category: "services" };
    const unclassifiedFile = { url: "uncategorized.md", filename: "uncategorized.md", title0: "uncategorized", chunks: 1, total_chars: 8, source: "sample", category: "" };
    mockRpc((method, params) => {
      if (method === "knowledge.list") return {
        ...page([classified, unclassified], [
          { category: "services", source: "sample", entries: 1, files: 1 },
          { category: "", source: "sample", entries: 1, files: 1 },
        ]),
        total: 2,
      };
      if (method === "knowledge.list_files") return params.group === ""
        ? { files: [classifiedFile, unclassifiedFile], total: 2 }
        : { files: [classifiedFile], total: 1 };
      if (method === "knowledge.titles_zh") return { titles: [] };
      return {};
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("uncategorized.md")).toBeTruthy();
    expect(screen.getByText("服务部署")).toBeTruthy();
    expect(screen.getAllByText("classified.md")).toHaveLength(1);
    expect(screen.getAllByText("uncategorized.md")).toHaveLength(1);
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.list_files", { group: "", library: "slim" });
  });

  it("shows load-more failure and can retry the same offset", async () => {
    let attempts = 0;
    mockRpc((method, params) => {
      if (method !== "knowledge.list") return {};
      if (params.offset === 0) return { ...page(Array.from({ length: 50 }, (_, i) => hit(`first-${i}`))), total: 51 };
      attempts += 1;
      if (attempts === 1) throw new Error("temporary failure");
      return { ...page([hit("last")]), total: 51, offset: 50 };
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
    const first = Array.from({ length: 50 }, (_, i) => hit(`slim-${i}`));
    mockRpc((method, params) => {
      if (method !== "knowledge.list") return {};
      if (params.library === "slim" && params.offset === 50) return pendingPage.promise;
      if (params.library === "slim") return { ...page(first), total: 56 };
      return { ...page([hit("full-view")]), total: 1 };
    });
    render(<KnowledgePanel />);
    expect(await screen.findByText("slim-0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.list", {
      limit: 50, offset: 50, library: "slim",
    }));
    chooseLibrary("我的知识");
    expect(await screen.findByText("full-view")).toBeTruthy();
    await act(async () => {
      pendingPage.resolve({ ...page([hit("stale-page-row")]), total: 56, offset: 50 });
      await pendingPage.promise;
    });
    expect(screen.getByText("full-view")).toBeTruthy();
    expect(screen.queryByText("stale-page-row")).toBeNull();
  });

  it("does not let pending file or title results from one library appear in the other", async () => {
    const pendingFiles = deferred<unknown>();
    const pendingTitles = deferred<unknown>();
    const sameFile = { url: "same.md", filename: "same.md", title0: "same", chunks: 1, total_chars: 4, source: "sample" };
    mockRpc((method, params) => {
      if (method === "knowledge.list") return { ...page([hit("same-hit", "same", "same.md")]), total: 1 };
      if (method === "knowledge.list_files") return params.library === "slim" ? pendingFiles.promise : { files: [sameFile] };
      if (method === "knowledge.titles_zh") return params.library === "slim"
        ? pendingTitles.promise
        : { titles: [{ url: "same.md", zh: "FULL TITLE" }] };
      return {};
    });
    render(<KnowledgePanel />);
    await vi.waitFor(() => {
      expect(invokeRpc).toHaveBeenCalledWith("knowledge.list_files", { group: "services", library: "slim" });
      expect(invokeRpc).toHaveBeenCalledWith("knowledge.titles_zh", { source: "sample", library: "slim" });
    });
    chooseLibrary("我的知识");
    expect(await screen.findByText("FULL TITLE")).toBeTruthy();
    await act(async () => {
      pendingFiles.resolve({ files: [sameFile] });
      await pendingFiles.promise;
    });
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.titles_zh", {
      source: "sample", library: "slim",
    }));
    await act(async () => {
      pendingTitles.resolve({ titles: [{ url: "same.md", zh: "STALE SLIM TITLE" }] });
      await pendingTitles.promise;
    });
    expect(screen.getByText("FULL TITLE")).toBeTruthy();
    expect(screen.queryByText("STALE SLIM TITLE")).toBeNull();
  });

  it("loads no-URL entry details from the selected library even when IDs match", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.list") return page([hit("shared-id", "Shared entry")]);
      if (method === "knowledge.get") return { entry: { ...hit("shared-id", "Shared entry", ""), content: `${params.library} body` } };
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("Shared entry"));
    expect(await screen.findByText("slim body")).toBeTruthy();
    fireEvent.click(screen.getByText("返回"));
    chooseLibrary("我的知识");
    fireEvent.click(await screen.findByText("Shared entry"));
    expect(await screen.findByText("full body")).toBeTruthy();
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "shared-id", library: "slim" });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get", { id: "shared-id", library: "full" });
  });

  it("does not let a late slim list replace the selected full library", async () => {
    const pending = deferred<unknown>();
    mockRpc((method, params) => {
      if (method !== "knowledge.list") return {};
      return params.library === "slim" ? pending.promise : Promise.resolve(page([hit("full-row")]));
    });
    render(<KnowledgePanel />);
    chooseLibrary("我的知识");
    expect(await screen.findByText("full-row")).toBeTruthy();
    await act(async () => { pending.resolve(page([hit("late-slim")])); await pending.promise; });
    expect(screen.getByText("full-row")).toBeTruthy();
    expect(screen.queryByText("late-slim")).toBeNull();
  });

  it("uses the full search RPC and discards search results after switching libraries", async () => {
    const pending = deferred<unknown>();
    mockRpc((method) => {
      if (method === "knowledge.list") return page([hit("full-initial-row")]);
      if (method === "knowledge.search_full") return pending.promise;
      if (method === "knowledge.search") return { results: [hit("slim-search")] };
      return {};
    });
    render(<KnowledgePanel />);
    chooseLibrary("我的知识");
    expect(await screen.findByText("full-initial-row")).toBeTruthy();
    const input = screen.getByPlaceholderText(/搜索命令/);
    fireEvent.change(input, { target: { value: "needle" } });
    const searchButton = screen.getByRole("button", { name: "检索" });
    await vi.waitFor(() => expect((searchButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(searchButton);
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.search_full", { query: "needle", limit: 30 }));
    chooseLibrary("内置知识");
    expect(await screen.findByText("slim-search")).toBeTruthy();
    await act(async () => { pending.resolve({ results: [hit("late-full-search")] }); await pending.promise; });
    expect(screen.queryByText("late-full-search")).toBeNull();
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.search", { query: "needle", limit: 30, method: "hybrid" }));
  });

  it("isolates same-URL documents by library and fetches each library body", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.list") return { ...page([hit(`${params.library}-hit`, `${params.library}-title`, "same.md")]), total: 1 };
      if (method === "knowledge.list_files") return { files: [{ url: "same.md", filename: "same.md", chunks: 1, total_chars: 4, source: "sample" }] };
      if (method === "knowledge.get_doc") return { ok: true, url: "same.md", filename: "same.md", title: "same", content: `${params.library} body`, chunks: 1, total_chars: 4 };
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("same.md"));
    expect(await screen.findByText("slim body")).toBeTruthy();
    fireEvent.click(screen.getByText("返回"));
    chooseLibrary("我的知识");
    fireEvent.click(await screen.findByText("same.md"));
    expect(await screen.findByText("full body")).toBeTruthy();
    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "knowledge.get_doc")).toHaveLength(2);
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", { url: "same.md", library: "slim" });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.get_doc", { url: "same.md", library: "full" });
  });

  it("does not show an old document response after opening another document", async () => {
    const oldDoc = deferred<unknown>();
    mockRpc((method, params) => {
      if (method === "knowledge.list") return page([hit("a", "doc-a", "a.md"), hit("b", "doc-b", "b.md")]);
      if (method === "knowledge.list_files") return { files: ["a.md", "b.md"].map((url) => ({ url, filename: url, chunks: 1, total_chars: 1, source: "sample" })) };
      if (method === "knowledge.get_doc") return params.url === "a.md" ? oldDoc.promise : { ok: true, url: "b.md", filename: "b.md", title: "b", content: "new document", chunks: 1, total_chars: 1 };
      return {};
    });
    render(<KnowledgePanel />);
    fireEvent.click(await screen.findByText("a.md"));
    fireEvent.click(screen.getByText("返回"));
    fireEvent.click(screen.getByText("b.md"));
    expect(await screen.findByText("new document")).toBeTruthy();
    await act(async () => { oldDoc.resolve({ ok: true, url: "a.md", filename: "a.md", title: "a", content: "stale document", chunks: 1, total_chars: 1 }); await oldDoc.promise; });
    expect(screen.getByText("new document")).toBeTruthy();
    expect(screen.queryByText("stale document")).toBeNull();
  });

  it("renders a list error instead of claiming the library is empty", async () => {
    mockRpc((method) => method === "knowledge.list" ? Promise.reject(new Error("offline")) : {});
    render(<KnowledgePanel />);
    expect(await screen.findByText(/加载失败/)).toBeTruthy();
    expect(screen.queryByText(/知识库为空/)).toBeNull();
  });

  it("switches to full after a successful import when the user stays in the current view", async () => {
    mockRpc((method, params) => {
      if (method === "knowledge.list") return params.library === "full"
        ? page([hit("imported-note", "Imported note")])
        : page([]);
      if (method === "knowledge.import_docs") return { imported: 1, skipped: 0, errors: 0, rejected: [] };
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    await screen.findByText(/知识库为空/);
    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickMarkdown(container);
    expect(await screen.findByText("Imported note")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "我的知识" }).getAttribute("aria-selected")).toBe("true");
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.import_docs", { files: [{ name: "note.md", content: "# Note\nBody" }] });
    expect(invokeRpc).toHaveBeenCalledWith("knowledge.list", { limit: 50, offset: 0, library: "full" });
    expect(toast.success).toHaveBeenCalled();
  });

  it("does not let a pending import completion take back a library the user switched to", async () => {
    const pendingImport = deferred<unknown>();
    mockRpc((method, params) => {
      if (method === "knowledge.list") return page([hit(`${params.library}-row`)]);
      if (method === "knowledge.import_docs") return pendingImport.promise;
      return {};
    });
    const { container } = render(<KnowledgePanel />);
    expect(await screen.findByText("slim-row")).toBeTruthy();
    chooseLibrary("我的知识");
    expect(await screen.findByText("full-row")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入 md" }));
    pickMarkdown(container);
    await vi.waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("knowledge.import_docs", {
      files: [{ name: "note.md", content: "# Note\nBody" }],
    }));
    chooseLibrary("内置知识");
    expect(await screen.findByText("slim-row")).toBeTruthy();
    await act(async () => {
      pendingImport.resolve({ imported: 1, skipped: 0, errors: 0, rejected: [] });
      await pendingImport.promise;
    });
    expect(screen.getByRole("tab", { name: "内置知识" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("slim-row")).toBeTruthy();
  });
});
