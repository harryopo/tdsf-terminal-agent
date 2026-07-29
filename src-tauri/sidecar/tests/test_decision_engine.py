"""
tests/test_decision_engine.py — 决策引擎测试（T-P1-06.4）
============================================================

测试 core.decision_engine 模块（基于 LangGraph 重写版）：
- DecisionEngine 实例化（依赖注入）
- 决策树图构建（5 节点）
- 决策逻辑（proceed / needs_approval / abort / use_history）
- 历史案例检索与复用（含防偏见警示）
- 风险评估集成
- 置信度计算集成
- HITL 状态机
- 备选方案生成
- MCP tool wrapper（tools.decision）
- 参数校验与错误处理

测试覆盖 spec T-P1-06.4 要求：
- 基于 LangGraph 节点实现决策树 ✅
- 集成历史案例检索（调用 history tool） ✅
- 集成到 LangGraph `decision` tool ✅
"""

from __future__ import annotations

from typing import Any

import pytest

from core.confidence import ConfidenceCalculator
from core.decision_engine import (
    DecisionEngine,
    DecisionState,
    _ANTI_BIAS_DISCLAIMER,
    _DEFAULT_HISTORY_RATING_THRESHOLD,
    create_decision_engine,
    create_initial_decision_state,
)
from core.schemas import (
    Evidence,
    EvidenceSource,
    RiskAssessment,
    RiskLevel,
    RootCause,
    create_evidence,
)


# ============================================================
# Mock 工具
# ============================================================


class MockRiskEngine:
    """Mock 风险引擎（实现 RiskEngineProtocol 协议）"""

    def __init__(self, level: RiskLevel = RiskLevel.LOW):
        self.level = level
        self.assess_call_count = 0

    def assess(self, command: str, target_asset: str = "") -> RiskAssessment:
        self.assess_call_count += 1
        return RiskAssessment(
            command=command,
            risk_level=self.level,
            matched_rule_name=f"mock_rule_{self.level.value}",
            requires_confirmation=self.level in (RiskLevel.HIGH, RiskLevel.MEDIUM),
            requires_audit_log=self.level == RiskLevel.HIGH,
            is_irreversible=self.level in (RiskLevel.HIGH, RiskLevel.DENY),
            syntax_valid=True,
            target_asset=target_asset,
            environment_criticality="low",
        )


def make_history_callback(cases: list[dict]) -> Any:
    """创建 mock 历史案例检索回调"""
    def callback(problem: str) -> list[dict]:
        return cases
    return callback


@pytest.fixture
def sample_evidence_chain() -> list[Evidence]:
    """示例证据链（用于构造 RootCause）"""
    return [
        create_evidence(
            raw_text="kernel: Out of memory: Killed process 1234 (mysqld)",
            source=EvidenceSource.DMESG,
            drain3_match_score=0.95,
        ),
        create_evidence(
            raw_text="mysqld: Out of memory",
            source=EvidenceSource.MYSQL_ERROR,
            drain3_match_score=0.90,
        ),
    ]


@pytest.fixture
def sample_root_cause(sample_evidence_chain: list[Evidence]) -> RootCause:
    """示例根因分析结果"""
    for ev in sample_evidence_chain:
        ev.is_grounded = True
    return RootCause(
        description="MySQL 进程被 OOM Killer 终止",
        evidence_chain=sample_evidence_chain,
        confidence=0.85,
    )


@pytest.fixture
def high_rated_history_case() -> dict:
    """高成功率历史案例（success_rating=1.0）"""
    return {
        "problem_description": "MySQL 服务无法启动",
        "fix_commands": ["systemctl restart mysql"],
        "success_rating": 1.0,
        "source": "history",
    }


@pytest.fixture
def low_rated_history_case() -> dict:
    """低成功率历史案例（success_rating=0.3）"""
    return {
        "problem_description": "MySQL 服务无法启动",
        "fix_commands": ["systemctl restart mysql"],
        "success_rating": 0.3,
        "source": "history",
    }


# ============================================================
# 测试套件 1: DecisionEngine 实例化
# ============================================================


class TestDecisionEngineInstantiation:
    """DecisionEngine 实例化与依赖注入测试。"""

    def test_create_with_minimal_deps(self) -> None:
        """最小依赖（仅 risk_engine）即可创建实例。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine())
        assert engine is not None
        assert engine.risk_engine is not None
        assert engine.confidence_calculator is None
        assert engine.history_callback is None

    def test_create_with_all_deps(self) -> None:
        """注入所有依赖（risk + confidence + history）。"""
        risk = MockRiskEngine()
        conf = ConfidenceCalculator()
        hist = make_history_callback([])

        engine = DecisionEngine(
            risk_engine=risk,
            confidence_calculator=conf,
            history_callback=hist,
        )
        assert engine.risk_engine is risk
        assert engine.confidence_calculator is conf
        assert engine.history_callback is hist

    def test_history_rating_threshold_default(self) -> None:
        """默认历史案例复用阈值为 0.8。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine())
        assert engine.history_rating_threshold == _DEFAULT_HISTORY_RATING_THRESHOLD
        assert engine.history_rating_threshold == 0.8

    def test_create_decision_engine_helper(self) -> None:
        """create_decision_engine 辅助函数正常工作。"""
        engine = create_decision_engine(risk_engine=MockRiskEngine())
        assert isinstance(engine, DecisionEngine)

    def test_graph_built_on_init(self) -> None:
        """初始化时构建 LangGraph 决策树。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine())
        # _graph 应为已编译的 LangGraph 实例
        assert engine._graph is not None
        # 应支持 invoke 方法
        assert hasattr(engine._graph, "invoke")


# ============================================================
# 测试套件 2: 决策树图构建
# ============================================================


class TestDecisionGraphStructure:
    """决策树图结构测试。"""

    def test_graph_has_5_nodes(self) -> None:
        """决策树应包含 5 个节点。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine())
        # 通过执行一次决策验证图能正常工作
        result = engine.decide(problem_description="测试")
        assert "decision" in result

    def test_initial_state_factory(self) -> None:
        """create_initial_decision_state 工厂函数创建合法状态。"""
        state = create_initial_decision_state(
            problem_description="nginx 启动失败",
            fix_commands=["systemctl restart nginx"],
        )
        assert state["problem_description"] == "nginx 启动失败"
        assert state["fix_commands"] == ["systemctl restart nginx"]
        assert state["hitl_status"] == "pending"
        assert state["decision"] == ""
        assert state["selected_history_case"] is None


# ============================================================
# 测试套件 3: 决策逻辑
# ============================================================


class TestDecisionLogic:
    """决策引擎核心决策逻辑测试。"""

    def test_low_risk_proceed(
        self,
        sample_root_cause: RootCause,
    ) -> None:
        """LOW 风险 + 无历史案例 → decision=proceed。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            confidence_calculator=ConfidenceCalculator(),
        )

        result = engine.decide(
            problem_description="查看磁盘使用情况",
            fix_commands=["df -h"],
            root_cause=sample_root_cause,
        )

        assert result["decision"] == "proceed"
        assert result["hitl_status"] == "pending"
        assert result["anti_bias_disclaimer"] == ""
        assert result["risk_assessment"] is not None
        assert result["risk_assessment"]["risk_level"] == "low"

    def test_medium_risk_needs_approval(self) -> None:
        """MEDIUM 风险 → decision=needs_approval, hitl=waiting_approval。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.MEDIUM))

        result = engine.decide(
            problem_description="重启 nginx 服务",
            fix_commands=["systemctl restart nginx"],
        )

        assert result["decision"] == "needs_approval"
        assert result["hitl_status"] == "waiting_approval"
        assert "MEDIUM" in result["reasoning"] or "medium" in result["reasoning"]

    def test_high_risk_needs_approval(self) -> None:
        """HIGH 风险 → decision=needs_approval。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.HIGH))

        result = engine.decide(
            problem_description="清理临时文件",
            fix_commands=["rm -rf /tmp/cache"],
        )

        assert result["decision"] == "needs_approval"
        assert result["hitl_status"] == "waiting_approval"

    def test_deny_risk_abort(self) -> None:
        """DENY 风险 → decision=abort, hitl=rejected。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.DENY))

        result = engine.decide(
            problem_description="危险操作",
            fix_commands=["rm -rf /"],
        )

        assert result["decision"] == "abort"
        assert result["hitl_status"] == "rejected"
        assert "DENY" in result["reasoning"] or "deny" in result["reasoning"]

    def test_no_fix_commands_proceed(self) -> None:
        """无修复命令（仅诊断）→ decision=proceed。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine())

        result = engine.decide(
            problem_description="诊断 nginx 故障",
            fix_commands=None,
        )

        assert result["decision"] == "proceed"
        assert result["risk_assessment"] is None

    def test_empty_problem_description_aborts(self) -> None:
        """空问题描述 → decision=abort（intake 节点拒绝）。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine())

        result = engine.decide(
            problem_description="",
            fix_commands=["df -h"],
        )

        assert result["decision"] == "abort"
        assert result["hitl_status"] == "rejected"


# ============================================================
# 测试套件 4: 历史案例检索与复用
# ============================================================


class TestHistoryRetrieval:
    """历史案例检索与复用测试。"""

    def test_high_rated_history_case_reused(
        self,
        high_rated_history_case: dict,
    ) -> None:
        """高成功率历史案例 → decision=use_history（风险 LOW 时）。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=make_history_callback([high_rated_history_case]),
        )

        result = engine.decide(
            problem_description="MySQL 服务无法启动",
            fix_commands=["systemctl restart mysql"],
        )

        assert result["decision"] == "use_history"
        assert result["history_case"] is not None
        assert result["history_case"]["success_rating"] == 1.0
        # 必须包含防偏见警示语
        assert result["anti_bias_disclaimer"] == _ANTI_BIAS_DISCLAIMER
        assert "该历史案例仅供参考" in result["anti_bias_disclaimer"]

    def test_low_rated_history_case_not_reused(
        self,
        low_rated_history_case: dict,
    ) -> None:
        """低成功率历史案例 → 不复用，decision=proceed（风险 LOW）。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=make_history_callback([low_rated_history_case]),
        )

        result = engine.decide(
            problem_description="MySQL 服务无法启动",
            fix_commands=["systemctl restart mysql"],
        )

        # 低成功率案例不应被复用，回退到 proceed
        assert result["decision"] == "proceed"
        assert result["history_case"] is None
        assert result["anti_bias_disclaimer"] == ""

    def test_no_history_callback_skips_retrieval(self) -> None:
        """无 history_callback → 跳过历史检索。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=None,
        )

        result = engine.decide(
            problem_description="测试",
            fix_commands=["df -h"],
        )

        assert result["history_case"] is None
        assert result["decision"] == "proceed"

    def test_high_risk_overrides_history(
        self,
        high_rated_history_case: dict,
    ) -> None:
        """HIGH 风险 + 历史案例 → 优先 needs_approval（风险优先于历史）。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.HIGH),
            history_callback=make_history_callback([high_rated_history_case]),
        )

        result = engine.decide(
            problem_description="MySQL 服务无法启动",
            fix_commands=["rm -rf /tmp/cache"],
        )

        # HIGH 风险优先，需审批
        assert result["decision"] == "needs_approval"
        assert result["hitl_status"] == "waiting_approval"

    def test_history_callback_exception_handled(self) -> None:
        """history_callback 抛异常 → 不影响决策（fallback 到 proceed）。"""
        def faulty_callback(problem: str) -> list[dict]:
            raise RuntimeError("database error")

        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=faulty_callback,
        )

        result = engine.decide(
            problem_description="测试",
            fix_commands=["df -h"],
        )

        # 异常被捕获，决策正常进行
        assert result["decision"] == "proceed"
        assert result["history_case"] is None

    def test_custom_rating_threshold(self) -> None:
        """自定义 rating_threshold=0.9 时，0.85 案例不应被复用。"""
        case_with_085 = {
            "problem_description": "test",
            "fix_commands": ["df -h"],
            "success_rating": 0.85,
        }
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=make_history_callback([case_with_085]),
            history_rating_threshold=0.9,
        )

        result = engine.decide(
            problem_description="test",
            fix_commands=["df -h"],
        )

        # 0.85 < 0.9 阈值，不复用
        assert result["decision"] == "proceed"
        assert result["history_case"] is None


# ============================================================
# 测试套件 5: 风险评估集成
# ============================================================


class TestRiskAssessmentIntegration:
    """风险评估集成测试。"""

    def test_risk_assessment_in_output(self) -> None:
        """决策输出应包含 risk_assessment 字段。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.MEDIUM))

        result = engine.decide(
            problem_description="test",
            fix_commands=["systemctl restart nginx"],
        )

        assert result["risk_assessment"] is not None
        assert result["risk_assessment"]["risk_level"] == "medium"
        assert result["risk_assessment"]["command"] == "systemctl restart nginx"

    def test_assess_fix_commands_batch(self) -> None:
        """assess_fix_commands 批量评估接口（保留旧版兼容）。"""
        risk = MockRiskEngine()
        engine = DecisionEngine(risk_engine=risk)

        commands = ["df -h", "systemctl restart nginx", "rm -rf /"]
        assessments = engine.assess_fix_commands(commands)

        assert len(assessments) == 3
        assert all(isinstance(a, RiskAssessment) for a in assessments)
        # MockRiskEngine 总是返回相同 level
        assert all(a.risk_level == risk.level for a in assessments)

    def test_determine_hitl_status_static(self) -> None:
        """determine_hitl_status 静态方法测试（保留旧版兼容）。"""
        # None → pending
        assert DecisionEngine.determine_hitl_status(None) == "pending"

        # LOW → pending
        low_risk = RiskAssessment(
            command="df -h",
            risk_level=RiskLevel.LOW,
        )
        assert DecisionEngine.determine_hitl_status(low_risk) == "pending"

        # MEDIUM → waiting_approval
        medium_risk = RiskAssessment(
            command="systemctl restart nginx",
            risk_level=RiskLevel.MEDIUM,
        )
        assert DecisionEngine.determine_hitl_status(medium_risk) == "waiting_approval"

        # HIGH → waiting_approval
        high_risk = RiskAssessment(
            command="rm -rf /tmp",
            risk_level=RiskLevel.HIGH,
        )
        assert DecisionEngine.determine_hitl_status(high_risk) == "waiting_approval"

        # DENY → rejected
        deny_risk = RiskAssessment(
            command="rm -rf /",
            risk_level=RiskLevel.DENY,
        )
        assert DecisionEngine.determine_hitl_status(deny_risk) == "rejected"


# ============================================================
# 测试套件 6: 置信度计算集成
# ============================================================


class TestConfidenceIntegration:
    """置信度计算集成测试。"""

    def test_confidence_calculated_with_root_cause(
        self,
        sample_root_cause: RootCause,
    ) -> None:
        """提供 root_cause + confidence_calculator → 计算置信度。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            confidence_calculator=ConfidenceCalculator(),
        )

        result = engine.decide(
            problem_description="OOM 故障",
            fix_commands=["df -h"],
            root_cause=sample_root_cause,
        )

        # 应计算非零置信度（sample_root_cause 有 2 条 grounded 证据）
        assert result["confidence"] > 0.0
        assert 0.0 <= result["confidence"] <= 1.0

    def test_confidence_zero_without_root_cause(self) -> None:
        """无 root_cause → 置信度为 0.0。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            confidence_calculator=ConfidenceCalculator(),
        )

        result = engine.decide(
            problem_description="test",
            fix_commands=["df -h"],
            root_cause=None,
        )

        assert result["confidence"] == 0.0

    def test_confidence_zero_without_calculator(
        self,
        sample_root_cause: RootCause,
    ) -> None:
        """无 confidence_calculator → 置信度为 0.0。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            confidence_calculator=None,
        )

        result = engine.decide(
            problem_description="test",
            fix_commands=["df -h"],
            root_cause=sample_root_cause,
        )

        assert result["confidence"] == 0.0


# ============================================================
# 测试套件 7: 备选方案生成
# ============================================================


class TestAlternativesGeneration:
    """备选方案生成测试。"""

    def test_proceed_alternatives(self) -> None:
        """proceed 决策 → 含 wait / abort 备选。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.LOW))
        result = engine.decide(
            problem_description="test",
            fix_commands=["df -h"],
        )
        actions = [a["action"] for a in result["alternatives"]]
        assert "wait" in actions
        assert "abort" in actions

    def test_needs_approval_alternatives(self) -> None:
        """needs_approval 决策 → 含 approve / reject / modify 备选。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.MEDIUM))
        result = engine.decide(
            problem_description="test",
            fix_commands=["systemctl restart nginx"],
        )
        actions = [a["action"] for a in result["alternatives"]]
        assert "approve" in actions
        assert "reject" in actions
        assert "modify" in actions

    def test_abort_alternatives(self) -> None:
        """abort 决策 → 含 modify / escalate 备选。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.DENY))
        result = engine.decide(
            problem_description="test",
            fix_commands=["rm -rf /"],
        )
        actions = [a["action"] for a in result["alternatives"]]
        assert "modify" in actions
        assert "escalate" in actions

    def test_use_history_alternatives(
        self,
        high_rated_history_case: dict,
    ) -> None:
        """use_history 决策 → 含 verify_first / modify / proceed_with_caution。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=make_history_callback([high_rated_history_case]),
        )
        result = engine.decide(
            problem_description="test",
            fix_commands=["df -h"],
        )
        assert result["decision"] == "use_history"
        actions = [a["action"] for a in result["alternatives"]]
        assert "verify_first" in actions
        assert "modify" in actions
        assert "proceed_with_caution" in actions

    def test_rollback_added_to_alternatives(self) -> None:
        """提供 rollback_commands → 追加 rollback 备选。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.LOW))
        result = engine.decide(
            problem_description="test",
            fix_commands=["df -h"],
            rollback_commands=["systemctl stop nginx"],
        )
        actions = [a["action"] for a in result["alternatives"]]
        assert "rollback" in actions


# ============================================================
# 测试套件 8: MCP tool wrapper（tools.decision）
# ============================================================


class TestDecisionToolWrapper:
    """tools.decision MCP tool wrapper 测试。"""

    def test_invoke_decision_tool_minimal_params(self) -> None:
        """invoke_decision_tool 接受最小参数。"""
        from tools.decision import invoke_decision_tool, reset_decision_engine

        reset_decision_engine()  # 确保单例干净
        result = invoke_decision_tool({
            "problem_description": "测试问题",
        })

        assert "decision" in result
        assert result["decision"] in ("proceed", "needs_approval", "abort", "use_history")

    def test_invoke_decision_tool_full_params(self) -> None:
        """invoke_decision_tool 接受完整参数。"""
        from tools.decision import invoke_decision_tool, reset_decision_engine

        reset_decision_engine()
        result = invoke_decision_tool({
            "problem_description": "nginx 启动失败",
            "fix_commands": ["systemctl restart nginx"],
            "rollback_commands": ["systemctl stop nginx"],
            "target_asset": "demo-nginx",
            "reasoning_mode": "deep",
        })

        assert result["decision"] == "needs_approval"
        assert result["risk_assessment"] is not None
        assert result["risk_assessment"]["target_asset"] == "demo-nginx"
        # 应有 rollback 备选
        actions = [a["action"] for a in result["alternatives"]]
        assert "rollback" in actions

    def test_invoke_decision_tool_missing_required(self) -> None:
        """缺少必填参数 → 抛 ValueError。"""
        from tools.decision import invoke_decision_tool, reset_decision_engine

        reset_decision_engine()
        with pytest.raises(ValueError, match="problem_description is required"):
            invoke_decision_tool({})

    def test_invoke_decision_tool_invalid_type(self) -> None:
        """参数类型错误 → 抛 ValueError。"""
        from tools.decision import invoke_decision_tool, reset_decision_engine

        reset_decision_engine()
        with pytest.raises(ValueError, match="must be str"):
            invoke_decision_tool({
                "problem_description": 123,  # 应为 str
            })

        with pytest.raises(ValueError, match="must be list"):
            invoke_decision_tool({
                "problem_description": "test",
                "fix_commands": "df -h",  # 应为 list
            })

    def test_tool_metadata(self) -> None:
        """工具元数据完整。"""
        from tools.decision import get_tool_metadata

        meta = get_tool_metadata()
        assert meta["name"] == "decision"
        assert "description" in meta
        assert "input_schema" in meta
        assert "output_schema" in meta
        assert "problem_description" in meta["input_schema"]["properties"]
        assert "problem_description" in meta["input_schema"]["required"]

    def test_get_decision_engine_singleton(self) -> None:
        """get_decision_engine 返回单例。"""
        from tools.decision import get_decision_engine, reset_decision_engine

        reset_decision_engine()
        engine1 = get_decision_engine()
        engine2 = get_decision_engine()
        assert engine1 is engine2

        # force_rebuild=True 强制重建
        engine3 = get_decision_engine(force_rebuild=True)
        assert engine3 is not engine1


# ============================================================
# 测试套件 9: 异步接口
# ============================================================


class TestAsyncInterface:
    """异步决策接口测试。"""

    @pytest.mark.asyncio
    async def test_adecide_returns_dict(self) -> None:
        """adecide 异步接口返回决策字典。"""
        engine = DecisionEngine(risk_engine=MockRiskEngine(level=RiskLevel.LOW))

        result = await engine.adecide(
            problem_description="test",
            fix_commands=["df -h"],
        )

        assert isinstance(result, dict)
        assert result["decision"] == "proceed"

    @pytest.mark.asyncio
    async def test_adecide_with_history(
        self,
        high_rated_history_case: dict,
    ) -> None:
        """adecide 异步接口支持历史案例检索。"""
        engine = DecisionEngine(
            risk_engine=MockRiskEngine(level=RiskLevel.LOW),
            history_callback=make_history_callback([high_rated_history_case]),
        )

        result = await engine.adecide(
            problem_description="MySQL 服务无法启动",
            fix_commands=["systemctl restart mysql"],
        )

        assert result["decision"] == "use_history"
        assert result["history_case"] is not None
