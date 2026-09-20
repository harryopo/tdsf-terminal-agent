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
import { SectionHeader } from "../components/SectionHeader";

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

/** 日志级别 → 徽标配色 */
const LEVEL_META: Record<string, { badge: string }> = {
  DEBUG: { badge: "bg-muted text-muted-foreground" },
  INFO: { badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  WARNING: { badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  ERROR: { badge: "bg-red-500/15 text-red-600 dark:text-red-400" },
  CRITICAL: { badge: "bg-red-600/25 text-red-700 dark:text-red-300" },
};

const LEVEL_FILTERS = ["ALL", "DEBUG", "INFO", "WARNING+", "ERROR", "CRITICAL"];

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
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { lines: 300 };
      if (levelFilter !== "ALL") params.level_filter = levelFilter;
      const res = await invokeRpc<LogTailResponse>("log.tail", params);
      if (res.ok === false) {
        setError(res.error ?? "读取日志失败");
        setLines([]);
      } else {
        // 按 ts 升序（旧→新，终端风格），无论后端返回顺序
        const sorted = [...(res.lines ?? [])].sort(
          (a, b) => (a.ts ?? 0) - (b.ts ?? 0),
        );
        setLines(sorted);
        setTotal(res.total ?? sorted.length);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [levelFilter]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void load();
  }, [load]);

  // 自动刷新（2s 轮询）
  useEffect(() => {
    if (!autoRefresh || !isTauriRuntime()) return;
    const t = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(t);
  }, [autoRefresh, load]);

  // 加载后滚到底（看最新）
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const clearLogs = useCallback(async () => {
    try {
      await invokeRpc("log.clear", {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="运行日志"
        description="后端 Python 引擎（sidecar）运行日志，便于检查检测与开发调试。数据源：内存环形缓冲（最近 5000 行），经 log.tail 读取。"
      />

      {!isTauriRuntime() ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 text-center text-[12px] text-muted-foreground">
          运行日志仅在桌面模式可用（需 Tauri 运行时连接 sidecar）
        </div>
      ) : (
        <>
          {/* 控制栏 */}
          <div className="flex items-center gap-2">
            <Select value={levelFilter} onValueChange={setLevelFilter}>
              <SelectTrigger className="h-8 w-32 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVEL_FILTERS.map((lv) => (
                  <SelectItem key={lv} value={lv}>
                    {lv}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={() => void load()}
              disabled={loading}
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
            >
              清空
            </Button>

            <span className="ml-auto text-[11px] text-muted-foreground">
              {lines.length} 行{total ? ` / 缓冲 ${total}` : ""}
            </span>
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-[11px] break-all text-destructive/90">
              {error}
            </div>
          ) : null}

          {/* 日志行 */}
          <div className="rounded-xl border border-border/60 bg-card/40">
            {lines.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-muted-foreground">
                {loading ? "加载中…" : "暂无日志"}
              </div>
            ) : (
              <div
                ref={scrollRef}
                className="max-h-[52vh] overflow-y-auto font-mono"
              >
                {lines.map((line, i) => {
                  const lm = LEVEL_META[line.level ?? ""] ?? {
                    badge: "bg-muted text-muted-foreground",
                  };
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 border-b border-border/30 px-3 py-1 text-[11px] last:border-b-0"
                    >
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {formatTs(line.ts)}
                      </span>
                      <span
                        className={cn(
                          "w-16 shrink-0 rounded px-1 text-center text-[10px]",
                          lm.badge,
                        )}
                      >
                        {line.level ?? "?"}
                      </span>
                      <span
                        className="max-w-[200px] shrink-0 truncate text-muted-foreground"
                        title={line.logger}
                      >
                        {line.logger ?? ""}
                      </span>
                      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground">
                        {line.msg ?? ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
