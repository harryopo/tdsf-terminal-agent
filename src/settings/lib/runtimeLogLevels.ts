/**
 * 运行日志级别筛选的**协议值**与**界面标签**（唯一主人）。
 *
 * 为什么单独一个文件（#166 看图轮续，2026-09-29 横扫设置窗十格）：那一格控制栏最左边的
 * 下拉原本直接画 `ALL`（点开是 ALL/DEBUG/INFO/WARNING+/ERROR/CRITICAL），是设置窗里唯一一处
 * 纯英文的**控件标签** —— ⑦ 那一族（技能/片段/隧道都中文化过，这格漏了）。
 *
 * 两头都不能错：
 * - 传给 sidecar `log.tail` 的 `level_filter` **值一个字都不许改**（翻了当场筛不出日志）；
 * - 给人看的标签必须是中文。
 * 所以拆成"值 + 标签映射"两份，放在非组件文件里（`react-refresh/only-export-components`
 * 也要求组件文件不要导出常量）。
 */
export const LEVEL_FILTERS = [
  "ALL",
  "DEBUG",
  "INFO",
  "WARNING+",
  "ERROR",
  "CRITICAL",
] as const;

export type LevelFilter = (typeof LEVEL_FILTERS)[number];

/** 界面标签。**日志行里那枚级别徽章保持原样**（INFO/WARN…）—— 它是日志记录本身的一部分，
 *  且消息原文里也带着同一个词，翻了会和行内文字对不上。 */
export const LEVEL_FILTER_LABEL: Record<LevelFilter, string> = {
  ALL: "全部级别",
  DEBUG: "调试",
  INFO: "信息",
  "WARNING+": "警告及以上",
  ERROR: "错误",
  CRITICAL: "严重",
};
