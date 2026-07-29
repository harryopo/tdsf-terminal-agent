"""
tests/test_risk_engine_p5.py — 4 层风控管道 P5 完整版测试（T-P5-04）
=====================================================================

验证内容：
1. assess_layer1_syntax（语法检查独立调用）
2. assess_layer2_risk_level（风险等级判定独立调用）
3. assess_layer3_confirmation（确认要求判定独立调用）
4. assess_layer4_audit（审计要求判定独立调用）
5. assess_full_pipeline（4 层完整管道）
6. assess 与 assess_full_pipeline 行为一致性
7. DENY 特殊处理（不需确认 + 不可逆）
8. 未匹配规则默认中风险 + 需确认（安全优先）

运行：
    cd python-sidecar
    python -m pytest tests/test_risk_engine_p5.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.risk_engine import RiskEngine, get_risk_engine
from core.schemas import RiskAssessment, RiskLevel


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture(scope="module")
def engine() -> RiskEngine:
    """加载真实配置文件的风险引擎实例。"""
    config_dir = Path(__file__).parent.parent / "config"
    return RiskEngine(
        risk_rules_path=config_dir / "risk_rules.yaml",
        assets_path=config_dir / "assets.yaml",
    )


# ============================================================================
# 1. assess_layer1_syntax 测试
# ============================================================================

class TestLayer1Syntax:
    """第 1 层：语法检查独立调用"""

    def test_valid_command_passes_syntax(self, engine: RiskEngine):
        """合法命令应通过语法检查"""
        is_valid, err = engine.assess_layer1_syntax("ls -la /tmp")
        assert is_valid is True
        assert err == ""

    def test_empty_command_fails_syntax(self, engine: RiskEngine):
        """空命令应失败"""
        is_valid, err = engine.assess_layer1_syntax("")
        assert is_valid is False
        assert "空" in err

    def test_special_char_prefix_fails_syntax(self, engine: RiskEngine):
        """以 & | ; 开头应失败"""
        for cmd in ["& echo hi", "| cat", "; ls"]:
            is_valid, err = engine.assess_layer1_syntax(cmd)
            assert is_valid is False, f"应拒绝: {cmd}"
            assert "特殊字符" in err

    def test_unbalanced_brackets_fails_syntax(self, engine: RiskEngine):
        """括号不匹配应失败"""
        is_valid, err = engine.assess_layer1_syntax("echo (hello")
        assert is_valid is False
        assert "括号" in err


# ============================================================================
# 2. assess_layer2_risk_level 测试
# ============================================================================

class TestLayer2RiskLevel:
    """第 2 层：风险等级判定独立调用"""

    def test_low_risk_command_classified_as_low(self, engine: RiskEngine):
        """只读命令应判为 LOW"""
        level, name, rule = engine.assess_layer2_risk_level("ls -la")
        assert level == RiskLevel.LOW
        assert name == "ls"
        assert rule is not None

    def test_medium_risk_command_classified_as_medium(self, engine: RiskEngine):
        """配置变更命令应判为 MEDIUM"""
        level, name, rule = engine.assess_layer2_risk_level("systemctl restart nginx")
        assert level == RiskLevel.MEDIUM
        assert name == "systemctl_restart"

    def test_high_risk_command_classified_as_high(self, engine: RiskEngine):
        """不可逆操作应判为 HIGH"""
        level, name, rule = engine.assess_layer2_risk_level("rm -rf /tmp/test")
        assert level == RiskLevel.HIGH
        assert name == "rm_rf"
        assert rule is not None
        assert rule.irreversible is True

    def test_deny_command_classified_as_deny(self, engine: RiskEngine):
        """拒绝执行命令应判为 DENY"""
        level, name, rule = engine.assess_layer2_risk_level("rm -rf /")
        assert level == RiskLevel.DENY
        assert name == "rm_root"

    def test_unknown_command_defaults_to_medium(self, engine: RiskEngine):
        """未知命令应默认 MEDIUM（安全优先）"""
        level, name, rule = engine.assess_layer2_risk_level("unknown_command_xyz")
        assert level == RiskLevel.MEDIUM
        assert name == ""
        assert rule is None


# ============================================================================
# 3. assess_layer3_confirmation 测试
# ============================================================================

class TestLayer3Confirmation:
    """第 3 层：确认要求判定独立调用"""

    def test_deny_does_not_require_confirmation(self, engine: RiskEngine):
        """DENY 不需确认（不允许执行）"""
        # 从 rm -rf / 获取 deny rule
        _, _, rule = engine.assess_layer2_risk_level("rm -rf /")
        result = engine.assess_layer3_confirmation(rule, RiskLevel.DENY)
        assert result is False

    def test_high_risk_requires_confirmation(self, engine: RiskEngine):
        """HIGH 风险命令需确认"""
        _, _, rule = engine.assess_layer2_risk_level("rm -rf /tmp/test")
        result = engine.assess_layer3_confirmation(rule, RiskLevel.HIGH)
        assert result is True  # rm_rf 规则 requires_confirmation=True

    def test_low_risk_does_not_require_confirmation(self, engine: RiskEngine):
        """LOW 风险命令不需确认"""
        _, _, rule = engine.assess_layer2_risk_level("ls -la")
        result = engine.assess_layer3_confirmation(rule, RiskLevel.LOW)
        assert result is False  # ls 规则 requires_confirmation=False（默认）

    def test_unmatched_rule_requires_confirmation(self, engine: RiskEngine):
        """未匹配规则默认需确认（安全优先）"""
        result = engine.assess_layer3_confirmation(None, RiskLevel.MEDIUM)
        assert result is True


# ============================================================================
# 4. assess_layer4_audit 测试
# ============================================================================

class TestLayer4Audit:
    """第 4 层：审计要求判定独立调用"""

    def test_high_risk_with_audit_rule_requires_audit(self, engine: RiskEngine):
        """HIGH 风险命令（规则配置 requires_audit_log）需审计"""
        _, _, rule = engine.assess_layer2_risk_level("rm -rf /tmp/test")
        result = engine.assess_layer4_audit(rule, RiskLevel.HIGH)
        assert result is True  # rm_rf 规则 requires_audit_log=True

    def test_low_risk_does_not_require_audit(self, engine: RiskEngine):
        """LOW 风险命令不需审计"""
        _, _, rule = engine.assess_layer2_risk_level("ls -la")
        result = engine.assess_layer4_audit(rule, RiskLevel.LOW)
        assert result is False

    def test_unmatched_rule_does_not_require_audit(self, engine: RiskEngine):
        """未匹配规则默认不需审计"""
        result = engine.assess_layer4_audit(None, RiskLevel.MEDIUM)
        assert result is False


# ============================================================================
# 5. assess_full_pipeline 测试
# ============================================================================

class TestFullPipeline:
    """4 层完整管道测试"""

    def test_full_pipeline_returns_risk_assessment(self, engine: RiskEngine):
        """assess_full_pipeline 应返回 RiskAssessment 对象"""
        result = engine.assess_full_pipeline("ls -la")
        assert isinstance(result, RiskAssessment)
        assert result.risk_level == RiskLevel.LOW
        assert result.syntax_valid is True

    def test_full_pipeline_includes_syntax_check(self, engine: RiskEngine):
        """语法错误应在 assess_full_pipeline 结果中体现"""
        result = engine.assess_full_pipeline("")
        assert result.syntax_valid is False
        assert result.syntax_error != ""

    def test_full_pipeline_deny_marks_irreversible(self, engine: RiskEngine):
        """DENY 命令应标记为不可逆"""
        result = engine.assess_full_pipeline("rm -rf /")
        assert result.risk_level == RiskLevel.DENY
        assert result.is_irreversible is True
        assert result.requires_confirmation is False  # DENY 不需确认

    def test_full_pipeline_environment_criticality(self, engine: RiskEngine):
        """目标资产关键性应体现在结果中"""
        # assets.yaml 中应有 demo-mysql: high
        result = engine.assess_full_pipeline("ls -la", target_asset="demo-mysql")
        assert result.target_asset == "demo-mysql"
        # environment_criticality 应至少为 "low"
        assert result.environment_criticality in ("low", "medium", "high")


# ============================================================================
# 6. assess 与 assess_full_pipeline 行为一致性测试
# ============================================================================

class TestAssessEquivalence:
    """assess 与 assess_full_pipeline 行为一致性测试（验收硬约束）"""

    @pytest.mark.parametrize(
        "command,target_asset",
        [
            ("ls -la", ""),
            ("systemctl restart nginx", ""),
            ("rm -rf /tmp/test", ""),
            ("rm -rf /", ""),
            ("unknown_command_xyz", ""),
            ("cat /etc/passwd", ""),
            ("chmod 777 /file", ""),
            ("ls -la", "demo-mysql"),
            ("reboot", ""),
            ("", ""),
        ],
    )
    def test_assess_equals_full_pipeline(
        self,
        engine: RiskEngine,
        command: str,
        target_asset: str,
    ):
        """assess 与 assess_full_pipeline 输出应完全一致"""
        a1 = engine.assess(command, target_asset=target_asset)
        a2 = engine.assess_full_pipeline(command, target_asset=target_asset)
        # 逐字段比较
        assert a1.command == a2.command
        assert a1.risk_level == a2.risk_level
        assert a1.matched_rule_name == a2.matched_rule_name
        assert a1.requires_confirmation == a2.requires_confirmation
        assert a1.requires_audit_log == a2.requires_audit_log
        assert a1.is_irreversible == a2.is_irreversible
        assert a1.syntax_valid == a2.syntax_valid
        assert a1.syntax_error == a2.syntax_error
        assert a1.target_asset == a2.target_asset
        assert a1.environment_criticality == a2.environment_criticality


# ============================================================================
# 7. 独立调用接口组合使用测试
# ============================================================================

class TestLayerComposition:
    """4 层接口独立调用 + 组合使用测试"""

    def test_layers_can_be_called_independently(self, engine: RiskEngine):
        """4 层接口可独立调用，互不影响"""
        # 仅调用第 1 层
        is_valid, err = engine.assess_layer1_syntax("ls -la")
        assert is_valid is True
        # 仅调用第 2 层
        level, _, _ = engine.assess_layer2_risk_level("ls -la")
        assert level == RiskLevel.LOW
        # 仅调用第 3 层（用 None 模拟未匹配）
        assert engine.assess_layer3_confirmation(None, RiskLevel.MEDIUM) is True
        # 仅调用第 4 层
        assert engine.assess_layer4_audit(None, RiskLevel.MEDIUM) is False

    def test_layers_compose_to_match_full_pipeline(self, engine: RiskEngine):
        """手动组合 4 层接口应与 assess_full_pipeline 结果一致"""
        command = "rm -rf /tmp/test"
        target_asset = ""

        # 手动按层调用
        syntax_valid, syntax_error = engine.assess_layer1_syntax(command)
        risk_level, matched_rule_name, rule = engine.assess_layer2_risk_level(command)
        requires_confirmation = engine.assess_layer3_confirmation(rule, risk_level)
        requires_audit_log = engine.assess_layer4_audit(rule, risk_level)
        is_irreversible = bool(rule.irreversible) if rule else False
        if risk_level == RiskLevel.DENY:
            is_irreversible = True

        # 与 assess_full_pipeline 比较
        full = engine.assess_full_pipeline(command, target_asset=target_asset)
        assert syntax_valid == full.syntax_valid
        assert syntax_error == full.syntax_error
        assert risk_level == full.risk_level
        assert matched_rule_name == full.matched_rule_name
        assert requires_confirmation == full.requires_confirmation
        assert requires_audit_log == full.requires_audit_log
        assert is_irreversible == full.is_irreversible


# ============================================================================
# 8. 模块级单例测试
# ============================================================================

class TestSingleton:
    """get_risk_engine 单例测试"""

    def test_get_risk_engine_returns_same_instance(self):
        """get_risk_engine 应返回同一实例"""
        a = get_risk_engine()
        b = get_risk_engine()
        assert a is b

    def test_singleton_has_layer_methods(self):
        """单例应具备 4 层接口方法"""
        engine = get_risk_engine()
        assert callable(engine.assess_layer1_syntax)
        assert callable(engine.assess_layer2_risk_level)
        assert callable(engine.assess_layer3_confirmation)
        assert callable(engine.assess_layer4_audit)
        assert callable(engine.assess_full_pipeline)
