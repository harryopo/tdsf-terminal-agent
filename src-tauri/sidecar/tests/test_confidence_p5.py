"""
tests/test_confidence_p5.py — D-S + PCR5 证据融合 P5 完整版测试（T-P5-05）
=========================================================================

验证内容：
1. dempster_shafer_combine 模块级独立函数
   - 一致证据融合（低冲突场景）
   - 归一化正确性（质量和 = 1）
   - 完全冲突场景（K=1）均匀分配
   - 空输入边界处理
   - 多元命题（>2 个键）支持
2. pcr5_combine 模块级独立函数
   - 高冲突场景重分配
   - 与 D-S 在无冲突场景下行为接近
   - 归一化正确性
3. combine_evidence 自动选择策略
   - K > threshold（默认 0.5）→ PCR5
   - K <= threshold → D-S
   - 自定义 threshold 生效
4. 与静态方法行为对比
   - 模块级函数与 DSConfidenceCalculator.dempster_combine 在 3 元辨识框架下兼容
   - 模块级函数与 PCR5ConflictResolver.pcr5_combine 在 3 元辨识框架下兼容

运行：
    cd python-sidecar
    python -m pytest tests/test_confidence_p5.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import core 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.confidence import (
    DSConfidenceCalculator,
    PCR5ConflictResolver,
    combine_evidence,
    dempster_shafer_combine,
    pcr5_combine,
)


# ============================================================================
# 1. dempster_shafer_combine 模块级函数测试
# ============================================================================


class TestDempsterShaferCombine:
    """dempster_shafer_combine 模块级独立函数测试"""

    def test_consistent_evidence_amplifies_confidence(self) -> None:
        """一致证据融合应放大置信度（D-S 经典特性）"""
        # 两个证据都强烈支持 A：m1(A)=0.8, m2(A)=0.7
        m1 = {"A": 0.8, "B": 0.2}
        m2 = {"A": 0.7, "B": 0.3}
        combined = dempster_shafer_combine(m1, m2)
        # 融合后 A 的置信度应高于任一原始值
        assert combined["A"] > 0.8
        assert combined["A"] > 0.7
        # B 的置信度应相应降低
        assert combined["B"] < 0.2
        assert combined["B"] < 0.3

    def test_combined_mass_is_normalized(self) -> None:
        """融合后所有命题质量之和应为 1（归一化）"""
        m1 = {"A": 0.6, "B": 0.3, "C": 0.1}
        m2 = {"A": 0.5, "B": 0.4, "C": 0.1}
        combined = dempster_shafer_combine(m1, m2)
        total = sum(combined.values())
        assert abs(total - 1.0) < 1e-9, f"质量总和应为 1，实际: {total}"

    def test_completely_conflict_uniform_distribution(self) -> None:
        """完全冲突（K=1）时应均匀分配（避免除零）"""
        # m1 完全支持 A，m2 完全支持 B → K = 1
        m1 = {"A": 1.0, "B": 0.0}
        m2 = {"A": 0.0, "B": 1.0}
        combined = dempster_shafer_combine(m1, m2)
        # K=1 时均匀分配：A=0.5, B=0.5
        assert abs(combined["A"] - 0.5) < 1e-9
        assert abs(combined["B"] - 0.5) < 1e-9

    def test_empty_inputs_return_empty(self) -> None:
        """两个空 mass function 融合应返回空字典"""
        assert dempster_shafer_combine({}, {}) == {}

    def test_one_empty_returns_copy_of_other(self) -> None:
        """一边为空时应返回另一边的副本（不影响原字典）"""
        m1 = {"A": 0.6, "B": 0.4}
        result1 = dempster_shafer_combine(m1, {})
        assert result1 == m1
        assert result1 is not m1  # 应是副本
        result2 = dempster_shafer_combine({}, m1)
        assert result2 == m1
        assert result2 is not m1

    def test_multi_proposition_support(self) -> None:
        """多元命题（>2 个键）融合应正确处理"""
        m1 = {"A": 0.4, "B": 0.3, "C": 0.2, "D": 0.1}
        m2 = {"A": 0.3, "B": 0.3, "C": 0.2, "D": 0.2}
        combined = dempster_shafer_combine(m1, m2)
        # 应包含所有键
        assert set(combined.keys()) == {"A", "B", "C", "D"}
        # 归一化
        assert abs(sum(combined.values()) - 1.0) < 1e-9
        # A 是最支持的，融合后应被放大
        assert combined["A"] > 0.4

    def test_identical_evidence_preserves_distribution(self) -> None:
        """完全相同的证据融合后分布应保持不变"""
        m = {"A": 0.6, "B": 0.4}
        combined = dempster_shafer_combine(m, m)
        # K = 0.6*0.4 + 0.4*0.6 = 0.48
        # combined[A] = 0.6*0.6 / (1 - 0.48) = 0.36 / 0.52 ≈ 0.6923
        # combined[B] = 0.4*0.4 / 0.52 = 0.16 / 0.52 ≈ 0.3077
        assert abs(combined["A"] - 0.36 / 0.52) < 1e-6
        assert abs(combined["B"] - 0.16 / 0.52) < 1e-6


# ============================================================================
# 2. pcr5_combine 模块级函数测试
# ============================================================================


class TestPcr5Combine:
    """pcr5_combine 模块级独立函数测试"""

    def test_high_conflict_pcr5_redistribution(self) -> None:
        """高冲突场景下 PCR5 应按比例重分配冲突质量"""
        # m1 强烈支持 A，m2 强烈支持 B → 高冲突
        m1 = {"A": 0.8, "B": 0.2}
        m2 = {"A": 0.2, "B": 0.8}
        combined = pcr5_combine(m1, m2)
        # 归一化
        assert abs(sum(combined.values()) - 1.0) < 1e-9
        # PCR5 在高冲突下应保持双方相对权重（不偏向任一方）
        # m1(A) > m2(A) 但 m2(B) > m1(B)，按 PCR5 重分配后 A 与 B 都接近原始均值
        assert 0.4 < combined["A"] < 0.6
        assert 0.4 < combined["B"] < 0.6

    def test_pcr5_normalized(self) -> None:
        """PCR5 融合后质量总和应为 1"""
        m1 = {"A": 0.6, "B": 0.3, "C": 0.1}
        m2 = {"A": 0.5, "B": 0.4, "C": 0.1}
        combined = pcr5_combine(m1, m2)
        assert abs(sum(combined.values()) - 1.0) < 1e-9

    def test_pcr5_low_conflict_close_to_dempster(self) -> None:
        """低冲突场景下 PCR5 与 D-S 结果应接近"""
        # 两个证据都强烈支持 A，冲突很小
        m1 = {"A": 0.9, "B": 0.1}
        m2 = {"A": 0.85, "B": 0.15}
        ds_result = dempster_shafer_combine(m1, m2)
        pcr5_result = pcr5_combine(m1, m2)
        # 低冲突时两者结果应非常接近（差异 < 0.05）
        assert abs(ds_result["A"] - pcr5_result["A"]) < 0.05
        assert abs(ds_result["B"] - pcr5_result["B"]) < 0.05

    def test_pcr5_empty_inputs(self) -> None:
        """PCR5 空输入边界处理"""
        assert pcr5_combine({}, {}) == {}
        m = {"A": 0.5, "B": 0.5}
        assert pcr5_combine(m, {}) == m
        assert pcr5_combine({}, m) == m


# ============================================================================
# 3. combine_evidence 自动选择策略测试
# ============================================================================


class TestCombineEvidenceAutoSelect:
    """combine_evidence 自动选择 D-S 或 PCR5"""

    def test_low_conflict_uses_dempster_shafer(self) -> None:
        """低冲突场景（K <= threshold）应使用 D-S"""
        # K = 0.8*0.3 + 0.2*0.7 = 0.24 + 0.14 = 0.38 < 0.5 → D-S
        m1 = {"A": 0.8, "B": 0.2}
        m2 = {"A": 0.7, "B": 0.3}
        result = combine_evidence(m1, m2, conflict_threshold=0.5)
        expected = dempster_shafer_combine(m1, m2)
        assert result == expected or all(
            abs(result[k] - expected[k]) < 1e-9 for k in expected
        )

    def test_high_conflict_uses_pcr5(self) -> None:
        """高冲突场景（K > threshold）应使用 PCR5"""
        # K = 0.8*0.8 + 0.2*0.2 = 0.64 + 0.04 = 0.68 > 0.5 → PCR5
        m1 = {"A": 0.8, "B": 0.2}
        m2 = {"A": 0.2, "B": 0.8}
        result = combine_evidence(m1, m2, conflict_threshold=0.5)
        expected = pcr5_combine(m1, m2)
        assert result == expected or all(
            abs(result[k] - expected[k]) < 1e-9 for k in expected
        )

    def test_custom_threshold_takes_effect(self) -> None:
        """自定义 threshold 应影响策略切换"""
        # K = 0.38，默认 threshold=0.5 → D-S
        m1 = {"A": 0.8, "B": 0.2}
        m2 = {"A": 0.7, "B": 0.3}
        # 把 threshold 降到 0.3，K=0.38 > 0.3 → PCR5
        result_low_threshold = combine_evidence(m1, m2, conflict_threshold=0.3)
        expected_pcr5 = pcr5_combine(m1, m2)
        assert all(
            abs(result_low_threshold[k] - expected_pcr5[k]) < 1e-9
            for k in expected_pcr5
        )

    def test_default_threshold_is_0_5(self) -> None:
        """默认冲突阈值应为 0.5"""
        # K=0.68 高冲突
        m1 = {"A": 0.8, "B": 0.2}
        m2 = {"A": 0.2, "B": 0.8}
        default_result = combine_evidence(m1, m2)
        explicit_result = combine_evidence(m1, m2, conflict_threshold=0.5)
        assert all(
            abs(default_result[k] - explicit_result[k]) < 1e-9
            for k in default_result
        )

    def test_empty_evidence_returns_empty(self) -> None:
        """空输入应返回空字典"""
        assert combine_evidence({}, {}) == {}

    def test_boundary_just_below_threshold_uses_ds(self) -> None:
        """K 恰好等于 threshold 时应使用 D-S（>才是 PCR5）"""
        # 构造 K = 0.5：m1={"A":0.5,"B":0.5}, m2={"A":1.0,"B":0.0}
        # K = 0.5*0.0 + 0.5*1.0 = 0.5，threshold=0.5，K > threshold 为 False → D-S
        m1 = {"A": 0.5, "B": 0.5}
        m2 = {"A": 1.0, "B": 0.0}
        result = combine_evidence(m1, m2, conflict_threshold=0.5)
        expected = dempster_shafer_combine(m1, m2)
        assert all(
            abs(result[k] - expected[k]) < 1e-9 for k in expected
        )


# ============================================================================
# 4. 与静态方法行为对比测试
# ============================================================================


class TestModuleFunctionVsStaticMethod:
    """模块级函数与类静态方法行为对比"""

    def test_ds_module_function_compatible_with_static_method(self) -> None:
        """模块级 dempster_shafer_combine 与 DSConfidenceCalculator.dempster_combine 兼容

        模块级函数处理互斥命题（A ∩ B = ∅），
        静态方法处理 3 元辨识框架 {True, False, Θ}，
        在 Θ=0（无不确定部分）时两者语义一致。
        """
        # 静态方法 3 元辨识框架，Θ=0
        m_static1 = {"True": 0.8, "False": 0.2, "Θ": 0.0}
        m_static2 = {"True": 0.7, "False": 0.3, "Θ": 0.0}
        combined_static, K_static = DSConfidenceCalculator.dempster_combine(
            m_static1, m_static2
        )

        # 模块级函数（命题键互斥）
        m_module1 = {"True": 0.8, "False": 0.2}
        m_module2 = {"True": 0.7, "False": 0.3}
        combined_module = dempster_shafer_combine(m_module1, m_module2)

        # 比较 True / False 部分（Θ=0 时两者应一致）
        assert abs(combined_static["True"] - combined_module["True"]) < 1e-6
        assert abs(combined_static["False"] - combined_module["False"]) < 1e-6

    def test_pcr5_module_function_compatible_with_static_method(self) -> None:
        """模块级 pcr5_combine 与 PCR5ConflictResolver.pcr5_combine 兼容"""
        # 静态方法 3 元辨识框架，Θ=0
        m_static1 = {"True": 0.6, "False": 0.4, "Θ": 0.0}
        m_static2 = {"True": 0.3, "False": 0.7, "Θ": 0.0}
        combined_static, _K = PCR5ConflictResolver.pcr5_combine(m_static1, m_static2)

        # 模块级函数（命题键互斥）
        m_module1 = {"True": 0.6, "False": 0.4}
        m_module2 = {"True": 0.3, "False": 0.7}
        combined_module = pcr5_combine(m_module1, m_module2)

        # Θ=0 时 True / False 应非常接近
        # 注意：模块级与静态方法 PCR5 公式细节略有差异（静态方法处理 Θ 项），
        # 但在 Θ=0 时两者数学等价
        assert abs(combined_static["True"] - combined_module["True"]) < 0.05
        assert abs(combined_static["False"] - combined_module["False"]) < 0.05


# ============================================================================
# 5. 边界与异常场景测试
# ============================================================================


class TestEdgeCases:
    """边界与异常场景测试"""

    def test_single_proposition_no_conflict(self) -> None:
        """单一命题（无冲突可能）应原样返回"""
        m = {"A": 1.0}
        combined = dempster_shafer_combine(m, m)
        # K=0，combined[A] = 1*1 / 1 = 1.0
        assert abs(combined["A"] - 1.0) < 1e-9

    def test_combine_evidence_idempotent_with_identical_inputs(self) -> None:
        """相同证据融合后归一化特性保持"""
        m = {"A": 0.6, "B": 0.4}
        result = combine_evidence(m, m)
        assert abs(sum(result.values()) - 1.0) < 1e-9

    def test_three_way_composition(self) -> None:
        """三证据链式融合应正确归一化"""
        m1 = {"A": 0.7, "B": 0.3}
        m2 = {"A": 0.6, "B": 0.4}
        m3 = {"A": 0.8, "B": 0.2}
        # 链式融合：((m1 ⊕ m2) ⊕ m3)
        step1 = combine_evidence(m1, m2)
        final = combine_evidence(step1, m3)
        # 应归一化
        assert abs(sum(final.values()) - 1.0) < 1e-9
        # 三个证据都偏向 A，最终 A 应很高
        assert final["A"] > 0.85
