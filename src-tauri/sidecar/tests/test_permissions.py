"""
tests/test_permissions.py — 4 档 × 3 mode 权限融合矩阵单元测试（T-P1-08.1 验证）
===================================================================================

验证内容：
1. PermissionMode / PermissionDecision 枚举定义正确性
2. check_permission 核心 API：15 单元矩阵全覆盖（3 mode × 5 risk_level）
3. 输入归一化：大小写不敏感、空格、枚举传入、混合形式
4. 错误处理：无效 mode / 无效 risk_level / 类型错误（fail-fast）
5. 辅助查询函数：get_auto_allow_max / is_auto_allowed / requires_approval
6. get_fusion_matrix 完整性与一致性
7. PermissionResult 不可变性（frozen dataclass）
8. check_permission_dict 与 check_permission 一致性
9. describe_fusion_matrix 输出格式
10. spec 关键约束：L4 在所有模式下都需审批（安全底线）

运行：
    cd python-sidecar
    python -m pytest tests/test_permissions.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import permissions 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from permissions import (
    PermissionDecision,
    PermissionMode,
    PermissionResult,
    check_permission,
    check_permission_dict,
    describe_fusion_matrix,
    get_auto_allow_max,
    get_fusion_matrix,
    is_auto_allowed,
    requires_approval,
)


# ============================================================================
# 1. 枚举定义测试
# ============================================================================


class TestPermissionModeEnum:
    """PermissionMode 枚举定义测试"""

    def test_enum_values(self):
        """3 个枚举值应为 plan / agent / yolo"""
        assert PermissionMode.PLAN.value == "plan"
        assert PermissionMode.AGENT.value == "agent"
        assert PermissionMode.YOLO.value == "yolo"

    def test_enum_count(self):
        """应正好 3 个枚举值"""
        assert len(list(PermissionMode)) == 3

    def test_enum_is_str_subclass(self):
        """枚举应继承 str（便于 JSON 序列化）"""
        assert isinstance(PermissionMode.PLAN, str)
        assert isinstance(PermissionMode.AGENT, str)
        assert isinstance(PermissionMode.YOLO, str)

    def test_enum_from_string(self):
        """应能从字符串构造枚举"""
        assert PermissionMode("plan") == PermissionMode.PLAN
        assert PermissionMode("agent") == PermissionMode.AGENT
        assert PermissionMode("yolo") == PermissionMode.YOLO

    def test_enum_invalid_string_raises(self):
        """无效字符串应抛 ValueError"""
        with pytest.raises(ValueError):
            PermissionMode("invalid")


class TestPermissionDecisionEnum:
    """PermissionDecision 枚举定义测试"""

    def test_enum_values(self):
        """3 个枚举值应为 allow / require_approval / deny"""
        assert PermissionDecision.ALLOW.value == "allow"
        assert PermissionDecision.REQUIRE_APPROVAL.value == "require_approval"
        assert PermissionDecision.DENY.value == "deny"

    def test_enum_count(self):
        """应正好 3 个枚举值"""
        assert len(list(PermissionDecision)) == 3


# ============================================================================
# 2. 核心矩阵测试：15 单元全覆盖（spec DEC-V321-01）
# ============================================================================


class TestFusionMatrixComplete:
    """15 单元矩阵完整覆盖测试（spec 行 209-214）

    spec 矩阵：
        | risk_level | plan              | agent             | yolo              |
        |------------|-------------------|-------------------|-------------------|
        | L0 (Safe)  | allow             | allow             | allow             |
        | L1 (Caution)| require_approval | allow             | allow             |
        | L2 (Warning)| require_approval | require_approval  | allow             |
        | L3 (Danger) | require_approval | require_approval  | require_approval  |
        | L4 (Critical)| require_approval| require_approval  | require_approval  |
    """

    # 期望矩阵（mode, risk_level）→ decision
    EXPECTED_MATRIX = {
        # L0 Safe：3 mode 全 allow
        ("plan", "L0"): PermissionDecision.ALLOW,
        ("agent", "L0"): PermissionDecision.ALLOW,
        ("yolo", "L0"): PermissionDecision.ALLOW,
        # L1 Caution：plan 需审批，agent/yolo allow
        ("plan", "L1"): PermissionDecision.REQUIRE_APPROVAL,
        ("agent", "L1"): PermissionDecision.ALLOW,
        ("yolo", "L1"): PermissionDecision.ALLOW,
        # L2 Warning：plan/agent 需审批，yolo allow
        ("plan", "L2"): PermissionDecision.REQUIRE_APPROVAL,
        ("agent", "L2"): PermissionDecision.REQUIRE_APPROVAL,
        ("yolo", "L2"): PermissionDecision.ALLOW,
        # L3 Danger：3 mode 全需审批
        ("plan", "L3"): PermissionDecision.REQUIRE_APPROVAL,
        ("agent", "L3"): PermissionDecision.REQUIRE_APPROVAL,
        ("yolo", "L3"): PermissionDecision.REQUIRE_APPROVAL,
        # L4 Critical：3 mode 全需审批（安全底线）
        ("plan", "L4"): PermissionDecision.REQUIRE_APPROVAL,
        ("agent", "L4"): PermissionDecision.REQUIRE_APPROVAL,
        ("yolo", "L4"): PermissionDecision.REQUIRE_APPROVAL,
    }

    @pytest.mark.parametrize(
        "mode,risk_level,expected_decision",
        [
            # L0
            ("plan", "L0", PermissionDecision.ALLOW),
            ("agent", "L0", PermissionDecision.ALLOW),
            ("yolo", "L0", PermissionDecision.ALLOW),
            # L1
            ("plan", "L1", PermissionDecision.REQUIRE_APPROVAL),
            ("agent", "L1", PermissionDecision.ALLOW),
            ("yolo", "L1", PermissionDecision.ALLOW),
            # L2
            ("plan", "L2", PermissionDecision.REQUIRE_APPROVAL),
            ("agent", "L2", PermissionDecision.REQUIRE_APPROVAL),
            ("yolo", "L2", PermissionDecision.ALLOW),
            # L3
            ("plan", "L3", PermissionDecision.REQUIRE_APPROVAL),
            ("agent", "L3", PermissionDecision.REQUIRE_APPROVAL),
            ("yolo", "L3", PermissionDecision.REQUIRE_APPROVAL),
            # L4
            ("plan", "L4", PermissionDecision.REQUIRE_APPROVAL),
            ("agent", "L4", PermissionDecision.REQUIRE_APPROVAL),
            ("yolo", "L4", PermissionDecision.REQUIRE_APPROVAL),
        ],
    )
    def test_matrix_cell(
        self,
        mode: str,
        risk_level: str,
        expected_decision: PermissionDecision,
    ):
        """逐单元验证矩阵决策"""
        result = check_permission(mode, risk_level)
        assert result.decision == expected_decision, (
            f"matrix[{mode}][{risk_level}] 应为 {expected_decision.value}，"
            f"实际 {result.decision.value}"
        )

    def test_matrix_complete_coverage(self):
        """15 单元全覆盖（无遗漏）"""
        for (mode, risk_level), expected in self.EXPECTED_MATRIX.items():
            result = check_permission(mode, risk_level)
            assert result.decision == expected

    def test_l4_always_requires_approval(self):
        """spec 安全底线：L4 在所有模式下都需要审批（不直接 deny，不自动 allow）"""
        for mode in ("plan", "agent", "yolo"):
            result = check_permission(mode, "L4")
            assert result.decision == PermissionDecision.REQUIRE_APPROVAL, (
                f"L4 在 {mode} 模式下必须 require_approval，"
                f"实际 {result.decision.value}"
            )

    def test_l0_always_allowed(self):
        """L0 在所有模式下都自动允许"""
        for mode in ("plan", "agent", "yolo"):
            result = check_permission(mode, "L0")
            assert result.decision == PermissionDecision.ALLOW


# ============================================================================
# 3. PermissionResult 结果对象测试
# ============================================================================


class TestPermissionResult:
    """PermissionResult 不可变 dataclass 测试"""

    def test_result_fields(self):
        """PermissionResult 应包含 4 个字段"""
        result = check_permission("agent", "L2")
        assert result.mode == PermissionMode.AGENT
        assert result.risk_level == "L2"
        assert result.decision == PermissionDecision.REQUIRE_APPROVAL
        assert isinstance(result.reason, str) and result.reason

    def test_result_is_frozen(self):
        """frozen dataclass：不可修改字段"""
        result = check_permission("agent", "L0")
        with pytest.raises((AttributeError, Exception)):
            result.decision = PermissionDecision.DENY  # type: ignore[misc]

    def test_result_to_dict(self):
        """to_dict 返回正确结构"""
        result = check_permission("yolo", "L3")
        d = result.to_dict()
        assert d == {
            "decision": "require_approval",
            "reason": result.reason,
            "mode": "yolo",
            "risk_level": "L3",
        }

    def test_result_to_dict_serializable(self):
        """to_dict 应为纯 JSON 可序列化类型"""
        import json

        result = check_permission("plan", "L4")
        d = result.to_dict()
        # 应能 JSON 序列化（不抛异常）
        json_str = json.dumps(d)
        restored = json.loads(json_str)
        assert restored == d

    def test_result_reason_contains_mode_and_level(self):
        """reason 字符串应包含 mode 和 risk_level"""
        for mode in ("plan", "agent", "yolo"):
            for level in ("L0", "L1", "L2", "L3", "L4"):
                result = check_permission(mode, level)
                assert mode in result.reason
                assert level in result.reason


# ============================================================================
# 4. 输入归一化测试
# ============================================================================


class TestInputNormalization:
    """输入归一化测试（大小写不敏感 / 空格 / 枚举）"""

    def test_mode_case_insensitive(self):
        """mode 大小写不敏感"""
        r1 = check_permission("PLAN", "L0")
        r2 = check_permission("Plan", "L0")
        r3 = check_permission("plan", "L0")
        assert r1.decision == r2.decision == r3.decision == PermissionDecision.ALLOW
        assert r1.mode == r2.mode == r3.mode == PermissionMode.PLAN

    def test_mode_with_whitespace(self):
        """mode 带空格应被 strip"""
        r1 = check_permission("  agent  ", "L0")
        r2 = check_permission("agent", "L0")
        assert r1.decision == r2.decision
        assert r1.mode == r2.mode

    def test_risk_level_case_insensitive(self):
        """risk_level 大小写不敏感"""
        r1 = check_permission("agent", "l0")
        r2 = check_permission("agent", "L0")
        assert r1.decision == r2.decision
        assert r1.risk_level == "L0"  # 应归一化为大写

    def test_risk_level_with_whitespace(self):
        """risk_level 带空格应被 strip"""
        r1 = check_permission("agent", "  L2  ")
        r2 = check_permission("agent", "L2")
        assert r1.decision == r2.decision
        assert r1.risk_level == "L2"

    def test_mode_as_enum(self):
        """mode 接受 PermissionMode 枚举"""
        result = check_permission(PermissionMode.YOLO, "L0")
        assert result.decision == PermissionDecision.ALLOW
        assert result.mode == PermissionMode.YOLO

    def test_mode_mixed_enum_and_string(self):
        """混合使用枚举和字符串应一致"""
        r1 = check_permission(PermissionMode.AGENT, "L2")
        r2 = check_permission("agent", "L2")
        assert r1.decision == r2.decision
        assert r1.mode == r2.mode == PermissionMode.AGENT


# ============================================================================
# 5. 错误处理测试（fail-fast）
# ============================================================================


class TestErrorHandling:
    """错误处理测试：无效输入应立即抛异常，不静默回退"""

    def test_invalid_mode_string_raises_value_error(self):
        """无效 mode 字符串应抛 ValueError"""
        with pytest.raises(ValueError, match="invalid mode"):
            check_permission("invalid_mode", "L0")

    def test_empty_mode_raises_value_error(self):
        """空 mode 字符串应抛 ValueError"""
        with pytest.raises(ValueError, match="invalid mode"):
            check_permission("", "L0")

    def test_invalid_risk_level_raises_value_error(self):
        """无效 risk_level 应抛 ValueError"""
        invalid_levels = ["L5", "L-1", "L6", "L10", "L", "LX", "LA", "5"]
        for level in invalid_levels:
            with pytest.raises(ValueError, match="invalid risk_level"):
                check_permission("agent", level)

    def test_empty_risk_level_raises_value_error(self):
        """空 risk_level 应抛 ValueError"""
        with pytest.raises(ValueError, match="invalid risk_level"):
            check_permission("agent", "")

    def test_non_string_mode_raises_type_error(self):
        """非字符串/枚举的 mode 应抛 TypeError"""
        with pytest.raises(TypeError, match="mode must be"):
            check_permission(123, "L0")  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="mode must be"):
            check_permission(None, "L0")  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="mode must be"):
            check_permission([], "L0")  # type: ignore[arg-type]

    def test_non_string_risk_level_raises_type_error(self):
        """非字符串的 risk_level 应抛 TypeError"""
        with pytest.raises(TypeError, match="risk_level must be"):
            check_permission("agent", 0)  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="risk_level must be"):
            check_permission("agent", None)  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="risk_level must be"):
            check_permission("agent", ["L0"])  # type: ignore[arg-type]

    def test_lowercase_l5_invalid(self):
        """l5（小写）也不合法"""
        with pytest.raises(ValueError, match="invalid risk_level"):
            check_permission("agent", "l5")


# ============================================================================
# 6. 辅助查询函数测试
# ============================================================================


class TestAutoAllowMax:
    """get_auto_allow_max 函数测试"""

    @pytest.mark.parametrize(
        "mode,expected_max",
        [
            ("plan", 0),
            ("agent", 1),
            ("yolo", 2),
            (PermissionMode.PLAN, 0),
            (PermissionMode.AGENT, 1),
            (PermissionMode.YOLO, 2),
        ],
    )
    def test_auto_allow_max(self, mode, expected_max):
        """3 mode 的自动允许上限应为 0 / 1 / 2"""
        assert get_auto_allow_max(mode) == expected_max

    def test_invalid_mode_raises(self):
        """无效 mode 应抛 ValueError"""
        with pytest.raises(ValueError):
            get_auto_allow_max("invalid")


class TestIsAutoAllowed:
    """is_auto_allowed 函数测试"""

    @pytest.mark.parametrize(
        "mode,risk_level,expected",
        [
            # plan: L0 allow, L1+ not
            ("plan", "L0", True),
            ("plan", "L1", False),
            ("plan", "L2", False),
            ("plan", "L3", False),
            ("plan", "L4", False),
            # agent: L0-L1 allow, L2+ not
            ("agent", "L0", True),
            ("agent", "L1", True),
            ("agent", "L2", False),
            ("agent", "L3", False),
            ("agent", "L4", False),
            # yolo: L0-L2 allow, L3+ not
            ("yolo", "L0", True),
            ("yolo", "L1", True),
            ("yolo", "L2", True),
            ("yolo", "L3", False),
            ("yolo", "L4", False),
        ],
    )
    def test_is_auto_allowed(self, mode, risk_level, expected):
        """is_auto_allowed 应与 check_permission 一致"""
        assert is_auto_allowed(mode, risk_level) is expected


class TestRequiresApproval:
    """requires_approval 函数测试"""

    def test_requires_approval_opposite_of_auto_allowed(self):
        """requires_approval 与 is_auto_allowed 互斥"""
        for mode in ("plan", "agent", "yolo"):
            for level in ("L0", "L1", "L2", "L3", "L4"):
                auto = is_auto_allowed(mode, level)
                req = requires_approval(mode, level)
                # 两者必互斥（当前 spec 未使用 deny）
                assert auto != req, (
                    f"{mode}/{level}: is_auto_allowed={auto}, "
                    f"requires_approval={req} 应互斥"
                )


# ============================================================================
# 7. get_fusion_matrix 完整性测试
# ============================================================================


class TestFusionMatrixFunction:
    """get_fusion_matrix 函数测试"""

    def test_matrix_has_3_modes(self):
        """矩阵应包含 3 个 mode"""
        matrix = get_fusion_matrix()
        assert set(matrix.keys()) == {"plan", "agent", "yolo"}

    def test_matrix_has_5_risk_levels_per_mode(self):
        """每个 mode 应包含 5 个 risk_level"""
        matrix = get_fusion_matrix()
        for mode in ("plan", "agent", "yolo"):
            assert set(matrix[mode].keys()) == {"L0", "L1", "L2", "L3", "L4"}

    def test_matrix_values_are_valid_decisions(self):
        """矩阵值应为合法 decision 字符串"""
        matrix = get_fusion_matrix()
        valid_decisions = {"allow", "require_approval", "deny"}
        for mode, row in matrix.items():
            for level, decision in row.items():
                assert decision in valid_decisions, (
                    f"matrix[{mode}][{level}]={decision} 不合法"
                )

    def test_matrix_consistent_with_check_permission(self):
        """矩阵应与 check_permission 函数一致"""
        matrix = get_fusion_matrix()
        for mode in ("plan", "agent", "yolo"):
            for num in range(5):
                level = f"L{num}"
                expected = check_permission(mode, level).decision.value
                assert matrix[mode][level] == expected

    def test_matrix_l4_all_require_approval(self):
        """L4 行全为 require_approval（安全底线）"""
        matrix = get_fusion_matrix()
        for mode in ("plan", "agent", "yolo"):
            assert matrix[mode]["L4"] == "require_approval"

    def test_matrix_l0_all_allow(self):
        """L0 行全为 allow"""
        matrix = get_fusion_matrix()
        for mode in ("plan", "agent", "yolo"):
            assert matrix[mode]["L0"] == "allow"


# ============================================================================
# 8. describe_fusion_matrix 输出格式测试
# ============================================================================


class TestDescribeFusionMatrix:
    """describe_fusion_matrix 函数测试"""

    def test_returns_non_empty_string(self):
        """应返回非空字符串"""
        s = describe_fusion_matrix()
        assert isinstance(s, str)
        assert len(s) > 0

    def test_includes_all_modes(self):
        """应包含所有 mode 名称"""
        s = describe_fusion_matrix()
        assert "plan" in s
        assert "agent" in s
        assert "yolo" in s

    def test_includes_all_risk_levels(self):
        """应包含所有 risk_level"""
        s = describe_fusion_matrix()
        for level in ("L0", "L1", "L2", "L3", "L4"):
            assert level in s

    def test_includes_title(self):
        """应包含标题"""
        s = describe_fusion_matrix()
        assert "Permission Fusion Matrix" in s

    def test_has_table_format(self):
        """应有表格格式（包含 | 分隔符）"""
        s = describe_fusion_matrix()
        assert "|" in s
        # 至少 5 行数据 + 3 行表头/分隔 = 8+ 行
        assert s.count("\n") >= 7


# ============================================================================
# 9. check_permission_dict 一致性测试
# ============================================================================


class TestCheckPermissionDict:
    """check_permission_dict 函数测试"""

    def test_dict_matches_to_dict(self):
        """dict 版本应与 PermissionResult.to_dict() 一致"""
        test_cases = [
            ("plan", "L0"),
            ("plan", "L4"),
            ("agent", "L1"),
            ("agent", "L3"),
            ("yolo", "L2"),
            ("yolo", "L4"),
        ]
        for mode, level in test_cases:
            result = check_permission(mode, level)
            d = check_permission_dict(mode, level)
            assert d == result.to_dict()

    def test_dict_has_required_keys(self):
        """dict 应包含 4 个必需 key"""
        d = check_permission_dict("agent", "L2")
        assert set(d.keys()) == {"decision", "reason", "mode", "risk_level"}

    def test_dict_serializable(self):
        """dict 应可 JSON 序列化"""
        import json

        d = check_permission_dict("yolo", "L3")
        json_str = json.dumps(d)
        assert json.loads(json_str) == d


# ============================================================================
# 10. spec 关键约束测试
# ============================================================================


class TestSpecConstraints:
    """spec DEC-V321-01 关键约束测试"""

    def test_l4_safety_baseline(self):
        """spec 行 214：L4 在 yolo 模式下也需要审批（安全底线）"""
        result = check_permission("yolo", "L4")
        assert result.decision == PermissionDecision.REQUIRE_APPROVAL

    def test_yolo_l3_still_requires_approval(self):
        """spec 行 214：yolo 模式 L3-L4 需审批"""
        result = check_permission("yolo", "L3")
        assert result.decision == PermissionDecision.REQUIRE_APPROVAL

    def test_yolo_l2_auto_allow(self):
        """spec 行 214：yolo 模式 L0-L2 静默"""
        result = check_permission("yolo", "L2")
        assert result.decision == PermissionDecision.ALLOW

    def test_agent_l1_auto_allow(self):
        """spec 行 213：agent 模式 L0-L1 静默"""
        result = check_permission("agent", "L1")
        assert result.decision == PermissionDecision.ALLOW

    def test_agent_l2_requires_approval(self):
        """spec 行 213：agent 模式 L2-L4 需审批"""
        result = check_permission("agent", "L2")
        assert result.decision == PermissionDecision.REQUIRE_APPROVAL

    def test_plan_l0_auto_allow(self):
        """spec 行 209-210：plan 模式仅 L0 静默（只读模式严格）"""
        result = check_permission("plan", "L0")
        assert result.decision == PermissionDecision.ALLOW

    def test_plan_l1_requires_approval(self):
        """plan 模式 L1 即需审批（只读模式严格管控写操作）"""
        result = check_permission("plan", "L1")
        assert result.decision == PermissionDecision.REQUIRE_APPROVAL

    def test_no_deny_in_current_spec(self):
        """当前 spec 场景不使用 deny（保留枚举但未使用）"""
        for mode in ("plan", "agent", "yolo"):
            for level in ("L0", "L1", "L2", "L3", "L4"):
                result = check_permission(mode, level)
                assert result.decision != PermissionDecision.DENY, (
                    f"{mode}/{level} 不应 deny（当前 spec 未使用 deny）"
                )

    def test_mode_priority_strictness(self):
        """模式严格度：plan > agent > yolo"""
        for level in ("L1", "L2", "L3"):
            plan_decision = check_permission("plan", level).decision
            agent_decision = check_permission("agent", level).decision
            yolo_decision = check_permission("yolo", level).decision
            # plan 严格度 >= agent >= yolo（更易 require_approval）
            plan_strict = plan_decision == PermissionDecision.REQUIRE_APPROVAL
            agent_strict = agent_decision == PermissionDecision.REQUIRE_APPROVAL
            yolo_strict = yolo_decision == PermissionDecision.REQUIRE_APPROVAL
            assert plan_strict >= agent_strict >= yolo_strict, (
                f"{level}: plan({plan_strict}) >= agent({agent_strict}) "
                f">= yolo({yolo_strict}) 应满足严格度顺序"
            )


# ============================================================================
# 11. 边界条件测试
# ============================================================================


class TestEdgeCases:
    """边界条件测试"""

    def test_boundary_l1_agent_allow_vs_plan_require(self):
        """L1 在 agent 模式 allow，在 plan 模式 require_approval（边界）"""
        assert check_permission("agent", "L1").decision == PermissionDecision.ALLOW
        assert (
            check_permission("plan", "L1").decision
            == PermissionDecision.REQUIRE_APPROVAL
        )

    def test_boundary_l2_yolo_allow_vs_agent_require(self):
        """L2 在 yolo 模式 allow，在 agent 模式 require_approval（边界）"""
        assert check_permission("yolo", "L2").decision == PermissionDecision.ALLOW
        assert (
            check_permission("agent", "L2").decision
            == PermissionDecision.REQUIRE_APPROVAL
        )

    def test_boundary_l3_yolo_require(self):
        """L3 在 yolo 模式 require_approval（yolo 安全底线边界）"""
        assert (
            check_permission("yolo", "L3").decision
            == PermissionDecision.REQUIRE_APPROVAL
        )

    def test_mode_normalization_preserves_canonical(self):
        """归一化后 mode 字段应为标准小写枚举值"""
        for mode_input in ("PLAN", "Plan", "plan", "  plan  "):
            result = check_permission(mode_input, "L0")
            assert result.mode == PermissionMode.PLAN
            assert result.mode.value == "plan"

    def test_risk_level_normalization_preserves_canonical(self):
        """归一化后 risk_level 字段应为标准大写 L0-L4"""
        for level_input in ("l0", "L0", "  L0  "):
            result = check_permission("agent", level_input)
            assert result.risk_level == "L0"
