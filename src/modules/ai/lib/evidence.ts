/**
 * evidence.ts — 会话证据（P1-2）
 * -----------------------------------------------------------------------------
 * AI 结论的证据 = 会话内真实发生的工具调用记录（后端 EvidenceTracker，
 * 经 evidence.list RPC 拉取）。前端在对话流底部展示"证据"折叠区，
 * 让用户核验 AI 依据了哪些真实操作（可观测性/可信度）。
 */

export interface EvidenceItem {
  tool_name: string;
  status: string;
  detail: string;
  result: string;
  agent: string;
  timestamp: number;
  source?: string;
}

/** 拉取会话证据列表（sidecar 不可用/无会话时返回空） */
export async function fetchEvidence(
  sessionId: string | null,
): Promise<EvidenceItem[]> {
  if (!sessionId) return [];
  try {
    const { invokeRpc } = await import("@/lib/sidecar-bridge");
    const result = await invokeRpc<EvidenceItem[] | null>("evidence.list", {
      session_id: sessionId,
    });
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

/** 证据工具名 → 展示标签（与后端 tool_name 对齐） */
export function evidenceLabel(toolName: string): string {
  if (toolName.startsWith("agent:")) {
    const name = toolName.slice("agent:".length);
    return `${name} Agent`;
  }
  const map: Record<string, string> = {
    ssh_command: "SSH 命令",
    read_remote_file: "读远程文件",
    analyze_logs: "日志分析",
    inspect_processes: "进程检查",
    network_diagnose: "网络诊断",
    skill_invoke: "技能调用",
    suggest_command: "命令建议",
    knowledge_search: "知识库检索",
    knowledge_get_doc: "知识库文档",
  };
  return map[toolName] ?? toolName;
}

/** 时间戳 → 短时间（HH:MM:SS） */
export function evidenceTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ============================================================================
// T10.2 证据三段分组（2026-09-01，spec 10.2 / 方案书 v4.0 P2）
// ----------------------------------------------------------------------------
// 按"收集（只读探查）→ 执行（写操作）→ 验证（写后只读确认）"分组，与
// Python 侧 registry.py 的 WRITE_CLASS_TOOL_NAMES / VERIFY_CLASS_TOOL_NAMES
// 语义对齐（改两侧需同步）。分组是**时序语义**：同为只读工具，写操作之前
// 的调用算"收集"、之后的算"验证"。
// ============================================================================

/** 写类工具（与 strands_backend/tools/registry.py WRITE_CLASS_TOOL_NAMES 对齐） */
export const WRITE_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ssh_command",
  "python_run",
  "service_manage",
  "package_manage",
  "firewall_manage",
  "backup_restore",
  "save_skill",
]);

/** 验证类工具（只读，写操作后出现即为"验证"；与 VERIFY_CLASS_TOOL_NAMES 对齐） */
export const VERIFY_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_remote_file",
  "config_diff",
  "analyze_logs",
  "inspect_processes",
  "network_diagnose",
  "get_terminal_output",
  "knowledge_search",
  "knowledge_get_doc",
]);

export type EvidenceStage = "collect" | "execute" | "verify";

/** 单条证据归属三段之一（时序语义：sawWrite 前的验证类调用算收集） */
export function classifyEvidenceStage(
  item: EvidenceItem,
  sawWrite: boolean,
): EvidenceStage {
  const tool = item.tool_name.replace(/^agent:/, "");
  if (WRITE_CLASS_TOOL_NAMES.has(tool)) return "execute";
  if (VERIFY_CLASS_TOOL_NAMES.has(tool) && sawWrite) return "verify";
  return "collect";
}

/**
 * 全量证据分组（保持时间序，组内仍按时间）。
 * 返回 [收集, 执行, 验证] 三组 + 各组条目（空组为空数组，UI 隐藏）。
 */
export function groupEvidence(items: EvidenceItem[]): {
  collect: EvidenceItem[];
  execute: EvidenceItem[];
  verify: EvidenceItem[];
} {
  const groups = { collect: [], execute: [], verify: [] } as {
    collect: EvidenceItem[];
    execute: EvidenceItem[];
    verify: EvidenceItem[];
  };
  let sawWrite = false;
  for (const item of items) {
    const stage = classifyEvidenceStage(item, sawWrite);
    groups[stage].push(item);
    if (stage === "execute") sawWrite = true;
  }
  return groups;
}
