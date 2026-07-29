/**
 * RiskEngine — TypeScript 风险等级类型
 * -----------------------------------------------------------------------------
 * 4 层风险控制 + 1 个 deny 级（与自研 Python sidecar 协议对齐）：
 *   L0  safe       无任何风险动作
 *   L1  low        写入本地文件/创建进程
 *   L2  medium     修改系统级配置（包管理、systemctl）
 *   L3  high       不可逆 + 需用户二次确认（如 rm -rf /、mkfs、dd of=/dev/sda）
 *   L4  deny       黑名单规则直接拒绝（如 :(){:|:&};: fork 炸弹、chmod -R 777 /）
 *
 * 设计依据：tdsf-terminal-agent/python-sidecar/core/schemas.py
 * 原 Python 实现走 4 层（low/medium/high/deny），TypeScript 端扩展 L0 safe
 * 便于前端 UI 区分"无风险" vs "低风险"。
 */
export type RiskLevel = "safe" | "low" | "medium" | "high" | "deny";

export interface RiskRule {
  /** 规则唯一名，例：rm_rf_root、fork_bomb */
  name: string;
  /** 规则描述，对话框里展示给用户 */
  description: string;
  /** 正则匹配列表（任一匹配即命中，re.test() 模式） */
  patterns: RegExp[];
  /** 命中后的风险等级 */
  level: RiskLevel;
  /** 是否需要人工确认（L3） */
  requiresConfirmation: boolean;
  /** 是否需要审计日志（L3+） */
  requiresAuditLog: boolean;
  /** 是否为不可逆操作（仅展示用） */
  irreversible: boolean;
}

export interface RiskAssessment {
  /** 风险等级（最高命中规则的 level） */
  level: RiskLevel;
  /** 命中的规则名（多条则取 level 最高那条） */
  ruleName: string | null;
  /** 命中规则的描述（用于对话框） */
  description: string;
  /** 是否需要弹窗确认 */
  requiresConfirmation: boolean;
  /** 建议的对话框措辞（中文） */
  promptText: string;
}
