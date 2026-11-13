/**
 * rank-v1 排序分数（冻结候选，2026-11-12）
 * -----------------------------------------------------------------------------
 * 设计真源：01-开发方案书 §5.2。第一版只做可解释统计分数，不训练模型：
 *
 *   S(c) = 0.50*T + 0.25*F + 0.15*R + 0.10*C
 *   T = 同 epoch 相邻 prev→c 次数 / prev 全部合格后继次数（后继 < 2 时取 0）
 *   F = log1p(频次) / log1p(合格池最大频次)（分母 0 时取 0）
 *   R = 2^(-距最后一次使用天数 / 7)
 *   C = (同 cwd 次数 + 1) / (全部次数 + 2)
 *
 * 这是**排序分数**，不是成功率、概率或安全置信度，展示层不得写成 95%。
 */

export const RANK_WEIGHTS = {
  transition: 0.5,
  frequency: 0.25,
  recency: 0.15,
  cwd: 0.1,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RankInputs = {
  transitionCount: number;
  transitionTotal: number;
  frequency: number;
  maxFrequency: number;
  lastUsedAt: number | null;
  cwdCount: number;
  totalCount: number;
  now: number;
};

export type RankComponents = {
  transition: number;
  frequency: number;
  recency: number;
  cwd: number;
};

export function rankComponents(inputs: RankInputs): RankComponents {
  const transition =
    inputs.transitionTotal >= 2
      ? clamp01(inputs.transitionCount / inputs.transitionTotal)
      : 0;
  const frequency =
    inputs.maxFrequency > 0
      ? clamp01(Math.log1p(inputs.frequency) / Math.log1p(inputs.maxFrequency))
      : 0;
  const recency =
    inputs.lastUsedAt == null
      ? 0
      : clamp01(
          2 **
            (-Math.max(0, inputs.now - inputs.lastUsedAt) / DAY_MS / 7),
        );
  const cwd =
    inputs.totalCount > 0
      ? clamp01((inputs.cwdCount + 1) / (inputs.totalCount + 2))
      : 0;
  return { transition, frequency, recency, cwd };
}

export function rankV1(inputs: RankInputs): number {
  const parts = rankComponents(inputs);
  return (
    RANK_WEIGHTS.transition * parts.transition +
    RANK_WEIGHTS.frequency * parts.frequency +
    RANK_WEIGHTS.recency * parts.recency +
    RANK_WEIGHTS.cwd * parts.cwd
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
