/**
 * KnowledgeBrowser.tsx — 知识库浏览器（P2-4 可视化）
 * -----------------------------------------------------------------------------
 * 弹窗式知识库：搜索 + 结果列表 + 详情（md 渲染，像看本地 md 文件）。
 *
 * 数据链路：
 *   knowledge.search(query, limit) → 结果列表
 *   knowledge.get(id) → 单条详情（content 为 markdown，MessageResponse 渲染）
 *
 * 设计规范：UI 组件套（Dialog/Input/Button/Badge/Separator）+ Hugeicons
 * 图标，不使用 emoji。
 */

import { useCallback, useEffect, useRef, useState } from "react";
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
import { MessageResponse } from "@/components/ai-elements/message";

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
  limit = 20,
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

// ============================================================================
// 组件
// ============================================================================

export function KnowledgeBrowser({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeHit | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const search = useCallback(async (q: string) => {
    const keyword = q.trim();
    if (!keyword) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    const hits = await searchKnowledge(keyword);
    setResults(hits);
    setLoading(false);
  }, []);

  // 打开时若已有 query 自动搜索
  const didInit = useRef(false);
  useEffect(() => {
    if (open && !didInit.current) {
      didInit.current = true;
      void search(query);
    }
    if (!open) {
      setDetailId(null);
      setDetail(null);
    }
  }, [open, search, query]);

  // 详情加载
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    void getKnowledge(detailId).then((entry) => {
      setDetail(entry);
      setDetailLoading(false);
    });
  }, [detailId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <HugeiconsIcon icon={BookOpen01Icon} size={15} strokeWidth={1.75} />
            知识库
            {detail && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-1 h-6 gap-1 px-1.5 text-[11px]"
                onClick={() => setDetailId(null)}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={12} strokeWidth={1.75} />
                返回
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>

        {!detail ? (
          <>
            {/* 搜索区 */}
            <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2.5">
              <div className="flex flex-1 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5">
                <HugeiconsIcon
                  icon={GlobalSearchIcon}
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0 text-muted-foreground"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void search(query);
                  }}
                  placeholder="搜索 Linux 命令 / 概念 / 排障案例…"
                  className="h-7 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                />
              </div>
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5 px-3 text-[11px]"
                onClick={() => void search(query)}
                disabled={loading || !query.trim()}
              >
                <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={1.75} />
                检索
              </Button>
            </div>

            {/* 结果列表 */}
            <div className="flex-1 overflow-y-auto p-3">
              {loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  检索中…
                </div>
              )}
              {!loading && searched && results.length === 0 && (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  未找到相关条目，可尝试其他关键词，或导入文档扩充知识库。
                </div>
              )}
              {!loading && !searched && (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  输入关键词检索内置教学知识库（命令/概念/哲学/排障案例）。
                </div>
              )}
              <div className="space-y-1.5">
                {results.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => setDetailId(hit.id)}
                    className={cn(
                      "block w-full rounded-lg border border-border/50 bg-card/40 px-3 py-2 text-left",
                      "transition-colors hover:border-border hover:bg-muted/40",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span className="flex-1 truncate text-[12px] font-medium text-foreground">
                        {hit.title}
                      </span>
                      {hit.match_type && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 px-1 py-px text-[9.5px]"
                        >
                          {hit.match_type === "both"
                            ? "混合"
                            : hit.match_type === "fts"
                              ? "关键词"
                              : "语义"}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {hit.content}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      {hit.source && (
                        <span className="rounded bg-muted px-1 py-px text-[9.5px] text-muted-foreground/80">
                          {hit.source}
                        </span>
                      )}
                      {hit.tags?.slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="rounded bg-muted/60 px-1 py-px text-[9.5px] text-muted-foreground/70"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          /* 详情视图（md 渲染，像看本地 md 文件） */
          <div className="flex-1 overflow-y-auto p-4">
            {detailLoading && (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                加载中…
              </div>
            )}
            {!detailLoading && detail && (
              <article className="not-prose">
                <h2 className="mb-1 text-[15px] font-semibold text-foreground">
                  {detail.title}
                </h2>
                <div className="mb-3 flex items-center gap-1.5">
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
                <Separator className="mb-3" />
                <div className="text-[12.5px] leading-relaxed text-muted-foreground">
                  <MessageResponse>{detail.content}</MessageResponse>
                </div>
                {detail.url && (
                  <div className="mt-3 text-[10.5px] text-muted-foreground/60">
                    来源：{detail.url}
                  </div>
                )}
              </article>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
