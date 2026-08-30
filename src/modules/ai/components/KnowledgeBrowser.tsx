/**
 * KnowledgeBrowser.tsx — 知识库浏览器（P2-4 可视化）
 * -----------------------------------------------------------------------------
 * 左侧栏「知识库」视图，双模式（TDSF 魔改 2026-08-29: 两级文件视图）：
 *
 *   浏览模式（默认）：来源分组 → 组内列「文件」（knowledge.list_files，
 *     按 url 聚合的文件级条目：filename/块数），点文件弹出
 *     「完整文档」（knowledge.get_doc 拼接全部分块）。无 url 的来源
 *     （case-* 会话沉淀）保持原条目式展示。
 *
 *   搜索模式：输入搜索词走 knowledge.search（按块命中，语义不变），
 *     命中条目显示所属文件名（从 hit.url 提取）；点击优先打开完整文档
 *     （get_doc），并提示「来自搜索命中，第 N 块」（N 从分块 id 尾部序号
 *     提取，id 形如 doc-<hash>-<seq>，seq 从 0 起）；清空搜索回落浏览模式。
 *
 *   导入 md（TDSF 魔改 2026-08-30）：内置教学语料剔除（个人语料不随应用
 *     分发），头部「导入 md」按钮 → HTML input 多选 .md（WebView 下读
 *     内容传后端）→ knowledge.import_docs（fail-closed 仅 .md）→
 *     清缓存 + 重载列表。
 *
 * 数据链路：
 *   knowledge.list(limit)          → 浏览模式来源清单 + 无 url 条目
 *   knowledge.list_files({source}) → 组内文件级列表（懒加载，per source 缓存）
 *   knowledge.get_doc({url})       → 完整文档 md（per url 缓存，弹窗重开不重复请求）
 *   knowledge.search(query, limit) → 搜索（按块命中，语义不变）
 *   knowledge.get(id)              → 无 url 条目详情（案例）
 *   knowledge.import_docs({files}) → 导入 md（{name, content} 列表）
 *
 * 设计规范：UI 组件套（Input/Button/Badge/Dialog）+ Hugeicons 图标，不使用 emoji。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { invokeRpc } from "@/lib/sidecar-bridge";
import { toast } from "sonner";
import {
  clearKnowledgeCaches,
  docCache,
  filesCache,
  titlesZhCache,
  type KnowledgeDoc,
  type KnowledgeFile,
} from "@/modules/ai/lib/knowledge-cache";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BookOpen01Icon,
  FileImportIcon,
  GlobalSearchIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

// ============================================================================
// 类型（与后端 knowledge.* RPC 返回对齐）
// ============================================================================

interface KnowledgeHit {
  id: string;
  source: string;
  title: string;
  content: string;
  url: string;
  tags: string[];
  match_type?: string;
  rrf_score?: number;
}

/** knowledge.list_files 返回的文件级条目与 knowledge.get_doc 返回的完整文档
 *  类型见 @/modules/ai/lib/knowledge-cache（KnowledgeFile / KnowledgeDoc） */

/** 详情弹窗打开目标：docUrl 优先走 get_doc 完整文档；entryId 走 get 条目详情 */
type DetailTarget = {
  /** 无 url 条目（会话案例沉淀）：走 knowledge.get(id) */
  entryId?: string;
  /** 文档 url：走 knowledge.get_doc(url) 取完整文档 */
  docUrl?: string;
  /** 搜索命中原条目（弹窗提示「来自搜索命中，第 N 块」） */
  hit?: KnowledgeHit;
};

/** 组内文件级列表的懒加载状态（per source） */
type FilesLoadState =
  | { status: "loading" }
  | { status: "ready"; files: KnowledgeFile[] }
  | { status: "error" };

// ============================================================================
// 来源分组（TDSF 魔改 2026-08-29: 按来源分组浏览，避免分块条目平铺）
// ============================================================================

/** 17 官方文档源 → 中文组名（TDSF 魔改 2026-08-30，与 crawlers/registry.py
 *  注册源一一对应；用户要求官方文档显示中文名，agent 检索仍用英文 source id） */
const OFFICIAL_SOURCE_LABELS: Record<string, string> = {
  "nginx-docs": "Nginx 官方文档",
  "apache-docs": "Apache HTTP 文档",
  "mariadb-docs": "MariaDB 知识库",
  "redis-docs": "Redis 官方文档",
  "docker-docs": "Docker 官方文档",
  "kubernetes-docs": "Kubernetes 官方文档",
  "systemd-docs": "systemd 手册",
  "selinux-docs": "SELinux 指南",
  "iptables-docs": "netfilter 文档",
  "ssh-docs": "OpenSSH 手册",
  "bash-docs": "Bash 手册",
  "python-docs": "Python 官方文档",
  "rust-docs": "Rust 官方文档",
  "git-docs": "Git 官方文档",
  "dnf-docs": "DNF 手册",
  "firewalld-docs": "Firewalld 手册",
  archwiki: "Arch Wiki 指南",
};

/** source 原始值 → 中文组名；未知 *-docs 回退「<前缀> 文档」，其余原样显示
 *  TDSF 魔改 2026-08-30: 内置教学语料剔除（个人语料改为手动导入），
 *  删 builtin-skills/builtin-docs/builtin-corpus 映射；17 官方源全量中文映射 */
function sourceGroupLabel(source: string): string {
  const mapped = OFFICIAL_SOURCE_LABELS[source];
  if (mapped) return mapped;
  if (source === "imported-docs") return "导入文档";
  if (source.startsWith("case-") || source === "session-case") return "会话沉淀";
  if (source.endsWith("-docs")) {
    return `${source.slice(0, -"-docs".length)} 文档`;
  }
  return source;
}

/** 从 url 提取文件名（本地路径与 http URL 通用，与后端 _filename_from_url 对齐） */
function fileNameFromUrl(url: string): string {
  if (!url) return "";
  let path = url;
  if (url.includes("://")) {
    try {
      path = new URL(url).pathname;
    } catch {
      // 非法 URL 原样按路径处理
    }
  } else {
    path = url.replace(/\\/g, "/");
  }
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return name || url;
}

/** 从分块 id 尾部提取块序号（doc-<hash>-3 → 3；无尾部数字 → null，与后端 _chunk_seq 对齐） */
function chunkSeqFromId(id: string): number | null {
  const tail = id.slice(id.lastIndexOf("-") + 1);
  return /^\d+$/.test(tail) ? parseInt(tail, 10) : null;
}

/** 搜索命中提示后缀：块序号可提取则「，第 N 块」（1 起计），否则空串 */
function hitSeqSuffix(id: string): string {
  const seq = chunkSeqFromId(id);
  return seq === null ? "" : `，第 ${seq + 1} 块`;
}

type KnowledgeGroup = {
  /** 原始 source（作为折叠状态 key） */
  source: string;
  label: string;
  entries: KnowledgeHit[];
  /** 组内是否含带 url 的文档条目（决定浏览模式下是否列文件） */
  hasFiles: boolean;
};

/** 按来源分组（保持首次出现顺序；作用于当前搜索/过滤结果） */
function groupKnowledgeHits(hits: KnowledgeHit[]): KnowledgeGroup[] {
  const groups = new Map<string, KnowledgeGroup>();
  for (const hit of hits) {
    let group = groups.get(hit.source);
    if (!group) {
      group = {
        source: hit.source,
        label: sourceGroupLabel(hit.source),
        entries: [],
        hasFiles: false,
      };
      groups.set(hit.source, group);
    }
    group.entries.push(hit);
    if (hit.url) group.hasFiles = true;
  }
  return [...groups.values()];
}

// ============================================================================
// RPC + 模块级浏览缓存
// ============================================================================
// invokeRpc 静态导入（与 BackendPill/NeedsYouApprovalCards 一致）：动态
// import("@/lib/sidecar-bridge") 在 Vite SSR 下对同一模块多 callsite 的
// vi.mock 拦截不一致（实测 list_files 命中 mock、titles_zh 却解析到真实
// 模块抛 browser-only 错误），故统一走静态导入。

async function searchKnowledge(
  query: string,
  limit = 30,
): Promise<KnowledgeHit[]> {
  try {
    const res = await invokeRpc<{ results?: KnowledgeHit[] } | null>(
      "knowledge.search",
      { query, limit, method: "hybrid" },
    );
    return res?.results ?? [];
  } catch {
    return [];
  }
}

async function getKnowledge(id: string): Promise<KnowledgeHit | null> {
  try {
    const res = await invokeRpc<{ entry?: KnowledgeHit } | null>(
      "knowledge.get",
      { id },
    );
    return res?.entry ?? null;
  } catch {
    return null;
  }
}

async function listKnowledge(limit = 50): Promise<KnowledgeHit[]> {
  try {
    const res = await invokeRpc<{ results?: KnowledgeHit[] } | null>(
      "knowledge.list",
      { limit, offset: 0 },
    );
    return res?.results ?? [];
  } catch {
    return [];
  }
}

/** 组内文件级列表（不吞错：RPC 失败上抛，由调用方置 error 态，不伪装成空列表） */
async function listKnowledgeFiles(source: string): Promise<KnowledgeFile[]> {
  const res = await invokeRpc<{ files?: KnowledgeFile[] } | null>(
    "knowledge.list_files",
    { source },
  );
  return res?.files ?? [];
}

/** 完整文档（不吞错：RPC 异常上抛，由弹窗统一显示错误态，fail-closed） */
async function getKnowledgeDoc(url: string): Promise<KnowledgeDoc> {
  return invokeRpc<KnowledgeDoc>("knowledge.get_doc", { url });
}

/** 中文标题映射（knowledge.titles_zh，gen_titles_zh.py 离线 LLM 生成）：
 *  url → 中文标题。吞错返回空 Map——无映射时前端回退英文原标题，不报错 */
async function listTitlesZh(source: string): Promise<Map<string, string>> {
  try {
    const res = await invokeRpc<{
      titles?: { url: string; zh: string }[];
    } | null>("knowledge.titles_zh", { source });
    const map = new Map<string, string>();
    for (const t of res?.titles ?? []) {
      if (t.url && t.zh) map.set(t.url, t.zh);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ============================================================================
// SourceFileList — 组内文件级列表（浏览模式，懒加载状态由父组件持有）
// ============================================================================

function SourceFileList({
  state,
  titles,
  onOpenDoc,
}: {
  state: FilesLoadState;
  /** url → 中文标题（knowledge.titles_zh；无映射回退英文 filename） */
  titles: Map<string, string>;
  onOpenDoc: (url: string) => void;
}) {
  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground/70">
        <Spinner className="size-3" />
        正在加载文件列表…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="px-1 py-1 text-[10px] leading-relaxed text-muted-foreground/70">
        文件列表加载失败，收起后再展开可重试。
      </div>
    );
  }
  if (state.files.length === 0) {
    return (
      <div className="px-1 py-1 text-[10px] text-muted-foreground/60">
        该来源暂无文档文件。
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {state.files.map((file) => {
        const zh = titles.get(file.url);
        return (
          <button
            key={file.url}
            type="button"
            onClick={() => onOpenDoc(file.url)}
            className={cn(
              "block w-full rounded-lg border border-border/50 bg-card/40 px-2.5 py-2 text-left",
              "transition-colors hover:border-border hover:bg-muted/40",
            )}
          >
            {/* TDSF 魔改 2026-08-30: 中文预览标题主行 + 英文 filename 副行
                （无中文映射时只显示英文 filename 主行，不报错） */}
            <div className="flex items-center gap-1.5">
              <span
                className={cn(
                  "flex-1 truncate text-[11.5px] font-medium text-foreground",
                  !zh && "font-mono text-[11px]",
                )}
              >
                {zh ?? file.filename}
              </span>
              <Badge
                variant="secondary"
                className="shrink-0 px-1 py-px text-[9px] tabular-nums"
              >
                {file.chunks} 块
              </Badge>
            </div>
            {zh && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                {file.filename}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// KnowledgePanel — 左侧栏内嵌面板（搜索 + 两级浏览列表）
// ============================================================================

export function KnowledgePanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  // TDSF 魔改 2026-08-29: 可折叠分组（记录已折叠组的 source）
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(
    new Set(),
  );
  // TDSF 魔改 2026-08-29: 组内文件级列表懒加载状态（per source）
  const [filesBySource, setFilesBySource] = useState<
    ReadonlyMap<string, FilesLoadState>
  >(new Map());
  // TDSF 魔改 2026-08-30: 导入 md（个人语料手动导入的唯一入口）
  const [importing, setImporting] = useState(false);
  // TDSF 魔改 2026-08-30: 中文预览标题映射（per source 懒加载，knowledge.titles_zh）
  const [titlesBySource, setTitlesBySource] = useState<
    ReadonlyMap<string, Map<string, string>>
  >(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 分组作用于当前搜索/过滤结果（保持首次出现顺序）
  const groups = useMemo(() => groupKnowledgeHits(results), [results]);

  /** 导入 md：HTML input 多选（WebView 下 File 无绝对路径，读内容传后端，
   *  与 composer 附件/主题导入同款机制）→ knowledge.import_docs
   *  （fail-closed 仅 .md）→ 清浏览缓存 + 重载列表 */
  const handleImportFiles = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = ""; // 允许重复选择同一文件
      if (files.length === 0) return;
      const mdRe = /\.md$/i;
      const mdFiles = files.filter((f) => mdRe.test(f.name));
      const rejectedNames = files
        .filter((f) => !mdRe.test(f.name))
        .map((f) => f.name);
      if (mdFiles.length === 0) {
        toast.error("仅支持导入 .md 文件");
        return;
      }
      setImporting(true);
      try {
        const payload = await Promise.all(
          mdFiles.map(async (f) => ({ name: f.name, content: await f.text() })),
        );
        const res = await invokeRpc<{
          imported?: number;
          errors?: number;
          rejected?: { name: string; reason: string }[];
        }>("knowledge.import_docs", { files: payload });
        const importedCount = res?.imported ?? 0;
        const rejected = res?.rejected ?? [];
        // 成功后刷新：清浏览缓存 + 组内文件态 + 中文标题态 + 重载列表（回落浏览模式）
        clearKnowledgeCaches();
        setFilesBySource(new Map());
        setTitlesBySource(new Map());
        const hits = await listKnowledge(50);
        setResults(hits);
        setSearched(false);
        if (rejectedNames.length > 0 || rejected.length > 0) {
          const names = [
            ...new Set([...rejectedNames, ...rejected.map((r) => r.name)]),
          ];
          toast.warning(
            `已导入 ${importedCount} 个文档，非 .md 文件被拒绝：${names.join("、")}`,
          );
        } else {
          toast.success(`已导入 ${importedCount} 个文档`);
        }
      } catch {
        toast.error("导入失败：知识库服务暂不可用，请稍后重试");
      } finally {
        setImporting(false);
      }
    },
    [],
  );

  const toggleGroup = useCallback((source: string) => {
    setCollapsedSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

  const loadFiles = useCallback((source: string) => {
    const cached = filesCache.get(source);
    if (cached) {
      setFilesBySource((prev) =>
        new Map(prev).set(source, { status: "ready", files: cached }),
      );
      return;
    }
    setFilesBySource((prev) => new Map(prev).set(source, { status: "loading" }));
    listKnowledgeFiles(source)
      .then((files) => {
        filesCache.set(source, files);
        setFilesBySource((prev) =>
          new Map(prev).set(source, { status: "ready", files }),
        );
      })
      .catch(() => {
        setFilesBySource((prev) => new Map(prev).set(source, { status: "error" }));
      });
  }, []);

  // 浏览模式下为「已展开且含文档」的组懒加载 list_files（缓存 per source，跳过已加载组）
  useEffect(() => {
    if (searched) return;
    for (const group of groups) {
      if (!group.hasFiles) continue;
      if (collapsedSources.has(group.source)) continue;
      if (filesBySource.has(group.source)) continue;
      loadFiles(group.source);
    }
  }, [searched, groups, collapsedSources, filesBySource, loadFiles]);

  /** 中文标题映射懒加载（per source；失败/无映射缓存空 Map，条目回退英文标题） */
  const loadTitles = useCallback((source: string) => {
    const cached = titlesZhCache.get(source);
    if (cached) {
      setTitlesBySource((prev) => new Map(prev).set(source, cached));
      return;
    }
    void listTitlesZh(source).then((map) => {
      titlesZhCache.set(source, map);
      setTitlesBySource((prev) => new Map(prev).set(source, map));
    });
  }, []);

  // 出现的组即预取中文标题（浏览/搜索两模式共用；缓存命中跳过，不阻塞列表渲染）
  useEffect(() => {
    for (const group of groups) {
      if (titlesBySource.has(group.source)) continue;
      loadTitles(group.source);
    }
  }, [groups, titlesBySource, loadTitles]);

  const search = useCallback(async (q: string) => {
    const keyword = q.trim();
    if (!keyword) {
      // 空查询 → 回到浏览模式（列出全部）
      setLoading(true);
      const hits = await listKnowledge(50);
      setResults(hits);
      setSearched(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    const hits = await searchKnowledge(keyword);
    setResults(hits);
    setLoading(false);
  }, []);

  // 打开即浏览（来源分组 → 组内文件/条目）
  useEffect(() => {
    void listKnowledge(50).then((hits) => {
      setResults(hits);
      setLoading(false);
    });
  }, []);

  // 条目样式：搜索命中条目与无 url 条目（案例）复用；
  // TDSF 魔改 2026-08-30: 中文预览标题主行 + 英文原标题副行（无映射只显示英文）
  const renderEntry = (hit: KnowledgeHit) => {
    const zh = hit.url ? titlesBySource.get(hit.source)?.get(hit.url) : undefined;
    return (
      <button
        key={hit.id}
        type="button"
        onClick={() =>
          setDetail(hit.url ? { docUrl: hit.url, hit } : { entryId: hit.id, hit })
        }
        className={cn(
          "block w-full rounded-lg border border-border/50 bg-card/40 px-2.5 py-2 text-left",
          "transition-colors hover:border-border hover:bg-muted/40",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="flex-1 truncate text-[11.5px] font-medium text-foreground">
            {zh ?? hit.title}
          </span>
          {hit.match_type && (
            <Badge
              variant="secondary"
              className="shrink-0 px-1 py-px text-[9px]"
            >
              {hit.match_type === "both"
                ? "混合"
                : hit.match_type === "fts"
                  ? "关键词"
                  : "语义"}
            </Badge>
          )}
        </div>
        {zh && (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">
            {hit.title}
          </div>
        )}
        {hit.url && (
          <div className="mt-1 flex items-center gap-1">
            <span className="rounded bg-muted px-1 py-px font-mono text-[9px] text-muted-foreground/80">
              {fileNameFromUrl(hit.url)}
            </span>
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* 隐藏的 md 文件选择 input（多选，仅 .md；WebView 下读内容传后端） */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".md,.markdown"
        className="hidden"
        onChange={(e) => void handleImportFiles(e)}
      />

      {/* 头部：标题 + 导入 md 按钮（TDSF 魔改 2026-08-30，个人语料手动导入入口） */}
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2">
        <HugeiconsIcon icon={BookOpen01Icon} size={13} strokeWidth={1.75} />
        {/* TDSF 魔改 2026-08-29: 视图标签中文化（推翻 2026-08-18 统一英文决策），与侧边栏一致 */}
        <span className="text-[11px] font-medium uppercase tracking-wide text-foreground">
          知识库
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 gap-1 px-1.5 text-[10.5px] text-muted-foreground hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
        >
          {importing ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={FileImportIcon} size={11} strokeWidth={1.75} />
          )}
          {importing ? "导入中…" : "导入 md"}
        </Button>
      </div>

      {/* 搜索区 */}
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2">
          <HugeiconsIcon
            icon={GlobalSearchIcon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search(query);
            }}
            placeholder="搜索命令/概念/案例…"
            className="h-6.5 border-0 bg-transparent px-0 py-1 text-[11px] shadow-none focus-visible:ring-0"
          />
        </div>
        <Button
          type="button"
          size="icon"
          className="size-6.5 shrink-0"
          onClick={() => void search(query)}
          disabled={loading || !query.trim()}
          aria-label="检索"
        >
          <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      {/* 列表区：浏览模式 = 来源分组 → 文件/条目；搜索模式 = 来源分组 → 命中条目 */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground">
            <Spinner className="size-3.5" />
            检索中…
          </div>
        )}
        {!loading && searched && results.length === 0 && (
          <div className="py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            未找到相关条目。
            <br />
            可导入文档或沉淀案例扩充知识库。
          </div>
        )}
        {!loading && !searched && results.length === 0 && (
          <div className="py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            知识库为空。
            <br />
            可导入文档或沉淀案例扩充知识库。
          </div>
        )}
        <div className="space-y-2.5">
          {groups.map((group) => {
            const isCollapsed = collapsedSources.has(group.source);
            return (
              <div key={group.source} className="space-y-1.5">
                {/* 分组头：来源中文名 + 条数 badge，可折叠 */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.source)}
                  aria-expanded={!isCollapsed}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/40"
                >
                  <HugeiconsIcon
                    icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                    size={11}
                    strokeWidth={2}
                    className="shrink-0 text-muted-foreground/70"
                  />
                  <span className="truncate text-[10.5px] font-semibold text-foreground/85">
                    {group.label}
                  </span>
                  <Badge
                    variant="secondary"
                    className="shrink-0 px-1 py-px text-[9px] tabular-nums"
                  >
                    {group.entries.length}
                  </Badge>
                </button>
                {!isCollapsed && (
                  <div className="space-y-1.5">
                    {searched ? (
                      // 搜索模式：按块命中的条目平铺（所属文件名在条目内显示）
                      group.entries.map(renderEntry)
                    ) : (
                      <>
                        {/* 浏览模式：含文档的组列文件级列表（懒加载） */}
                        {group.hasFiles && (
                          <SourceFileList
                            state={
                              filesBySource.get(group.source) ?? {
                                status: "loading",
                              }
                            }
                            titles={
                              titlesBySource.get(group.source) ?? new Map()
                            }
                            onOpenDoc={(url) => setDetail({ docUrl: url })}
                          />
                        )}
                        {/* 浏览模式：无 url 条目（案例）保持条目式 */}
                        {group.entries
                          .filter((e) => !e.url)
                          .map(renderEntry)}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 详情弹窗 */}
      <KnowledgeDetailDialog target={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

// ============================================================================
// KnowledgeDetailDialog — 详情弹窗
// 浏览模式点文件 / 搜索命中带 url → get_doc 完整文档（标题=filename，
// 头部「共 N 块 · 约 X 字」元信息，保留 streamdown heading 紧凑覆盖）；
// 无 url 条目（案例）→ knowledge.get 条目详情（原样式）。
// get_doc 失败（RPC 异常或 ok=false）→ 弹窗内错误提示（fail-closed）。
// ============================================================================

export function KnowledgeDetailDialog({
  target,
  onClose,
}: {
  target: DetailTarget | null;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<KnowledgeDoc | null>(null);
  const [entry, setEntry] = useState<KnowledgeHit | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setEntry(null);
    setError(null);
    if (!target) return;
    if (target.docUrl) {
      const url = target.docUrl;
      const cached = docCache.get(url);
      if (cached) {
        setDoc(cached);
        return;
      }
      setLoading(true);
      getKnowledgeDoc(url)
        .then((res) => {
          if (res?.ok && typeof res.content === "string") {
            docCache.set(url, res);
            setDoc(res);
          } else {
            setError(res?.error ?? "未知错误");
          }
        })
        .catch(() => setError("知识库服务暂不可用，请稍后重试"))
        .finally(() => setLoading(false));
      return;
    }
    if (target.entryId) {
      setLoading(true);
      void getKnowledge(target.entryId).then((e) => {
        setEntry(e);
        setLoading(false);
      });
    }
  }, [target]);

  const isDocMode = !!target?.docUrl;
  const titleText = isDocMode
    ? doc?.filename || fileNameFromUrl(target?.docUrl ?? "") || "完整文档"
    : "知识详情";

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[70vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-1 h-6 gap-1 px-1.5 text-[11px]"
              onClick={onClose}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} size={12} strokeWidth={1.75} />
              返回
            </Button>
            <HugeiconsIcon icon={BookOpen01Icon} size={15} strokeWidth={1.75} />
            <span className="truncate">{titleText}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              加载中…
            </div>
          )}
          {!loading && error && (
            <div className="py-8 text-center text-xs leading-relaxed text-muted-foreground">
              文档加载失败：{error}
              <br />
              请关闭后从列表重新打开该文档重试。
            </div>
          )}
          {!loading && !error && isDocMode && doc && (
            <div className="space-y-3">
              {doc.title && (
                <h2 className="text-[15px] font-semibold text-foreground">
                  {doc.title}
                </h2>
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {typeof doc.chunks === "number" && (
                  <Badge
                    variant="secondary"
                    className="px-1.5 py-px text-[10px] tabular-nums"
                  >
                    共 {doc.chunks} 块 · 约 {doc.total_chars ?? 0} 字
                  </Badge>
                )}
                {target?.hit && (
                  <Badge variant="outline" className="px-1.5 py-px text-[10px]">
                    来自搜索命中{hitSeqSuffix(target.hit.id)}
                  </Badge>
                )}
                {doc.source && (
                  <Badge
                    variant="secondary"
                    className="px-1.5 py-px text-[10px]"
                  >
                    {sourceGroupLabel(doc.source)}
                  </Badge>
                )}
              </div>
              {/* TDSF 魔改 2026-08-30: 中文摘要条（doc_titles_zh.summary_zh，
                  gen_titles_zh.py 离线 LLM 生成；无摘要不占位） */}
              {doc.summary_zh && (
                <div className="rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground/80">摘要：</span>
                  {doc.summary_zh}
                </div>
              )}
              {/* TDSF 魔改 2026-08-18: 完整 md 渲染（MessageResponse = Streamdown），
                  像看本地 md 文件一样滚动阅读。
                  TDSF 魔改 2026-08-29: 任意值子选择器覆盖 streamdown 内置大字号 heading，
                  知识文档标题改为紧凑层级。 */}
              <MessageResponse className="text-[12.5px] leading-relaxed [&_[data-streamdown=heading-1]]:mt-4 [&_[data-streamdown=heading-1]]:text-base [&_[data-streamdown=heading-1]]:font-semibold [&_[data-streamdown=heading-2]]:mt-3.5 [&_[data-streamdown=heading-2]]:text-[14.5px] [&_[data-streamdown=heading-2]]:font-semibold [&_[data-streamdown=heading-3]]:mt-3 [&_[data-streamdown=heading-3]]:text-[13.5px] [&_[data-streamdown=heading-3]]:font-semibold">
                {doc.content}
              </MessageResponse>
              {doc.url && (
                <div className="text-[10.5px] text-muted-foreground/60">
                  来源：{doc.url}
                </div>
              )}
            </div>
          )}
          {!loading && !error && !isDocMode && (
            <>
              {entry ? (
                <div className="space-y-3">
                  <h2 className="text-[15px] font-semibold text-foreground">
                    {entry.title}
                  </h2>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {entry.source && (
                      <Badge
                        variant="secondary"
                        className="px-1.5 py-px text-[10px]"
                      >
                        {entry.source}
                      </Badge>
                    )}
                    {entry.tags?.map((t) => (
                      <Badge
                        key={t}
                        variant="outline"
                        className="px-1.5 py-px text-[10px]"
                      >
                        {t}
                      </Badge>
                    ))}
                  </div>
                  <MessageResponse className="text-[12.5px] leading-relaxed [&_[data-streamdown=heading-1]]:mt-4 [&_[data-streamdown=heading-1]]:text-base [&_[data-streamdown=heading-1]]:font-semibold [&_[data-streamdown=heading-2]]:mt-3.5 [&_[data-streamdown=heading-2]]:text-[14.5px] [&_[data-streamdown=heading-2]]:font-semibold [&_[data-streamdown=heading-3]]:mt-3 [&_[data-streamdown=heading-3]]:text-[13.5px] [&_[data-streamdown=heading-3]]:font-semibold">
                    {entry.content}
                  </MessageResponse>
                  {entry.url && (
                    <div className="text-[10.5px] text-muted-foreground/60">
                      来源：{entry.url}
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  未获取到该条目的详情。
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// 向后兼容：KnowledgeBrowser（Dialog 外壳版，弃用建议用 KnowledgePanel）
// ============================================================================

export function KnowledgeBrowser({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <KnowledgePanel />
      </DialogContent>
    </Dialog>
  );
}
