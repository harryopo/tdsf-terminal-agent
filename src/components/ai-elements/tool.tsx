"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  BookOpen01Icon,
  Cancel01Icon,
  CheckListIcon,
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
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  categoryGroupLabel,
  plainSummary,
  sourceGroupLabel,
} from "@/modules/ai/lib/knowledge-labels";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useEffect, useState } from "react";


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

/** L 级色带（跟随现有 badge 色板：L0-L1 绿 / L2 黄 / L3 橙 / L4 红） */
const RISK_BADGE: Record<number, string> = {
  0: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  1: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  2: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  3: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  4: "bg-destructive/15 text-destructive",
};

const RISK_LABEL: Record<number, string> = {
  0: "L0 无风险",
  1: "L1 低风险",
  2: "L2 中风险",
  3: "L3 高风险",
  4: "L4 危险",
};

type ToolApprovalCardProps = {
  toolName: string;
  /** 工具调用 input（四层字段：semantic / command / explanation / impact / risk_l） */
  input?: unknown;
  onRespond: ToolApprovalRespond;
  className?: string;
};

/**
 * 四层审批卡（自上而下）：
 * ① 语义描述（semantic，如「想重启服务：nginx」）
 * ② 命令原文（代码块，永不改写）
 * ③ 解释（LLM 用途解释，缺失显示「（无解释）」）
 * ④ 影响预测（类别标签 + 对象列表 + L0-L4 风险色带）
 *
 * 三按钮：【拒绝】（可展开附言）【⚡批准且本会话只读免审】（仅 L0-L1）【▶执行】
 * L3/L4 无「本会话/永久」类选项（⚡按钮仅 risk_l ≤ 1 渲染）。
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
  const riskL =
    typeof i.risk_l === "number"
      ? i.risk_l
      : typeof impact?.max_risk_l === "number"
        ? impact.max_risk_l
        : null;
  const denied = impact?.denied === true;
  const dangerous = impact?.dangerous_construct === true;
  // ⚡会话免审仅低风险且无黑名单/危险构造时提供（L3/L4 永远逐条确认）
  const canSessionTrust =
    riskL != null && riskL <= 1 && !denied && !dangerous;

  const rejectWithNote = () => {
    onRespond({ approved: false, note: note.trim() || undefined });
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/40 bg-card shadow-sm",
        className,
      )}
      data-approval-card={toolName}
    >
      {/* 卡头 */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
        <HugeiconsIcon
          icon={ShieldUserIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">
          需要你的确认
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>

      <div className="space-y-2.5 px-3 py-2.5">
        {/* ① 语义描述 */}
        <div className="text-[12px] text-foreground">
          {semantic || "Agent 请求执行操作"}
        </div>

        {/* ② 命令原文（永不改写） */}
        {command ? (
          <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed text-foreground">
            {command}
          </pre>
        ) : null}

        {/* ③ 解释 */}
        {explanation ? (
          <div className="text-[11px] text-muted-foreground">{explanation}</div>
        ) : (
          <div className="text-[11px] italic text-muted-foreground/60">
            （无解释）
          </div>
        )}

        {/* ④ 影响预测 */}
        <div className="space-y-1.5 rounded border border-border/50 bg-muted/20 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-medium text-muted-foreground">
              影响预测
            </span>
            {riskL != null && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-[10px] font-medium",
                  RISK_BADGE[riskL] ?? RISK_BADGE[3],
                )}
              >
                {RISK_LABEL[riskL] ?? `L${riskL}`}
              </span>
            )}
            {denied && (
              <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                命中硬底线黑名单
              </span>
            )}
            {dangerous && (
              <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                含危险构造
              </span>
            )}
          </div>
          {impact?.summary ? (
            <div className="text-[11px] text-foreground">{impact.summary}</div>
          ) : null}
          {impact?.segments?.length ? (
            <div className="space-y-0.5">
              {impact.segments.slice(0, 6).map((seg, idx) => (
                <div
                  key={idx}
                  className="flex flex-wrap items-center gap-1.5 text-[10.5px]"
                >
                  {seg.category_label && (
                    <span className="rounded bg-foreground/8 px-1 py-0.5 text-muted-foreground">
                      {seg.category_label}
                    </span>
                  )}
                  {seg.objects?.length ? (
                    <span className="min-w-0 truncate font-mono text-muted-foreground">
                      {seg.objects.join("、")}
                    </span>
                  ) : null}
                  {seg.denied && seg.deny_reason && (
                    <span className="text-destructive">{seg.deny_reason}</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          {!impact?.summary && !impact?.segments?.length && (
            <div className="text-[11px] text-orange-700 dark:text-orange-400">
              影响未知——请人工审查
            </div>
          )}
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
      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
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
            className="h-7 gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400"
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

const TOOL_META: Record<string, { label: string; icon: typeof File01Icon }> = {
  read_file: { label: "Read", icon: File01Icon },
  list_directory: { label: "List", icon: FolderOpenIcon },
  write_file: { label: "Write", icon: FilePlusIcon },
  create_directory: { label: "Create dir", icon: FolderAddIcon },
  edit: { label: "Edit", icon: FileEditIcon },
  multi_edit: { label: "Edit", icon: Edit02Icon },
  bash_run: { label: "Run", icon: TerminalIcon },
  bash_background: { label: "Spawn", icon: TerminalIcon },
  bash_logs: { label: "Logs", icon: TerminalIcon },
  bash_list: { label: "Jobs", icon: TerminalIcon },
  bash_kill: { label: "Kill", icon: TerminalIcon },
  grep: { label: "Search", icon: GlobalSearchIcon },
  glob: { label: "Glob", icon: Folder01Icon },
  suggest_command: { label: "Suggest", icon: SparklesIcon },
  open_preview: { label: "Preview", icon: EyeIcon },
  run_subagent: { label: "Subagent", icon: RobotIcon },
  todo_write: { label: "Todos", icon: CheckListIcon },
  // P2-4: 知识库检索（RAG 混合检索工具）
  knowledge_search: { label: "知识库", icon: BookOpen01Icon },
  // TDSF 2026-08-31 双库: 知识库完整文档读取（knowledge_get_doc）
  knowledge_get_doc: { label: "文档", icon: BookOpen01Icon },
  // P2-3: 扩展运维工具
  service_manage: { label: "服务", icon: TerminalIcon },
  package_manage: { label: "包管理", icon: TerminalIcon },
  firewall_manage: { label: "防火墙", icon: ShieldUserIcon },
  security_audit: { label: "安全审计", icon: ShieldUserIcon },
  performance_analyze: { label: "性能", icon: TerminalIcon },
};

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
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

function getToolMeta(toolName: string): { label: string; icon: typeof File01Icon } {
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
    return { label, icon: RobotIcon };
  }
  return TOOL_META[toolName] ?? { label: toolName, icon: ToolsIcon };
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
      return str("path");
    case "bash_run":
    case "bash_background":
    case "ssh_command":
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
  "edit",
  "multi_edit",
  "run_subagent",
  "todo_write",
]);

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
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  const open = defaultOpen ?? isError;
  const isHeavy = HEAVY_CONTENT_TOOLS.has(toolName);
  // For heavy tools, only show details on error — never the streamed input
  // body, which is huge and re-renders per token.
  const showInputBody = !isHeavy && Boolean(input);
  const showOutputBody = !isHeavy && output !== undefined;
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText);

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
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent
          className={cn("terax-collapsible-content")}
        >
          <div className="ml-3 mt-1 space-y-2 border-l border-border/60 pl-3 pb-1">
            {showInputBody ? (
              <ToolInput toolName={toolName} input={input} />
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
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          Input
        </div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Input</div>
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
            {timeout ? `${timeout}s` : null}
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

  return null;
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

  return (
    <div className="space-y-1">
      <div className="space-y-1">
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
      <div className="text-[10px] text-muted-foreground">
        {hits.length} 条结果
        {typeof data.query === "string" && data.query
          ? ` · 「${data.query}」`
          : ""}
      </div>
    </div>
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
  if (!content) return null;

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
      <CollapsibleContent className="terax-collapsible-content">
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

function SuggestCommandCard({
  command,
  explanation,
  predictedOutput,
}: {
  command: string;
  explanation: string | null;
  predictedOutput: string | null;
}) {
  const [inserted, setInserted] = useState(false);
  const [showPredicted, setShowPredicted] = useState(false);
  const onInsert = () => {
    const store = useChatStore.getState();
    // TDSF 魔改 (2026-08-09): 终端执行模式——加换行符自动执行命令
    const text = store.autoExecuteInTerminal ? command + "\n" : command;
    const ok = store.live.injectIntoActivePty(text);
    if (ok) setInserted(true);
  };
  // TDSF 魔改 (2026-08-09): 终端执行模式——自动执行（组件渲染时触发一次）
  useEffect(() => {
    if (inserted) return;
    const { autoExecuteInTerminal, live } = useChatStore.getState();
    if (!autoExecuteInTerminal) return;
    const ok = live.injectIntoActivePty(command + "\n");
    if (ok) setInserted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 command 变化时触发
  }, [command]);
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
          {command}
        </pre>
        <button
          type="button"
          onClick={onInsert}
          disabled={inserted}
          className={cn(
            "shrink-0 flex items-center gap-1 px-2.5 text-[11px] font-medium",
            "border-l border-border/60",
            "hover:bg-muted/80 active:bg-muted",
            "disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label="Insert into active terminal"
        >
          <HugeiconsIcon
            icon={inserted ? TerminalIcon : ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
      {/* TDSF 魔改 (2026-08-09): 预测回显——让用户提前知道命令执行后应看到什么 */}
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

// Compatibility re-exports — the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };
