/**
 * evidence.ts — 会话证据（P1-2）
 * -----------------------------------------------------------------------------
 * 会话级真实工具记录，经 evidence.list RPC 拉取，供独立证据页的数据准备。
 * 工具卡 ID 与 SDK 调用 ID 分开，缺失标识不补造；记录不证明模型结论正确。
 */

export interface EvidenceItem {
  tool_name: string;
  status: string;
  detail: string;
  result: string;
  agent: string;
  timestamp: number;
  source?: string;
  /** 记录自身的稳定标识，与工具卡/SDK 调用标识独立；旧记录可能缺失。 */
  evidence_id?: string;
  /** 仅表示本地长度裁剪；false 不意味着摘要无损或原输出完整。 */
  detail_truncated?: boolean;
  summary_truncated?: boolean;
  /** 工具明确报告的截断状态；缺失表示未采集。 */
  output_truncated?: boolean;
  /** 已取得的非负整数退出码；缺失不推定为 0，非零不直接等于失败。 */
  exit_code?: number;
  tool_call_id?: string;
  sdk_tool_use_id?: string;
  ssh_session_id?: string;
  target_endpoint?: string;
  operation_id?: string;
  result_status?: string;
  result_ok?: boolean;
  result_available?: boolean;
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
    write_remote_file: "写远程文件",
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
// 的调用算"收集"、之后的算"验证"。这仅是时序分组，不证明同目标验证完成。
// ============================================================================

/** 写类工具（与 strands_backend/tools/registry.py WRITE_CLASS_TOOL_NAMES 对齐） */
export const WRITE_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ssh_command",
  "python_run",
  "service_manage",
  "package_manage",
  "firewall_manage",
  "backup_restore",
  "write_remote_file",
  "save_skill",
]);

/** 验证类工具（只读，写操作后出现即为"验证"；与 VERIFY_CLASS_TOOL_NAMES 对齐）
 *
 * 单一真源 = `strands_backend/tools/registry.py` 的 VERIFY_CLASS_TOOL_NAMES，
 * 此处是前端镜像，**改一侧必须同步另一侧**（2026-09-02 曾因漏同步少一个
 * suggest_command）。
 * 已知不对称（有意保留）：ssh_command 在 Python 侧按命令内容细分只读/写
 * （`adapter.py` 的命令级判定），前端只看 tool_name 故一律归"执行"——
 * 证据分组是展示层语义，不在这里复刻命令解析逻辑。
 */
export const VERIFY_CLASS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_remote_file",
  "config_diff",
  "analyze_logs",
  "inspect_processes",
  "network_diagnose",
  "get_terminal_output",
  "knowledge_search",
  "knowledge_get_doc",
  "suggest_command",
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
