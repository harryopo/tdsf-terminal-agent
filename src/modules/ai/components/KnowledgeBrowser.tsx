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
 * 设计规范：UI 组件套（Input/Button/Badge/Separator/Dialog）+ Hugeicons
 * 图标，不使用 emoji。
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ArrowLeft01Icon,
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

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2">
        <HugeiconsIcon icon={BookOpen01Icon} size={13} strokeWidth={1.75} />
        <span className="text-[11px] font-medium text-foreground">知识库</span>
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
        <div className="space-y-1.5">
          {results.map((hit) => (
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
              <div className="mt-0.5 line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
                {hit.content}
              </div>
              {hit.source && (
                <div className="mt-1 flex items-center gap-1">
                  <span className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground/80">
                    {hit.source}
                  </span>
                </div>
              )}
            </button>
          ))}
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
// 概述工具：剥离 markdown 语法符号，提取前几行非标题内容作为简单概述
// （详情弹窗只展示概述，不渲染完整 md——用户要求 UI 简单）
// ============================================================================

function toSummary(content: string, maxLines = 3): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.replace(/[#*_`>~|[]()]/g, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, maxLines);
}

// ============================================================================
// KnowledgeDetailDialog — 详情弹窗（简单概述卡片，2026-08-15 改版）
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
      <DialogContent className="flex h-[70vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
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
            /* 简单概述卡片：标题 + 来源/标签 + 概述（不渲染完整 md） */
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
              <Separator className="mb-1" />
              <div className="text-[12.5px] leading-relaxed text-muted-foreground">
                {toSummary(detail.content).map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
                {toSummary(detail.content).length === 0 && (
                  <p className="italic">（无概述内容）</p>
                )}
              </div>
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
