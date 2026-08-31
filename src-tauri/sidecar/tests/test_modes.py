"""
tests/test_modes.py — 三模式信任体系单测（P0-A1，方案书 v3.1 §3.2）
====================================================================

验证内容：
1. core.decision_engine.decide 模式 × 风险映射矩阵——全格覆盖 5 风险 × 3 模式
   （15 断言）+ 多种输入形态（RiskLevel / int / "L3" / "low"）+ 非法输入 fail-closed
2. strands_backend.modes.parse_mode——合法解析 / AgentMode 透传 / 缺省与非法
   降级 confirm + 降级 warning（同值仅一次）
3. 观察模式工具集过滤——schema 中不存在任何 readonly=False 的工具
   （ToolPolicy.readonly 白名单单一真源）
4. 模式感知 prompt 拼接——模式指令按 mode 拼接 + teach 皮肤开关 + 长度控制

运行：
    cd src-tauri/sidecar
    python -m pytest tests/test_modes.py -v
"""
from __future__ import annotations

import logging

import pytest

from core.decision_engine import decide
from core.schemas import RiskLevel
from strands_backend.modes import AgentMode, parse_mode

# ============================================================================
# 1. decide 模式 × 风险映射矩阵（方案书 §3.2 全格覆盖）
# ============================================================================


class TestDecideMatrix:
    """decide(risk_l, mode) → allow/confirm/deny 全格覆盖（5 风险 × 3 模式）"""

    # --- observe：L0-L4 全部 deny（只读类由调用方按 readonly 先行短路）---

    def test_observe_L0_deny(self):
        assert decide(0, AgentMode.OBSERVE) == "deny"

    def test_observe_L1_deny(self):
        assert decide(1, AgentMode.OBSERVE) == "deny"

    def test_observe_L2_deny(self):
        assert decide(2, AgentMode.OBSERVE) == "deny"

    def test_observe_L3_deny(self):
        assert decide(3, AgentMode.OBSERVE) == "deny"

    def test_observe_L4_deny(self):
        assert decide(4, AgentMode.OBSERVE) == "deny"

    # --- confirm：L0-L1 allow；L2-L4 confirm ---

    def test_confirm_L0_allow(self):
        assert decide(0, AgentMode.CONFIRM) == "allow"

    def test_confirm_L1_allow(self):
        assert decide(1, AgentMode.CONFIRM) == "allow"

    def test_confirm_L2_confirm(self):
        assert decide(2, AgentMode.CONFIRM) == "confirm"

    def test_confirm_L3_confirm(self):
        assert decide(3, AgentMode.CONFIRM) == "confirm"

    def test_confirm_L4_confirm(self):
        assert decide(4, AgentMode.CONFIRM) == "confirm"

    # --- auto：L0-L2 allow；L3 confirm（升级确认）；L4 confirm（永远确认）---

    def test_auto_L0_allow(self):
        assert decide(0, AgentMode.AUTO) == "allow"

    def test_auto_L1_allow(self):
        assert decide(1, AgentMode.AUTO) == "allow"

    def test_auto_L2_allow(self):
        assert decide(2, AgentMode.AUTO) == "allow"

    def test_auto_L3_confirm(self):
        assert decide(3, AgentMode.AUTO) == "confirm"

    def test_auto_L4_confirm(self):
        """L4 在任何模式（含 auto）都人工确认，不可绕过"""
        assert decide(4, AgentMode.AUTO) == "confirm"


class TestDecideInputForms:
    """decide 输入形态兼容（RiskLevel / int / L 字符串 / RiskLevel 字符串值）"""

    def test_risk_level_enum_low(self):
        # LOW → L0
        assert decide(RiskLevel.LOW, "auto") == "allow"

    def test_risk_level_enum_medium(self):
        # MEDIUM → L2
        assert decide(RiskLevel.MEDIUM, "auto") == "allow"
        assert decide(RiskLevel.MEDIUM, "confirm") == "confirm"

    def test_risk_level_enum_high(self):
        # HIGH → L3
        assert decide(RiskLevel.HIGH, "auto") == "confirm"

    def test_risk_level_enum_deny(self):
        # DENY → L4（永远确认，不再走旧 abort 语义——本函数是执行链映射）
        assert decide(RiskLevel.DENY, "auto") == "confirm"
        assert decide(RiskLevel.DENY, "observe") == "deny"

    def test_l_string_upper(self):
        assert decide("L3", "auto") == "confirm"

    def test_l_string_lower(self):
        assert decide("l2", "confirm") == "confirm"

    def test_risk_level_value_string(self):
        assert decide("high", "auto") == "confirm"
        assert decide("low", "observe") == "deny"

    def test_agent_mode_string_value(self):
        assert decide(2, "observe") == "deny"
        assert decide(2, "AUTO") == "allow"
        assert decide(2, " Auto ") == "allow"

    def test_invalid_risk_raises(self):
        for bad in (5, -1, "L5", "L9", "critical", True, 1.5, None):
            with pytest.raises(ValueError):
                decide(bad, "confirm")  # type: ignore[arg-type]

    def test_invalid_mode_raises(self):
        for bad in ("aggressive", "", 123, None):
            with pytest.raises(ValueError):
                decide(2, bad)  # type: ignore[arg-type]


# ============================================================================
# 2. parse_mode 解析（缺省/非法 → confirm + 降级 warning 一次）
# ============================================================================


class TestParseMode:
    """AgentMode 解析与降级"""

    def test_valid_modes(self):
        assert parse_mode("observe") is AgentMode.OBSERVE
        assert parse_mode("confirm") is AgentMode.CONFIRM
        assert parse_mode("auto") is AgentMode.AUTO

    def test_case_and_whitespace_insensitive(self):
        assert parse_mode("OBSERVE") is AgentMode.OBSERVE
        assert parse_mode(" Auto ") is AgentMode.AUTO

    def test_agent_mode_passthrough(self):
        assert parse_mode(AgentMode.AUTO) is AgentMode.AUTO

    def test_missing_defaults_to_confirm(self, caplog):
        with caplog.at_level(logging.WARNING, logger="sidecar.strands_backend.modes"):
            assert parse_mode(None) is AgentMode.CONFIRM

    def test_invalid_defaults_to_confirm(self):
        assert parse_mode("aggressive") is AgentMode.CONFIRM
        assert parse_mode(123) is AgentMode.CONFIRM
        assert parse_mode("") is AgentMode.CONFIRM

    def test_custom_default(self):
        assert parse_mode(None, default="observe") is AgentMode.OBSERVE

    def test_invalid_default_falls_back_confirm(self):
        assert parse_mode("xxx", default="also-bad") is AgentMode.CONFIRM

    def test_degrade_warning_logged_once_per_value(self, caplog):
        """同一非法原始值只记一次降级 warning（老会话兼容不刷屏）"""
        logger = logging.getLogger("sidecar.strands_backend.modes")
        marker = f"unique-bad-mode-{id(object())}"
        with caplog.at_level(logging.WARNING, logger=logger.name):
            parse_mode(marker)
            parse_mode(marker)
            parse_mode(marker)
        warnings = [
            r for r in caplog.records
            if r.levelno == logging.WARNING and marker in r.getMessage()
        ]
        assert len(warnings) == 1


# ============================================================================
# 3. 观察模式工具集过滤（schema 级隔离：无 readonly=False 工具）
# ============================================================================


class TestObserveToolsetFilter:
    """observe 模式下 main 工具集 = TOOL_REGISTRY 只读白名单"""

    @staticmethod
    def _tool_names(tools) -> set[str]:
        return {getattr(t, "__name__", str(t)) for t in tools}

    def test_filter_tools_readonly_keeps_only_readonly(self):
        from strands_backend.tools import ToolContext, filter_tools_readonly, make_all_ops_tools

        ctx = ToolContext(agent_name="mode-test", session_id="s-mode-1")
        full = make_all_ops_tools(ctx)
        observe = filter_tools_readonly(full)

        names = self._tool_names(observe)
        from strands_backend.tools.registry import READONLY_TOOL_NAMES

        assert names == set(READONLY_TOOL_NAMES)
        # 执行/写类工具必须被裁掉
        for exec_tool in ("ssh_command", "service_manage", "package_manage",
                          "firewall_manage", "backup_restore", "skill_invoke"):
            assert exec_tool not in names

    def test_observe_schema_has_no_nonreadonly_tool(self):
        """spec 验收：observe 模式 schema 中不存在任何 readonly=False 的工具"""
        from strands_backend.tools import ToolContext, filter_tools_readonly, make_all_ops_tools
        from strands_backend.tools.registry import TOOL_REGISTRY, get_tool_policy

        ctx = ToolContext(agent_name="mode-test", session_id="s-mode-2")
        observe = filter_tools_readonly(make_all_ops_tools(ctx))
        for name in self._tool_names(observe):
            policy = get_tool_policy(name)
            assert policy is not None, f"工具 {name} 未注册（observe 白名单外泄）"
            assert policy.readonly, f"observe schema 中出现 readonly=False 工具: {name}"
        # 全量 20 工具中确实存在非只读（过滤不是空转）
        assert any(not s.policy.readonly for s in TOOL_REGISTRY.values())

    def test_non_registry_tools_filtered_in_observe(self):
        """extra_tools（非注册工具）在 observe 下同样被裁（fail-closed）"""
        from strands_backend.tools import ToolContext, filter_tools_readonly

        def _extra_tool():
            pass

        _extra_tool.__name__ = "mystery_extra_tool"
        assert self._tool_names(filter_tools_readonly([_extra_tool])) == set()


# ============================================================================
# 4. 模式感知 prompt 拼接（模式指令 + teach 皮肤 + 长度控制）
# ============================================================================


class TestModeAwarePrompt:
    """main system prompt = 基础段 + 模式指令 (+ teach 皮肤)"""

    @staticmethod
    def _compose(mode: AgentMode, teach: bool) -> str:
        from strands_backend.adapter import _compose_system_prompt

        return _compose_system_prompt(mode, teach)

    def test_mode_instruction_composed(self):
        observe_prompt = self._compose(AgentMode.OBSERVE, teach=False)
        assert "只读观察模式" in observe_prompt
        assert "一切写操作" in observe_prompt

    def test_confirm_mode_instruction_composed(self):
        prompt = self._compose(AgentMode.CONFIRM, teach=False)
        assert "先说明再动手" in prompt

    def test_auto_mode_instruction_composed(self):
        prompt = self._compose(AgentMode.AUTO, teach=False)
        assert "高效执行" in prompt

    def test_teach_skin_appended_when_on(self):
        prompt = self._compose(AgentMode.CONFIRM, teach=True)
        # 教学契约（原 teach agent 结构化输出迁移）
        assert "概念与原理" in prompt
        assert "易错点与考点" in prompt
        assert "练习" in prompt
        # 禁委派话术
        assert "不得声称把任务委派给其他 agent" in prompt

    def test_teach_skin_absent_when_off(self):
        prompt = self._compose(AgentMode.CONFIRM, teach=False)
        assert "概念与原理" not in prompt

    # TDSF 2026-08-31 (任务C 环境感知前置): 任何模式/开关下系统提示都必须含
    # 前置感知流程约束（用户钦定方向——agent 回答前先确认环境再行动）
    def test_env_awareness_section_always_present(self):
        for mode in AgentMode:
            for teach in (False, True):
                prompt = self._compose(mode, teach)
                assert "环境感知前置" in prompt, f"mode={mode}, teach={teach}"
                # ① connection_mode: ssh → 远程 Linux 服务器（按发行版）
                assert "远程 Linux 服务器" in prompt
                # ② connection_mode: local（本地终端已打开）→ Windows 本地环境
                assert "Windows 本地环境" in prompt
                # ③ connection_mode: none → 明确告知未开终端并引导
                #    （2026-08-31 问题1修复：以 connection_mode 为唯一口径，
                #    none 分支严禁自称"本地终端模式"，要求如实告知用户）
                assert "connection_mode: none" in prompt
                assert "当前未打开终端" in prompt
                assert "新建本地终端" in prompt
                # 指向注入区数据源
                assert "<environment>" in prompt or "live_context" in prompt

    def test_no_delegation_instructions_left(self):
        """委派指令段已删除：任何模式的 prompt 都不含子 agent 委派说明"""
        for mode in AgentMode:
            for teach in (False, True):
                prompt = self._compose(mode, teach)
                assert "Sub-agents" not in prompt
                assert "委派专家" not in prompt

    def test_prompt_length_controlled(self):
        """拼接后 ≤ 原委派版体量（原 main 委派版 ≈ 基础段+委派段+teach 子 prompt）"""
        longest = self._compose(AgentMode.OBSERVE, teach=True)
        assert len(longest) < 4000, f"prompt 过长: {len(longest)} 字符"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
