"""
tests/test_risk_engine.py — 4 层风险控制引擎单元测试（T-P1-06.2 验证）
=========================================================================

验证内容：
1. 配置加载：从 YAML 加载风险规则与资产标签
2. 4 档风险等级识别：low / medium / high / deny
3. 4 层风控管道：语法检查 / 风险等级 / 确认要求 / 审计要求
4. L0-L4 风险等级映射（spec 要求）
5. 环境关键性上调
6. deny 特殊处理（不需确认 + 不可逆）
7. 未知命令默认中风险（安全优先）

运行：
    cd python-sidecar
    python -m pytest tests/test_risk_engine.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import core 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from core.risk_engine import RiskEngine, get_risk_engine
from core.schemas import RiskLevel, l0_l4_to_numeric, risk_level_to_l0_l4


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture(scope="module")
def risk_engine() -> RiskEngine:
    """加载真实配置文件的风险引擎实例。"""
    config_dir = Path(__file__).parent.parent / "config"
    return RiskEngine(
        risk_rules_path=config_dir / "risk_rules.yaml",
        assets_path=config_dir / "assets.yaml",
    )


# ============================================================================
# 1. 配置加载测试
# ============================================================================

class TestConfigLoading:
    """配置加载测试"""

    def test_risk_engine_loads_without_error(self, risk_engine: RiskEngine):
        """RiskEngine 应能成功加载 YAML 配置"""
        assert risk_engine is not None
        # 应加载 4 个等级的规则
        assert hasattr(risk_engine, "_rules")
        assert "low" in risk_engine._rules
        assert "medium" in risk_engine._rules
        assert "high" in risk_engine._rules
        assert "deny" in risk_engine._rules

    def test_assets_loaded(self, risk_engine: RiskEngine):
        """资产标签应被加载"""
        assert "demo-mysql" in risk_engine._assets
        assert risk_engine._assets["demo-mysql"] == "high"
        assert risk_engine._assets["demo-nginx"] == "medium"

    def test_get_risk_engine_singleton(self):
        """get_risk_engine 应返回单例"""
        e1 = get_risk_engine()
        e2 = get_risk_engine()
        assert e1 is e2


# ============================================================================
# 2. 4 档风险等级识别测试
# ============================================================================

class TestRiskLevelClassification:
    """4 档风险等级识别测试"""

    def test_low_risk_readonly_command(self, risk_engine: RiskEngine):
        """只读命令（df -h）应为低风险"""
        result = risk_engine.assess("df -h")
        assert result.risk_level == RiskLevel.LOW
        assert result.matched_rule_name == "df"

    def test_medium_risk_config_command(self, risk_engine: RiskEngine):
        """配置变更命令（systemctl restart nginx）应为中风险"""
        result = risk_engine.assess("systemctl restart nginx")
        assert result.risk_level == RiskLevel.MEDIUM
        assert result.matched_rule_name == "systemctl_restart"

    def test_high_risk_irreversible_command(self, risk_engine: RiskEngine):
        """不可逆命令（rm -rf /tmp/test）应为高风险"""
        result = risk_engine.assess("rm -rf /tmp/test")
        assert result.risk_level == RiskLevel.HIGH
        assert result.matched_rule_name == "rm_rf"

    def test_deny_command_blocked(self, risk_engine: RiskEngine):
        """禁止命令（rm -rf /）应被直接拒绝"""
        result = risk_engine.assess("rm -rf /")
        assert result.risk_level == RiskLevel.DENY
        assert result.matched_rule_name == "rm_root"

    @pytest.mark.parametrize(
        "cmd,expected_level",
        [
            ("cat /var/log/syslog", RiskLevel.LOW),
            ("grep ERROR /var/log/messages", RiskLevel.LOW),
            ("free -m", RiskLevel.LOW),
            ("ps aux", RiskLevel.LOW),
            ("systemctl restart nginx", RiskLevel.MEDIUM),
            ("chmod 755 /opt/app", RiskLevel.MEDIUM),
            ("iptables -A INPUT -p tcp --dport 80 -j ACCEPT", RiskLevel.MEDIUM),
            ("rm -rf /tmp/cache", RiskLevel.HIGH),
            ("dd if=/dev/zero of=/dev/sdb", RiskLevel.HIGH),
            ("mkfs.ext4 /dev/sda1", RiskLevel.HIGH),
            ("shutdown -h now", RiskLevel.HIGH),
            ("reboot", RiskLevel.HIGH),
        ],
    )
    def test_command_classification(
        self, risk_engine: RiskEngine, cmd: str, expected_level: RiskLevel
    ):
        """各类命令应被正确分级"""
        result = risk_engine.assess(cmd)
        assert result.risk_level == expected_level, (
            f"命令 '{cmd}' 应为 {expected_level.value}，实际: {result.risk_level}"
        )


# ============================================================================
# 3. 4 层风控管道测试
# ============================================================================

class TestFourLayerPipeline:
    """4 层风控管道测试（语法/等级/确认/审计）"""

    def test_high_risk_requires_confirmation(self, risk_engine: RiskEngine):
        """高风险命令必须标记 requires_confirmation=True"""
        result = risk_engine.assess("rm -rf /tmp/test")
        assert result.requires_confirmation is True

    def test_high_risk_requires_audit_log(self, risk_engine: RiskEngine):
        """高风险命令必须标记 requires_audit_log=True"""
        result = risk_engine.assess("rm -rf /tmp/test")
        assert result.requires_audit_log is True

    def test_high_risk_is_irreversible(self, risk_engine: RiskEngine):
        """高风险命令必须标记 is_irreversible=True"""
        result = risk_engine.assess("rm -rf /tmp/test")
        assert result.is_irreversible is True

    def test_deny_no_confirmation_needed(self, risk_engine: RiskEngine):
        """deny 命令不允许执行，故不需要人工确认"""
        result = risk_engine.assess("rm -rf /")
        assert result.requires_confirmation is False

    def test_deny_irreversible(self, risk_engine: RiskEngine):
        """deny 命令应标记为不可逆操作"""
        result = risk_engine.assess("rm -rf /")
        assert result.is_irreversible is True

    def test_unknown_defaults_to_medium(self, risk_engine: RiskEngine):
        """未知命令应默认中风险并要求人工确认（安全优先）"""
        result = risk_engine.assess("some_unknown_command_xyz")
        assert result.risk_level == RiskLevel.MEDIUM
        assert result.matched_rule_name == ""
        assert result.requires_confirmation is True


# ============================================================================
# 4. 语法检查测试
# ============================================================================

class TestSyntaxCheck:
    """第 1 层：语法检查测试"""

    def test_empty_command_fails(self, risk_engine: RiskEngine):
        """空命令语法检查应失败"""
        result = risk_engine.assess("")
        assert result.syntax_valid is False
        assert result.syntax_error == "命令不能为空"

    def test_special_char_start_fails(self, risk_engine: RiskEngine):
        """以特殊字符开头应失败（防 shell 注入）"""
        result = risk_engine.assess("& ls")
        assert result.syntax_valid is False
        assert "特殊字符" in result.syntax_error

    def test_consecutive_special_chars_fails(self, risk_engine: RiskEngine):
        """连续特殊字符应失败"""
        result = risk_engine.assess("ls &&& whoami")
        assert result.syntax_valid is False

    def test_injection_attempt_fails(self, risk_engine: RiskEngine):
        """疑似命令注入应失败"""
        result = risk_engine.assess("ls; rm /tmp/x")
        assert result.syntax_valid is False

    def test_unbalanced_brackets_fails(self, risk_engine: RiskEngine):
        """括号不匹配应失败"""
        result = risk_engine.assess("echo (test")
        assert result.syntax_valid is False

    def test_valid_command_passes(self, risk_engine: RiskEngine):
        """合法命令语法检查应通过"""
        result = risk_engine.assess("df -h")
        assert result.syntax_valid is True
        assert result.syntax_error == ""


# ============================================================================
# 5. 环境关键性上调测试
# ============================================================================

class TestEnvironmentCriticality:
    """环境关键性测试"""

    def test_high_asset_low_command_upgrades(self, risk_engine: RiskEngine):
        """高关键性资产上低风险命令应上调为中风险"""
        result = risk_engine.assess("df -h", target_asset="demo-mysql")
        assert result.risk_level == RiskLevel.LOW  # 原始等级
        assert result.environment_criticality == "high"
        assert result.adjusted_risk_level == RiskLevel.MEDIUM  # 上调后

    def test_unknown_asset_returns_low(self, risk_engine: RiskEngine):
        """未知资产应返回 low 关键性"""
        result = risk_engine.assess("df -h", target_asset="unknown-asset")
        assert result.environment_criticality == "low"

    def test_no_asset_returns_low(self, risk_engine: RiskEngine):
        """无目标资产应返回 low 关键性"""
        result = risk_engine.assess("df -h")
        assert result.environment_criticality == "low"


# ============================================================================
# 6. L0-L4 风险等级映射测试（spec 要求）
# ============================================================================

class TestL0L4Mapping:
    """L0-L4 风险等级映射测试"""

    def test_low_to_l0(self):
        """RiskLevel.LOW → L0"""
        assert risk_level_to_l0_l4(RiskLevel.LOW) == "L0"

    def test_medium_to_l2(self):
        """RiskLevel.MEDIUM → L2"""
        assert risk_level_to_l0_l4(RiskLevel.MEDIUM) == "L2"

    def test_high_to_l3(self):
        """RiskLevel.HIGH → L3"""
        assert risk_level_to_l0_l4(RiskLevel.HIGH) == "L3"

    def test_deny_to_l4(self):
        """RiskLevel.DENY → L4"""
        assert risk_level_to_l0_l4(RiskLevel.DENY) == "L4"

    def test_l0_l4_numeric(self):
        """L0-L4 数值映射"""
        assert l0_l4_to_numeric("L0") == 0
        assert l0_l4_to_numeric("L1") == 1
        assert l0_l4_to_numeric("L2") == 2
        assert l0_l4_to_numeric("L3") == 3
        assert l0_l4_to_numeric("L4") == 4

    def test_risk_assessment_l0_l4_level(self, risk_engine: RiskEngine):
        """RiskAssessment.l0_l4_level 应正确返回 L0-L4"""
        # 低风险 → L0
        result = risk_engine.assess("df -h")
        assert result.l0_l4_level == "L0"

        # 中风险 → L2
        result = risk_engine.assess("systemctl restart nginx")
        assert result.l0_l4_level == "L2"

        # 高风险 → L3
        result = risk_engine.assess("rm -rf /tmp/test")
        assert result.l0_l4_level == "L3"

        # deny → L4
        result = risk_engine.assess("rm -rf /")
        assert result.l0_l4_level == "L4"

    def test_risk_assessment_l0_l4_numeric(self, risk_engine: RiskEngine):
        """RiskAssessment.l0_l4_numeric 应正确返回 0-4"""
        result = risk_engine.assess("df -h")
        assert result.l0_l4_numeric == 0

        result = risk_engine.assess("rm -rf /")
        assert result.l0_l4_numeric == 4

    def test_environment_criticality_affects_l0_l4(self, risk_engine: RiskEngine):
        """环境关键性应影响 L0-L4 等级（上调后）"""
        # demo-mysql (high) + df -h (low) → adjusted 为 medium → L2
        result = risk_engine.assess("df -h", target_asset="demo-mysql")
        assert result.risk_level == RiskLevel.LOW
        assert result.adjusted_risk_level == RiskLevel.MEDIUM
        assert result.l0_l4_level == "L2"  # 上调后为 L2
