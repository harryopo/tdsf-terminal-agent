import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { invokeRpc } from "@/lib/sidecar-bridge";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { diagnosticText } from "@/modules/ai/lib/sessionDiagnostics";
import { LogRecord } from "../components/LogRecord";
import { SectionHeader } from "../components/SectionHeader";
import { LEVEL_FILTER_LABEL, LEVEL_FILTERS } from "../lib/runtimeLogLevels";

// ============================================================================
// 运行日志面板（B3 2026-09-03 用户钦定：后端日志可视化，方便检查检测与开发）
// ============================================================================
// 数据源：sidecar 内存 ringbuffer（core/log_capture.py），经 log.tail RPC 读取。
// 每条日志 {ts, level, logger, msg}；level_filter 支持 ALL/DEBUG/INFO/WARNING+/ERROR/CRITICAL。

type LogEntry = {
  ts?: number;
  level?: string;
  logger?: string;
  msg?: string;
};

type LogTailResponse = {
  ok?: boolean;
  lines?: LogEntry[];
  returned?: number;
  total?: number;
  error?: string;
};

// 协议值与界面标签的唯一主人在 `../lib/runtimeLogLevels.ts`
// （拆出去有两个原因：值不许被"顺手翻译"、而组件文件导出常量会破 react-refresh 边界）

function formatTs(ts: number | undefined): string {
  if (ts == null) return "--:--:--";
  const d = new Date(ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toTimeString().slice(0, 8);
}

export function RuntimeLogsSection() {
  const [levelFilter, setLevelFilter] = useState("ALL");
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const pending = useRef<{ key: string; version: number } | null>(null);
  const displayedFilter = useRef("");
  const selectedFilter = useRef(levelFilter);
  selectedFilter.current = levelFilter;
  const mounted = useRef(true);
  const clearPending = useRef(false);

  const load = useCallback(async () => {
    if (
      selectedFilter.current !== levelFilter ||
      pending.current?.key === levelFilter
    )
      return;
    if (displayedFilter.current !== levelFilter) {
      setLines([]);
      setTotal(0);
    }
    displayedFilter.current = levelFilter;
    if (clearPending.current) return;
    const version = ++requestVersion.current;
    pending.current = { key: levelFilter, version };
    setLoading(true);
    setError(null);
    const current = () =>
      mounted.current &&
      selectedFilter.current === levelFilter &&
      version === requestVersion.current;
    try {
      const params: Record<string, unknown> = { lines: 300 };
      if (levelFilter !== "ALL") params.level_filter = levelFilter;
      const res = await invokeRpc<LogTailResponse>("log.tail", params);
      if (!current()) return;
      if (res.ok !== true || !Array.isArray(res.lines))
        throw new Error(res.error || "读取日志失败");
      const sorted = [...res.lines].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      setLines(sorted);
      setTotal(res.total ?? sorted.length);
    } catch (e) {
      if (current()) {
        setError(diagnosticText(e instanceof Error ? e.message : String(e)));
        setLines([]);
        setTotal(0);
      }
    } finally {
      if (current()) {
        pending.current = null;
        setLoading(false);
      }
    }
  }, [levelFilter]);

  useEffect(() => {
    const counter = requestVersion;
    mounted.current = true;
    return () => {
      mounted.current = false;
      counter.current++;
      pending.current = null;
    };
  }, []);
  useEffect(() => {
    if (isTauriRuntime()) void load();
  }, [load, refreshRevision]);
  useEffect(() => {
    if (!autoRefresh || !isTauriRuntime()) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [autoRefresh, load]);
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  const clearLogs = useCallback(async () => {
    if (clearPending.current) return;
    clearPending.current = true;
    requestVersion.current++;
    pending.current = null;
    setClearing(true);
    setLoading(false);
    setError(null);
    try {
      const res = await invokeRpc<{ ok?: boolean; error?: string }>(
        "log.clear",
        {},
      );
      if (!mounted.current) return;
      if (res.ok !== true) throw new Error(res.error || "清空日志失败");
      setLines([]);
      setTotal(0);
      setRefreshRevision((v) => v + 1);
    } catch (e) {
      if (mounted.current)
        setError(diagnosticText(e instanceof Error ? e.message : String(e)));
    } finally {
      clearPending.current = false;
      if (mounted.current) setClearing(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="运行日志"
        description="查看后端运行情况与错误。每次读取最近 300 行内存日志；它与按会话保存的对话流水独立。"
      />

      {!isTauriRuntime() ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 text-center text-[12px] text-muted-foreground">
          运行日志仅在桌面模式可用（需 Tauri 运行时连接 sidecar）
        </div>
      ) : (
        <>
          {/* 控制栏 */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card p-3">
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger
                aria-label="日志级别"
                className="h-8 w-32 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVEL_FILTERS.map((lv) => (
                  <SelectItem key={lv} value={lv}>
                    {LEVEL_FILTER_LABEL[lv] ?? lv}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={() => void load()}
              disabled={loading || clearing}
            >
              <HugeiconsIcon
                icon={RefreshIcon}
                size={12}
                strokeWidth={1.75}
                className={cn(loading && "animate-spin")}
              />
              刷新
            </Button>

            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              className="h-8 px-2.5 text-xs"
              onClick={() => setAutoRefresh((v) => !v)}
            >
              自动刷新：{autoRefresh ? "开" : "关"}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2.5 text-xs text-destructive/80 hover:text-destructive"
              onClick={() => void clearLogs()}
              disabled={clearing}
            >
              {clearing ? "清空中…" : "清空"}
            </Button>

            <span className="ml-auto text-[11px] text-muted-foreground">
              {lines.length} 行{total ? ` / 缓冲 ${total}` : ""}
            </span>
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-[11px] break-all text-destructive/90"
            >
              {error}
            </div>
          ) : null}

          {/* 日志行 */}
          <div className="rounded-xl border border-border/60 bg-card p-3">
            {lines.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-muted-foreground">
                {loading ? "加载中…" : "暂无日志"}
              </div>
            ) : (
              <div
                ref={scrollRef}
                className="max-h-[52vh] overflow-y-auto font-mono"
              >
                {lines.map((line, i) => (
                  <LogRecord
                    key={i}
                    time={formatTs(line.ts)}
                    label={line.level || "未知级别"}
                    source={
                      line.logger ? diagnosticText(line.logger) : undefined
                    }
                    text={diagnosticText(line.msg)}
                    critical={
                      line.level === "ERROR" || line.level === "CRITICAL"
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
