import type { UIMessage } from "ai";
import { invokeRpc } from "@/lib/sidecar-bridge";
import type { EvidenceItem } from "./evidence";
import { redactSensitive } from "./redact";
import { version as appVersion } from "../../../../package.json";

export type RunEvent = {
  event_id?: string;
  ts: number;
  type: string;
  content: string;
  content_truncated?: boolean;
  meta?: Record<string, unknown>;
};
export type RunLog = {
  session_id: string;
  lines: RunEvent[];
  window_limited?: boolean;
  archive_available?: boolean;
  invalid_lines?: number;
  write_errors?: number;
};
export type DiagnosticSource<T> =
  { status: "ready"; data: T } | { status: "error"; error: string };
export type SessionDiagnostics = {
  sessionId: string;
  fetchedAt: string;
  journal: DiagnosticSource<RunLog>;
  evidence: DiagnosticSource<EvidenceItem[]>;
};

export type DiagnosticConversationPart = {
  kind: "reasoning" | "tool";
  label: string;
  text: string;
  text_truncated: boolean;
};
type DiagnosticConversationMessage = {
  id: string;
  role: UIMessage["role"];
  text: string;
  text_truncated: boolean;
  parts?: DiagnosticConversationPart[];
};
type DiagnosticSnapshot = {
  schema_version: number;
  app_version: string;
  session_id: string;
  exported_at: string;
  sources: {
    fetched_at: string;
    export_policy?: { include_returned_reasoning: boolean };
    journal: DiagnosticSource<RunLog>;
    evidence: DiagnosticSource<EvidenceItem[]>;
  };
  conversation: DiagnosticConversationMessage[];
  limitations: string[];
};

const SECRET_KEY =
  /password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|^(?:token|authorization|cookie|set-cookie|credential)$/i;

/** Diagnostic projection only; does not change the original message or terminal. */
export function redactDiagnostic(value: unknown, depth = 0): unknown {
  if (depth > 20) return "<OMITTED:depth-limit>";
  if (Array.isArray(value))
    return value.map((v) => redactDiagnostic(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "<REDACTED>" : redactDiagnostic(v, depth + 1),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (/^\s*[{[]/.test(value)) {
    try {
      return JSON.stringify(redactDiagnostic(JSON.parse(value), depth + 1));
    } catch {
      /* Partial JSON falls through to text redaction. */
    }
  }
  return redactSensitive(
    value
      .replace(
        /(["'](?:[^"']*(?:password|passwd|passphrase|secret|api[_-]?key|private[_-]?key|token)|authorization|cookie)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,
        '$1"<REDACTED>"',
      )
      .replace(
        /(\b(?:[\w-]*[_-])?(?:password|passwd|passphrase|token|secret|api[_-]?key|private[_-]?key)\s*(?:=|:|\s)\s*)("(?:\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|[^\s;|&]+)/gi,
        "$1<REDACTED>",
      )
      .replace(
        /\b((?:Proxy-)?Authorization|(?:Set-)?Cookie)\s*:\s*[^\r\n]+/gi,
        "$1: <REDACTED>",
      )
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
        "<REDACTED:private-key>",
      )
      .replace(
        /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,
        "$1<REDACTED:credentials>@",
      ),
  );
}

export function diagnosticText(value: unknown): string {
  const safe = redactDiagnostic(value);
  return typeof safe === "string"
    ? safe
    : (JSON.stringify(safe, null, 2) ?? "");
}

async function source<T>(read: () => Promise<T>): Promise<DiagnosticSource<T>> {
  try {
    return { status: "ready", data: await read() };
  } catch (error) {
    return {
      status: "error",
      error: diagnosticText(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export async function fetchSessionDiagnostics(
  sessionId: string,
  limit = 200,
): Promise<SessionDiagnostics> {
  if (!sessionId) throw new Error("请选择对话后查看运行记录");
  const [journal, evidence] = await Promise.all([
    source(async () => {
      const result = await invokeRpc<RunLog & { ok?: boolean; error?: string }>(
        "debug.agent_log_tail",
        { session_id: sessionId, lines: limit },
      );
      if (
        !result ||
        result.ok !== true ||
        result.session_id !== sessionId ||
        !Array.isArray(result.lines)
      ) {
        throw new Error(result?.error || "运行记录读取失败或会话不匹配");
      }
      if (
        !result.lines.every(
          (e) =>
            e &&
            typeof e.type === "string" &&
            typeof e.content === "string" &&
            typeof e.ts === "number" &&
            Number.isFinite(e.ts),
        )
      ) {
        throw new Error("运行记录格式不完整，未作为空记录处理");
      }
      return {
        ...result,
        lines: result.lines.map((e) => ({
          ...e,
          content: e.type === "env_inject"
            ? "此事件已记录；环境上下文不纳入诊断快照。"
            : diagnosticText(e.content),
          meta: redactDiagnostic(e.meta) as RunEvent["meta"],
        })),
      };
    }),
    source(async () => {
      const result = await invokeRpc<EvidenceItem[]>("evidence.list", {
        session_id: sessionId,
      });
      if (
        !Array.isArray(result) ||
        !result.every(
          (e) =>
            e &&
            typeof e.tool_name === "string" &&
            typeof e.status === "string" &&
            typeof e.detail === "string" &&
            typeof e.result === "string" &&
            typeof e.timestamp === "number" &&
            Number.isFinite(e.timestamp),
        )
      ) {
        throw new Error("工具证据读取失败，未作为空记录处理");
      }
      return redactDiagnostic(result) as EvidenceItem[];
    }),
  ]);
  return { sessionId, fetchedAt: new Date().toISOString(), journal, evidence };
}

function stripContextAttachments(text: string): string {
  return text.replace(
    /<(env|environment|terminal-context|terminal-selection|live_context|selection|file)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "[上下文附件已省略]",
  );
}

function clipConversationContent(value: unknown) {
  const safe = diagnosticText(value);
  const text = safe.slice(0, 8000).replace(/[\uD800-\uDBFF]$/u, "");
  return { text, text_truncated: text.length < safe.length };
}

export function conversationSnapshot(messages: UIMessage[], limit = 200, details = false): DiagnosticConversationMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-limit)
    .map((m) => {
      const raw = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const entry: DiagnosticConversationMessage = {
        id: m.id, role: m.role, ...clipConversationContent(stripContextAttachments(raw)),
      };
      if (details) {
        entry.parts = [];
        const reasoning = m.parts.filter((p) => p.type === "reasoning").map((p) => p.text).join("\n");
        if (reasoning) entry.parts.push({ kind: "reasoning", label: "已返回的思考", ...clipConversationContent(stripContextAttachments(reasoning)) });
        for (const part of m.parts) {
          if (!(part.type === "dynamic-tool" || part.type.startsWith("tool-")) || !("toolCallId" in part)) continue;
          const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
          entry.parts.push({
            kind: "tool", label: `工具 · ${diagnosticText(toolName)}`,
            ...clipConversationContent({
              tool_name: toolName, tool_call_id: part.toolCallId, state: part.state, input: part.input,
              ...("output" in part ? { output: part.output } : {}),
              ...("errorText" in part ? { error: part.errorText } : {}),
            }),
          });
        }
      }
      return entry;
    });
}

function projectDiagnosticExport(snapshot: DiagnosticSnapshot, includeReturnedReasoning: boolean): DiagnosticSnapshot {
  const journal = snapshot.sources.journal;
  return redactDiagnostic({
    ...snapshot,
    sources: {
      ...snapshot.sources,
      export_policy: { include_returned_reasoning: includeReturnedReasoning },
      journal: journal.status === "ready" ? {
        ...journal,
        data: {
          ...journal.data,
          lines: journal.data.lines.map((entry) => ({
            ...entry,
            content: entry.type === "env_inject"
              ? "此事件已记录；环境上下文不纳入诊断快照。"
              : entry.type === "reasoning" && !includeReturnedReasoning
                ? "此事件已记录；思考正文未选择导出。"
                : entry.content,
          })),
        },
      } : journal,
    },
    conversation: snapshot.conversation.map((entry) => ({
      ...entry,
      ...(entry.parts ? { parts: entry.parts.filter((part) => includeReturnedReasoning || part.kind !== "reasoning") } : {}),
    })),
  }) as DiagnosticSnapshot;
}

export function buildDiagnosticSnapshot(
  data: SessionDiagnostics,
  messages: UIMessage[],
  limit = 200,
  includeReturnedReasoning = false,
): DiagnosticSnapshot {
  return projectDiagnosticExport({
    schema_version: 1,
    app_version: appVersion,
    session_id: data.sessionId,
    exported_at: new Date().toISOString(),
    sources: {
      fetched_at: data.fetchedAt,
      journal: data.journal,
      evidence: data.evidence,
    },
    conversation: conversationSnapshot(messages, limit, true),
    limitations: [
      `当前会话最近 ${limit} 条流水和消息；正文及各段返回内容最多 8000 字符，JSONL 摘要最多 2000 字符。`,
      "工具证据为进程内最近 200 条，重启可能丢失；旧记录缺失字段不补造。",
      "时间先后不证明因果或结论正确；未计算经过校准的正确概率。",
      "思考正文仅在显式勾选后导出；不包含全局系统日志、上下文附件或隐藏 SDK 字段。",
      "已作规则脱敏，主机、路径和业务正文可能仍敏感，请人工复核后分享。",
    ],
  }, includeReturnedReasoning);
}

export async function exportDiagnosticSnapshot(
  snapshot: ReturnType<typeof buildDiagnosticSnapshot>,
  includeReturnedReasoning = false,
): Promise<string> {
  const result = await invokeRpc<{ ok: boolean; path: string }>(
    "debug.export_session_diagnostics",
    {
      session_id: snapshot.session_id,
      snapshot: projectDiagnosticExport(snapshot, includeReturnedReasoning),
    },
  );
  if (!result?.ok || !result.path) throw new Error("诊断日志未保存成功");
  return result.path;
}

export const RUN_EVENT_LABELS: Record<string, string> = {
  user_msg: "收到消息",
  env_inject: "加载环境",
  assistant_msg: "生成回答",
  reasoning: "模型思考",
  tool_call: "调用工具",
  tool_result: "工具返回",
  needs_you: "等待与审批",
  loop_progress: "回合进度",
  todo_followup: "任务跟进",
  verify_followup: "验证跟进",
  watchdog_timeout: "等待超时",
};
