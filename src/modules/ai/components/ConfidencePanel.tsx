import { useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  Cancel01Icon,
  Download01Icon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { evidenceLabel, evidenceTime } from "../lib/evidence";
import {
  buildDiagnosticSnapshot,
  conversationSnapshot,
  diagnosticText,
  exportDiagnosticSnapshot,
  fetchSessionDiagnostics,
  RUN_EVENT_LABELS,
  type SessionDiagnostics,
} from "../lib/sessionDiagnostics";

type View = "flow" | "conversation" | "evidence";
type Row = {
  id: string;
  title: string;
  time?: number;
  summary: string;
  body: string;
  details: unknown;
  fields?: [string, unknown][];
  callId?: string;
  note?: string;
};

/** An inspection surface, independent of Agent execution and approval controls. */
export function ConfidencePanel({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: UIMessage[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="ml-auto h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          title="查看当前对话的运行记录与工具证据"
        >
          <HugeiconsIcon icon={Activity01Icon} size={13} />
          置信度
        </Button>
      </DialogTrigger>
      <DialogContent
        data-confidence-panel
        showCloseButton={false}
        className="flex h-[min(760px,88vh)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden rounded-2xl border border-border bg-background p-0 text-foreground sm:max-w-5xl motion-reduce:animate-none"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="mb-2 text-[10px] font-medium tracking-[0.18em] text-muted-foreground">
              SESSION INSPECTOR
            </div>
            <DialogTitle className="text-xl font-semibold tracking-tight">
              置信度与运行记录
            </DialogTitle>
            <DialogDescription className="mt-2 text-xs">
              从消息到工具回显，查看本次对话留下的记录。记录可追溯，不代表结论已核验。
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="关闭置信度面板">
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </Button>
          </DialogClose>
        </div>
        {open && (
          <PanelBody
            key={sessionId}
            sessionId={sessionId}
            messages={messages}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PanelBody({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: UIMessage[];
}) {
  const [data, setData] = useState<SessionDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(200);
  const [view, setView] = useState<View>("flow");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<ReturnType<
    typeof buildDiagnosticSnapshot
  > | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState("");
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setLoading(true);
      try {
        const next = await fetchSessionDiagnostics(sessionId, limit);
        if (!disposed) {
          setData(next);
          setLoadError("");
        }
      } catch (error) {
        if (!disposed) {
          setData(null);
          setLoadError(
            diagnosticText(
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      } finally {
        if (!disposed) {
          setLoading(false);
          if (autoRefresh) timer = setTimeout(() => void read(), 3000);
        }
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [sessionId, limit, revision, autoRefresh]);

  const conversation = useMemo(
    () => conversationSnapshot(messages, limit),
    [messages, limit],
  );
  const logs = data?.journal.status === "ready" ? data.journal.data : null;
  const evidence =
    data?.evidence.status === "ready" ? data.evidence.data : null;
  const rows: Row[] =
    view === "flow"
      ? (logs?.lines ?? []).map((entry, i) => ({
          id: entry.event_id ?? `legacy-${entry.ts}-${i}`,
          title: RUN_EVENT_LABELS[entry.type] ?? entry.type,
          time: entry.ts,
          summary:
            typeof entry.meta?.tool_name === "string"
              ? entry.meta.tool_name
              : entry.content,
          body: entry.content,
          fields: [
            ["记录类型", entry.type],
            ["工具", entry.meta?.tool_name],
            ["记录状态", entry.meta?.status],
            ["审批事件", entry.meta?.event],
            ["请求 ID", entry.meta?.request_id],
          ],
          details: entry,
          callId:
            typeof entry.meta?.tool_call_id === "string"
              ? entry.meta.tool_call_id
              : undefined,
          note: entry.content_truncated
            ? "本条内容已截断"
            : entry.content_truncated === undefined
              ? "旧记录未采集完整性标记"
              : undefined,
        }))
      : view === "conversation"
        ? conversation.map((entry) => ({
            id: entry.id,
            title: entry.role === "user" ? "你的消息" : "Agent 回答",
            summary: entry.text || "仅有工具或附件，无对话正文",
            body: entry.text,
            details: entry,
            note: entry.text_truncated
              ? "正文超过 8000 字，快照已截断"
              : undefined,
          }))
        : (evidence ?? []).map((entry, i) => ({
            id: entry.evidence_id ?? `legacy-evidence-${entry.timestamp}-${i}`,
            title: evidenceLabel(entry.tool_name),
            time: entry.timestamp,
            summary: entry.detail,
            body: entry.result,
            details: entry,
            callId: entry.tool_call_id,
            fields: [
              ["工具状态", entry.status],
              ["业务状态", entry.result_status],
              ["退出码", entry.exit_code ?? "未采集"],
              ["执行目标", entry.target_endpoint ?? "未采集"],
              ["操作 ID", entry.operation_id],
              ["SDK 调用 ID", entry.sdk_tool_use_id],
            ],
            note:
              entry.output_truncated ||
              entry.summary_truncated ||
              entry.detail_truncated
                ? "包含裁剪或截断；不能作为完整回显"
                : "工具结果摘要；来源完整性以原记录为准",
          }));
  const query = search.trim().toLocaleLowerCase();
  const visible = rows.filter(
    (row) =>
      !query ||
      `${row.title} ${diagnosticText(row.details)}`
        .toLocaleLowerCase()
        .includes(query),
  );
  const active =
    visible.find((row) => row.id === selected) ?? visible[visible.length - 1];
  const sourceError =
    view === "flow" && data?.journal.status === "error"
      ? data.journal.error
      : view === "evidence" && data?.evidence.status === "error"
        ? data.evidence.error
        : loadError;
  const counts = [logs?.lines.length, conversation.length, evidence?.length];
  const total = counts.reduce<number>((n, count) => n + (count ?? 0), 0);

  const save = async () => {
    if (!exportPreview || saving) return;
    setSaving(true);
    setExportError("");
    try {
      setSavedPath(await exportDiagnosticSnapshot(exportPreview));
      setExportPreview(null);
    } catch (error) {
      setExportError(
        diagnosticText(error instanceof Error ? error.message : String(error)),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="shrink-0 border-b border-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-6">
            {["流程记录", "对话消息", "工具证据"].map((label, i) => (
              <div key={label}>
                <span className="mr-2 font-mono text-2xl tabular-nums">
                  {counts[i] ?? "—"}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {label}
                </span>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || loading}
            onClick={() => {
              if (data) {
                setExportPreview(
                  buildDiagnosticSnapshot(data, messages, limit),
                );
                setExportError("");
                setSavedPath("");
              }
            }}
          >
            <HugeiconsIcon icon={Download01Icon} size={14} />
            导出日志
          </Button>
        </div>
        <div
          className="mt-4 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`记录构成：流程 ${counts[0] ?? "未知"}，消息 ${counts[1]}，证据 ${counts[2] ?? "未知"}；不是置信评分`}
        >
          {counts.map((count, i) =>
            count ? (
              <span
                key={i}
                className={cn(
                  "h-full",
                  ["bg-foreground/80", "bg-foreground/40", "bg-foreground/20"][
                    i
                  ],
                )}
                style={{ width: `${(count / Math.max(total, 1)) * 100}%` }}
              />
            ) : null,
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-3">
        <nav className="mr-auto flex gap-1" aria-label="日志视图">
          {(
            [
              ["flow", "运行流程"],
              ["conversation", "对话"],
              ["evidence", "工具证据"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={view === value}
              onClick={() => {
                setView(value);
                setSelected(null);
              }}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs transition-colors focus-visible:outline-2",
                view === value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
        <select
          aria-label="读取记录范围"
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
        >
          <option value={50}>最近 50 条</option>
          <option value={200}>最近 200 条</option>
          <option value={500}>最近 500 条</option>
        </select>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={autoRefresh}
          onClick={() => setAutoRefresh((v) => !v)}
        >
          {autoRefresh ? "自动刷新" : "已暂停刷新"}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          aria-label="刷新运行记录"
          onClick={() => setRevision((r) => r + 1)}
        >
          <HugeiconsIcon icon={RefreshIcon} size={14} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <section
          className="flex min-h-0 max-h-[45%] flex-col border-b border-border sm:max-h-none sm:w-[38%] sm:border-r sm:border-b-0"
          aria-label="记录列表"
        >
          <label className="mx-4 my-3 flex items-center gap-2 rounded-lg border border-border px-3 text-muted-foreground">
            <HugeiconsIcon icon={Search01Icon} size={14} />
            <input
              aria-label="搜索当前视图记录"
              placeholder="搜索命令、结果或调用 ID…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {sourceError ? (
              <p role="alert" className="m-3 text-xs text-destructive">
                读取失败：{sourceError}
              </p>
            ) : visible.length === 0 ? (
              <p
                role="status"
                className="p-8 text-center text-xs text-muted-foreground"
              >
                {loading && !data
                  ? "正在读取记录…"
                  : query
                    ? "没有匹配的记录"
                    : "当前会话暂无此类记录"}
              </p>
            ) : (
              <ol className="space-y-1">
                {visible.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      aria-pressed={active?.id === row.id}
                      onClick={() => setSelected(row.id)}
                      className={cn(
                        "group flex w-full gap-3 rounded-lg border border-transparent px-3 py-3 text-left transition-colors focus-visible:outline-2",
                        active?.id === row.id
                          ? "border-border bg-muted"
                          : "hover:bg-muted/60",
                      )}
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/50"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2 text-xs font-medium">
                          <span>{row.title}</span>
                          <time className="font-mono text-[10px] font-normal text-muted-foreground">
                            {row.time ? evidenceTime(row.time) : ""}
                          </time>
                        </span>
                        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                          {row.summary}
                        </span>
                        {row.note && (
                          <span className="mt-1 block text-[10px] text-muted-foreground">
                            {row.note}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
        <section
          aria-label="记录详情"
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5 sm:p-6"
        >
          {active && !sourceError ? (
            <>
              <div className="mb-4 flex items-baseline justify-between gap-2">
                <h3 className="text-base font-medium">{active.title}</h3>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {active.time ? evidenceTime(active.time) : "对话正文"}
                </span>
              </div>
              {active.note && (
                <p className="mb-4 border-l-2 border-foreground/30 pl-3 text-xs leading-relaxed text-muted-foreground">
                  {active.note}
                </p>
              )}
              {active.callId && (
                <div className="mb-4 break-all text-[11px] text-muted-foreground">
                  调用 ID <code>{active.callId}</code>
                  <p className="mt-1">
                    同一调用记录：
                    {logs?.lines.filter(
                      (e) => e.meta?.tool_call_id === active.callId,
                    ).length ?? "未知"}{" "}
                    条流程 ·{" "}
                    {evidence?.filter((e) => e.tool_call_id === active.callId)
                      .length ?? "未知"}{" "}
                    条证据
                  </p>
                </div>
              )}
              {active.fields && (
                <dl className="mb-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
                  {active.fields
                    .filter(
                      ([, value]) => value !== undefined && value !== null,
                    )
                    .map(([label, value]) => (
                      <div key={label} className="contents">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 font-mono break-all">
                          {diagnosticText(value)}
                        </dd>
                      </div>
                    ))}
                </dl>
              )}
              {view === "evidence" && active.summary && (
                <div className="mb-4">
                  <h4 className="mb-2 text-[10px] font-medium tracking-wider text-muted-foreground">
                    调用内容
                  </h4>
                  <pre className="rounded-lg border border-border p-3 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap">
                    {active.summary}
                  </pre>
                </div>
              )}
              <h4 className="mb-2 text-[10px] font-medium tracking-wider text-muted-foreground">
                {view === "conversation"
                  ? "消息正文"
                  : view === "evidence"
                    ? "结果摘要"
                    : "事件内容"}
              </h4>
              <pre
                className={cn(
                  "rounded-xl border border-border bg-muted/30 p-4 text-xs leading-6 break-words whitespace-pre-wrap",
                  view === "conversation" ? "font-sans" : "font-mono",
                )}
              >
                {active.body || "此记录没有正文"}
              </pre>
              <details className="mt-5 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer py-2">查看诊断字段</summary>
                <pre className="mt-2 break-words whitespace-pre-wrap">
                  {diagnosticText(active.details)}
                </pre>
              </details>
            </>
          ) : (
            <div className="flex h-full min-h-24 items-center justify-center text-center text-xs leading-6 text-muted-foreground">
              {sourceError
                ? "此数据源不可用，其他视图仍可查看。"
                : "选择一条记录，查看内容与来源。"}
            </div>
          )}
        </section>
      </div>
      {exportPreview && (
        <div
          className="shrink-0 border-t border-border bg-muted/40 px-6 py-3"
          role="region"
          aria-label="确认导出日志"
        >
          <p className="text-xs leading-5">
            仅导出打开预览时的当前会话快照，保存到本机 diagnostics
            目录。已按规则脱敏，但可能含主机、路径和业务正文，分享前请检查。
          </p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => setExportPreview(null)}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "正在保存…" : "确认保存 JSON"}
            </Button>
          </div>
        </div>
      )}
      {exportError && (
        <p role="alert" className="shrink-0 px-6 py-2 text-xs text-destructive">
          {exportError}
        </p>
      )}
      {savedPath && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-2 text-xs">
          <span className="min-w-0 flex-1 break-all">已保存：{savedPath}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void import("@tauri-apps/plugin-opener")
                .then(({ revealItemInDir }) => revealItemInDir(savedPath))
                .catch(() =>
                  setExportError("无法打开文件夹，请根据上方路径手动查找。"),
                );
            }}
          >
            打开所在目录
          </Button>
        </div>
      )}
      <footer className="shrink-0 space-y-1 border-t border-border px-6 py-3 text-[10px] leading-4 text-muted-foreground">
        <div className="flex flex-wrap justify-between gap-2">
          <span className="font-mono">会话 {sessionId}</span>
          <span role="status">
            {loading
              ? "正在刷新…"
              : data
                ? `更新于 ${new Date(data.fetchedAt).toLocaleTimeString()}`
                : "记录不可用"}
          </span>
        </div>
        <p>
          流水为有界摘要；工具证据仅在本次服务进程内保留最近 200
          条。旧审批可能缺失。暂无经过校准的置信评分。
        </p>
        {logs?.window_limited ||
        logs?.archive_available ||
        logs?.invalid_lines ||
        logs?.write_errors ? (
          <p>
            部分历史未展示{logs.window_limited ? " · 已达到读取范围" : ""}
            {logs.archive_available ? " · 存在轮转归档" : ""}
            {logs.invalid_lines
              ? ` · 跳过 ${logs.invalid_lines} 条损坏记录`
              : ""}
            {logs.write_errors
              ? ` · 服务累计写入失败 ${logs.write_errors} 次（非本会话计数）`
              : ""}
            。
          </p>
        ) : null}
      </footer>
    </>
  );
}
