// TDSF 魔改: Confidence RPC 客户端 (T2.3)
// -----------------------------------------------------------------------------
// 通过 Tauri ipc_invoke 调用 Python Sidecar 的 confidence.score JSON-RPC 方法，
// 获取 AI 消息的置信度评分（0-1）。失败时 fail-open 回退到本地 TS 评分
//（./index.ts 的 scoreConfidence），保证 Sidecar 不可用时 AI 聊天仍可正常使用。
//
// 协议对齐：
//   - 任务约定的 RPC 接口：params = { message: string, history: string[] }
//   - 返回：{ score: number, ... }
//   - Python sidecar 的 confidence.score 方法（tools/rpc_methods.py）在简单
//     模式下按启发式构造 evidence 再走 D-S+PCR5 融合，返回
//     { score, method, conflict, evidence_count, grounded_count }。
//   - RPC 失败时回退到本地 TS 评分（5 维信号词匹配，含 breakdown 明细）。
//
// TDSF 2026-08-31 (问题3修复): 低置信度必须附原因——此前 UI 只显示"置信度 低"
// 无任何解释（用户实测反馈）。现在评分结果附带 reason 字段（人话原因）：
//   - local 来源：从 5 维 breakdown 提取低分维度（未引用权威来源等）
//   - rpc 来源：从 grounded_count/evidence_count/conflict 生成
// 无原因可生成时 reason=null，UI 按约定不显示标签（简洁优先）。
import { invoke } from "@tauri-apps/api/core";
import {
  scoreConfidence as scoreConfidenceLocal,
  type ConfidenceBreakdown,
} from "./index";

/** Python sidecar confidence.score 返回的原始 payload */
export interface ConfidenceRpcPayload {
  score?: number;
  method?: string;
  conflict?: number;
  evidence_count?: number;
  grounded_count?: number;
}

/** RPC 返回的扩展结果（带 source 标识 + 低置信度原因） */
export interface ConfidenceRpcResult {
  /** 综合置信度 [0, 1] */
  score: number;
  /** 评分来源：rpc（Python sidecar） / local（TS fallback） */
  source: "rpc" | "local";
  /** 5 维明细（仅 local 来源时有值） */
  breakdown?: ReturnType<typeof scoreConfidenceLocal>["breakdown"];
  /**
   * 低置信度原因（人话，供 UI 直接展示，如"未引用权威来源"）。
   * null = 无原因可生成（UI 约定：此时不显示置信度标签）。
   */
  reason?: string | null;
}

/** 类型守卫 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * TDSF 2026-08-31 (问题3修复): 从本地 5 维 breakdown 提取低置信度原因。
 * 只取最关键的至多 2 条，避免 UI 堆砌；全部达标时返回 null。
 */
export function localConfidenceReason(b: ConfidenceBreakdown): string | null {
  const parts: string[] = [];
  if (b.source < 0.5) parts.push("未引用权威来源");
  if (b.verifiability < 0.5) parts.push("缺少可验证细节（命令/路径/数字）");
  if (b.specificity < 0.5) parts.push("缺少具体版本号/错误码");
  if (b.consistency < 0.9) parts.push("表述存在自相矛盾");
  if (b.terminology < 0.5) parts.push("术语不够精确");
  return parts.length ? parts.slice(0, 2).join("、") : null;
}

/** TDSF 2026-08-31 (问题3修复): 从 RPC payload 提取低置信度原因 */
export function rpcConfidenceReason(p: ConfidenceRpcPayload): string | null {
  const parts: string[] = [];
  if (
    typeof p.evidence_count === "number" &&
    typeof p.grounded_count === "number"
  ) {
    if (p.evidence_count > 0 && p.grounded_count === 0) {
      parts.push("未检索到可靠来源佐证");
    } else if (p.grounded_count < p.evidence_count) {
      parts.push(
        `仅 ${p.grounded_count}/${p.evidence_count} 条证据落地`,
      );
    }
  }
  if (typeof p.conflict === "number" && p.conflict >= 0.3) {
    parts.push("证据间存在冲突");
  }
  return parts.length ? parts.slice(0, 2).join("；") : null;
}

/** 本地 TS fallback */
function localFallback(message: string): ConfidenceRpcResult {
  const local = scoreConfidenceLocal(message);
  return {
    score: local.score,
    source: "local",
    breakdown: local.breakdown,
    reason: localConfidenceReason(local.breakdown),
  };
}

/**
 * 调用 Python sidecar 评分 AI 消息置信度。
 *
 * fail-open 策略：
 *   - Sidecar 未运行 / 方法未注册 / 超时 / 返回格式异常 → 回退到本地 TS 评分
 *   - 本地评分基于 5 维信号词匹配，覆盖 80% 实战场景
 *
 * @param message AI 回复消息文本
 * @param history 历史消息列表（可选，用于上下文一致性评分）
 * @returns ConfidenceRpcResult（含 score + source + reason）
 */
export async function scoreConfidenceRpc(
  message: string,
  history: string[] = [],
): Promise<ConfidenceRpcResult> {
  try {
    const raw = await invoke<unknown>("ipc_invoke", {
      method: "confidence.score",
      params: { message, history },
    });
    if (!isObject(raw)) {
      return localFallback(message);
    }
    const payload = raw as ConfidenceRpcPayload;
    if (typeof payload.score !== "number") {
      return localFallback(message);
    }
    // 钳位到 [0, 1]
    const score = Math.max(0, Math.min(1, payload.score));
    return { score, source: "rpc", reason: rpcConfidenceReason(payload) };
  } catch {
    // Sidecar 不可用 / 方法未注册 → fail-open 回退
    return localFallback(message);
  }
}

/**
 * 同步快速评分（不调 RPC，用于流式过程中的实时标记）。
 *
 * 流式过程中消息不断变化，不能每次都调 RPC。
 * 用本地 TS 评分做实时标记，流式结束后再调 RPC 获取精确评分。
 */
export function scoreConfidenceSync(message: string): ConfidenceRpcResult {
  return localFallback(message);
}

/** 置信度 → CSS 边框颜色（用于消息容器视觉标记） */
export function confidenceBorderColor(score: number): string {
  if (score < 0.3) return "#ef4444"; // red-500
  if (score < 0.5) return "#f59e0b"; // amber-500
  return "transparent"; // 正常样式
}

/** 置信度 → 标签文本（用于顶部标记） */
export function confidenceLabel(score: number): string | null {
  if (score < 0.3) return "⚠ 不确定";
  if (score < 0.5) return "🤔 较低置信";
  return null; // 正常样式不显示标签
}
