/**
 * RiskEngine rules — 内置高危命令规则库（TDSF 自研）
 * -----------------------------------------------------------------------------
 * 规则分类：
 *   L4 deny  → 直接拒绝（如 fork 炸弹、chmod -R 777 /）
 *   L3 high  → 必须二次确认（如 rm -rf /、mkfs、dd of=/dev/sda）
 *   L2 medium → 默认中风险（如 systemctl restart）
 *   L1 low   → 仅记录（如 ping、curl localhost）
 *
 * 来源：tdsf-terminal-agent/python-sidecar/core/risk_engine.py
 *       + tdsf-terminal-agent/python-sidecar/config/risk_rules.yaml
 * 这里用 TypeScript 简化版（覆盖 80% 实战场景，避免过度复杂化）。
 */
import type { RiskLevel, RiskRule } from "./types";

// 优先级排序（deny > high > medium > low > safe）
const LEVEL_PRIORITY: Record<RiskLevel, number> = {
  deny: 4,
  high: 3,
  medium: 2,
  low: 1,
  safe: 0,
};

export const RISK_RULES: RiskRule[] = [
  // ============ L4 deny: 永远拒绝 ============
  {
    name: "fork_bomb",
    description: "Fork 炸弹（耗尽系统进程）",
    // 匹配 :(){ :|:& };: 或 :(){:|:&};: 等变体
    patterns: [
      /:[ \t]*\([ \t]*\)[ \t]*\{[ \t]*:[ \t]*\|[ \t]*:[ \t]*&[ \t]*\}[ \t]*;/,
    ],
    level: "deny",
    requiresConfirmation: false,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "chmod_777_recursive_root",
    description: "对根目录递归 777（破坏权限）",
    patterns: [/chmod\s+(-R|--recursive)\s+777\s+(\/|~|\$\{HOME\})(\s|$)/],
    level: "deny",
    requiresConfirmation: false,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "rm_root_wildcard",
    description: "rm -rf / 或 /*（擦除系统）",
    // 匹配 rm -rf /、rm -rf /*、rm -rf ~/ 等
    patterns: [
      /\brm\s+(?:-[\w]*[rR][\w]*\s+)*-[\w]*[fF][\w]*\s+\/(?:\s|$|\*)/,
      /\brm\s+(?:-[\w]*[rR][\w]*\s+)*-[\w]*[fF][\w]*\s+\/\*/,
      /\brm\s+-rf\s+--no-preserve-root\s+\//,
    ],
    level: "deny",
    requiresConfirmation: false,
    requiresAuditLog: true,
    irreversible: true,
  },

  // ============ L3 high: 必须二次确认 ============
  {
    name: "rm_rf_recursive",
    description: "递归删除（不可逆）",
    // 任意 rm -rf 路径，但不命中根目录（上面已 deny）
    patterns: [/\brm\s+(-[a-zA-Z]*[rfRF][a-zA-Z]*|--recursive|--force)\b/],
    level: "high",
    requiresConfirmation: true,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "mkfs_format",
    description: "格式化文件系统（擦除分区）",
    patterns: [/\bmkfs(\.\w+)?\s+\/dev\//],
    level: "high",
    requiresConfirmation: true,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "dd_to_block_device",
    description: "向块设备写入（可能擦除数据）",
    patterns: [/\bdd\s+.*\bof=\/dev\/(sd|hd|nvme|vd|mmcblk)/],
    level: "high",
    requiresConfirmation: true,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "shutdown_reboot",
    description: "关机/重启",
    patterns: [/\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/],
    level: "high",
    requiresConfirmation: true,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "disk_partition",
    description: "磁盘分区操作（fdisk/parted）",
    patterns: [/\b(fdisk|parted|mkfs\.\w+)\s+\/dev\//],
    level: "high",
    requiresConfirmation: true,
    requiresAuditLog: true,
    irreversible: true,
  },
  {
    name: "wget_pipe_shell",
    description: "下载并执行（远程代码注入风险）",
    patterns: [/(curl|wget)\s+.*\|\s*(bash|sh|zsh|python|powershell|pwsh)\b/],
    level: "high",
    requiresConfirmation: true,
    requiresAuditLog: true,
    irreversible: false,
  },

  // ============ L2 medium: 默认中风险 ============
  {
    name: "systemctl_modify",
    description: "修改 systemd 服务",
    patterns: [
      /\bsystemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask)\b/,
    ],
    level: "medium",
    requiresConfirmation: false,
    requiresAuditLog: true,
    irreversible: false,
  },
  {
    name: "package_install",
    description: "安装系统包",
    patterns: [
      /\b(apt|apt-get|yum|dnf|pacman|zypper|brew|choco|scoop)\s+install\b/,
    ],
    level: "medium",
    requiresConfirmation: false,
    requiresAuditLog: true,
    irreversible: false,
  },
  {
    name: "firewall_modify",
    description: "修改防火墙规则",
    patterns: [/\b(iptables|ufw|firewall-cmd|nft)\s+/],
    level: "medium",
    requiresConfirmation: false,
    requiresAuditLog: true,
    irreversible: false,
  },

  // ============ L1 low: 仅记录（不拦截）============
  {
    name: "network_request",
    description: "网络请求（默认 low，仅审计）",
    patterns: [/\b(curl|wget|ping|nc|netcat|ssh|scp|rsync)\b/],
    level: "low",
    requiresConfirmation: false,
    requiresAuditLog: false,
    irreversible: false,
  },
];

/**
 * 内部工具：取多条规则中优先级最高的 level
 */
export function maxLevel(rules: RiskRule[]): {
  level: RiskLevel;
  rule: RiskRule | null;
} {
  let best: RiskRule | null = null;
  for (const r of rules) {
    if (!best || LEVEL_PRIORITY[r.level] > LEVEL_PRIORITY[best.level]) {
      best = r;
    }
  }
  return { level: best?.level ?? "safe", rule: best };
}
