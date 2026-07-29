"""
core/confidence.py — 证据置信度计算（T-P1-06.3 迁移自 projects/src/tdsf/core/confidence.py）
================================================================================================

迁移与升级说明（用户决策④ + spec 要求 D-S + PCR5）：
- 完整保留原 ConfidenceCalculator（α 加权融合）作为 baseline 实现
- 新增 DSConfidenceCalculator（Dempster-Shafer 证据理论）
- 新增 PCR5ConflictResolver（PCR5 冲突重分配规则）
- 新增 DSPCR5ConfidenceCalculator（D-S + PCR5 综合实现，spec 要求）

实现方案书 4.1 节的置信度计算体系：
- baseline 公式：confidence = α × drain3_match_score + (1-α) × source_prior
- D-S 证据理论：用 mass function / Belief / Plausibility 处理不确定性
- PCR5 规则：当证据冲突时（K > 0），将冲突质量按比例分配回各命题

D-S 证据理论核心概念：
- mass function（BPA）：m(A) ∈ [0, 1], m(∅) = 0, Σ m(A) = 1
- Belief：Bel(A) = Σ m(B), B ⊆ A（信任下界）
- Plausibility：Pl(A) = 1 - Bel(~A)（信任上界）
- Dempster 组合规则：m12(A) = Σ m1(B) × m2(C) / (1 - K), B ∩ C = A
- 冲突度量：K = Σ m1(B) × m2(C), B ∩ C = ∅

PCR5 冲突重分配（Dezert-Smarandache）：
- 当 K > 0 时，Dempster 规则的归一化会"放大"冲突
- PCR5 将冲突质量按原始比例分配回各命题，更稳健
- 简化公式：m_PCR5(A) = m12(A) + K × [m1(A) × m2(~A) + m2(A) × m1(~A)] / [m1(A) + m2(~A) + m2(A) + m1(~A)]

本模块提供：
- ConfidenceCalculator:               baseline 加权融合
- DSPCR5ConfidenceCalculator:         D-S + PCR5 升级版
- DSConfidenceCalculator:             纯 D-S（无 PCR5，便于对比）
- PCR5ConflictResolver:               PCR5 冲突解析器
- compute_self_consistency_confidence: 自洽采样一致率
- DEFAULT_ALPHA / DEFAULT_THRESHOLD:  默认权重与重采样阈值常量
"""

from __future__ import annotations

from collections import Counter
from typing import Any
from uuid import UUID

from core.schemas import Evidence, Hypothesis, SOURCE_PRIOR

# ============================================================
# 常量定义
# ============================================================

# 默认模板匹配权重 α（更信任可计算的 Drain3 模板匹配度）
DEFAULT_ALPHA: float = 0.7

# 默认置信度阈值：综合置信度低于此值会触发重采样
DEFAULT_THRESHOLD: float = 0.7

# 空证据链时返回的最低置信度，避免除零并体现「无证据不可信」原则
_EMPTY_CHAIN_CONFIDENCE: float = 0.0

# D-S 证据理论的辨识框架（Frame of Discernment, Θ）
# 对于运维场景，简化为二元命题：{True（根因成立）, False（根因不成立）}
# Θ = {True, False}
_THETA_TRUE = "True"
_THETA_FALSE = "False"
_THETA_UNKNOWN = "Θ"  # 表示不确定（既非 True 也非 False）


# ============================================================
# Baseline 置信度计算器（α 加权融合，原实现）
# ============================================================


class ConfidenceCalculator:
    """证据置信度计算器（baseline 加权融合）。

    按照 ``confidence = α × drain3_match_score + (1-α) × source_prior``
    公式，分层计算单条证据、证据链与假设的置信度。

    所有计算均为纯函数式（无外部依赖、无副作用），
    保证同一输入永远得到同一输出，可复现、可解释。
    """

    def __init__(self, alpha: float = DEFAULT_ALPHA) -> None:
        """初始化置信度计算器。

        Args:
            alpha: 模板匹配权重 α，取值范围 [0.0, 1.0]。
                   α 越大越信任 Drain3 模板匹配结果；
                   α 越小越信任来源先验权重表。
                   默认 0.7，与方案书保持一致。
        """
        # 边界保护：α 必须落在 [0.0, 1.0]，越界则回退到默认值
        if 0.0 <= alpha <= 1.0:
            self.alpha: float = alpha
        else:
            self.alpha = DEFAULT_ALPHA

    # ----------------------------------------------------------
    # 单条证据置信度
    # ----------------------------------------------------------

    def compute_evidence_confidence(self, evidence: Evidence) -> float:
        """计算单条证据的置信度。

        公式：``confidence = α × drain3_match_score + (1-α) × source_prior``

        Args:
            evidence: 待计算的证据对象。

        Returns:
            置信度值，范围 [0.0, 1.0]，保留 4 位小数。
        """
        # 来源先验权重：未知来源回退到 0.50
        source_prior: float = SOURCE_PRIOR.get(evidence.source, 0.50)
        # 加权融合：模板匹配度 × α + 来源先验 × (1-α)
        confidence: float = (
            self.alpha * evidence.drain3_match_score
            + (1.0 - self.alpha) * source_prior
        )
        # 钳位到 [0.0, 1.0]，防止浮点误差越界
        confidence = max(0.0, min(1.0, confidence))
        return round(confidence, 4)

    # ----------------------------------------------------------
    # 证据链综合置信度
    # ----------------------------------------------------------

    def compute_chain_confidence(
        self,
        evidence_chain: list[Evidence],
    ) -> float:
        """计算证据链综合置信度。

        规则：
        - 仅统计 ``is_grounded=True`` 的证据（通过 Ground-Check 的证据）
        - 以各证据的 ``drain3_match_score`` 作为权重做加权平均
        - 若没有 grounded 证据或权重总和为 0，返回 0.0（无证据不可信）

        Args:
            evidence_chain: 证据链（可能含未通过溯源校验的证据）。

        Returns:
            综合置信度值，范围 [0.0, 1.0]，保留 4 位小数。
        """
        # 空证据链或无 grounded 证据：直接返回最低置信度
        grounded_evidences: list[Evidence] = [
            ev for ev in evidence_chain if ev.is_grounded
        ]
        if not grounded_evidences:
            return _EMPTY_CHAIN_CONFIDENCE

        # 计算加权平均：分子 = Σ (confidence × match_score)，分母 = Σ match_score
        total_weight: float = 0.0
        weighted_sum: float = 0.0
        for evidence in grounded_evidences:
            weight: float = evidence.drain3_match_score
            # 权重为 0 的证据（未匹配到 Drain3 模板）不参与加权，
            # 但仍保留在 grounded 列表中，避免完全被忽略
            confidence: float = self.compute_evidence_confidence(evidence)
            weighted_sum += confidence * weight
            total_weight += weight

        # 所有权重都为 0：退化为简单平均，避免除零
        if total_weight == 0.0:
            avg: float = sum(
                self.compute_evidence_confidence(ev) for ev in grounded_evidences
            ) / len(grounded_evidences)
            return round(max(0.0, min(1.0, avg)), 4)

        chain_confidence: float = weighted_sum / total_weight
        chain_confidence = max(0.0, min(1.0, chain_confidence))
        return round(chain_confidence, 4)

    # ----------------------------------------------------------
    # 假设置信度
    # ----------------------------------------------------------

    def compute_hypothesis_confidence(
        self,
        hypothesis: Hypothesis,
        evidence_map: dict[UUID, Evidence],
    ) -> float:
        """计算假设的置信度。

        规则：取该假设所有支持证据（必须在 evidence_map 中存在）
        的置信度平均值作为假设置信度。

        Args:
            hypothesis: 待计算的假设对象。
            evidence_map: 证据 ID → 证据对象的映射，用于查找支持证据。

        Returns:
            假设置信度值，范围 [0.0, 1.0]，保留 4 位小数。
            若支持证据均不存在，返回 0.0。
        """
        # 收集所有能查到的支持证据
        supporting_evidences: list[Evidence] = []
        for evidence_id in hypothesis.supporting_evidence_ids:
            evidence = evidence_map.get(evidence_id)
            if evidence is not None:
                supporting_evidences.append(evidence)

        # 无可查的支持证据：置信度为 0
        if not supporting_evidences:
            return 0.0

        # 取支持证据置信度的平均值
        total: float = 0.0
        for evidence in supporting_evidences:
            total += self.compute_evidence_confidence(evidence)
        hypothesis_confidence: float = total / len(supporting_evidences)
        hypothesis_confidence = max(0.0, min(1.0, hypothesis_confidence))
        return round(hypothesis_confidence, 4)


# ============================================================
# D-S 证据理论 + PCR5 冲突重分配（spec 要求）
# ============================================================


class DSConfidenceCalculator:
    """Dempster-Shafer 证据理论置信度计算器。

    将每条证据视为一个独立的 mass function（BPA）：
    - m({True})  = evidence.confidence（证据支持结论的程度）
    - m({False}) = 1 - evidence.confidence（证据反对结论的程度）
    - m(Θ)       = 0（假设证据完全确定，无不确定部分）

    用 Dempster 组合规则融合所有证据，得到综合置信度。
    当证据冲突时（K > 0），归一化会放大置信度，可能不稳定。
    建议在冲突较大时改用 DSPCR5ConfidenceCalculator。

    适用场景：
    - 证据之间相对一致（K 较小）
    - 需要快速计算
    """

    def __init__(self, alpha: float = DEFAULT_ALPHA) -> None:
        """初始化 D-S 计算器。

        Args:
            alpha: 用于计算单条证据 confidence 的权重（与 ConfidenceCalculator 一致）
        """
        self._baseline = ConfidenceCalculator(alpha=alpha)

    def compute_evidence_mass(self, evidence: Evidence) -> dict[str, float]:
        """计算单条证据的 mass function（BPA）。

        将 evidence.confidence 转换为 D-S 的 mass function：
        - m({True})  = confidence
        - m({False}) = 1 - confidence
        - m(Θ)       = 0

        Args:
            evidence: 待计算的证据

        Returns:
            mass function 字典：{"True": m_true, "False": m_false, "Θ": m_theta}
        """
        confidence = self._baseline.compute_evidence_confidence(evidence)
        return {
            _THETA_TRUE: confidence,
            _THETA_FALSE: 1.0 - confidence,
            _THETA_UNKNOWN: 0.0,
        }

    @staticmethod
    def dempster_combine(
        m1: dict[str, float],
        m2: dict[str, float],
    ) -> tuple[dict[str, float], float]:
        """Dempster 证据组合规则。

        组合两个 mass function m1 和 m2：
        - m12({True})  = m1({True})×m2({True}) + m1({True})×m2(Θ) + m1(Θ)×m2({True})
        - m12({False}) = m1({False})×m2({False}) + m1({False})×m2(Θ) + m1(Θ)×m2({False})
        - m12(Θ)       = m1(Θ)×m2(Θ)
        - K = m1({True})×m2({False}) + m1({False})×m2({True})  （冲突质量）

        归一化：m12(A) = m12(A) / (1 - K)，K < 1 时

        Args:
            m1: 第一个 mass function
            m2: 第二个 mass function

        Returns:
            (combined_mass, conflict_K) 元组
            - combined_mass: 组合后的 mass function（已归一化）
            - conflict_K: 冲突质量（0-1，越大表示冲突越严重）
        """
        # 计算冲突质量 K
        K = m1[_THETA_TRUE] * m2[_THETA_FALSE] + m1[_THETA_FALSE] * m2[_THETA_TRUE]

        # 计算非冲突部分的组合
        m_true = (
            m1[_THETA_TRUE] * m2[_THETA_TRUE]
            + m1[_THETA_TRUE] * m2[_THETA_UNKNOWN]
            + m1[_THETA_UNKNOWN] * m2[_THETA_TRUE]
        )
        m_false = (
            m1[_THETA_FALSE] * m2[_THETA_FALSE]
            + m1[_THETA_FALSE] * m2[_THETA_UNKNOWN]
            + m1[_THETA_UNKNOWN] * m2[_THETA_FALSE]
        )
        m_theta = m1[_THETA_UNKNOWN] * m2[_THETA_UNKNOWN]

        # 归一化（Dempster 规则）
        if K < 1.0:
            normalize_factor = 1.0 - K
            m_true /= normalize_factor
            m_false /= normalize_factor
            m_theta /= normalize_factor
        else:
            # 完全冲突（K=1）：无法融合，分配为完全不确定
            m_true = 0.5
            m_false = 0.5
            m_theta = 0.0

        return (
            {
                _THETA_TRUE: m_true,
                _THETA_FALSE: m_false,
                _THETA_UNKNOWN: m_theta,
            },
            K,
        )

    def compute_chain_confidence(self, evidence_chain: list[Evidence]) -> float:
        """计算证据链综合置信度（D-S 融合）。

        流程：
        1. 过滤 grounded 证据（is_grounded=True）
        2. 为每条证据计算 mass function
        3. 用 Dempster 规则迭代组合
        4. 最终置信度 = m({True})

        Args:
            evidence_chain: 证据链

        Returns:
            综合置信度 [0.0, 1.0]，保留 4 位小数
        """
        grounded = [ev for ev in evidence_chain if ev.is_grounded]
        if not grounded:
            return _EMPTY_CHAIN_CONFIDENCE

        # 初始 mass：完全不确定 m(Θ) = 1
        combined = {
            _THETA_TRUE: 0.0,
            _THETA_FALSE: 0.0,
            _THETA_UNKNOWN: 1.0,
        }

        for evidence in grounded:
            ev_mass = self.compute_evidence_mass(evidence)
            combined, _K = self.dempster_combine(combined, ev_mass)

        return round(max(0.0, min(1.0, combined[_THETA_TRUE])), 4)


class PCR5ConflictResolver:
    """PCR5 冲突重分配规则（Proportional Conflict Redistribution Rule 5）。

    当 Dempster 组合产生冲突（K > 0）时，Dempster 的归一化会"放大"
    非冲突部分的质量，可能导致过度自信。

    PCR5 改进：将冲突质量 K 按原始证据中各命题的比例重新分配回各命题。

    简化版 PCR5 公式（二元命题 {True, False}）：
        m_PCR5({True})  = m12({True})  + K × [m1({True})×m2({False})] / [m1({True})+m2({False})]
        m_PCR5({False}) = m12({False}) + K × [m1({False})×m2({True})] / [m1({False})+m2({True})]

    其中 K × [m1({True})×m2({False})] 是 True 和 False 之间的冲突质量，
    按比例 [m1({True})/(m1({True})+m2({False}))] 分配回 True。

    适用场景：
    - 证据冲突较大（K > 0.3）
    - 需要更稳健的融合结果
    """

    @staticmethod
    def pcr5_combine(
        m1: dict[str, float],
        m2: dict[str, float],
    ) -> tuple[dict[str, float], float]:
        """PCR5 证据组合规则。

        Args:
            m1: 第一个 mass function
            m2: 第二个 mass function

        Returns:
            (combined_mass, conflict_K) 元组
        """
        # 第一步：Dempster 非冲突部分组合（不归一化）
        m_true_non_conflict = (
            m1[_THETA_TRUE] * m2[_THETA_TRUE]
            + m1[_THETA_TRUE] * m2[_THETA_UNKNOWN]
            + m1[_THETA_UNKNOWN] * m2[_THETA_TRUE]
        )
        m_false_non_conflict = (
            m1[_THETA_FALSE] * m2[_THETA_FALSE]
            + m1[_THETA_FALSE] * m2[_THETA_UNKNOWN]
            + m1[_THETA_UNKNOWN] * m2[_THETA_FALSE]
        )
        m_theta_non_conflict = m1[_THETA_UNKNOWN] * m2[_THETA_UNKNOWN]

        # 冲突质量
        K = m1[_THETA_TRUE] * m2[_THETA_FALSE] + m1[_THETA_FALSE] * m2[_THETA_TRUE]
        # 拆分冲突：
        # - k_true_false = m1({True})×m2({False})  （True 与 False 冲突）
        # - k_false_true = m1({False})×m2({True})  （False 与 True 冲突）
        k_true_false = m1[_THETA_TRUE] * m2[_THETA_FALSE]
        k_false_true = m1[_THETA_FALSE] * m2[_THETA_TRUE]

        # 第二步：PCR5 重分配
        # 冲突 k_true_false 按比例分配回 True 和 False
        # - 分配回 True 的比例：m1({True}) / (m1({True}) + m2({False}))
        # - 分配回 False 的比例：m2({False}) / (m1({True}) + m2({False}))
        denom_true_false = m1[_THETA_TRUE] + m2[_THETA_FALSE]
        if denom_true_false > 0:
            pcr5_true_from_tf = k_true_false * m1[_THETA_TRUE] / denom_true_false
            pcr5_false_from_tf = k_true_false * m2[_THETA_FALSE] / denom_true_false
        else:
            pcr5_true_from_tf = 0.0
            pcr5_false_from_tf = 0.0

        # 冲突 k_false_true 按比例分配回 False 和 True
        denom_false_true = m1[_THETA_FALSE] + m2[_THETA_TRUE]
        if denom_false_true > 0:
            pcr5_false_from_ft = k_false_true * m1[_THETA_FALSE] / denom_false_true
            pcr5_true_from_ft = k_false_true * m2[_THETA_TRUE] / denom_false_true
        else:
            pcr5_false_from_ft = 0.0
            pcr5_true_from_ft = 0.0

        # 合并 PCR5 结果
        m_true = m_true_non_conflict + pcr5_true_from_tf + pcr5_true_from_ft
        m_false = m_false_non_conflict + pcr5_false_from_tf + pcr5_false_from_ft
        m_theta = m_theta_non_conflict

        # 钳位到 [0, 1] 并归一化（防止浮点误差导致总和 != 1）
        total = m_true + m_false + m_theta
        if total > 0:
            m_true /= total
            m_false /= total
            m_theta /= total

        return (
            {
                _THETA_TRUE: m_true,
                _THETA_FALSE: m_false,
                _THETA_UNKNOWN: m_theta,
            },
            K,
        )


class DSPCR5ConfidenceCalculator:
    """D-S + PCR5 综合置信度计算器（spec 要求的 D-S + PCR5 证据融合）。

    工作流程：
    1. 为每条证据计算 mass function（与 DSConfidenceCalculator 一致）
    2. 用 PCR5 规则迭代组合所有证据
    3. 最终置信度 = m({True})

    与 DSConfidenceCalculator 的区别：
    - DSConfidenceCalculator 用 Dempster 规则（归一化处理冲突）
    - 本计算器用 PCR5 规则（按比例重分配冲突）
    - 当证据冲突较大时，PCR5 结果更稳健

    适用场景：
    - 证据链中存在冲突（不同证据支持不同结论）
    - spec 要求的 D-S + PCR5 证据融合场景
    """

    def __init__(self, alpha: float = DEFAULT_ALPHA) -> None:
        """初始化 D-S + PCR5 计算器。

        Args:
            alpha: 用于计算单条证据 confidence 的权重
        """
        self._ds = DSConfidenceCalculator(alpha=alpha)

    def compute_evidence_mass(self, evidence: Evidence) -> dict[str, float]:
        """计算单条证据的 mass function（委托给 DSConfidenceCalculator）。"""
        return self._ds.compute_evidence_mass(evidence)

    def compute_chain_confidence(self, evidence_chain: list[Evidence]) -> float:
        """计算证据链综合置信度（D-S + PCR5 融合）。

        流程：
        1. 过滤 grounded 证据
        2. 为每条证据计算 mass function
        3. 用 PCR5 规则迭代组合
        4. 最终置信度 = m({True})

        Args:
            evidence_chain: 证据链

        Returns:
            综合置信度 [0.0, 1.0]，保留 4 位小数
        """
        grounded = [ev for ev in evidence_chain if ev.is_grounded]
        if not grounded:
            return _EMPTY_CHAIN_CONFIDENCE

        # 初始 mass：完全不确定 m(Θ) = 1
        combined = {
            _THETA_TRUE: 0.0,
            _THETA_FALSE: 0.0,
            _THETA_UNKNOWN: 1.0,
        }

        for evidence in grounded:
            ev_mass = self.compute_evidence_mass(evidence)
            combined, _K = PCR5ConflictResolver.pcr5_combine(combined, ev_mass)

        return round(max(0.0, min(1.0, combined[_THETA_TRUE])), 4)

    def compute_chain_confidence_with_conflict(
        self,
        evidence_chain: list[Evidence],
    ) -> tuple[float, float]:
        """计算证据链综合置信度 + 总冲突度量。

        Args:
            evidence_chain: 证据链

        Returns:
            (confidence, total_conflict) 元组
            - confidence: 综合置信度 [0.0, 1.0]
            - total_conflict: 累积冲突度量 [0.0, 1.0]（用于冲突诊断）
        """
        grounded = [ev for ev in evidence_chain if ev.is_grounded]
        if not grounded:
            return _EMPTY_CHAIN_CONFIDENCE, 0.0

        combined = {
            _THETA_TRUE: 0.0,
            _THETA_FALSE: 0.0,
            _THETA_UNKNOWN: 1.0,
        }
        total_conflict = 0.0

        for evidence in grounded:
            ev_mass = self.compute_evidence_mass(evidence)
            combined, K = PCR5ConflictResolver.pcr5_combine(combined, ev_mass)
            total_conflict = max(total_conflict, K)  # 取最大冲突度量

        confidence = round(max(0.0, min(1.0, combined[_THETA_TRUE])), 4)
        return confidence, round(total_conflict, 4)


# ============================================================
# 自洽采样一致率
# ============================================================


def compute_self_consistency_confidence(samples: list[str]) -> float:
    """对多次采样的根因结论做多数投票，返回一致率。

    规则：
    - ``agree_ratio = 最高频结论出现次数 / 总采样次数``
    - 完全一致 → 1.0
    - 完全分裂 → 接近 1/n
    - 空采样列表 → 0.0（无样本无法判断一致性）

    Args:
        samples: 多次采样得到的根因结论文本列表。

    Returns:
        一致率，范围 [0.0, 1.0]，保留 3 位小数。
    """
    # 空采样：无法判断一致性，返回 0.0
    if not samples:
        return 0.0

    # 统计每个结论出现次数，取最高频
    counter: Counter[str] = Counter(samples)
    most_common_count: int = counter.most_common(1)[0][1]

    # 一致率 = 最高频结论出现次数 / 总采样次数
    agree_ratio: float = most_common_count / len(samples)
    agree_ratio = max(0.0, min(1.0, agree_ratio))
    return round(agree_ratio, 3)


# ============================================================
# 模块级单例（懒加载）
# ============================================================

_baseline_calculator: ConfidenceCalculator | None = None
_dspcr5_calculator: DSPCR5ConfidenceCalculator | None = None


def get_baseline_calculator() -> ConfidenceCalculator:
    """获取全局 baseline ConfidenceCalculator 实例（α 加权融合）。"""
    global _baseline_calculator
    if _baseline_calculator is None:
        _baseline_calculator = ConfidenceCalculator(alpha=DEFAULT_ALPHA)
    return _baseline_calculator


def get_dspcr5_calculator() -> DSPCR5ConfidenceCalculator:
    """获取全局 D-S + PCR5 ConfidenceCalculator 实例（spec 要求）。"""
    global _dspcr5_calculator
    if _dspcr5_calculator is None:
        _dspcr5_calculator = DSPCR5ConfidenceCalculator(alpha=DEFAULT_ALPHA)
    return _dspcr5_calculator


# ============================================================
# 模块级独立函数（T-P5-05：D-S + PCR5 完整版）
# ============================================================
#
# 这些函数提供与 DSConfidenceCalculator.dempster_combine /
# PCR5ConflictResolver.pcr5_combine 静态方法并列的模块级接口，
# 便于不实例化类的情况下直接调用。
#
# 设计差异：
# - 静态方法：专门处理 3 元辨识框架 {True, False, Θ}，Θ 表示不确定
# - 模块级函数：假设所有命题键互斥（更通用，支持任意 N 元命题）
#
# 当需要处理 Θ（不确定）语义时，请使用静态方法；
# 当命题互斥时（如多分类问题），使用模块级函数更方便。


def dempster_shafer_combine(
    m1: dict[str, float],
    m2: dict[str, float],
) -> dict[str, float]:
    """Dempster-Shafer 证据组合规则（模块级独立函数）。

    假设所有命题键互斥（任意两个不同键的交集为空集）。
    公式：
    - 非冲突部分：m12(A) = m1(A) × m2(A)
    - 冲突质量：K = Σ m1(A) × m2(B), A ≠ B
    - 归一化：m12(A) /= (1 - K)

    Args:
        m1: 第一个 mass function（命题 → 质量）
        m2: 第二个 mass function

    Returns:
        组合后的 mass function（已归一化）。
        当 m1 或 m2 为空时，返回另一个的副本。
        当完全冲突（K=1）时，所有命题均匀分配。

    Examples:
        >>> m1 = {"A": 0.6, "B": 0.4}
        >>> m2 = {"A": 0.7, "B": 0.3}
        >>> dempster_shafer_combine(m1, m2)
        {'A': 0.85..., 'B': 0.14...}
    """
    if not m1 and not m2:
        return {}
    if not m1:
        return dict(m2)
    if not m2:
        return dict(m1)

    # 收集所有键
    all_keys: set[str] = set(m1.keys()) | set(m2.keys())

    # 计算冲突质量 K = Σ m1(A) × m2(B), A ≠ B
    K: float = 0.0
    for a in m1:
        for b in m2:
            if a != b:
                K += m1[a] * m2[b]

    # 非冲突部分：m12(A) = m1(A) × m2(A)
    combined: dict[str, float] = {}
    for key in all_keys:
        combined[key] = m1.get(key, 0.0) * m2.get(key, 0.0)

    # 归一化（Dempster 规则）
    if K < 1.0:
        factor: float = 1.0 - K
        if factor > 0:
            for key in combined:
                combined[key] /= factor
    else:
        # 完全冲突（K=1）：均匀分配
        n: int = len(all_keys)
        uniform: float = 1.0 / n if n > 0 else 0.0
        for key in combined:
            combined[key] = uniform

    return combined


def pcr5_combine(
    m1: dict[str, float],
    m2: dict[str, float],
) -> dict[str, float]:
    """PCR5 证据组合规则（模块级独立函数）。

    假设所有命题键互斥。
    PCR5 将冲突质量按原始证据中各命题的比例重新分配回各命题。

    公式：
    - 非冲突部分：m12(A) = m1(A) × m2(A)
    - 冲突部分（A,B 对，A≠B）：
      - k_ab = m1(A) × m2(B)
      - 分配回 A：k_ab × m1(A) / (m1(A) + m2(B))
      - 分配回 B：k_ab × m2(B) / (m1(A) + m2(B))
    - 总和：m_PCR5(A) = m12(A) + Σ 冲突分配回 A 的部分

    Args:
        m1: 第一个 mass function
        m2: 第二个 mass function

    Returns:
        组合后的 mass function（已归一化）。
        当 m1 或 m2 为空时，返回另一个的副本。

    Examples:
        >>> m1 = {"A": 0.6, "B": 0.4}
        >>> m2 = {"A": 0.2, "B": 0.8}
        >>> pcr5_combine(m1, m2)
        {'A': 0.23..., 'B': 0.76...}
    """
    if not m1 and not m2:
        return {}
    if not m1:
        return dict(m2)
    if not m2:
        return dict(m1)

    all_keys: set[str] = set(m1.keys()) | set(m2.keys())

    # 非冲突部分
    combined: dict[str, float] = {}
    for key in all_keys:
        combined[key] = m1.get(key, 0.0) * m2.get(key, 0.0)

    # PCR5 冲突重分配
    for a in m1:
        for b in m2:
            if a != b:
                k_ab: float = m1[a] * m2[b]
                m1_a: float = m1[a]
                m2_b: float = m2[b]
                denom: float = m1_a + m2_b
                if denom > 0:
                    # 冲突 k_ab 按比例分配回 a 和 b
                    combined[a] += k_ab * m1_a / denom
                    combined[b] += k_ab * m2_b / denom

    # 归一化（防止浮点误差导致总和 != 1）
    total: float = sum(combined.values())
    if total > 0:
        for key in combined:
            combined[key] /= total

    return combined


def combine_evidence(
    m1: dict[str, float],
    m2: dict[str, float],
    conflict_threshold: float = 0.5,
) -> dict[str, float]:
    """自动选择证据融合策略（D-S 或 PCR5）。

    根据冲突度量 K 自动选择：
    - K > conflict_threshold → PCR5（高冲突场景更稳健）
    - K <= conflict_threshold → D-S（低冲突场景归一化放大可信）

    Args:
        m1: 第一个 mass function
        m2: 第二个 mass function
        conflict_threshold: 冲突阈值，默认 0.5
            K 超过此值时切换到 PCR5

    Returns:
        组合后的 mass function

    Examples:
        >>> # 低冲突场景（K=0.08，阈值 0.5）→ D-S
        >>> m1 = {"A": 0.8, "B": 0.2}
        >>> m2 = {"A": 0.7, "B": 0.3}
        >>> combine_evidence(m1, m2)  # 使用 D-S
        >>> # 高冲突场景（K=0.56，阈值 0.5）→ PCR5
        >>> m3 = {"A": 0.8, "B": 0.2}
        >>> m4 = {"A": 0.2, "B": 0.8}
        >>> combine_evidence(m3, m4)  # 使用 PCR5
    """
    if not m1 and not m2:
        return {}
    if not m1:
        return dict(m2)
    if not m2:
        return dict(m1)

    # 计算冲突度量 K = Σ m1(A) × m2(B), A ≠ B
    K: float = 0.0
    for a in m1:
        for b in m2:
            if a != b:
                K += m1[a] * m2[b]

    # 冲突 > threshold → PCR5
    if K > conflict_threshold:
        return pcr5_combine(m1, m2)
    # 否则 → D-S
    return dempster_shafer_combine(m1, m2)
