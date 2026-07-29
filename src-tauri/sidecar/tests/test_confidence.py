"""
tests/test_confidence.py — 置信度计算单元测试（T-P1-06.3 验证）
=================================================================

验证内容：
1. baseline ConfidenceCalculator（α 加权融合）
   - 单条证据置信度公式正确性
   - 证据链综合置信度（加权平均）
   - 假设置信度（支持证据平均）
   - 边界值处理
   - α 权重效果
2. DSConfidenceCalculator（D-S 证据理论）
   - mass function 计算
   - Dempster 组合规则
   - 证据链融合
3. PCR5ConflictResolver（PCR5 冲突重分配）
   - 无冲突场景（K=0）
   - 有冲突场景（K>0）
   - 完全冲突场景（K=1）
4. DSPCR5ConfidenceCalculator（D-S + PCR5 综合，spec 要求）
   - 证据链综合置信度
   - 冲突场景稳健性
   - 与 baseline 对比
5. compute_self_consistency_confidence（自洽采样一致率）

运行：
    cd python-sidecar
    python -m pytest tests/test_confidence.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path
from uuid import uuid4

# 确保能 import core 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.confidence import (
    DEFAULT_ALPHA,
    DEFAULT_THRESHOLD,
    ConfidenceCalculator,
    DSConfidenceCalculator,
    DSPCR5ConfidenceCalculator,
    PCR5ConflictResolver,
    compute_self_consistency_confidence,
)
from core.schemas import (
    Evidence,
    EvidenceSource,
    Hypothesis,
    create_evidence,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def calculator() -> ConfidenceCalculator:
    """默认 alpha=0.7 的 baseline 置信度计算器"""
    return ConfidenceCalculator(alpha=DEFAULT_ALPHA)


@pytest.fixture
def ds_calculator() -> DSConfidenceCalculator:
    """D-S 证据理论计算器"""
    return DSConfidenceCalculator(alpha=DEFAULT_ALPHA)


@pytest.fixture
def dspcr5_calculator() -> DSPCR5ConfidenceCalculator:
    """D-S + PCR5 综合计算器"""
    return DSPCR5ConfidenceCalculator(alpha=DEFAULT_ALPHA)


@pytest.fixture
def high_match_evidence() -> Evidence:
    """高模板匹配度（0.95）+ 高来源先验（DMESG=0.95）的证据"""
    return create_evidence(
        raw_text="kernel: Out of memory: Killed process 1234 (mysqld)",
        source=EvidenceSource.DMESG,
        drain3_match_score=0.95,
    )


@pytest.fixture
def low_match_evidence() -> Evidence:
    """低模板匹配度（0.1）+ 低来源先验（APP_LOG=0.75）的证据"""
    return create_evidence(
        raw_text="something weird happened",
        source=EvidenceSource.APP_LOG,
        drain3_match_score=0.1,
    )


def make_grounded_evidence(
    raw_text: str,
    source: EvidenceSource = EvidenceSource.DMESG,
    match_score: float = 0.9,
) -> Evidence:
    """创建已通过溯源校验的证据（is_grounded=True）"""
    ev = create_evidence(
        raw_text=raw_text,
        source=source,
        drain3_match_score=match_score,
    )
    ev.is_grounded = True
    return ev


# ============================================================================
# 1. Baseline ConfidenceCalculator 测试
# ============================================================================

class TestBaselineCalculator:
    """baseline α 加权融合测试"""

    def test_evidence_confidence_in_valid_range(self, calculator: ConfidenceCalculator):
        """置信度必须在 [0.0, 1.0] 范围内"""
        test_evidences = [
            create_evidence(raw_text="a", source=EvidenceSource.DMESG, drain3_match_score=0.0),
            create_evidence(raw_text="b", source=EvidenceSource.DMESG, drain3_match_score=1.0),
            create_evidence(raw_text="c", source=EvidenceSource.UNKNOWN, drain3_match_score=0.0),
            create_evidence(raw_text="d", source=EvidenceSource.UNKNOWN, drain3_match_score=1.0),
        ]
        for ev in test_evidences:
            conf = calculator.compute_evidence_confidence(ev)
            assert 0.0 <= conf <= 1.0

    def test_high_match_yields_high_confidence(
        self, calculator: ConfidenceCalculator, high_match_evidence: Evidence
    ):
        """高匹配度（0.95）+ DMESG → 高置信度（>=0.7）"""
        conf = calculator.compute_evidence_confidence(high_match_evidence)
        # 0.7*0.95 + 0.3*0.95 = 0.95
        assert conf >= 0.7
        assert conf == 0.95  # 精确值验证

    def test_low_match_yields_low_confidence(
        self, calculator: ConfidenceCalculator, low_match_evidence: Evidence
    ):
        """低匹配度（0.1）+ APP_LOG → 低置信度（<0.5）"""
        conf = calculator.compute_evidence_confidence(low_match_evidence)
        # 0.7*0.1 + 0.3*0.75 = 0.07 + 0.225 = 0.295
        assert conf < 0.5
        assert conf == 0.295

    def test_empty_chain_yields_zero(self, calculator: ConfidenceCalculator):
        """空证据链 → 置信度 0.0"""
        assert calculator.compute_chain_confidence([]) == 0.0

    def test_no_grounded_evidence_yields_zero(self, calculator: ConfidenceCalculator):
        """无 grounded 证据 → 置信度 0.0"""
        chain = [
            create_evidence(raw_text="x", source=EvidenceSource.DMESG, drain3_match_score=0.9),
        ]
        # 默认 is_grounded=False
        assert calculator.compute_chain_confidence(chain) == 0.0

    def test_full_grounded_chain_yields_high_confidence(
        self, calculator: ConfidenceCalculator
    ):
        """完整证据链（3 条 grounded 高质量证据）→ 高置信度（>=0.7）"""
        chain = [
            make_grounded_evidence("kernel: OOM killed", EvidenceSource.DMESG, 0.95),
            make_grounded_evidence("mysqld: Out of memory", EvidenceSource.MYSQL_ERROR, 0.90),
            make_grounded_evidence("systemd: mysql.service failed", EvidenceSource.JOURNALCTL, 0.85),
        ]
        conf = calculator.compute_chain_confidence(chain)
        assert conf >= DEFAULT_THRESHOLD

    def test_alpha_weight_effect(self):
        """alpha=0.9 时模板匹配权重更高"""
        evidence = create_evidence(
            raw_text="high match but unknown source",
            source=EvidenceSource.UNKNOWN,  # prior=0.50
            drain3_match_score=1.0,
        )
        calc_high = ConfidenceCalculator(alpha=0.9)
        calc_default = ConfidenceCalculator(alpha=0.7)

        conf_high = calc_high.compute_evidence_confidence(evidence)
        conf_default = calc_default.compute_evidence_confidence(evidence)

        assert conf_high > conf_default
        # alpha=0.9: 0.9*1.0 + 0.1*0.5 = 0.95
        assert conf_high == 0.95
        # alpha=0.7: 0.7*1.0 + 0.3*0.5 = 0.85
        assert conf_default == 0.85

    def test_alpha_invalid_falls_back_to_default(self):
        """alpha 越界（1.5 / -0.1）应回退到默认 0.7"""
        assert ConfidenceCalculator(alpha=1.5).alpha == DEFAULT_ALPHA
        assert ConfidenceCalculator(alpha=-0.1).alpha == DEFAULT_ALPHA

    def test_hypothesis_confidence_is_average(
        self,
        calculator: ConfidenceCalculator,
        high_match_evidence: Evidence,
        low_match_evidence: Evidence,
    ):
        """假设置信度 = 支持证据置信度的平均值"""
        evidence_map = {
            high_match_evidence.id: high_match_evidence,
            low_match_evidence.id: low_match_evidence,
        }
        hypothesis = Hypothesis(
            description="OOM 导致 MySQL 崩溃",
            supporting_evidence_ids=[high_match_evidence.id, low_match_evidence.id],
        )

        expected = (
            calculator.compute_evidence_confidence(high_match_evidence)
            + calculator.compute_evidence_confidence(low_match_evidence)
        ) / 2
        actual = calculator.compute_hypothesis_confidence(hypothesis, evidence_map)
        assert actual == round(expected, 4)

    def test_hypothesis_no_supporting_evidence_yields_zero(
        self, calculator: ConfidenceCalculator
    ):
        """假设无支持证据 → 置信度 0.0"""
        hypothesis = Hypothesis(
            description="空假设",
            supporting_evidence_ids=[uuid4()],
        )
        assert calculator.compute_hypothesis_confidence(hypothesis, {}) == 0.0


# ============================================================================
# 2. DSConfidenceCalculator 测试（D-S 证据理论）
# ============================================================================

class TestDSCalculator:
    """D-S 证据理论测试"""

    def test_evidence_mass_function(self, ds_calculator: DSConfidenceCalculator):
        """单条证据的 mass function 应满足 m(True) + m(False) + m(Θ) = 1"""
        ev = create_evidence(
            raw_text="test",
            source=EvidenceSource.DMESG,
            drain3_match_score=0.9,
        )
        mass = ds_calculator.compute_evidence_mass(ev)

        assert "True" in mass
        assert "False" in mass
        assert "Θ" in mass
        # m(True) = confidence, m(False) = 1 - confidence, m(Θ) = 0
        assert mass["True"] == pytest.approx(ev.compute_confidence(), abs=1e-4)
        assert mass["False"] == pytest.approx(1 - ev.compute_confidence(), abs=1e-4)
        assert mass["Θ"] == 0.0
        # 总和 = 1
        assert sum(mass.values()) == pytest.approx(1.0, abs=1e-6)

    def test_dempster_combine_no_conflict(self):
        """无冲突场景（K=0）：Dempster 组合应保持一致性"""
        # 两个都支持 True 的证据
        m1 = {"True": 0.8, "False": 0.2, "Θ": 0.0}
        m2 = {"True": 0.7, "False": 0.3, "Θ": 0.0}

        combined, K = DSConfidenceCalculator.dempster_combine(m1, m2)

        # K = m1(True)*m2(False) + m1(False)*m2(True) = 0.8*0.3 + 0.2*0.7 = 0.38
        assert K == pytest.approx(0.38, abs=1e-6)
        # 组合后 True 应高于单个证据
        assert combined["True"] > 0.8  # 增强信任
        # 总和 = 1
        assert sum(combined.values()) == pytest.approx(1.0, abs=1e-6)

    def test_dempster_combine_full_conflict(self):
        """完全冲突（K=1）：Dempster 无法融合，回退到 [0.5, 0.5]"""
        m1 = {"True": 1.0, "False": 0.0, "Θ": 0.0}
        m2 = {"True": 0.0, "False": 1.0, "Θ": 0.0}

        combined, K = DSConfidenceCalculator.dempster_combine(m1, m2)

        assert K == 1.0  # 完全冲突
        # 回退到完全不确定
        assert combined["True"] == 0.5
        assert combined["False"] == 0.5

    def test_ds_empty_chain_yields_zero(self, ds_calculator: DSConfidenceCalculator):
        """空证据链 → 0.0"""
        assert ds_calculator.compute_chain_confidence([]) == 0.0

    def test_ds_no_grounded_yields_zero(self, ds_calculator: DSConfidenceCalculator):
        """无 grounded 证据 → 0.0"""
        chain = [
            create_evidence(raw_text="x", source=EvidenceSource.DMESG, drain3_match_score=0.9),
        ]
        assert ds_calculator.compute_chain_confidence(chain) == 0.0

    def test_ds_full_chain_increases_confidence(self, ds_calculator: DSConfidenceCalculator):
        """多条一致证据融合后，置信度应高于单条"""
        single = [make_grounded_evidence("evidence1", EvidenceSource.DMESG, 0.7)]
        multi = [
            make_grounded_evidence("evidence1", EvidenceSource.DMESG, 0.7),
            make_grounded_evidence("evidence2", EvidenceSource.MYSQL_ERROR, 0.7),
            make_grounded_evidence("evidence3", EvidenceSource.JOURNALCTL, 0.7),
        ]

        single_conf = ds_calculator.compute_chain_confidence(single)
        multi_conf = ds_calculator.compute_chain_confidence(multi)

        # 多条一致证据应增强置信度
        assert multi_conf > single_conf


# ============================================================================
# 3. PCR5ConflictResolver 测试
# ============================================================================

class TestPCR5Resolver:
    """PCR5 冲突重分配测试"""

    def test_pcr5_no_conflict(self):
        """无冲突场景（K=0）：PCR5 与 Dempster 一致"""
        m1 = {"True": 0.9, "False": 0.1, "Θ": 0.0}
        m2 = {"True": 0.8, "False": 0.2, "Θ": 0.0}

        combined, K = PCR5ConflictResolver.pcr5_combine(m1, m2)

        # K = 0.9*0.2 + 0.1*0.8 = 0.26
        assert K == pytest.approx(0.26, abs=1e-6)
        assert combined["True"] > 0.9  # 增强
        # 总和 = 1
        assert sum(combined.values()) == pytest.approx(1.0, abs=1e-6)

    def test_pcr5_with_conflict(self):
        """有冲突场景：PCR5 应稳健处理"""
        # m1 强烈支持 True，m2 弱支持 False
        m1 = {"True": 0.9, "False": 0.1, "Θ": 0.0}
        m2 = {"True": 0.3, "False": 0.7, "Θ": 0.0}

        combined, K = PCR5ConflictResolver.pcr5_combine(m1, m2)

        # K = 0.9*0.7 + 0.1*0.3 = 0.66（较大冲突）
        assert K > 0.5
        # PCR5 应给出合理的结果（True 仍占优势，但不会过度放大）
        assert 0.5 < combined["True"] < 0.95
        assert sum(combined.values()) == pytest.approx(1.0, abs=1e-6)

    def test_pcr5_full_conflict(self):
        """完全冲突（K=1）：PCR5 仍可处理"""
        m1 = {"True": 1.0, "False": 0.0, "Θ": 0.0}
        m2 = {"True": 0.0, "False": 1.0, "Θ": 0.0}

        combined, K = PCR5ConflictResolver.pcr5_combine(m1, m2)

        assert K == 1.0
        # 完全冲突时回退到 [0.5, 0.5]
        assert combined["True"] == 0.5
        assert combined["False"] == 0.5

    def test_pcr5_zero_evidence(self):
        """零质量证据：m1 和 m2 都为 Θ=1（完全不确定）"""
        m1 = {"True": 0.0, "False": 0.0, "Θ": 1.0}
        m2 = {"True": 0.0, "False": 0.0, "Θ": 1.0}

        combined, K = PCR5ConflictResolver.pcr5_combine(m1, m2)

        assert K == 0.0
        # 完全不确定 + 完全不确定 = 完全不确定
        assert combined["Θ"] == 1.0


# ============================================================================
# 4. DSPCR5ConfidenceCalculator 测试（spec 要求的 D-S + PCR5）
# ============================================================================

class TestDSPCR5Calculator:
    """D-S + PCR5 综合计算器测试"""

    def test_dspcr5_empty_chain_yields_zero(
        self, dspcr5_calculator: DSPCR5ConfidenceCalculator
    ):
        """空证据链 → 0.0"""
        assert dspcr5_calculator.compute_chain_confidence([]) == 0.0

    def test_dspcr5_no_grounded_yields_zero(
        self, dspcr5_calculator: DSPCR5ConfidenceCalculator
    ):
        """无 grounded 证据 → 0.0"""
        chain = [
            create_evidence(raw_text="x", source=EvidenceSource.DMESG, drain3_match_score=0.9),
        ]
        assert dspcr5_calculator.compute_chain_confidence(chain) == 0.0

    def test_dspcr5_single_evidence(
        self, dspcr5_calculator: DSPCR5ConfidenceCalculator
    ):
        """单条 grounded 证据的置信度应等于其 confidence"""
        ev = make_grounded_evidence("test", EvidenceSource.DMESG, 0.85)
        conf = dspcr5_calculator.compute_chain_confidence([ev])
        # 单条证据：m(True) = confidence, m(False) = 1 - confidence
        # 初始 m(Θ)=1，组合后 m(True) = ev.confidence
        expected_conf = ConfidenceCalculator().compute_evidence_confidence(ev)
        assert conf == pytest.approx(expected_conf, abs=1e-4)

    def test_dspcr5_consistent_evidences_increase_confidence(
        self, dspcr5_calculator: DSPCR5ConfidenceCalculator
    ):
        """多条一致证据（都支持同一结论）应增强置信度"""
        single = [make_grounded_evidence("e1", EvidenceSource.DMESG, 0.7)]
        multi = [
            make_grounded_evidence("e1", EvidenceSource.DMESG, 0.7),
            make_grounded_evidence("e2", EvidenceSource.MYSQL_ERROR, 0.7),
            make_grounded_evidence("e3", EvidenceSource.JOURNALCTL, 0.7),
        ]

        single_conf = dspcr5_calculator.compute_chain_confidence(single)
        multi_conf = dspcr5_calculator.compute_chain_confidence(multi)

        # 多条一致证据应增强置信度
        assert multi_conf > single_conf

    def test_dspcr5_with_conflict_metric(
        self, dspcr5_calculator: DSPCR5ConfidenceCalculator
    ):
        """compute_chain_confidence_with_conflict 应返回 (confidence, conflict)"""
        chain = [
            make_grounded_evidence("e1", EvidenceSource.DMESG, 0.9),
            make_grounded_evidence("e2", EvidenceSource.MYSQL_ERROR, 0.8),
        ]
        conf, conflict = dspcr5_calculator.compute_chain_confidence_with_conflict(chain)

        assert 0.0 <= conf <= 1.0
        assert 0.0 <= conflict <= 1.0
        # 一致证据冲突应该较小（理论值约 0.24，放宽到 0.3）
        # 注：PCR5 K = m1(True)*m2(False) + m1(False)*m2(True)
        #   = 0.915*0.185 + 0.085*0.815 ≈ 0.24
        assert conflict < 0.3

    def test_dspcr5_high_confidence_chain(self, dspcr5_calculator: DSPCR5ConfidenceCalculator):
        """高质量证据链应产生高置信度（>=0.7）"""
        chain = [
            make_grounded_evidence("kernel: OOM", EvidenceSource.DMESG, 0.95),
            make_grounded_evidence("mysqld: OOM", EvidenceSource.MYSQL_ERROR, 0.90),
            make_grounded_evidence("systemd: failed", EvidenceSource.JOURNALCTL, 0.85),
        ]
        conf = dspcr5_calculator.compute_chain_confidence(chain)
        assert conf >= 0.7


# ============================================================================
# 5. baseline vs D-S+PCR5 对比测试
# ============================================================================

class TestBaselineVSDSPCR5:
    """baseline 与 D-S+PCR5 对比测试"""

    def test_consistent_chain_similar_results(
        self,
        calculator: ConfidenceCalculator,
        dspcr5_calculator: DSPCR5ConfidenceCalculator,
    ):
        """一致证据链：两种方法结果应在合理范围内一致"""
        chain = [
            make_grounded_evidence("e1", EvidenceSource.DMESG, 0.85),
            make_grounded_evidence("e2", EvidenceSource.MYSQL_ERROR, 0.85),
            make_grounded_evidence("e3", EvidenceSource.JOURNALCTL, 0.85),
        ]

        baseline_conf = calculator.compute_chain_confidence(chain)
        dspcr5_conf = dspcr5_calculator.compute_chain_confidence(chain)

        # 两种方法都应给出高置信度
        assert baseline_conf >= 0.7
        assert dspcr5_conf >= 0.7
        # 差距不应过大（一致证据时两种方法应接近）
        assert abs(baseline_conf - dspcr5_conf) < 0.3


# ============================================================================
# 6. compute_self_consistency_confidence 测试
# ============================================================================

class TestSelfConsistency:
    """自洽采样一致率测试"""

    def test_unanimous_yields_one(self):
        """3 次采样完全一致 → 1.0"""
        samples = ["OOM", "OOM", "OOM"]
        assert compute_self_consistency_confidence(samples) == 1.0

    def test_split_yields_fraction(self):
        """3 次采样 2:1 分裂 → 0.667"""
        samples = ["OOM", "OOM", "Config error"]
        assert compute_self_consistency_confidence(samples) == 0.667

    def test_empty_yields_zero(self):
        """空采样 → 0.0"""
        assert compute_self_consistency_confidence([]) == 0.0

    def test_all_different_yields_low(self):
        """3 次完全分裂 → 0.333"""
        samples = ["OOM", "Nginx 502", "Redis timeout"]
        assert compute_self_consistency_confidence(samples) == 0.333
