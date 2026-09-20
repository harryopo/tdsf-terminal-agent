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
import { useCallback, useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

// ============================================================================
// 对话历史面板（B2 2026-09-03 用户钦定：后端 Agent 流水可视化，便于追溯）
// ============================================================================
// 数据源：sidecar agent-logs/<session_id>.jsonl，经 debug.agent_log_tail RPC 读取。
// 后端已就绪（agent_log.py list_sessions/tail），本组件是缺失的前端界面。

type LogLine = {
  ts?: string | number;
  type?: string;
  content?: unknown;
  meta?: Record<string, unknown>;
};

type SessionFile = {
  session_id: string;
  file: string;
  size: number;
  mtime: number;
};

type TailResponse = {
  ok?: boolean;
  files?: SessionFile[];
  latest_session_id?: string;
  lines?: LogLine[];
  returned?: number;
  total_in_file?: number;
  error?: string;
};

/** 事件类型 → 中文标签 + 徽标配色（10 类，见 agent_log.py 类型全集） */
const EVENT_TYPE_META: Record<string, { label: string; badge: string }> = {
  user_msg: { label: "用户", badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  env_inject: { label: "环境注入", badge: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400" },
  assistant_msg: { label: "回答", badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  reasoning: { label: "思考", badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  tool_call: { label: "工具调用", badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  tool_result: { label: "工具结果", badge: "bg-amber-500/10 text-amber-700/80 dark:text-amber-400/80" },
  loop_progress: { label: "回合", badge: "bg-muted text-muted-foreground" },
  todo_followup: { label: "待办追踪", badge: "bg-muted text-muted-foreground" },
  verify_followup: { label: "写后验证", badge: "bg-emerald-500/10 text-emerald-700/80 dark:text-emerald-400/80" },
  watchdog_timeout: { label: "超时熔断", badge: "bg-red-500/15 text-red-600 dark:text-red-400" },
};

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部事件" },
  { value: "user_msg", label: "用户输入" },
  { value: "assistant_msg", label: "AI 回答" },
  { value: "reasoning", label: "思考" },
  { value: "tool_call", label: "工具调用" },
  { value: "tool_result", label: "工具结果" },
  { value: "env_inject", label: "环境注入" },
  { value: "verify_followup", label: "写后验证" },
];

function formatTs(ts: string | number | undefined): string {
  if (ts == null) return "--:--:--";
  const d = new Date(typeof ts === "number" ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(11, 19) || "--:--:--";
  return d.toTimeString().slice(0, 8);
}

function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content, null, 0);
  } catch {
    return String(content);
  }
}

export function AgentHistorySection() {
  const [sessions, setSessions] = useState<SessionFile[]>([]);
  const [activeSession, setActiveSession] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await invokeRpc<TailResponse>("debug.agent_log_tail", {
        lines: 1,
      });
      setSessions(res.files ?? []);
      setActiveSession((prev) => prev || res.latest_session_id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLines = useCallback(async () => {
    if (!activeSession) {
      setLines([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, unknown> = {
        session_id: activeSession,
        lines: 200,
      };
      if (typeFilter) params.type = typeFilter;
      const res = await invokeRpc<TailResponse>("debug.agent_log_tail", params);
      setLines(res.lines ?? []);
      setTotal(res.total_in_file ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeSession, typeFilter]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void loadLines();
  }, [loadLines]);

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="对话历史"
        description="后端 Agent 流水（用户输入 / 环境注入 / 思考 / 工具调用 / 回答），便于追溯每一轮对话的完整链路。数据源 agent-logs/*.jsonl。"
      />

      {!isTauriRuntime() ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 text-center text-[12px] text-muted-foreground">
          对话历史仅在桌面模式可用（需 Tauri 运行时读取后端流水）
        </div>
      ) : (
        <>
          {/* 控制栏：会话选择 + 事件过滤 + 刷新 */}
          <div className="flex items-center gap-2">
            <Select value={activeSession} onValueChange={setActiveSession}>
              <SelectTrigger className="h-8 w-56 text-[12px]">
                <SelectValue placeholder="选择会话" />
              </SelectTrigger>
              <SelectContent>
                {sessions.length === 0 ? (
                  <SelectItem value="__empty" disabled>
                    暂无会话流水
                  </SelectItem>
                ) : (
                  sessions.map((s) => (
                    <SelectItem key={s.session_id} value={s.session_id}>
                      {s.session_id.slice(0, 12)}…（{Math.round(s.size / 1024)}KB）
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 w-32 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_FILTERS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              onClick={() => {
                void loadSessions();
                void loadLines();
              }}
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

            <span className="ml-auto text-[11px] text-muted-foreground">
              {lines.length} 条{total ? ` / 共 ${total}` : ""}
            </span>
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-[11px] break-all text-destructive/90">
              {error}
            </div>
          ) : null}

          {/* 时间线 */}
          <div className="flex flex-col rounded-xl border border-border/60 bg-card/40">
            {lines.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-muted-foreground">
                {loading ? "加载中…" : "暂无流水记录"}
              </div>
            ) : (
              <div className="max-h-[52vh] overflow-y-auto">
                {lines.map((line, i) => {
                  const meta = EVENT_TYPE_META[line.type ?? ""] ?? {
                    label: line.type ?? "?",
                    badge: "bg-muted text-muted-foreground",
                  };
                  const toolName =
                    line.meta && typeof line.meta.tool_name === "string"
                      ? line.meta.tool_name
                      : null;
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 border-b border-border/40 px-3 py-1.5 last:border-b-0"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                        {formatTs(line.ts)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          meta.badge,
                        )}
                      >
                        {meta.label}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] break-words whitespace-pre-wrap text-foreground">
                          {contentToText(line.content) || "（空）"}
                        </div>
                        {toolName ? (
                          <div className="font-mono text-[10px] text-muted-foreground">
                            {toolName}
                          </div>
                        ) : null}
                      </div>
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
