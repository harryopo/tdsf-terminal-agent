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
