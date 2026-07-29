/**
 * Confidence Engine — TypeScript 简化版 (T2.3)
 * -----------------------------------------------------------------------------
 * 5 维评分：来源 / 术语 / 可验证性 / 一致性 / 特异性
 * 满分为 1.0，越高越可信。前端用色标直观展示：
 *   ≥ 0.8  emerald-500  高置信
 *   ≥ 0.6  sky-500      中置信
 *   ≥ 0.4  amber-500    低置信
 *   < 0.4   red-500      不可信
 *
 * 协议：与自研 Python core/confidence.py 5 维对齐（baseline + D-S + PCR5）
 * 这里是 TS 端独立运行，绕过 Sidecar 即可演示；T3 阶段接通 Python 后，
 * 该模块可无缝替换为 invoke('ipc_invoke', { method: 'confidence.score' })
 */
export interface ConfidenceBreakdown {
  /** 来源可信度：含"man page / 官方文档 / 根据"等词加分 */
  source: number;
  /** 术语精确度：含专业术语加分 */
  terminology: number;
  /** 可验证性：含具体数字 / 命令 / 路径加分 */
  verifiability: number;
  /** 内部一致性：不含自我矛盾（"应该" + "一定"等冲突词） */
  consistency: number;
  /** 特异性：含具体文件 / 行号 / 错误码加分 */
  specificity: number;
}

export interface ConfidenceScore {
  /** 综合分数 0-1（5 维等权平均） */
  score: number;
  /** 5 维明细 */
  breakdown: ConfidenceBreakdown;
}

// 中文 AI 文本中常见高可信信号词
const SOURCE_SIGNALS = [
  /根据\s*\w+/,
  /man\s*page/i,
  /官方文档/,
  /Linux\s+(手册|内核|基金会)/,
  /GNU\s+/,
  /RFC\s*\d+/,
  /POSIX/,
];
// 术语词
const TERMINOLOGY_SIGNALS = [
  /进程|信号|文件描述符|系统调用|内核|线程|中断/i,
  /\b(SIGTERM|SIGKILL|fork|exec|pipe|mmap|epoll)\b/i,
  /Linux|GNU|POSIX/,
];
// 可验证性
const VERIFIABILITY_SIGNALS = [
  /\b\d+\b/, // 数字
  /\/[\w/]+/, // 路径
  /\$\s*\w+/, // shell 变量
  /`(?:ls|cat|grep|find|man|ps|kill)\s+[^`]+`/, // 命令引用
];
// 特异性
const SPECIFICITY_SIGNALS = [
  /\b\d+\.\d+(\.\d+)?\b/, // 版本号
  /第\s*\d+\s*行/,
  /line\s*\d+/,
  /errno\s*=?\s*\d+/i,
  /exit\s+code\s*\d+/i,
];
// 一致性矛盾词
const CONTRADICTION_SIGNALS = [
  /可能.*一定/,
  /也许.*绝对/,
  /不确定.*肯定/,
  /should.*must/i,
  /maybe.*definitely/i,
];

/**
 * 评分主函数
 */
export function scoreConfidence(text: string): ConfidenceScore {
  const breakdown: ConfidenceBreakdown = {
    source: hitRate(text, SOURCE_SIGNALS),
    terminology: hitRate(text, TERMINOLOGY_SIGNALS),
    verifiability: hitRate(text, VERIFIABILITY_SIGNALS),
    consistency: CONTRADICTION_SIGNALS.some((p) => p.test(text)) ? 0.3 : 0.9,
    specificity: hitRate(text, SPECIFICITY_SIGNALS),
  };
  // 加权：source 权重 0.25 / verifiability 0.25 / specificity 0.2 / terminology 0.15 / consistency 0.15
  const weights = {
    source: 0.25,
    verifiability: 0.25,
    specificity: 0.2,
    terminology: 0.15,
    consistency: 0.15,
  };
  const score =
    breakdown.source * weights.source +
    breakdown.verifiability * weights.verifiability +
    breakdown.specificity * weights.specificity +
    breakdown.terminology * weights.terminology +
    breakdown.consistency * weights.consistency;
  return { score, breakdown };
}

function hitRate(text: string, patterns: RegExp[]): number {
  if (!text.trim()) return 0;
  const hit = patterns.filter((p) => p.test(text)).length;
  return Math.min(1, hit / 2); // 2 个命中即满分
}

/**
 * 置信度 → CSS 颜色（用于圆形评分数字背景）
 */
export function confidenceColor(score: number): string {
  if (score >= 0.8) return "#10b981"; // emerald-500
  if (score >= 0.6) return "#0ea5e9"; // sky-500
  if (score >= 0.4) return "#f59e0b"; // amber-500
  return "#ef4444"; // red-500
}
