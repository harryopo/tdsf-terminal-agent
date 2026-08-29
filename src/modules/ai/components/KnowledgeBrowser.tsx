/**
 * KnowledgeBrowser.tsx — 知识库浏览器（P2-4 可视化）
 * -----------------------------------------------------------------------------
 * 左侧栏「知识库」视图：搜索 + 结果列表（KnowledgePanel，内嵌面板），
 * 点击条目弹出详情（KnowledgeDetailDialog，md 渲染，像看本地 md 文件）。
 *
 * 数据链路：
 *   knowledge.search(query, limit) → 结果列表
 *   knowledge.get(id) → 单条详情（content 为 markdown，MessageResponse 渲染）
 *
 * 设计规范：UI 组件套（Input/Button/Badge/Dialog）+ Hugeicons
 * 图标，不使用 emoji。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  BookOpen01Icon,
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

// ============================================================================
// 来源分组（TDSF 魔改 2026-08-29: 按来源分组浏览，避免分块条目平铺）
// ============================================================================

/** source 原始值 → 中文组名；未知 source 原样显示 */
function sourceGroupLabel(source: string): string {
  if (source === "builtin-docs") return "内置教学文档";
  if (source === "builtin-corpus") return "内置命令卡片";
  if (source === "imported-docs") return "导入文档";
  if (source.startsWith("case-")) return "会话沉淀";
  if (source.endsWith("-docs")) {
    return `${source.slice(0, -"-docs".length)}文档`;
  }
  return source;
}

/** builtin-docs 条目的源 md 文件名（从 url 提取） */
function builtinDocFileName(url: string): string {
  if (!url) return "";
  const parts = url.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? "") : "";
}

type KnowledgeGroup = {
  /** 原始 source（作为折叠状态 key） */
  source: string;
  label: string;
  entries: KnowledgeHit[];
  /** builtin-docs 组按源 md 文件名二级分组；其他来源为 null（平铺） */
  fileGroups: { name: string; entries: KnowledgeHit[] }[] | null;
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
        fileGroups: hit.source === "builtin-docs" ? [] : null,
      };
      groups.set(hit.source, group);
    }
    group.entries.push(hit);
    if (group.fileGroups) {
      const name = builtinDocFileName(hit.url);
      const sub = group.fileGroups.find((g) => g.name === name);
      if (sub) sub.entries.push(hit);
      else group.fileGroups.push({ name, entries: [hit] });
    }
  }
  return [...groups.values()];
}

// ============================================================================
// RPC
// ============================================================================

async function searchKnowledge(
  query: string,
  limit = 30,
): Promise<KnowledgeHit[]> {
  try {
    const { invokeRpc } = await import("@/lib/sidecar-bridge");
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
    const { invokeRpc } = await import("@/lib/sidecar-bridge");
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
    const { invokeRpc } = await import("@/lib/sidecar-bridge");
    const res = await invokeRpc<{ results?: KnowledgeHit[] } | null>(
      "knowledge.list",
      { limit, offset: 0 },
    );
    return res?.results ?? [];
  } catch {
    return [];
  }
}

// ============================================================================
// KnowledgePanel — 左侧栏内嵌面板（搜索 + 列表）
// ============================================================================

export function KnowledgePanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // TDSF 魔改 2026-08-29: 可折叠分组（记录已折叠组的 source）
  const [collapsedSources, setCollapsedSources] = useState<Set<string>>(
    new Set(),
  );

  // 分组作用于当前搜索/过滤结果（保持首次出现顺序）
  const groups = useMemo(() => groupKnowledgeHits(results), [results]);

  const toggleGroup = useCallback((source: string) => {
    setCollapsedSources((prev) => {
      const next = new Set(prev);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return next;
    });
  }, []);

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

  // 打开即浏览（像文件列表：列出全部条目，点击查看 md）
  useEffect(() => {
    void listKnowledge(50).then((hits) => {
      setResults(hits);
      setLoading(false);
    });
  }, []);

  // 条目样式沿用原有 title/徽章行，组内与子分组复用
  const renderEntry = (hit: KnowledgeHit) => (
    <button
      key={hit.id}
      type="button"
      onClick={() => setDetailId(hit.id)}
      className={cn(
        "block w-full rounded-lg border border-border/50 bg-card/40 px-2.5 py-2 text-left",
        "transition-colors hover:border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-1 truncate text-[11.5px] font-medium text-foreground">
          {hit.title}
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
      {hit.source && (
        <div className="mt-1 flex items-center gap-1">
          <span className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground/80">
            {hit.source}
          </span>
        </div>
      )}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2">
        <HugeiconsIcon icon={BookOpen01Icon} size={13} strokeWidth={1.75} />
        {/* TDSF 魔改 2026-08-29: 视图标签中文化（推翻 2026-08-18 统一英文决策），与侧边栏一致 */}
        <span className="text-[11px] font-medium uppercase tracking-wide text-foreground">
          知识库
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          搜索/浏览教学语料
        </span>
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

      {/* 结果列表 */}
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
                    {group.fileGroups
                      ? // builtin-docs：按源 md 文件名显示组内小标题
                        group.fileGroups.map((fileGroup) => (
                          <div
                            key={fileGroup.name || "__ungrouped__"}
                            className="space-y-1.5"
                          >
                            {fileGroup.name && (
                              <div className="truncate px-1 text-[10px] font-medium text-muted-foreground/75">
                                {fileGroup.name}
                              </div>
                            )}
                            {fileGroup.entries.map(renderEntry)}
                          </div>
                        ))
                      : group.entries.map(renderEntry)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 详情弹窗 */}
      <KnowledgeDetailDialog
        detailId={detailId}
        onClose={() => setDetailId(null)}
      />
    </div>
  );
}

// ============================================================================
// KnowledgeDetailDialog — 详情弹窗（MessageResponse 渲染完整 md）
// ============================================================================

export function KnowledgeDetailDialog({
  detailId,
  onClose,
}: {
  detailId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<KnowledgeHit | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    void getKnowledge(detailId).then((entry) => {
      setDetail(entry);
      setLoading(false);
    });
  }, [detailId]);

  return (
    <Dialog open={!!detailId} onOpenChange={(o) => !o && onClose()}>
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
            知识详情
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              加载中…
            </div>
          )}
          {!loading && !detail && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              未获取到该条目的详情。
            </div>
          )}
          {!loading && detail && (
            <div className="space-y-3">
              <h2 className="text-[15px] font-semibold text-foreground">
                {detail.title}
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                {detail.source && (
                  <Badge variant="secondary" className="px-1.5 py-px text-[10px]">
                    {detail.source}
                  </Badge>
                )}
                {detail.tags?.map((t) => (
                  <Badge
                    key={t}
                    variant="outline"
                    className="px-1.5 py-px text-[10px]"
                  >
                    {t}
                  </Badge>
                ))}
              </div>
              {/* TDSF 魔改 2026-08-18: 完整 md 渲染（MessageResponse = Streamdown），
                  像看本地 md 文件一样滚动阅读。
                  TDSF 魔改 2026-08-29: 任意值子选择器覆盖 streamdown 内置大字号 heading，
                  知识文档（分块 md）标题改为紧凑层级。 */}
              <MessageResponse className="text-[12.5px] leading-relaxed [&_[data-streamdown=heading-1]]:mt-4 [&_[data-streamdown=heading-1]]:text-base [&_[data-streamdown=heading-1]]:font-semibold [&_[data-streamdown=heading-2]]:mt-3.5 [&_[data-streamdown=heading-2]]:text-[14.5px] [&_[data-streamdown=heading-2]]:font-semibold [&_[data-streamdown=heading-3]]:mt-3 [&_[data-streamdown=heading-3]]:text-[13.5px] [&_[data-streamdown=heading-3]]:font-semibold">
                {detail.content}
              </MessageResponse>
              {detail.url && (
                <div className="text-[10.5px] text-muted-foreground/60">
                  来源：{detail.url}
                </div>
              )}
            </div>
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
