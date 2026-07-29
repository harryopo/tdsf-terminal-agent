// TDSF 魔改: RiskEngine RPC 客户端 (T2.2)
// -----------------------------------------------------------------------------
// 通过 Tauri ipc_invoke 调用 Python Sidecar 的 risk.evaluate JSON-RPC 方法，
// 获取 L0-L4 风险等级。失败时 fail-open 回退到本地 TS 同步评估（./index.ts），
// 保证 Sidecar 不可用时终端仍可正常使用。
//
// 协议对齐：
//   - Python tools/risk.py 返回 { level: "L0"|"L1"|"L2"|"L3"|"L4", risk_level:
//     "low"|"medium"|"high"|"deny", require_approval: bool, reason: string, ... }
//   - 前端 RiskLevel 用 "safe"|"low"|"medium"|"high"|"deny"（与现有 rules.ts 对齐）
//   - L0/L1 → safe/low（放行） / L2 → medium（放行） / L3 → high（弹窗） / L4 → deny（拒绝）
//
// 注意：
//   - Rust 端 ipc_invoke 返回 Result<Value, IPCError>，成功时 Value 直接序列化为
//     JSON 对象给前端；错误时 IPCError 序列化为字符串。因此前端用 invoke<unknown>
//     拿到对象，无需 JSON.parse。
import { invoke } from "@tauri-apps/api/core";
import { evaluate as evaluateLocal } from "./index";
import type { RiskAssessment, RiskLevel } from "./types";

/** Python sidecar risk.evaluate 返回的原始 payload（未知字段用 unknown 兜底） */
export interface RiskRpcPayload {
  level?: string;
  risk_level?: string;
  reason?: string;
  require_approval?: boolean;
  require_audit_log?: boolean;
  is_irreversible?: boolean;
  syntax_valid?: boolean;
  syntax_error?: string;
  matched_rule_name?: string;
}

/** RPC 返回的扩展 assessment（带 source 标识，便于 UI 区分来源） */
export interface RiskRpcAssessment extends RiskAssessment {
  /** 评分来源：rpc（Python sidecar） / local（TS fallback） */
  source: "rpc" | "local";
}

/** Python L0-L4 → 前端 RiskLevel 映射 */
function mapL0L4ToFrontendLevel(
  l0L4: string | undefined,
  riskLevel: string | undefined,
): RiskLevel {
  // 优先用 L0-L4 字符串
  if (l0L4) {
    const upper = l0L4.toUpperCase();
    if (upper === "L0") return "safe";
    if (upper === "L1") return "low";
    if (upper === "L2") return "medium";
    if (upper === "L3") return "high";
    if (upper === "L4") return "deny";
  }
  // 回退到 risk_level 字段
  if (riskLevel) {
    const lower = riskLevel.toLowerCase();
    if (lower === "low") return "low";
    if (lower === "medium") return "medium";
    if (lower === "high") return "high";
    if (lower === "deny") return "deny";
  }
  // 默认 safe（fail-open）
  return "safe";
}

/** 类型守卫：判断 invoke 返回值是否为对象（RPC 成功响应） */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 将 RPC payload 转换为 RiskRpcAssessment */
function payloadToAssessment(payload: RiskRpcPayload): RiskRpcAssessment {
  const level = mapL0L4ToFrontendLevel(payload.level, payload.risk_level);
  const ruleName = payload.matched_rule_name ?? payload.reason ?? null;
  const description = payload.reason ?? payload.matched_rule_name ?? "";
  const requiresConfirmation =
    level === "high" || (payload.require_approval ?? false);
  const promptText = `[RPC] ${level}：${description || "无描述"}`;
  return {
    level,
    ruleName,
    description,
    requiresConfirmation,
    promptText,
    source: "rpc",
  };
}

/**
 * 调用 Python sidecar 评估命令风险。
 *
 * fail-open 策略：
 *   - Sidecar 未运行 / 方法未注册 / 超时 / 返回格式异常 → 回退到本地 TS evaluate
 *   - 本地 evaluate 是同步纯函数，保证终端输入不卡顿
 *
 * @param command 待评估的命令字符串
 * @returns RiskRpcAssessment（含 source 标识）
 */
export async function evaluateRisk(
  command: string,
): Promise<RiskRpcAssessment> {
  try {
    const raw = await invoke<unknown>("ipc_invoke", {
      method: "risk.evaluate",
      params: { command },
    });
    if (!isObject(raw)) {
      // 返回值不是对象（可能是 null / 字符串错误），回退到本地
      return localFallback(command);
    }
    const payload = raw as RiskRpcPayload;
    return payloadToAssessment(payload);
  } catch {
    // Sidecar 不可用 / 方法未注册 / 网络错误 → fail-open 回退
    return localFallback(command);
  }
}

/** 本地 TS fallback（同步评估） */
function localFallback(command: string): RiskRpcAssessment {
  const local = evaluateLocal(command);
  return { ...local, source: "local" };
}

/**
 * 同步快速评估（不调 RPC，用于终端输入快速拦截）。
 *
 * 终端输入需要 < 10ms 响应，不能等待 async RPC。
 * 先用同步 TS 评估快速拦截 L3+ 命令，命中后再异步调 RPC 获取精确评分。
 */
export function evaluateRiskSync(command: string): RiskRpcAssessment {
  return localFallback(command);
}
