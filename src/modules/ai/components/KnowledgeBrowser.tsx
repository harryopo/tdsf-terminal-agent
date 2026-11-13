/**
 * Knowledge panel: built-in/personal documents, with raw references kept separate.
 * Reading and recovery have their own static, non-terminal components.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { invokeRpc } from "@/lib/sidecar-bridge";
import { toast } from "sonner";
import { clearKnowledgeCaches, docCache, knowledgeCacheKey, type KnowledgeDoc, type KnowledgeDocument, type KnowledgeGroupSummary } from "@/modules/ai/lib/knowledge-cache";
import { categoryGroupLabel, plainSummary, sourceGroupLabel } from "@/modules/ai/lib/knowledge-labels";
import { knowledgeDisplayTitle } from "@/modules/ai/lib/knowledge-reader";
import { diagnosticText } from "@/modules/ai/lib/sessionDiagnostics";
import { KnowledgeReader } from "./KnowledgeReader";
import { KnowledgeRecoveryDialog } from "./KnowledgeRecoveryDialog";
import { ArrowDown01Icon, ArrowRight01Icon, BookOpen01Icon, FileImportIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type BrowserLibrary = "builtin" | "personal" | "reference";
type BrowserRow = KnowledgeDocument & { content?: string; title?: string };
type Page = { documents: BrowserRow[]; total: number; groups: KnowledgeGroupSummary[] };
type DetailTarget = { row: BrowserRow; library: BrowserLibrary; searched: boolean };
const PAGE_SIZE = 30;
const CATEGORY_ORDER = ["linux-philosophy", "basic-ops", "cmd-tools", "sys-admin", "net-remote", "security", "services", ""];
const libraryNames = { builtin: "内置知识", personal: "我的知识", reference: "原始参考" };

function rowKey(row: BrowserRow) { return row.url ? `url:${row.url}` : `entry:${row.id}`; }
function categoryRank(category: string) { const rank = CATEGORY_ORDER.indexOf(category); return rank < 0 ? CATEGORY_ORDER.length - 1 : rank; }

async function loadPage(library: BrowserLibrary, offset: number, category: string | null, query: string): Promise<Page> {
  if (query) {
    const result = await invokeRpc<{ results: (BrowserRow & { title: string })[] }>("knowledge.search", { query, limit: PAGE_SIZE, method: "hybrid", library });
    if (!Array.isArray(result.results)) throw new Error("Invalid knowledge search response");
    return { documents: result.results.map((row) => ({ ...row, library, title0: row.title, chunks: 1, total_chars: row.content?.length ?? 0, summary_zh: plainSummary(row.content) })), total: result.results.length, groups: [] };
  }
  const result = await invokeRpc<Page>("knowledge.documents", { library, limit: PAGE_SIZE, offset, ...(category !== null ? { category } : {}) });
  if (!Array.isArray(result.documents)) throw new Error("Invalid knowledge document response");
  return result;
}

function KnowledgeDetailDialog({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [errorDetails, setErrorDetails] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFailed(false);
    setErrorDetails("");
    const { row, library } = target;
    const key = knowledgeCacheKey(library, row.url);
    const cached = row.url ? docCache.get(key) : undefined;
    if (cached) { setDoc(cached); return; }
    const pending = row.url
      ? invokeRpc<KnowledgeDoc>("knowledge.get_doc", { url: row.url, library })
      : invokeRpc<{ entry?: { content: string; content_zh?: string; title?: string; source?: string } }>("knowledge.get", { id: row.id, library }).then((value): KnowledgeDoc => value.entry ? { ...value.entry, ok: true, chunks: 1, total_chars: value.entry.content.length } : { ok: false });
    void pending.then((value) => {
      if (cancelled) return;
      if (!value.ok) { setErrorDetails(diagnosticText(value.error ?? "").slice(0, 1500)); setFailed(true); return; }
      const owned = { ...value, library };
      if (row.url) docCache.set(key, owned);
      setDoc(owned);
    }).catch((error: unknown) => {
      if (!cancelled) { setErrorDetails(diagnosticText(error instanceof Error ? error.message : error).slice(0, 1500)); setFailed(true); }
    });
    return () => { cancelled = true; };
  }, [target, revision]);
  const title = knowledgeDisplayTitle(doc ?? target.row);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} className="flex h-[82vh] max-h-[900px] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-4xl">
      <DialogHeader className="flex-row items-start gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[11px] tracking-wide text-muted-foreground">{libraryNames[target.library]}{target.searched ? " · 从搜索命中打开" : ""}</p>
          <DialogTitle className="break-words text-lg font-semibold leading-7">{title}</DialogTitle>
          {doc?.summary_zh && <p className="mt-2 text-xs leading-6 text-muted-foreground">{plainSummary(doc.summary_zh, 220)}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>返回</Button>
      </DialogHeader>
      {doc ? <KnowledgeReader key={`${target.library}:${rowKey(target.row)}`} doc={doc} /> : failed
        ? <div role="status" className="space-y-3 overflow-auto p-6 text-sm text-muted-foreground"><p>文档加载失败，请重试或返回列表。</p>{errorDetails && <details><summary className="cursor-pointer text-xs">技术详情（已脱敏）</summary><pre className="mt-2 whitespace-pre-wrap break-all text-xs">{errorDetails}</pre></details>}<Button variant="outline" onClick={() => setRevision((value) => value + 1)}>重试</Button></div>
        : <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><Spinner className="size-4" />读取文档…</div>}
    </DialogContent>
  </Dialog>;
}

export function KnowledgePanel() {
  const [library, setLibrary] = useState<BrowserLibrary>("builtin");
  const primaryLibrary = useRef<"builtin" | "personal">("builtin");
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<BrowserRow[]>([]);
  const [groups, setGroups] = useState<KnowledgeGroupSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const viewVersion = useRef(0);
  const pageOffset = useRef(0);
  const pagePending = useRef(false);
  const importPending = useRef(false);
  const viewReady = useRef(false);
  const mounted = useRef(false);
  const recoveryOwner = useRef(0);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; viewVersion.current += 1; }; }, []);
  useEffect(() => {
    const owner = ++viewVersion.current;
    viewReady.current = false;
    pagePending.current = false;
    pageOffset.current = 0;
    setRows([]); setGroups([]); setTotal(0); setLoadError(false); setLoadingMore(false); setLoading(true);
    void loadPage(library, 0, category, searchTerm).then((page) => {
      if (!mounted.current || owner !== viewVersion.current) return;
      if (page.documents.length === 0 && page.total > 0) throw new Error("Empty knowledge page");
      setRows(page.documents); setGroups(page.groups); setTotal(page.total);
      pageOffset.current = page.documents.length;
      viewReady.current = true;
    }).catch(() => { if (mounted.current && owner === viewVersion.current) setLoadError(true); })
      .finally(() => { if (mounted.current && owner === viewVersion.current) setLoading(false); });
    return () => { if (viewVersion.current === owner) viewVersion.current += 1; };
  }, [library, category, searchTerm, revision]);

  function invalidate() { viewVersion.current += 1; viewReady.current = false; }
  function chooseLibrary(next: BrowserLibrary) {
    if (next === library) return;
    invalidate();
    if (next !== "reference") primaryLibrary.current = next;
    setLibrary(next); setCategory(null); setCollapsed(new Set()); setDetail(null);
  }
  function search() { invalidate(); setSearchTerm(query.trim()); setRevision((value) => value + 1); }

  async function loadMore() {
    if (pagePending.current || !viewReady.current || searchTerm || pageOffset.current >= total) return;
    pagePending.current = true;
    const owner = viewVersion.current;
    const offset = pageOffset.current;
    setLoadingMore(true); setLoadError(false);
    try {
      const page = await loadPage(library, offset, category, "");
      if (!mounted.current || owner !== viewVersion.current) return;
      if (page.documents.length === 0 && offset < page.total) throw new Error("Empty knowledge page");
      setRows((previous) => {
        const merged = new Map(previous.map((row) => [rowKey(row), row]));
        for (const row of page.documents) if (!merged.has(rowKey(row))) merged.set(rowKey(row), row);
        return [...merged.values()];
      });
      pageOffset.current = offset + page.documents.length;
      setGroups(page.groups); setTotal(page.total);
    } catch { if (mounted.current && owner === viewVersion.current) setLoadError(true); }
    finally { if (mounted.current && owner === viewVersion.current) { pagePending.current = false; setLoadingMore(false); } }
  }

  function refreshPersonal(owner: number) {
    clearKnowledgeCaches();
    if (!mounted.current || owner !== viewVersion.current) return;
    invalidate(); primaryLibrary.current = "personal"; setLibrary("personal"); setCategory(null); setSearchTerm(""); setQuery(""); setRevision((value) => value + 1);
  }

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (importPending.current || files.length === 0) return;
    const accepted = files.filter((file) => /\.(?:md|markdown)$/i.test(file.name));
    if (accepted.length !== files.length) toast.warning("只导入 Markdown 文件，其他格式已跳过。");
    if (accepted.length === 0) return;
    importPending.current = true; setImporting(true);
    const owner = viewVersion.current;
    try {
      const values = await Promise.all(accepted.map(async (file) => ({ name: file.name, content: await file.text() })));
      const result = await invokeRpc<{ imported: number; skipped: number; errors: number; rejected: string[]; conflicts?: number; error?: string }>("knowledge.import_docs", { files: values, library: "personal" });
      if (result.error || result.errors > 0) toast.error("部分文档导入失败，请检查文件后重试。");
      if (result.imported > 0) { toast.success(`已导入 ${result.imported} 篇文档`); refreshPersonal(owner); }
      if (result.conflicts) toast.warning(`${result.conflicts} 篇同名文档有冲突，未覆盖原内容。`);
      if (result.imported === 0 && !result.error && !result.errors && !result.conflicts) toast.warning("没有新增内容，重复或不支持的文件已跳过。");
    } catch { toast.error("文档导入失败，未自动切换知识来源。"); }
    finally { importPending.current = false; if (mounted.current) setImporting(false); }
  }

  const categories = [...new Set(groups.map((group) => group.category))].sort((a, b) => categoryRank(a) - categoryRank(b));
  const visibleCategories = [...new Set(rows.map((row) => row.category || ""))].sort((a, b) => categoryRank(a) - categoryRank(b));
  const hasMore = !searchTerm && pageOffset.current < total;

  return <div className="flex h-full min-h-0 flex-col">
    <input ref={fileInput} type="file" multiple accept=".md,.markdown" className="hidden" onChange={(event) => void importFiles(event)} />
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-3">
      <HugeiconsIcon icon={BookOpen01Icon} size={16} strokeWidth={1.75} />
      <span className="text-xs font-semibold">知识库</span>
      <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 px-1.5 text-[11px] text-muted-foreground" disabled={importing} onClick={() => fileInput.current?.click()}>
        {importing ? <Spinner className="size-3" /> : <HugeiconsIcon icon={FileImportIcon} size={13} strokeWidth={1.75} />}{importing ? "导入中…" : "导入 md"}
      </Button>
    </div>
    <nav aria-label="知识库来源" className="mx-2.5 mt-3 grid grid-cols-2 rounded-lg bg-muted/50 p-1">
      {(["builtin", "personal"] as const).map((value) => <Button key={value} variant={library === value ? "secondary" : "ghost"} aria-pressed={library === value} className="h-8 rounded-md text-xs" onClick={() => chooseLibrary(value)}>{libraryNames[value]}</Button>)}
    </nav>
    <div className="space-y-2 border-b border-border/60 px-3 py-3">
      <p className="text-[11px] leading-5 text-muted-foreground">{library === "builtin" ? "随应用提供的教学资料与参考整理" : library === "personal" ? "你的翻译、笔记与手动导入文档" : "本机爬取缓存 · 未整理的原始参考"}</p>
      <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <Input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value && searchTerm) { invalidate(); setSearchTerm(""); } }} placeholder="搜索命令、概念或章节…" className="h-8 min-w-0 text-xs" />
        <Button type="submit" variant="outline" size="sm" className="h-8 shrink-0 text-xs" aria-label="检索">搜索</Button>
      </form>
      {!searchTerm && <Select value={category === null ? "(all)" : category || "(uncategorized)"} onValueChange={(value) => { invalidate(); setCategory(value === "(all)" ? null : value === "(uncategorized)" ? "" : value); }}>
        <SelectTrigger aria-label="按主题筛选" size="sm" className="w-full text-xs text-muted-foreground"><SelectValue /></SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value="(all)">全部主题</SelectItem>
          {categories.map((value) => <SelectItem key={value} value={value || "(uncategorized)"}>{categoryGroupLabel(value)} · {groups.filter((group) => group.category === value).reduce((sum, group) => sum + group.files, 0)} 篇</SelectItem>)}
        </SelectContent>
      </Select>}
      {library === "personal" && <Button variant="ghost" size="sm" className="h-6 px-0 text-[11px] text-muted-foreground" onClick={() => { recoveryOwner.current = viewVersion.current; setRecoveryOpen(true); }}>恢复已有中文整理</Button>}
    </div>
    <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
      {loading && <div role="status" className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground"><Spinner className="size-3.5" />读取知识…</div>}
      {!loading && loadError && <div role="status" className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-xs leading-6 text-muted-foreground"><p>加载失败，请重试。未将服务异常当作空知识库。</p><Button variant="outline" size="sm" onClick={() => { invalidate(); setRevision((value) => value + 1); }}>重试</Button></div>}
      {!loading && !loadError && rows.length === 0 && <div className="space-y-2 py-10 text-center text-xs leading-6 text-muted-foreground">
        <p>{searchTerm ? "未找到相关内容。" : library === "personal" ? "还没有个人整理文档。" : library === "reference" ? "本机暂无原始参考缓存。" : "内置资料暂不可用。"}</p>
        <p>{library === "personal" ? "导入 Markdown，或恢复你已有的中文整理。" : searchTerm ? "换一个命令、概念或关键词再试。" : "不会自动调用模型翻译或重新爬取。"}</p>
      </div>}
      {visibleCategories.map((value) => <section key={value} className="mb-4">
        <button type="button" aria-expanded={!collapsed.has(value)} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(value)) next.delete(value); else next.add(value); return next; })} className="flex w-full items-center gap-1 py-2 text-left text-[11px] font-semibold text-muted-foreground">
          <HugeiconsIcon icon={collapsed.has(value) ? ArrowRight01Icon : ArrowDown01Icon} size={11} />{categoryGroupLabel(value)}
        </button>
        {!collapsed.has(value) && rows.filter((row) => (row.category || "") === value).map((row) => <button key={searchTerm ? row.id : rowKey(row)} type="button" onClick={() => setDetail({ row, library, searched: Boolean(searchTerm) })} className="group block w-full rounded-lg border-b border-border/50 px-2 py-3 text-left transition-colors hover:bg-muted/50">
          <span className="block break-words text-[13px] font-medium leading-5 text-foreground">{knowledgeDisplayTitle(row)}</span>
          {row.summary_zh && <span className="mt-1.5 line-clamp-2 block text-[11px] leading-5 text-muted-foreground">{plainSummary(row.summary_zh)}</span>}
          <span className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[10px] leading-4 text-muted-foreground/80"><span>{sourceGroupLabel(row.source)}</span><span>{library === "reference" ? "未整理缓存" : library === "builtin" ? "教学 / 整理版" : "个人资料"}{searchTerm ? " · 命中章节" : ""}</span></span>
        </button>)}
      </section>)}
      {!loading && rows.length > 0 && <div className="space-y-2 border-t border-border/50 py-3 text-center text-[11px] text-muted-foreground">
        <p>{searchTerm ? `${rows.length} 个匹配片段` : `已载入 ${rows.length} / ${total} 篇文档`}</p>
        {hasMore && <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "加载中…" : "加载更多"}</Button>}
      </div>}
    </div>
    <div className="shrink-0 border-t border-border/60 p-2">
      <Button variant="ghost" size="sm" aria-expanded={library === "reference"} className="h-8 w-full justify-start gap-2 text-[11px] text-muted-foreground" onClick={() => chooseLibrary(library === "reference" ? primaryLibrary.current : "reference")}>
        <HugeiconsIcon icon={library === "reference" ? ArrowDown01Icon : ArrowRight01Icon} size={12} />{library === "reference" ? "收起原始参考" : "原始参考 · 未整理"}
      </Button>
    </div>
    {detail && <KnowledgeDetailDialog key={`${detail.library}:${rowKey(detail.row)}`} target={detail} onClose={() => setDetail(null)} />}
    {recoveryOpen && <KnowledgeRecoveryDialog onClose={() => setRecoveryOpen(false)} onRecovered={() => refreshPersonal(recoveryOwner.current)} />}
  </div>;
}

export function KnowledgeBrowser({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent aria-describedby={undefined} className="flex h-[75vh] flex-col gap-0 p-0 sm:max-w-2xl">
      <DialogHeader className="sr-only"><DialogTitle>知识库</DialogTitle></DialogHeader>
      <KnowledgePanel />
    </DialogContent>
  </Dialog>;
}
