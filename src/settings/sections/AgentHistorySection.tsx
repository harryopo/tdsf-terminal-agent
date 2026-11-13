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

// ============================================================================
// 对话历史面板（B2 2026-09-03 用户钦定：后端 Agent 流水可视化，便于追溯）
// ============================================================================
// 数据源：sidecar agent-logs/<session_id>.jsonl，经 debug.agent_log_tail RPC 读取。
// 后端已就绪（agent_log.py list_sessions/tail），本组件是缺失的前端界面。

type LogLine = {
  event_id?: string;
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
  session_id?: string;
  files?: SessionFile[];
  latest_session_id?: string;
  lines?: LogLine[];
  returned?: number;
  total_in_file?: number;
  error?: string;
};

/** Journal labels; diagnostic outcomes are not inferred from event types. */
const EVENT_TYPE_META: Record<string, string> = {
  user_msg: "用户",
  env_inject: "环境注入",
  assistant_msg: "回答",
  reasoning: "思考",
  tool_call: "工具调用",
  tool_result: "工具结果",
  loop_progress: "回合",
  todo_followup: "待办追踪",
  verify_followup: "写后验证",
  watchdog_timeout: "超时熔断",
};

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "__all", label: "全部事件" },
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

export function AgentHistorySection() {
  const [sessions, setSessions] = useState<SessionFile[]>([]);
  const [activeSession, setActiveSession] = useState("");
  const [typeFilter, setTypeFilter] = useState("__all");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [lineLoading, setLineLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const listVersion = useRef(0);
  const lineVersion = useRef(0);
  const pendingLines = useRef<string | null>(null);
  const displayedKey = useRef("");
  const mounted = useRef(true);
  const selection = useRef("");
  const key = JSON.stringify([activeSession, typeFilter]);
  selection.current = key;
  const loading = listLoading || lineLoading;
  const error = listError || lineError;

  const loadSessions = useCallback(async () => {
    const version = ++listVersion.current;
    setListLoading(true);
    setListError(null);
    try {
      const res = await invokeRpc<TailResponse>("debug.agent_log_tail", {
        lines: 1,
      });
      if (!mounted.current || version !== listVersion.current) return;
      if (res.ok !== true || !Array.isArray(res.files))
        throw new Error(res.error || "读取会话列表失败");
      const files = res.files;
      setSessions(files);
      setActiveSession((prev) =>
        files.some((f) => f.session_id === prev)
          ? prev
          : files.find((f) => f.session_id === res.latest_session_id)
              ?.session_id ||
            files[0]?.session_id ||
            "",
      );
    } catch (e) {
      if (mounted.current && version === listVersion.current)
        setListError(
          diagnosticText(e instanceof Error ? e.message : String(e)),
        );
    } finally {
      if (mounted.current && version === listVersion.current)
        setListLoading(false);
    }
  }, []);

  const loadLines = useCallback(async () => {
    if (selection.current !== key || pendingLines.current === key) return;
    const version = ++lineVersion.current;
    if (!activeSession) {
      pendingLines.current = null;
      setLines([]);
      setTotal(0);
      setLineLoading(false);
      setLineError(null);
      return;
    }
    pendingLines.current = key;
    if (displayedKey.current !== key) {
      setLines([]);
      setTotal(0);
    }
    displayedKey.current = key;
    setLineLoading(true);
    setLineError(null);
    const current = () =>
      mounted.current &&
      selection.current === key &&
      version === lineVersion.current;
    try {
      const params: Record<string, unknown> = {
        session_id: activeSession,
        lines: 200,
      };
      if (typeFilter !== "__all") params.type = typeFilter;
      const res = await invokeRpc<TailResponse>("debug.agent_log_tail", params);
      if (!current()) return;
      if (
        res.ok !== true ||
        !Array.isArray(res.lines) ||
        (res.session_id !== undefined && res.session_id !== activeSession)
      )
        throw new Error(res.error || "流水读取失败或会话不匹配");
      setLines(res.lines);
      setTotal(res.total_in_file ?? 0);
    } catch (e) {
      if (current()) {
        setLineError(
          diagnosticText(e instanceof Error ? e.message : String(e)),
        );
        setLines([]);
        setTotal(0);
      }
    } finally {
      if (current()) {
        pendingLines.current = null;
        setLineLoading(false);
      }
    }
  }, [activeSession, typeFilter, key]);

  useEffect(() => {
    const listCounter = listVersion;
    const lineCounter = lineVersion;
    mounted.current = true;
    return () => {
      mounted.current = false;
      listCounter.current++;
      lineCounter.current++;
      pendingLines.current = null;
    };
  }, []);
  useEffect(() => {
    if (isTauriRuntime()) void loadSessions();
  }, [loadSessions]);
  useEffect(() => {
    if (isTauriRuntime()) void loadLines();
  }, [loadLines]);

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title="对话历史"
        description="按会话追溯输入、回答与工具调用。每次读取最近 200 条流水，详情已脱敏；不代表完整归档。"
      />

      {!isTauriRuntime() ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 text-center text-[12px] text-muted-foreground">
          对话历史仅在桌面模式可用（需 Tauri 运行时读取后端流水）
        </div>
      ) : (
        <>
          {/* 控制栏：会话选择 + 事件过滤 + 刷新 */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-card p-3">
            <Select value={activeSession} onValueChange={setActiveSession}>
              <SelectTrigger
                aria-label="选择会话"
                className="h-8 max-w-full w-56 text-[12px]"
              >
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
                      {s.session_id.slice(0, 12)}…（{Math.round(s.size / 1024)}
                      KB）
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>

            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger
                aria-label="事件类型"
                className="h-8 w-32 text-[12px]"
              >
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
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-[11px] break-all text-destructive/90"
            >
              {error}
            </div>
          ) : null}

          {/* 时间线 */}
          <div className="flex flex-col rounded-xl border border-border/60 bg-card p-3">
            {lines.length === 0 ? (
              <div className="p-6 text-center text-[12px] text-muted-foreground">
                {loading ? "加载中…" : "暂无流水记录"}
              </div>
            ) : (
              <div className="max-h-[52vh] overflow-y-auto">
                {lines.map((line, i) => (
                  <LogRecord
                    key={line.event_id || i}
                    time={formatTs(line.ts)}
                    label={
                      EVENT_TYPE_META[line.type ?? ""] ||
                      line.type ||
                      "未知事件"
                    }
                    source={
                      typeof line.meta?.tool_name === "string"
                        ? diagnosticText(line.meta.tool_name)
                        : undefined
                    }
                    text={diagnosticText(line.content)}
                    detail={
                      line.meta && Object.keys(line.meta).length
                        ? diagnosticText(line.meta)
                        : undefined
                    }
                    critical={line.type === "watchdog_timeout"}
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
