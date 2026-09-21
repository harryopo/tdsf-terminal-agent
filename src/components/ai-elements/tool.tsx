"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  onSshCommandOutput,
  type SshCommandOutputEvent,
} from "@/lib/sidecar-bridge";
import { cn } from "@/lib/utils";
import {
  formatTeachingResultForAgent,
  TEACHING_EXECUTION_TIMEOUT_MS,
  useTeachingExecutionStore,
} from "@/modules/terminal/lib/teachingExecutionStore";
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  Cancel01Icon,
  CheckListIcon,
  CopyIcon,
  Edit02Icon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  FlashIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  ShieldUserIcon,
  SparklesIcon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import {
  claimAutoType,
  markAutoTyped,
} from "@/modules/ai/lib/autoTypeLedger";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { sendMessage } from "@/modules/ai/store/chatRuntime";
import {
  categoryGroupLabel,
  plainSummary,
  sourceGroupLabel,
} from "@/modules/ai/lib/knowledge-labels";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { useTerminalCardTarget } from "@/modules/ai/lib/useTerminalCardTarget";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useEffect, useRef, useState } from "react";


export type ToolPart = ToolUIPart | DynamicToolUIPart;

// ============================================================================
// 审批卡（Task 3.1，方案书 v3.1 §4.4 四层卡面 + 三按钮）
// ============================================================================

/** 影响预测（第 4 层数据，来自 Python command_impact.analyze） */
export type ToolImpact = {
  /** 影响摘要（人话，如「删除文件：/tmp/a」） */
  summary?: string;
  max_risk_l?: number;
  /** denylist 硬底线命中（永不放行） */
  denied?: boolean;
  /** 含危险构造 $() / eval / 管道到 shell 等（永不自动放行） */
  dangerous_construct?: boolean;
  segments?: Array<{
    command?: string;
    category?: string;
    category_label?: string;
    objects?: string[];
    risk_l?: number;
    denied?: boolean;
    dangerous_construct?: boolean;
    deny_reason?: string;
  }>;
};

/** 审批响应：approved + 可选拒绝附言 + 可选会话级只读免审（Task 5 白名单接口） */
export type ToolApprovalRespond = (response: {
  approved: boolean;
  /** 用户附言（拒绝时 agent 收到「用户附言：…」用于给替代方案） */
  note?: string;
  /** ⚡批准且本会话只读免审（仅 L0-L1 显示；由会话层记录免审记忆） */
  sessionTrust?: boolean;
}) => void;

const RISK_LABEL: Record<number, string> = {
  0: "L0 无风险",
  1: "L1 低风险",
  2: "L2 中风险",
  3: "L3 高风险",
  4: "L4 危险",
};

function compactApprovalSentence(value: string, maxLength = 96): string {
  const sentence = value.replace(/\s+/g, " ").trim();
  return sentence.length > maxLength
    ? `${sentence.slice(0, maxLength - 1).trimEnd()}…`
    : sentence;
}

type ToolApprovalCardProps = {
  toolName: string;
  /** 工具调用 input（四层字段：semantic / command / explanation / impact / risk_l） */
  input?: unknown;
  onRespond: ToolApprovalRespond;
  className?: string;
};

/**
 * 紧凑审批卡：真实命令原文 + 一句用途 + 一句 impact 摘要。
 * 风险 metadata 只用于简短等级提示和 fail-closed 的会话免审判断，不再展开
 * segments/objects，避免把同一对象重复渲染成多块风险面板。
 */
export function ToolApprovalCard({
  toolName,
  input,
  onRespond,
  className,
}: ToolApprovalCardProps) {
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");
  const i = (input ?? {}) as Record<string, unknown>;
  const semantic = typeof i.semantic === "string" ? i.semantic : "";
  const command = typeof i.command === "string" ? i.command : "";
  const explanation = typeof i.explanation === "string" ? i.explanation : "";
  const impact: ToolImpact | null =
    i.impact && typeof i.impact === "object"
      ? (i.impact as ToolImpact)
      : null;
  const segments = impact?.segments ?? [];
  const riskCandidates = [
    typeof i.risk_l === "number" ? i.risk_l : null,
    typeof impact?.max_risk_l === "number" ? impact.max_risk_l : null,
    ...segments.map((segment) =>
      typeof segment.risk_l === "number" ? segment.risk_l : null,
    ),
  ].filter((value): value is number => value != null && Number.isFinite(value));
  const riskL = riskCandidates.length ? Math.max(...riskCandidates) : null;
  const denied =
    impact?.denied === true || segments.some((segment) => segment.denied === true);
  const dangerous =
    impact?.dangerous_construct === true ||
    segments.some((segment) => segment.dangerous_construct === true);
  const impactMetadataComplete =
    segments.length > 0 &&
    segments.every(
      (segment) =>
        typeof segment.category === "string" &&
        segment.category.trim() !== "" &&
        segment.category !== "unknown" &&
        typeof segment.risk_l === "number" &&
        Number.isFinite(segment.risk_l),
    );
  const purposeSource = explanation.trim() || semantic.trim();
  const purpose = purposeSource
    ? compactApprovalSentence(purposeSource)
    : "未提供用途说明。";
  const denyReason = segments.find(
    (segment) => segment.denied && segment.deny_reason?.trim(),
  )?.deny_reason;
  const impactSummary = impact?.summary?.trim();
  const impactText = denied
    ? compactApprovalSentence(
        denyReason?.trim()
          ? `安全规则已拦截：${denyReason}`
          : "影响元数据标记此操作已被安全规则拦截。",
      )
    : dangerous
      ? "影响元数据检测到危险命令构造，需要逐条确认。"
      : impactSummary
        ? compactApprovalSentence(impactSummary)
        : "影响信息不完整，需要逐条确认。";
  // ⚡会话免审仅用于 metadata 完整的低风险操作；未知/冲突数据保守逐条确认。
  const canSessionTrust =
    impactMetadataComplete &&
    riskL != null &&
    riskL >= 0 &&
    riskL <= 1 &&
    !denied &&
    !dangerous;

  const rejectWithNote = () => {
    onRespond({ approved: false, note: note.trim() || undefined });
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card shadow-sm",
        className,
      )}
      data-approval-card={toolName}
    >
      {/* 卡头 */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/70" />
        <HugeiconsIcon
          icon={ShieldUserIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">
          等待你的确认
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          确认后才会执行
        </span>
      </div>

      <div className="space-y-2 px-3 py-2">
        {/* ① 命令原文（永不改写）——C1 (2026-09-01) whitespace-pre-wrap：
            长命令自动换行完整可见，不再右侧截断（overflow-auto 保留横向兜底） */}
        {command ? (
          <pre
            className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/35 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground"
            data-testid="approval-command"
          >{command}</pre>
        ) : null}

        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px] leading-relaxed">
          {/* ② 中文用途：explanation 与 semantic 二选一，避免同义重复。 */}
          <span className="text-muted-foreground">用途</span>
          <span className="min-w-0 text-foreground">{purpose}</span>

          {/* ③ 影响：只消费已有 metadata 的 summary/flags，不预测 stdout。 */}
          <span className="text-muted-foreground">影响</span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-1.5 text-foreground">
            {riskL != null ? (
              <span
                className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
              >
                {RISK_LABEL[riskL] ?? `L${riskL}`}
              </span>
            ) : null}
            <span className="min-w-0">{impactText}</span>
          </span>
        </div>

        {/* 拒绝附言（展开式） */}
        {showNote && (
          <div className="space-y-1.5">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="附言（可选）：告诉 Agent 为什么拒绝 / 期望的替代方案"
              rows={2}
              className="w-full resize-none rounded border border-border bg-background px-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        )}
      </div>

      {/* 三按钮 */}
      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-border/60 px-3 py-1.5">
        {showNote ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowNote(false)}
              className="h-7 text-[11px]"
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={rejectWithNote}
              className="h-7 gap-1.5 text-[11px]"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              确认拒绝
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowNote(true)}
            className="h-7 gap-1.5 text-[11px] text-destructive hover:text-destructive"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            拒绝
          </Button>
        )}
        {canSessionTrust && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              // Task 5: ⚡点击 → 前端会话级免审标志置位（内存不落盘，切会话
              // 重置）；Python 侧经 needs_you.respond 的 trust 响应同步记录
              useChatStore.getState().setSessionReadOnlyTrust(true);
              onRespond({ approved: true, sessionTrust: true });
            }}
            className="h-7 gap-1.5 text-[11px] text-muted-foreground"
            title="批准本次操作，且本会话内同类只读操作不再询问"
          >
            <HugeiconsIcon icon={FlashIcon} size={12} strokeWidth={2} />
            批准且本会话只读免审
          </Button>
        )}
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond({ approved: true })}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          执行
        </Button>
      </div>
    </div>
  );
}

/** 工具类别（B1 2026-09-03 用户钦定：按类配色让工具调用一眼可辨） */
type ToolCategory = "file" | "exec" | "knowledge" | "skill" | "diagnose" | "plan";

/** 类别 → 颜色 + 中文名（单一真源：图标着色统一消费） */
const CATEGORY_META: Record<ToolCategory, { label: string; color: string }> = {
  file: { label: "文件", color: "text-amber-600 dark:text-amber-400" },
  exec: { label: "执行", color: "text-red-600 dark:text-red-400" },
  knowledge: { label: "知识库", color: "text-emerald-600 dark:text-emerald-400" },
  skill: { label: "技能", color: "text-violet-600 dark:text-violet-400" },
  diagnose: { label: "诊断", color: "text-sky-600 dark:text-sky-400" },
  plan: { label: "规划", color: "text-cyan-600 dark:text-cyan-400" },
};

const TOOL_META: Record<
  string,
  { label: string; icon: typeof File01Icon; category: ToolCategory }
> = {
  // 文件读写编辑（琥珀）
  read_file: { label: "Read", icon: File01Icon, category: "file" },
  list_directory: { label: "List", icon: FolderOpenIcon, category: "file" },
  write_file: { label: "Write", icon: FilePlusIcon, category: "file" },
  create_directory: { label: "Create dir", icon: FolderAddIcon, category: "file" },
  edit: { label: "Edit", icon: FileEditIcon, category: "file" },
  multi_edit: { label: "Edit", icon: Edit02Icon, category: "file" },
  grep: { label: "Search", icon: GlobalSearchIcon, category: "file" },
  glob: { label: "Glob", icon: Folder01Icon, category: "file" },
  open_preview: { label: "Preview", icon: EyeIcon, category: "file" },
  read_remote_file: { label: "读远程", icon: File01Icon, category: "file" },
  write_remote_file: { label: "写远程", icon: FileEditIcon, category: "file" },
  sftp_read: { label: "SFTP 读", icon: File01Icon, category: "file" },
  sftp_write: { label: "SFTP 写", icon: FilePlusIcon, category: "file" },
  // 命令执行（红）
  bash_run: { label: "Run", icon: TerminalIcon, category: "exec" },
  bash_background: { label: "Spawn", icon: TerminalIcon, category: "exec" },
  bash_logs: { label: "Logs", icon: TerminalIcon, category: "exec" },
  bash_list: { label: "Jobs", icon: TerminalIcon, category: "exec" },
  bash_kill: { label: "Kill", icon: TerminalIcon, category: "exec" },
  ssh_command: { label: "SSH", icon: TerminalIcon, category: "exec" },
  python_run: { label: "Python", icon: FlashIcon, category: "exec" },
  service_manage: { label: "服务", icon: TerminalIcon, category: "exec" },
  package_manage: { label: "包管理", icon: TerminalIcon, category: "exec" },
  firewall_manage: { label: "防火墙", icon: ShieldUserIcon, category: "exec" },
  backup_restore: { label: "备份恢复", icon: ToolsIcon, category: "exec" },
  // 知识库（绿）
  knowledge_search: { label: "知识库", icon: BookOpen01Icon, category: "knowledge" },
  knowledge_get_doc: { label: "文档", icon: BookOpen01Icon, category: "knowledge" },
  // 技能（紫）
  skill_invoke: { label: "Skill", icon: SparklesIcon, category: "skill" },
  save_skill: { label: "存技能", icon: BookOpen01Icon, category: "skill" },
  // 诊断分析（蓝）
  analyze_logs: { label: "日志分析", icon: File01Icon, category: "diagnose" },
  inspect_processes: { label: "进程", icon: ToolsIcon, category: "diagnose" },
  network_diagnose: { label: "网络", icon: GlobalSearchIcon, category: "diagnose" },
  security_audit: { label: "安全审计", icon: ShieldUserIcon, category: "diagnose" },
  performance_analyze: { label: "性能", icon: TerminalIcon, category: "diagnose" },
  config_diff: { label: "配置对比", icon: FileEditIcon, category: "diagnose" },
  get_terminal_output: { label: "终端输出", icon: TerminalIcon, category: "diagnose" },
  search_history: { label: "历史案例", icon: GlobalSearchIcon, category: "diagnose" },
  ssh_list_sessions: { label: "SSH 会话", icon: TerminalIcon, category: "diagnose" },
  // 规划建议（青）
  suggest_command: { label: "命令建议", icon: SparklesIcon, category: "plan" },
  teach_command: { label: "教学命令", icon: BookOpen01Icon, category: "plan" },
  todo_write: { label: "Todos", icon: CheckListIcon, category: "plan" },
  run_subagent: { label: "Subagent", icon: RobotIcon, category: "plan" },
  // TDSF 2026-09-18: 标签不再叫「置信度」——旧的分数算法已被会话证据三态取代，
  // 这是 UI 里最后一处常驻「置信度」字样（任何模式都渲染），保留会误导。
  assess_confidence: { label: "证据评估", icon: ShieldUserIcon, category: "plan" },
};

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-red-500",
  "output-available": "bg-emerald-500",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

function getToolMeta(toolName: string): {
  label: string;
  icon: typeof File01Icon;
  category: ToolCategory;
} {
  // P0-6: agent:<name> 前缀 → 子 agent 委派卡片（main 统一入口委派专家）
  if (toolName.startsWith("agent:")) {
    const agentName = toolName.slice("agent:".length);
    const label =
      agentName === "teach"
        ? "Teach Agent"
        : agentName === "coding"
          ? "Coding Agent"
          : agentName === "explore"
            ? "Explore Agent"
            : agentName === "history"
              ? "History Agent"
              : `${agentName} Agent`;
    return { label, icon: RobotIcon, category: "plan" };
  }
  return (
    TOOL_META[toolName] ?? {
      label: toolName,
      icon: ToolsIcon,
      category: "diagnose" as ToolCategory,
    }
  );
}

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  // P0-6: agent:<name> → 委派输入文本（截断展示）
  if (toolName.startsWith("agent:")) {
    const task = str("input") ?? str("task");
    if (!task) return null;
    return task.length > 60 ? `${task.slice(0, 60)}…` : task;
  }

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit":
    case "multi_edit":
    case "create_directory":
    case "list_directory":
    case "read_remote_file":
    case "write_remote_file":
    case "sftp_read":
    case "sftp_write":
    case "config_diff":
      return str("path");
    case "bash_run":
    case "bash_background":
    case "ssh_command":
    case "teach_command":
      return str("command");
    case "bash_logs":
    case "bash_kill":
      return str("id");
    case "grep":
      return str("pattern") ?? str("query");
    case "glob":
      return str("pattern");
    case "suggest_command":
      return str("intent") ?? str("description");
    case "knowledge_search":
      return str("query") ?? str("intent");
    case "knowledge_get_doc":
      return str("url");
    case "open_preview":
      return str("path") ?? str("url");
    case "run_subagent":
      return str("agent") ?? str("task");
    case "skill_invoke":
      return str("skill") ?? str("name") ?? str("skill_name");
    case "save_skill":
      return str("name") ?? str("skill_name");
    case "python_run":
      return str("code");
    case "todo_write": {
      const items = Array.isArray(i.todos) ? i.todos : null;
      return items
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : null;
    }
    default:
      return null;
  }
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
  /** Task 3.1: approval-requested 状态下的审批响应回调——提供时渲染四层审批卡 */
  onApprovalRespond?: ToolApprovalRespond;
};

// Tools whose `input` carries large/streaming content (file bodies, sub-
// agent prompts, todo lists). The AI diff tab is the canonical place to
// view file changes; for the rest, the header summary + final output is
// enough. Re-rendering streamed input on every token both stalls the UI
// and duplicates information.
const HEAVY_CONTENT_TOOLS = new Set([
  "write_file",
  "write_remote_file",
  "edit",
  "multi_edit",
  "run_subagent",
  "todo_write",
]);

const MAX_LIVE_SSH_OUTPUT = 65_536;

function appendLiveSshOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_LIVE_SSH_OUTPUT
    ? combined
    : combined.slice(-MAX_LIVE_SSH_OUTPUT);
}

function SshCommandLiveOutput({ command }: { command: string }) {
  const sessionId = useChatStore((state) => state.activeSessionId);
  const [live, setLive] = useState<SshCommandOutputEvent | null>(null);
  const [output, setOutput] = useState("");

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};

    void onSshCommandOutput((event) => {
      if (disposed) return;
      if (
        event.conversationSessionId &&
        event.conversationSessionId !== sessionId
      ) {
        return;
      }
      if (event.command.trim() !== command.trim()) return;

      setLive(event);
      setOutput((current) =>
        event.status === "running" && event.stream === "status"
          ? event.chunk
          : appendLiveSshOutput(current, event.chunk),
      );
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten();
    };
  }, [command, sessionId]);

  const completed = live?.status === "completed";
  const failed = live?.status === "failed";
  const label = completed ? "已完成" : failed ? "执行失败" : "实时回显";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            completed && "bg-emerald-500",
            failed && "bg-destructive",
            !completed && !failed && "animate-pulse bg-sky-500",
          )}
        />
        <span
          className={cn(
            "font-medium",
            completed && "text-emerald-700 dark:text-emerald-400",
            failed && "text-destructive",
            !completed && !failed && "text-sky-700 dark:text-sky-400",
          )}
        >
          {label}
        </span>
      </div>
      <pre
        aria-live="polite"
        className="max-h-72 overflow-auto rounded-md border border-border/45 bg-muted/35 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words"
      >
        {output || (live?.status === "running" ? "等待远端输出…" : "等待命令开始…")}
      </pre>
    </div>
  );
}

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  onApprovalRespond,
  defaultOpen,
  ...props
}: ToolProps) => {
  // Task 3.1: 审批等待态 + 提供了响应回调 → 渲染四层审批卡（三按钮）。
  // 未提供回调时保持通用折叠卡渲染（向后兼容，approval 交互由上层处理）。
  if (state === "approval-requested" && onApprovalRespond) {
    return (
      <ToolApprovalCard
        toolName={toolName}
        input={input}
        onRespond={onApprovalRespond}
        className={className}
      />
    );
  }

  const meta = getToolMeta(toolName);
  const Icon = meta.icon;
  const label = meta.label;
  const catColor = CATEGORY_META[meta.category].color;
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  const sshCommand =
    toolName === "ssh_command" &&
    input &&
    typeof input === "object" &&
    typeof (input as Record<string, unknown>).command === "string"
      ? ((input as Record<string, unknown>).command as string)
      : null;
  const showLiveSshOutput = state === "input-streaming" && Boolean(sshCommand);
  // 部分后端工具失败时仍走 completed 事件（内层 ok/success=false 或 status 为失败态），
  // part 状态停在 output-available → 状态点会谎报 done。内容判失败时同步降级徽标。
  const innerFailure = state === "output-available" && isFailedOutput(output);
  const innerFailureStatus =
    innerFailure && typeof output === "object" && output !== null
      ? typeof (output as Record<string, unknown>).status === "string"
        ? (output as Record<string, unknown>).status
        : ""
      : "";
  const innerFailureLabel =
    innerFailureStatus === "unmatched" ? "未匹配" : "failed";
  const open = defaultOpen ?? (isError || showLiveSshOutput);
  const isHeavy = HEAVY_CONTENT_TOOLS.has(toolName);
  const isTeachingCard =
    output !== null &&
    typeof output === "object" &&
    (output as Record<string, unknown>).status === "teach_command";
  // For heavy tools, only show details on error — never the streamed input
  // body, which is huge and re-renders per token.
  // 教学命令的 JSON 参数会和下方的命令卡重复；无论来自专用工具还是映射工具，
  // 教学界面只保留可执行卡。
  const showInputBody =
    !isTeachingCard && !isHeavy && Boolean(input);
  // 重量级工具只在失败时展示输出体：成功路径的结果很小且重复，
  // 但内层 ok/success=false 的失败说明是用户唯一能看到「为什么失败」的地方。
  const showOutputBody =
    output !== undefined &&
    (!isHeavy || innerFailure || isError || toolName === "write_remote_file");
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText) || showLiveSshOutput;

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            innerFailure ? "bg-orange-500" : STATUS_DOT[state],
          )}
          aria-label={
            innerFailure
              ? innerFailureStatus === "unmatched"
                ? "unmatched"
                : "failed"
              : STATUS_LABEL[state]
          }
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className={cn("shrink-0", catColor)}
        />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {(isError || innerFailure) && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            {isError ? "failed" : innerFailureLabel}
          </span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent
          className={cn("tdsf-collapsible-content")}
        >
          <div className="ml-3 mt-1 space-y-2 border-l border-border/60 pl-3 pb-1">
            {showInputBody ? (
              <ToolInput toolName={toolName} input={input} />
            ) : null}
            {showLiveSshOutput && sshCommand ? (
              <SshCommandLiveOutput command={sshCommand} />
            ) : null}
            {showOutputBody || errorText ? (
              <ToolOutput
                toolName={toolName}
                output={showOutputBody ? output : undefined}
                errorText={errorText}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// For heavy tools, the only thing that should trigger a re-render is a
// state transition or the path summary changing — NOT every input-content
// token. We compare the cheap derived summary instead of the input ref.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (a.onApprovalRespond !== b.onApprovalRespond) return false;
  if (HEAVY_CONTENT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) ===
      deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const title = toolName === "suggest_command" ? "需求（不会执行）" : "Input";
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          {title}
        </div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">{title}</div>
      <CodeBlockMini
        code={
          typeof input === "string" ? input : JSON.stringify(input, null, 2)
        }
        language="json"
      />
    </div>
  );
}

function renderInputPreview(
  toolName: string,
  input: unknown,
): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cmd = str("command");
    const cwd = str("cwd");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            {cwd}
          </div>
        ) : null}
        <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
          {cmd}
        </pre>
      </div>
    );
  }
  // TDSF 2026-08-01: SSH 运维工具 Input 预览（命令 + 会话 + 超时摘要，
  // 替代裸 JSON——ssh_command 等工具的 input 主要价值在命令本身）
  if (
    toolName === "ssh_command" ||
    toolName === "write_remote_file" ||
    toolName === "sftp_read" ||
    toolName === "sftp_write"
  ) {
    const cmd = str("command") ?? str("path");
    if (!cmd) return null;
    const session = str("ssh_session_id") ?? str("sshSessionId");
    const timeout = i.timeout != null ? String(i.timeout) : null;
    return (
      <div className="space-y-1 font-mono text-[11px]">
        <pre className="overflow-auto rounded bg-muted/40 p-2 leading-relaxed">
          {cmd}
        </pre>
        {session || timeout ? (
          <div className="text-[10px] text-muted-foreground">
            {session ? `session ${session}` : null}
            {session && timeout ? " · " : null}
            {timeout ? `最长等待 ${timeout}s` : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "create_directory" ||
    toolName === "open_preview"
  ) {
    const path = str("path") ?? str("url");
    if (!path) return null;
    return (
      <div className="font-mono text-[11px] text-muted-foreground">{path}</div>
    );
  }
  if (toolName === "grep") {
    const pat = str("pattern") ?? str("query");
    const path = str("path") ?? str("root");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  if (toolName === "suggest_command") {
    const intent = str("intent") ?? str("description");
    const targetOs = str("target_os");
    if (!intent) return null;
    return (
      <div className="space-y-1">
        <div className="rounded bg-muted/40 px-2 py-1.5 text-[11px] text-foreground">
          {intent}
        </div>
        {targetOs ? (
          <div className="text-[10px] text-muted-foreground">
            目标环境：{targetOs}
          </div>
        ) : null}
      </div>
    );
  }
  return null;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-destructive">Error</div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else if (typeof output === "object" && !isValidElement(output)) {
    body = (
      <CodeBlockMini code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        Output
      </div>
      {body}
    </div>
  );
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  // 教学链路的第二次工具调用只是后端阻止“并列多步骤”的回执；上一张
  // 命令卡已经明确提示等待终端回显，不再重复渲染一条原始 JSON 工具输出。
  if (o.status === "teach_step_pending") return null;

  if (o.status === "teach_command_unavailable") {
    const message =
      typeof o.message === "string"
        ? o.message
        : "这一步无法安全转换为教学终端命令。";
    return <div className="text-[11px] text-muted-foreground">{message}</div>;
  }

  // A3 (2026-09-04): 教学模式终端执行链路——teach_command 事件分发。
  // 任何工具返回 status="teach_command" 时渲染 TeachCommandCard（学生手动执行）。
  if (o.status === "teach_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    if (!cmd) return null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    const predictedOutput =
      typeof o.predicted_output === "string" ? o.predicted_output : null;
    return (
      <TeachCommandCard
        command={cmd}
        explanation={explanation}
        predictedOutput={predictedOutput}
        toolName={toolName}
      />
    );
  }

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (toolName === "get_terminal_output") {
    return <TerminalOutputCard data={o} />;
  }

  // SSH 工具返回的是 { command, output, exit_code, duration, explanation }。
  // 没有专用卡片时会退化成整段 JSON，既重复命令又掩盖终端输出；此处采用和
  // bash_run 一致的“状态 → 说明 → 原始输出”层次。非零 exit_code 仍不是
  // Tool failure（上方 failure 逻辑保持原有语义）。
  if (
    toolName === "ssh_command" &&
    !TOOL_FAILURE_STATUSES.has(typeof o.status === "string" ? o.status : "") &&
    (typeof o.output === "string" || typeof o.exit_code === "number")
  ) {
    return <SshCommandOutput data={o} />;
  }

  // TDSF 2026-08-31 双库: 知识检索结果 → 知识卡片列表（title + source 中文
  // 标签 + 摘要 + category 徽标），替代裸 JSON
  if (toolName === "knowledge_search") {
    return <KnowledgeSearchOutput data={o} />;
  }

  // TDSF 2026-08-31 双库: 完整文档读取 → 文档卡片（title + 折叠全文）
  if (toolName === "knowledge_get_doc") {
    return <KnowledgeDocCard data={o} />;
  }

  if (toolName === "suggest_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    const predictedOutput =
      typeof o.predicted_output === "string" ? o.predicted_output : null;
    if (!cmd && o.status === "unmatched") {
      const message =
        typeof o.explanation === "string"
          ? o.explanation
          : "未匹配到内置命令规则，请补充目标对象。";
      const suggestions = Array.isArray(o.suggestions)
        ? o.suggestions.filter((item): item is string => typeof item === "string")
        : [];
      return (
        <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px]">
          <div className="font-medium text-amber-700 dark:text-amber-400">
            未匹配命令
          </div>
          <div className="text-muted-foreground">{message}</div>
          {suggestions.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {suggestions.map((item) => (
                <span
                  key={item}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {item}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    if (!cmd) return null;
    return (
      <SuggestCommandCard
        command={cmd}
        explanation={explanation}
        predictedOutput={predictedOutput}
      />
    );
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    const matches = Array.isArray(o.matches)
      ? (o.matches as string[])
      : Array.isArray(o.paths)
        ? (o.paths as string[])
        : [];
    if (matches.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
        </div>
      );
    }
    return (
      <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="truncate text-muted-foreground">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit" || toolName === "multi_edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? (
            <span className="text-muted-foreground">· {path}</span>
          ) : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "write_remote_file" && o.status === "success") {
    const path = typeof o.path === "string" ? o.path : "";
    const backupPath = typeof o.backup_path === "string" ? o.backup_path : "";
    const size = typeof o.size === "number" ? o.size : null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          <span className="text-foreground">已备份、写入并回读验证</span>
          {size != null ? (
            <span className="text-muted-foreground">({formatBytes(size)})</span>
          ) : null}
        </div>
        {path ? <div className="text-muted-foreground">目标 · {path}</div> : null}
        {backupPath ? (
          <div className="text-muted-foreground">备份 · {backupPath}</div>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {handle ? <span className="text-foreground">{handle}</span> : null}
          <span className="text-muted-foreground">running</span>
        </div>
        {cmd ? (
          <div className="truncate text-muted-foreground">{cmd}</div>
        ) : null}
      </div>
    );
  }

  // 通用失败兜底（放在所有专用分支之后，避免抢掉定制渲染）：后端工具失败态
  // 或显式 ok/success=false → 状态徽标 + 中文说明，替代落到 JSON.stringify 的裸 JSON
  const failure = pickToolFailure(o);
  if (failure) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-amber-600 dark:text-amber-400">
          {failure.status}
        </div>
        {failure.text ? (
          <div className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
            {failure.text}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
}

/**
 * 后端工具失败态词汇（与 Python `ToolCallLimitHook._result_status` 对齐）。
 *
 * 注：`exit_code != 0` **不在**此列——命令非零退出是正常输出信息，把它算失败会
 * 污染熔断计数并削弱 T7「写操作后必须验证」的判定（决策记录见 dev-state §37.103）。
 */
const TOOL_FAILURE_STATUSES = new Set([
  "command_blocked",
  "rejected",
  "needs_approval",
  "unavailable",
  "stale_source",
  "indeterminate",
  "unmatched",
  "error",
]);

/** 失败说明文本候选字段（按信息量优先级） */
const TOOL_FAILURE_TEXT_KEYS = ["message", "error", "stderr", "reason"];

function pickToolFailure(
  o: Record<string, unknown>,
): { status: string; text: string } | null {
  const status = typeof o.status === "string" ? o.status : "";
  const explicitFailure = o.ok === false || o.success === false;
  if (!explicitFailure && !TOOL_FAILURE_STATUSES.has(status)) return null;
  const raw = TOOL_FAILURE_TEXT_KEYS.map((key) =>
    typeof o[key] === "string" ? (o[key] as string).trim() : "",
  ).find(Boolean);
  // 剥掉 `command_blocked!` / `rejected!` 前缀——那是给 LLM 的双轨反馈关键字
  const text = raw ? raw.replace(/^[a-z_]+!\s*/, "") : "";
  return { status: status || "failed", text };
}

/** 工具输出内容本身是否表示失败（与 pickToolFailure 同一口径） */
function isFailedOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    pickToolFailure(output as Record<string, unknown>) !== null
  );
}

// ============================================================================
// TDSF 2026-08-31 双库: 知识工具卡片（knowledge_search / knowledge_get_doc）
// ============================================================================

/** knowledge_search 单条结果（与后端 invoke_knowledge_search_tool 返回对齐） */
type KnowledgeSearchHit = {
  title?: string;
  content?: string;
  source?: string;
  url?: string;
  category?: string;
};

/** 摘要截取长度（卡片副文，任务书钦定 150 字） */
const KNOWLEDGE_SNIPPET_CHARS = 150;

function KnowledgeSearchOutput({ data }: { data: Record<string, unknown> }) {
  const status = typeof data.status === "string" ? data.status : "";
  const hits = Array.isArray(data.results)
    ? (data.results as KnowledgeSearchHit[])
    : [];

  if (status === "empty" || (status !== "error" && hits.length === 0)) {
    return (
      <div className="text-[11px] italic text-muted-foreground">
        知识库暂无相关内容
      </div>
    );
  }
  if (status === "error" && hits.length === 0) {
    const message = typeof data.message === "string" ? data.message : "";
    return (
      <div className="text-[11px] text-destructive">
        {message || "知识库检索失败"}
      </div>
    );
  }

  const query = typeof data.query === "string" ? data.query : "";

  return (
    <Collapsible className="rounded border border-border/40 bg-muted/20">
      <CollapsibleTrigger
        className="group flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/30"
        aria-label={`展开知识库检索结果（${hits.length} 条）`}
      >
        <HugeiconsIcon
          icon={BookOpen01Icon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
          知识库命中{query ? ` · ${query}` : ""}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {hits.length} 条
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="tdsf-collapsible-content border-t border-border/40">
        <div className="space-y-1 px-2 py-1.5">
          {hits.map((hit, idx) => {
            const title = hit.title || "（无标题）";
            // plainSummary 剥残留 markdown 符号（###/---/表格竖线），TDSF 2026-08-31
            const snippet = plainSummary(hit.content, KNOWLEDGE_SNIPPET_CHARS);
            const truncatedSnippet =
              snippet.length > KNOWLEDGE_SNIPPET_CHARS
                ? `${snippet.slice(0, KNOWLEDGE_SNIPPET_CHARS)}…`
                : snippet;
            return (
              <div
                key={hit.url ? `${hit.url}-${idx}` : idx}
                className="rounded border border-border/40 bg-muted/20 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
                    {title}
                  </span>
                  {hit.category ? (
                    <span className="shrink-0 rounded bg-foreground/8 px-1 py-0.5 text-[9px] text-muted-foreground">
                      {categoryGroupLabel(hit.category)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">
                    {sourceGroupLabel(hit.source || "")}
                  </span>
                </div>
                {truncatedSnippet ? (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                    {truncatedSnippet}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function KnowledgeDocCard({ data }: { data: Record<string, unknown> }) {
  const status = typeof data.status === "string" ? data.status : "";
  const title = typeof data.title === "string" ? data.title : "";
  const content = typeof data.content === "string" ? data.content : "";
  const category = typeof data.category === "string" ? data.category : "";
  const chunks = typeof data.chunks === "number" ? data.chunks : null;
  const truncated = data.truncated === true;

  if (status === "not_found" || status === "error") {
    const message = typeof data.message === "string" ? data.message : "";
    return (
      <div className="text-[11px] text-muted-foreground">
        {status === "not_found"
          ? message || "知识库中不存在该文档"
          : message || "知识库文档读取失败"}
      </div>
    );
  }
  if (!content) {
    return (
      <div className="text-[11px] text-muted-foreground">
        {status === "success"
          ? "知识库文档已找到，但没有可显示的正文"
          : "知识库文档没有可显示的正文"}
      </div>
    );
  }

  return (
    <Collapsible className="rounded border border-border/40 bg-muted/20">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left">
        <HugeiconsIcon
          icon={BookOpen01Icon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground">
          {title || "知识文档"}
        </span>
        {category ? (
          <span className="shrink-0 rounded bg-foreground/8 px-1 py-0.5 text-[9px] text-muted-foreground">
            {categoryGroupLabel(category)}
          </span>
        ) : null}
        {chunks != null ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {chunks} 块
          </span>
        ) : null}
        <span className="shrink-0 text-[10px] text-muted-foreground">
          全文
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="tdsf-collapsible-content">
        <pre className="max-h-72 overflow-auto border-t border-border/40 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {content}
        </pre>
        {truncated ? (
          <div className="border-t border-border/40 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-400">
            内容已截断（超 30000 字符）
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">{t.count}</span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Tool input/output is debug-grade detail — JSON arrives pre-formatted and
  // file content is shown in the editor diff tab. Highlighting here is not
  // worth the parser hop.
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
      {code}
    </pre>
  );
}

function TerminalCommandCard({
  command,
  onRun,
  runLabel,
  runTitle,
  runAriaLabel,
  disabled = false,
  tone = "default",
}: {
  command: string;
  onRun: () => void;
  runLabel: string;
  runTitle: string;
  runAriaLabel: string;
  disabled?: boolean;
  tone?: "default" | "teach";
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number>(0);
  const teach = tone === "teach";

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const onCopy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is host-controlled; keep the command visible if denied.
    }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded border",
        teach
          ? "border-violet-500/20 bg-violet-500/5"
          : "border-border/60 bg-muted/40",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b px-2.5 py-1",
          teach ? "border-violet-500/20" : "border-border/50",
        )}
      >
        <span
          className={cn(
            "font-mono text-[10px] font-medium tracking-wide",
            teach
              ? "text-violet-600 dark:text-violet-400"
              : "text-muted-foreground",
          )}
        >
          BASH
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRun}
            disabled={disabled}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
              "hover:bg-muted/80 disabled:cursor-default disabled:opacity-60",
              teach && "text-violet-600 hover:bg-violet-500/10 dark:text-violet-400",
            )}
            aria-label={runAriaLabel}
            title={runTitle}
          >
            <HugeiconsIcon icon={disabled ? Tick02Icon : TerminalIcon} size={11} strokeWidth={1.75} />
            <span>{runLabel}</span>
          </button>
          <button
            type="button"
            onClick={() => void onCopy()}
            className="rounded p-1 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            aria-label="复制命令"
            title="复制命令"
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : CopyIcon} size={11} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <pre className="overflow-auto p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
        {command}
      </pre>
    </div>
  );
}

function SuggestCommandCard({
  command,
  explanation,
  predictedOutput,
}: {
  command: string;
  explanation: string | null;
  predictedOutput: string | null;
}) {
  const [action, setAction] = useState<"inserted" | "executed" | null>(null);
  const autoTypeCommands = usePreferencesStore(
    (s) => s.agentAutoTypeCommands,
  );
  const agentMode = useChatStore((s) => s.agentMode);
  // 教学模式禁止自动插入终端，学生手动逐条执行：teach 会话下该偏好强制视为 false。
  const teach = useChatStore((s) => s.teach);
  const executeOnClick =
    autoTypeCommands && !teach && agentMode === "auto";
  // 确认模式步步确认（2026-09-04 用户钦定）：预测回显默认展开，
  // 让用户点“执行”前先看到命令预期输出（“预测命令的回显是什么”）。
  const [showPredicted, setShowPredicted] = useState(true);
  // 2026-09-03 修复 Maximum update depth：autoFiredRef 保证自动注入只触发一次。
  // 旧版仅靠 inserted state + deps[command]，流式期间 command 逐字变化会反复
  // 触发 useEffect，叠加 injectIntoActivePty 回流重渲染可能高频循环直至 React
  // 抛 "Maximum update depth exceeded"。与 chat-code.tsx CommandCard 同款守卫。
  const autoFiredRef = useRef(false);
  // #91 第⑤条：这张卡归属哪一条终端，在首次渲染时就定下来；点 Run 时若活动终端
  // 已经换人，宁可拒绝也不把命令打进别的 shell（#89 之后那可能是另一台机器）。
  const terminalGuard = useTerminalCardTarget();
  const onInsert = () => {
    const block = terminalGuard.blockReason();
    if (block) {
      toast.warning(block);
      return;
    }
    const store = useChatStore.getState();
    // TDSF (2026-08-09): 终端执行模式——加换行符自动执行命令
    // 教学模式禁止自动插入终端，学生手动逐条执行（teach 下视为偏好关闭）。
    const execute =
      usePreferencesStore.getState().agentAutoTypeCommands &&
      !store.teach &&
      store.agentMode === "auto";
    const text = execute ? command + "\n" : command;
    const ok = store.live.injectIntoActivePty(text);
    if (ok) setAction(execute ? "executed" : "inserted");
  };
  // TDSF 2026-09-18（用户钦定"要写入命令就自动输出到终端，别让我点 Run"）:
  // 建议命令卡渲染后自动打字到活动终端，四种模式全开。
  // 安全边界保留 2026-09-03 教训（确认模式自动执行=绕过 HITL 审批）：
  // 只有 auto 模式追加 \n 真正执行，confirm/observe/teach 只打字不回车。
  // autoFiredRef 守卫不可省：流式期间 command 逐字变化会反复触发本 effect，
  // 叠加 injectIntoActivePty 回流重渲染可致 "Maximum update depth exceeded"。
  useEffect(() => {
    if (autoFiredRef.current) return;
    const { activeSessionId, agentMode, live, teach } = useChatStore.getState();
    if (!usePreferencesStore.getState().agentAutoTypeCommands) return;
    // 自动打字闸门：Private 终端 / 用户正在敲的半行 / 不在提示符 → 不注入。
    const gate = live.canAutoTypeToActiveTerminal;
    if (gate && !gate()) return;
    // 重挂重放 / 同批互踩由 ledger 拦住：见 autoTypeLedger 注释。
    // 记账等注入成功之后——失败就记账会让常见命令整轮应用再也不自动打字。
    if (!claimAutoType(command, activeSessionId)) return;
    autoFiredRef.current = true;
    const execute = agentMode === "auto" && !teach;
    const ok = live.injectIntoActivePty(execute ? command + "\n" : command);
    if (!ok) return;
    markAutoTyped(command, activeSessionId);
    setAction(execute ? "executed" : "inserted");
  }, [command]);
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <TerminalCommandCard
        command={command}
        onRun={onInsert}
        disabled={action !== null}
        runLabel={
          action === "executed" ? "已执行" : action === "inserted" ? "已粘贴" : "Run"
        }
        runAriaLabel="运行命令：粘贴到活动终端"
        runTitle={
          executeOnClick
            ? "自动模式下会立即执行"
            : "粘贴到活动终端；由你自行确认执行"
        }
      />
      {/* TDSF (2026-08-09): 预测回显——让用户提前知道命令执行后应看到什么 */}
      {predictedOutput ? (
        <div className="rounded border border-dashed border-border/50 bg-muted/20">
          <button
            type="button"
            onClick={() => setShowPredicted((v) => !v)}
            className="flex w-full items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/40"
          >
            <HugeiconsIcon
              icon={EyeIcon}
              size={10}
              strokeWidth={1.75}
              className={showPredicted ? "opacity-40" : ""}
            />
            <span>{showPredicted ? "隐藏预测回显" : "预测回显"}</span>
          </button>
          {showPredicted ? (
            <pre className="border-t border-dashed border-border/50 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground/80">
              {predictedOutput}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// A3 (2026-09-04): 教学模式命令卡——学生手动点击注入终端（打字机）
// ============================================================================
// 与 SuggestCommandCard 的关键差异：
// 1. 永不自动执行（即使自动打字偏好开启 + auto 模式），必须学生手动点击
// 2. 显示命令预测回显，帮助学生判断下一步
// 3. 教学模式专属紫色调（与 teach 模式强调色一致）
// 4. 只以 TerminalBlockCollector 已划定的命令块回填结果；不读取全量滚屏

function TeachCommandCard({
  command,
  explanation,
  predictedOutput,
  toolName,
}: {
  command: string;
  explanation: string | null;
  predictedOutput: string | null;
  toolName: string;
}) {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [continued, setContinued] = useState(false);
  const terminalGuard = useTerminalCardTarget();
  const execution = useTeachingExecutionStore((state) =>
    executionId ? state.executions[executionId] ?? null : null,
  );
  const agentBusy = useChatStore((state) => state.agentMeta.status !== "idle");

  useEffect(() => {
    if (!executionId || execution?.status !== "waiting") return;
    const remaining = Math.max(0, execution.expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      useTeachingExecutionStore.getState().expire(executionId);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [execution?.expiresAt, execution?.status, executionId]);

  // 教学模式专属：永不自动执行，必须学生手动点击确认
  // （与 SuggestCommandCard 的 auto 模式自动注入不同）
  const onExecute = () => {
    if (executionId) return;
    // #91 第⑤条：教学单步执行同样只认这张卡当初那条终端。
    const block = terminalGuard.blockReason();
    if (block) {
      setCardError(block);
      return;
    }
    const store = useChatStore.getState();
    // 该入口会先登记 terminal leaf 的等待态，再以当前打字机设置可见注入。
    const started = store.live.startTeachingCommand(command);
    if (started.ok) {
      setExecutionId(started.executionId);
      setCardError(null);
      return;
    }
    const message =
      started.reason === "terminal-busy"
        ? "该终端已有一条教学命令正在等待结果；请先完成或等待其超时。"
        : "未找到已就绪的可见终端，命令没有执行。请先打开或连接终端后重试。";
    setCardError(message);
  };

  const onContinue = async () => {
    if (!execution || execution.status !== "completed" || !execution.block) return;
    if (agentBusy) {
      setCardError("当前 Agent 仍在回应；请等待本轮结束后再基于结果继续讲解。");
      return;
    }
    setCardError(null);
    const ok = await sendMessage(formatTeachingResultForAgent(execution));
    if (ok) setContinued(true);
    else setCardError("当前没有可继续的对话会话，结果未发送给 Agent。");
  };

  const duration = execution?.block
    ? execution.block.durationMs >= 1000
      ? `${(execution.block.durationMs / 1000).toFixed(1)} 秒`
      : `${execution.block.durationMs} 毫秒`
    : null;

  return (
    <div className="space-y-1.5">
      {/* 教学模式标识 */}
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="rounded bg-violet-500/10 px-1.5 py-0.5 font-medium text-violet-600 dark:text-violet-400">
          教学
        </span>
        <span className="text-muted-foreground">
          {toolName}
        </span>
      </div>
      {/* 解释文字 */}
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <TerminalCommandCard
        command={command}
        onRun={onExecute}
        disabled={executionId !== null}
        runLabel={executionId ? "已提交" : "Run"}
        runAriaLabel="教学命令：点击注入终端执行"
        runTitle="教学模式：点击后命令以打字机方式注入终端执行，请观察终端输出"
        tone="teach"
      />
      {predictedOutput ? (
        <div className="rounded border border-dashed border-violet-500/20 bg-violet-500/5 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-violet-600 dark:text-violet-400">
            预期回显
          </span>
          <span> · {predictedOutput}</span>
        </div>
      ) : null}
      {execution?.status === "waiting" ? (
        <div className="text-[10px] text-violet-500/70 dark:text-violet-400/70">
          命令已可见地输入终端，正在等待 shell 返回完成标记…
        </div>
      ) : null}
      {execution?.status === "completed" && execution.block ? (
        <div className="space-y-1 rounded border border-violet-500/20 bg-background/50 p-2">
          <div className="text-[10px] font-medium text-violet-600 dark:text-violet-400">
            执行结果 · exit {execution.block.exitCode ?? "?"}
            {duration ? ` · ${duration}` : ""}
          </div>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
            {execution.block.outputTail || "（命令已完成，没有可显示的输出）"}
          </pre>
          <button
            type="button"
            onClick={() => void onContinue()}
            disabled={continued || agentBusy}
            className={cn(
              "rounded border border-violet-500/30 px-2 py-1 text-[10px] font-medium",
              "text-violet-600 hover:bg-violet-500/10 dark:text-violet-400",
              "disabled:cursor-default disabled:opacity-60",
            )}
            title={agentBusy ? "等待当前 Agent 回应结束后再继续" : "将已关联结果交给 Agent 继续讲解"}
          >
            {continued ? "已交给 Agent 继续讲解" : "基于结果继续讲解"}
          </button>
        </div>
      ) : null}
      {execution?.status === "timed-out" ? (
        <div className="text-[10px] text-amber-600 dark:text-amber-400">
          {Math.round(TEACHING_EXECUTION_TIMEOUT_MS / 1000)} 秒内未检测到该命令的完成标记。请检查终端；为避免重复执行，本卡不会再次注入，也不会把不确定的滚屏结果交给 Agent。
        </div>
      ) : null}
      {cardError ? <div className="text-[10px] text-destructive">{cardError}</div> : null}
    </div>
  );
}

function TerminalOutputCard({ data }: { data: Record<string, unknown> }) {
  const output = typeof data.output === "string" ? data.output : "";
  const requested =
    typeof data.lines_requested === "number" ? data.lines_requested : null;
  const returned =
    typeof data.lines_returned === "number" ? data.lines_returned : null;
  const available = data.available !== false;
  const truncated = data.truncated === true;
  const hasMore = data.has_more === true;
  const note = typeof data.note === "string" ? data.note : "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <span
          className={cn(
            "size-1.5 rounded-full",
            available ? "bg-emerald-500" : "bg-muted-foreground/50",
          )}
        />
        <span>
          {available
            ? output
              ? "已读取终端回显"
              : "终端已连接（暂无回显）"
            : "终端回读不可用"}
        </span>
        {returned != null ? (
          <span className="font-mono tabular-nums">
            {returned}
            {requested != null ? `/${requested}` : ""} 行
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400">
            已截断
          </span>
        ) : null}
        {hasMore && !truncated ? (
          <span className="rounded bg-muted px-1">尾部</span>
        ) : null}
      </div>
      {output ? (
        <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {output}
        </pre>
      ) : (
        <div className="rounded bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
          {note || "当前终端没有可读取的输出。"}
        </div>
      )}
      {output && note ? (
        <div className="text-[10px] text-muted-foreground">{note}</div>
      ) : null}
    </div>
  );
}

function SshCommandOutput({ data }: { data: Record<string, unknown> }) {
  const output = typeof data.output === "string" ? data.output : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const explanation =
    typeof data.explanation === "string" && data.explanation.trim()
      ? data.explanation.trim()
      : null;
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const duration = typeof data.duration === "number" ? data.duration : null;
  const body = output || stderr || "（命令没有产生可展示的输出）";
  const durationLabel =
    duration == null
      ? null
      : duration < 1
        ? `${Math.max(1, Math.round(duration * 1000))} ms`
        : `${duration.toFixed(duration < 10 ? 2 : 1)} s`;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
          命令已返回
        </span>
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
            )}
          >
            退出码 {exit}
          </span>
        ) : null}
        {durationLabel ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            耗时 {durationLabel}
          </span>
        ) : null}
      </div>
      {explanation ? (
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="mr-1 font-medium text-foreground/80">命令说明</span>
          {explanation}
        </div>
      ) : null}
      <div className="text-[10px] font-medium text-muted-foreground">终端输出</div>
      <pre className="max-h-72 overflow-auto rounded-md border border-border/45 bg-muted/35 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
        {body}
      </pre>
    </div>
  );
}

// Compatibility re-exports — the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };
