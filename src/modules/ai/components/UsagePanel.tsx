import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatTokenCount,
  queryUsageSafely,
  summarizeUsageModels,
  trendPoints,
  USAGE_CHANGED_EVENT,
  type UsageFilters,
  type UsageQueryResult,
} from "../lib/usage";

const EMPTY_FILTERS: UsageFilters = { days: 90 };

export function UsagePanel({
  sessionId,
  compact = false,
  showFilters = false,
  loadUsage = queryUsageSafely,
}: {
  sessionId?: string;
  compact?: boolean;
  showFilters?: boolean;
  loadUsage?: typeof queryUsageSafely;
}) {
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [days, setDays] = useState(90);
  const [applied, setApplied] = useState<UsageFilters>(EMPTY_FILTERS);
  const [result, setResult] = useState<UsageQueryResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const effectiveFilters = useMemo<UsageFilters>(
    () => compact ? { sessionId, days: 90 } : applied,
    [applied, compact, sessionId],
  );

  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    return Promise.resolve()
      .then(() => loadUsage(effectiveFilters))
      .then((outcome) => {
        if (current !== generation.current) return;
        setResult(outcome.data);
        if (outcome.error) setError(outcome.error);
      })
      .catch((reason: unknown) => {
        if (current === generation.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setResult(null);
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  }, [effectiveFilters, loadUsage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const listener = (event: Event) => {
      const changed = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!compact || !sessionId || changed === sessionId) void reload();
    };
    window.addEventListener(USAGE_CHANGED_EVENT, listener);
    return () => window.removeEventListener(USAGE_CHANGED_EVENT, listener);
  }, [compact, reload, sessionId]);

  const summary = result?.summary;
  const points = trendPoints(result?.trend ?? []);
  const models = summarizeUsageModels(result?.events ?? []);
  const latest = result?.events[0];
  const cacheRate = summary && summary.input_tokens !== null && summary.input_tokens > 0 && summary.cached_input_tokens !== null
    ? `${Math.round((summary.cached_input_tokens / summary.input_tokens) * 100)}%`
    : "—";
  const unknownUsageCount = summary?.unknown_usage_count ?? 0;
  const cancelledCount = summary?.cancelled_count ?? 0;
  const failedCount = summary?.failed_count ?? 0;

  const content = (
    <div className="flex flex-col gap-3">
      {loading && <p className="text-[11px] text-muted-foreground">正在读取实报用量…</p>}
      {error && <p role="alert" className="text-[11px] text-destructive">用量读取失败：{error}</p>}
      {!loading && !error && summary?.event_count === 0 && (
        <p className="text-[11px] text-muted-foreground">尚无实报；未知不会按 0 计入。</p>
      )}
      {summary && summary.event_count > 0 && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="用量事件" value={formatTokenCount(summary.event_count)} />
            <Metric label="含实报事件" value={formatTokenCount(summary.reported_event_count ?? summary.event_count)} />
            <Metric label="输入" value={formatTokenCount(summary.input_tokens)} />
            <Metric label="输出" value={formatTokenCount(summary.output_tokens)} />
            <Metric label="Provider 总量" value={formatTokenCount(summary.total_tokens)} />
            <Metric label="缓存读取" value={formatTokenCount(summary.cached_input_tokens)} />
            <Metric label="缓存写入" value={formatTokenCount(summary.cache_creation_input_tokens)} />
            <Metric label="思考（输出子集）" value={formatTokenCount(summary.reasoning_tokens)} />
            <Metric label="缓存命中率" value={cacheRate} />
          </div>
          {unknownUsageCount > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {unknownUsageCount} 个事件没有Provider用量回执，按未知保留，不计为0。
              {cancelledCount > 0 ? ` 取消 ${cancelledCount} 个。` : ""}
              {failedCount > 0 ? ` 失败/降级 ${failedCount} 个。` : ""}
            </p>
          )}
          {points && (
            <svg viewBox="0 0 100 100" className="h-16 w-full text-foreground/60" role="img" aria-label="输入 Token 趋势；仅绘制已知数据">
              <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {models.length > 0 && (
            <div className="space-y-1">
              {models.map((row) => (
                <div key={row.model} className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="truncate font-mono">{row.model}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {row.event_count} 次 · 入 {formatTokenCount(row.input_tokens)} · 出 {formatTokenCount(row.output_tokens)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {latest && (
            <p className="text-[10.5px] text-muted-foreground">
              最近状态 {latest.status} · {latest.granularity === "invocation_aggregate" ? "回合聚合" : "逐调用"} · 配置快照 {latest.config_snapshot_id ?? "—"}
            </p>
          )}
        </>
      )}
      <p className="text-[10px] text-muted-foreground">实报不是费用账单；账本不自动删除，近 {compact ? 90 : applied.days ?? 90} 天仅为查询范围。</p>
    </div>
  );

  const filterForm = showFilters && (
    <form
      className="mb-3 grid gap-2 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        setApplied({
          provider: provider.trim() || undefined,
          model: model.trim() || undefined,
          sessionId: sessionFilter.trim() || undefined,
          days,
        });
      }}
    >
      <input aria-label="Provider 筛选" placeholder="Provider" value={provider} onChange={(event) => setProvider(event.target.value)} className="h-8 rounded-md border border-border/60 bg-background px-2 text-[11px]" />
      <input aria-label="模型筛选" placeholder="模型" value={model} onChange={(event) => setModel(event.target.value)} className="h-8 rounded-md border border-border/60 bg-background px-2 text-[11px]" />
      <input aria-label="会话筛选" placeholder="会话 ID" value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)} className="h-8 rounded-md border border-border/60 bg-background px-2 text-[11px]" />
      <div className="flex gap-2">
        <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
          <SelectTrigger aria-label="查询天数" className="h-8 min-w-0 flex-1 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 天</SelectItem>
            <SelectItem value="30">30 天</SelectItem>
            <SelectItem value="90">90 天</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" variant="outline">筛选</Button>
      </div>
    </form>
  );

  if (compact) {
    return (
      <details className="shrink-0 border-b border-border/40 px-3 py-1.5 text-[11px]">
        <summary className="cursor-pointer select-none text-muted-foreground">
          会话实报{summary ? ` · ${summary.event_count} 次` : ""}
        </summary>
        <div className="pt-2">{content}</div>
      </details>
    );
  }
  return (
    <section aria-labelledby="usage-panel-title" className="rounded-lg border border-border/60 bg-card/60 p-3">
      <h2 id="usage-panel-title" className="mb-3 text-[13px] font-medium">模型用量</h2>
      {filterForm}
      {content}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/35 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-[12px]">{value}</div>
    </div>
  );
}