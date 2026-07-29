/**
 * RiskEngine index — TDSF 自研 4 层风险评估引擎
 * -----------------------------------------------------------------------------
 * 公共 API：
 *   evaluate(command: string): RiskAssessment   — 同步评估单条命令
 *
 * 集成点：
 *   src/modules/terminal/lib/useTerminalSession.ts → submitToLeaf
 *   写入 PTY 前调用 evaluate()，命中 L3 弹窗、命中 L4 直接拒绝
 *
 * 设计：
 *   - 纯函数（无状态），便于测试
 *   - 同步返回（命令拦截必须 < 10ms，否则终端输入卡顿）
 *   - 复用 TDSF 现有 alert-dialog UI（无需自造组件）
 */
import { maxLevel, RISK_RULES } from "./rules";
import type { RiskAssessment, RiskLevel } from "./types";

const LEVEL_PROMPT: Record<RiskLevel, string> = {
  safe: "无风险",
  low: "低风险（仅审计）",
  medium: "中风险（系统配置变更）",
  high: "高风险（不可逆操作）",
  deny: "黑名单（系统拒绝）",
};

/**
 * 评估单条命令的风险等级
 *
 * @param command 完整命令字符串（可能含管道、重定向）
 * @returns RiskAssessment — 包含 level / ruleName / requiresConfirmation
 *
 * 示例：
 *   evaluate("ls -la")              → safe
 *   evaluate("rm -rf /tmp/foo")     → high
 *   evaluate("rm -rf /")            → deny
 *   evaluate("systemctl restart nginx") → medium
 */
export function evaluate(command: string): RiskAssessment {
  // 空命令视为 safe
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      level: "safe",
      ruleName: null,
      description: "空命令",
      requiresConfirmation: false,
      promptText: "无风险",
    };
  }

  // 过滤 # 注释
  if (trimmed.startsWith("#")) {
    return {
      level: "safe",
      ruleName: null,
      description: "注释",
      requiresConfirmation: false,
      promptText: "无风险",
    };
  }

  // 收集所有命中规则
  const matched = RISK_RULES.filter((r) =>
    r.patterns.some((p) => p.test(trimmed)),
  );

  const { level, rule } = maxLevel(matched);

  return {
    level,
    ruleName: rule?.name ?? null,
    description: rule?.description ?? "未匹配风险规则",
    requiresConfirmation: rule?.requiresConfirmation ?? false,
    promptText: rule ? `${LEVEL_PROMPT[level]}：${rule.description}` : "无风险",
  };
}

/**
 * 工具：是否需要阻断（弹窗或拒绝）
 */
export function shouldBlock(assessment: RiskAssessment): boolean {
  return assessment.level === "deny" || assessment.requiresConfirmation;
}

export { RISK_RULES } from "./rules";
export type { RiskAssessment, RiskLevel, RiskRule } from "./types";
