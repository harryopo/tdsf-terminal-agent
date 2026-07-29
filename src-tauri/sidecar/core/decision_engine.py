"""
core/decision_engine.py — 决策引擎（T-P1-06.4，用 LangGraph 重写）
====================================================================

spec 要求（用户决策④：DecisionEngine 用 LangGraph 重写，不复用旧代码）：
- 基于 LangGraph 节点实现决策树
- 集成历史案例检索（调用 history tool）
- 集成到 LangGraph `decision` tool

设计要点（与旧 projects/src/tdsf/core/decision_engine.py 的区别）：
1. 不再使用旧的 DecisionCard 大模型，改用 dict 输出（MCP tool 兼容）
2. 决策流程用 LangGraph StateGraph 实现，节点间状态机化
3. 历史案例检索解耦：通过 history_tool_callback 注入，避免硬依赖 history tool
4. 风险评估解耦：通过 risk_engine 注入（鸭子类型）
5. 置信度计算解耦：通过 confidence_calculator 注入
6. 决策树含防偏见警示（保留旧版 _ANTI_BIAS_DISCLAIMER 设计）

决策树结构（5 节点 LangGraph）：

    START
      │
      ▼
    intake ──────────► history_retrieve
      │                    │
      │                    ▼
      │                risk_assess
      │                    │
      │                    ▼
      │                  decide
      │                    │
      │                    ▼
      │                alternatives
      │                    │
      └────────────────────┘
                            │
                            ▼
                           END

节点职责：
1. intake_node:          接收问题描述 + 修复命令，初始化决策状态
2. history_retrieve_node: 调用 history tool 检索相似案例（>= 0.8 成功率才复用）
3. risk_assess_node:     调用 RiskEngine 评估命令风险
4. decide_node:          综合风险 + 历史案例 + 置信度，输出 proceed/needs_approval/abort/use_history
5. alternatives_node:    生成备选方案

输出格式（dict，与 MCP tool 兼容）：
    {
        "decision": "proceed" | "needs_approval" | "abort" | "use_history",
        "alternatives": [{"action": "...", "reason": "..."}, ...],
        "reasoning": "决策理由",
        "risk_assessment": {...},          # RiskAssessment.model_dump()
        "history_case": {...} | None,      # 复用的历史案例
        "confidence": 0.0-1.0,
        "hitl_status": "pending" | "waiting_approval" | "rejected",
        "anti_bias_disclaimer": "..."      # 防偏见警示语
    }
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Protocol, TypedDict

from langgraph.graph import END, START, StateGraph

from core.confidence import ConfidenceCalculator
from core.schemas import (
    RiskAssessment,
    RiskLevel,
    RootCause,
    risk_level_to_l0_l4,
)

logger = logging.getLogger("sidecar.core.decision_engine")


# ============================================================================
# 协议定义：风险引擎接口（鸭子类型，与旧版保持兼容）
# ============================================================================


class RiskEngineProtocol(Protocol):
    """风险引擎协议（鸭子类型接口）。

    任何实现了 ``assess(command, target_asset) -> RiskAssessment`` 方法的对象
    均可作为 ``DecisionEngine`` 的风险引擎注入。
    """

    def assess(self, command: str, target_asset: str = "") -> RiskAssessment:
        """评估单条命令的风险等级。"""
        ...


# 历史案例检索回调类型
# 输入：problem_description（问题描述）
# 输出：list[dict]，每个 dict 至少包含 success_rating / fix_commands / problem_description
HistoryRetrieveCallback = Callable[[str], list[dict]]


# ============================================================================
# 常量定义
# ============================================================================

# 历史案例复用阈值（ITOps AlertProcessor 策略：success_rate >= 0.8 才复用）
_DEFAULT_HISTORY_RATING_THRESHOLD: float = 0.8

# 防偏见警示语（注入决策输出时强制附加，防止 LLM 直接照搬历史结论）
_ANTI_BIAS_DISCLAIMER: str = (
    "该历史案例仅供参考，你仍必须基于当前证据独立验证，不得直接照搬历史结论"
)


# ============================================================================
# 决策状态（LangGraph State）
# ============================================================================


class DecisionState(TypedDict, total=False):
    """LangGraph 决策树状态（所有字段可选，便于增量更新）。

    设计：
    - 每个节点返回 dict（只包含需要更新的字段）
    - LangGraph 自动 merge 到 DecisionState
    - 状态字段按决策流程阶段分组
    """

    # === 输入字段 ===
    problem_description: str          # 问题描述
    fix_commands: list[str]           # 修复命令列表
    rollback_commands: list[str]      # 回滚命令列表
    target_asset: str                 # 目标资产名称（用于环境关键性判定）
    reasoning_mode: str               # 推理模式（fast / deep）
    root_cause: RootCause | None      # 根因分析结果（可选）

    # === 历史案例字段 ===
    history_cases: list[dict]         # 检索到的历史案例列表
    selected_history_case: dict | None  # 选中的复用案例（None 表示不复用）

    # === 风险评估字段 ===
    risk_assessments: list[RiskAssessment]  # 多条命令的风险评估（与 fix_commands 对应）
    primary_risk: RiskAssessment | None     # 主风险评估（取 fix_commands[0]）

    # === 置信度字段 ===
    confidence: float                 # 综合置信度（0.0-1.0）

    # === 决策输出字段 ===
    decision: str                     # proceed / needs_approval / abort / use_history
    alternatives: list[dict]          # 备选方案列表
    reasoning: str                    # 决策理由
    hitl_status: str                  # pending / waiting_approval / rejected
    anti_bias_disclaimer: str         # 防偏见警示语


# ============================================================================
# 决策状态工厂函数
# ============================================================================


def create_initial_decision_state(
    problem_description: str,
    fix_commands: list[str] | None = None,
    rollback_commands: list[str] | None = None,
    target_asset: str = "",
    reasoning_mode: str = "deep",
    root_cause: RootCause | None = None,
) -> DecisionState:
    """创建决策状态初始值

    Args:
        problem_description: 问题描述
        fix_commands: 修复命令列表
        rollback_commands: 回滚命令列表
        target_asset: 目标资产名称
        reasoning_mode: 推理模式（fast / deep）
        root_cause: 根因分析结果

    Returns:
        DecisionState 初始状态
    """
    return DecisionState(
        problem_description=problem_description,
        fix_commands=fix_commands if fix_commands is not None else [],
        rollback_commands=rollback_commands if rollback_commands is not None else [],
        target_asset=target_asset,
        reasoning_mode=reasoning_mode,
        root_cause=root_cause,
        history_cases=[],
        selected_history_case=None,
        risk_assessments=[],
        primary_risk=None,
        confidence=0.0,
        decision="",
        alternatives=[],
        reasoning="",
        hitl_status="pending",
        anti_bias_disclaimer="",
    )


# ============================================================================
# 节点 1: intake — 接收问题描述，初始化决策状态
# ============================================================================


def intake_node(state: DecisionState) -> dict:
    """接收节点：验证输入，初始化决策状态

    职责：
    - 检查 problem_description 非空
    - 检查 fix_commands 是否为空（空时跳过风险评估）
    - 设置 hitl_status=pending
    """
    problem = state.get("problem_description", "")
    fix_commands = state.get("fix_commands", [])

    if not problem:
        logger.warning("intake: empty problem_description, will abort")
        return {
            "decision": "abort",
            "reasoning": "问题描述为空，无法决策",
            "hitl_status": "rejected",
        }

    logger.info(
        f"intake: problem='{problem[:50]}', fix_commands_count={len(fix_commands)}"
    )

    return {
        "hitl_status": "pending",
    }


# ============================================================================
# 节点 2: history_retrieve — 检索历史案例
# ============================================================================


def _make_history_retrieve_node(
    history_callback: HistoryRetrieveCallback | None,
    rating_threshold: float = _DEFAULT_HISTORY_RATING_THRESHOLD,
) -> Callable[[DecisionState], dict]:
    """工厂函数：创建 history_retrieve 节点

    Args:
        history_callback: 历史案例检索回调（None 时跳过检索）
        rating_threshold: 复用阈值（success_rating >= 此值才复用）

    Returns:
        history_retrieve 节点函数
    """

    def history_retrieve_node(state: DecisionState) -> dict:
        """历史案例检索节点

        职责：
        - 调用 history_callback 检索相似案例
        - 按 success_rating >= rating_threshold 过滤
        - 取首个满足条件的案例作为 selected_history_case
        - 无可复用案例时 selected_history_case=None
        """
        if history_callback is None:
            logger.info("history_retrieve: no callback, skipping")
            return {
                "history_cases": [],
                "selected_history_case": None,
            }

        problem = state.get("problem_description", "")
        try:
            cases = history_callback(problem)
        except Exception as e:
            logger.warning(f"history_retrieve: callback failed: {e}")
            cases = []

        logger.info(
            f"history_retrieve: retrieved {len(cases)} cases, "
            f"threshold={rating_threshold}"
        )

        # 筛选可复用案例（success_rating >= 阈值）
        reusable: dict | None = None
        for case in cases:
            success_rating = case.get("success_rating", 0.0)
            if success_rating >= rating_threshold:
                reusable = case
                logger.info(
                    f"history_retrieve: selected case with "
                    f"success_rating={success_rating}"
                )
                break

        return {
            "history_cases": cases,
            "selected_history_case": reusable,
        }

    return history_retrieve_node


# ============================================================================
# 节点 3: risk_assess — 风险评估
# ============================================================================


def _make_risk_assess_node(
    risk_engine: RiskEngineProtocol,
) -> Callable[[DecisionState], dict]:
    """工厂函数：创建 risk_assess 节点

    Args:
        risk_engine: 风险引擎实例

    Returns:
        risk_assess 节点函数
    """

    def risk_assess_node(state: DecisionState) -> dict:
        """风险评估节点

        职责：
        - 对每条 fix_command 调用 risk_engine.assess
        - 取 fix_commands[0] 的评估结果作为 primary_risk
        - 无 fix_commands 时 primary_risk=None
        """
        fix_commands = state.get("fix_commands", [])
        target_asset = state.get("target_asset", "")

        if not fix_commands:
            logger.info("risk_assess: no fix_commands, skipping")
            return {
                "risk_assessments": [],
                "primary_risk": None,
            }

        assessments: list[RiskAssessment] = []
        for cmd in fix_commands:
            try:
                assessment = risk_engine.assess(cmd, target_asset)
                assessments.append(assessment)
                logger.info(
                    f"risk_assess: cmd='{cmd[:40]}', "
                    f"level={assessment.risk_level.value}"
                )
            except Exception as e:
                logger.warning(
                    f"risk_assess: failed for cmd='{cmd[:40]}': {e}"
                )

        primary = assessments[0] if assessments else None
        return {
            "risk_assessments": assessments,
            "primary_risk": primary,
        }

    return risk_assess_node


# ============================================================================
# 节点 4: decide — 综合决策
# ============================================================================


def _make_decide_node(
    confidence_calculator: ConfidenceCalculator | None,
) -> Callable[[DecisionState], dict]:
    """工厂函数：创建 decide 节点

    Args:
        confidence_calculator: 置信度计算器（None 时跳过置信度计算）

    Returns:
        decide 节点函数
    """

    def decide_node(state: DecisionState) -> dict:
        """决策节点

        职责：
        - 综合风险评估 + 历史案例 + 置信度，输出决策
        - 决策类型：proceed / needs_approval / abort / use_history
        - 设置 hitl_status（pending / waiting_approval / rejected）
        - 附带防偏见警示语（仅 use_history 时）

        决策规则：
        1. primary_risk.risk_level == DENY → decision=abort, hitl=rejected
        2. primary_risk.risk_level in (HIGH, MEDIUM) → decision=needs_approval, hitl=waiting_approval
        3. selected_history_case 存在 → decision=use_history, 附带防偏见警示
        4. primary_risk.risk_level == LOW → decision=proceed
        5. 无 primary_risk（无 fix_commands）→ decision=proceed（仅诊断）
        """
        primary_risk = state.get("primary_risk")
        history_case = state.get("selected_history_case")
        root_cause = state.get("root_cause")

        # === 计算置信度 ===
        confidence: float = 0.0
        if confidence_calculator and root_cause:
            try:
                evidence_chain = root_cause.evidence_chain if root_cause else []
                confidence = confidence_calculator.compute_chain_confidence(
                    evidence_chain
                )
                logger.info(f"decide: confidence={confidence}")
            except Exception as e:
                logger.warning(f"decide: confidence calc failed: {e}")
                confidence = 0.0

        # === 决策逻辑 ===
        # 情况 1：无风险评估（无 fix_commands，仅诊断）
        if primary_risk is None:
            logger.info("decide: no risk assessment, decision=proceed (diagnosis only)")
            return {
                "decision": "proceed",
                "reasoning": "无修复命令，仅诊断，可直接执行",
                "hitl_status": "pending",
                "confidence": confidence,
                "anti_bias_disclaimer": "",
            }

        risk_level = primary_risk.adjusted_risk_level

        # 情况 2：DENY → 直接拒绝
        if risk_level == RiskLevel.DENY:
            logger.info(f"decide: risk={risk_level.value}, decision=abort")
            return {
                "decision": "abort",
                "reasoning": (
                    f"命令被风险引擎判定为 DENY（禁止执行），"
                    f"匹配规则: {primary_risk.matched_rule_name}"
                ),
                "hitl_status": "rejected",
                "confidence": confidence,
                "anti_bias_disclaimer": "",
            }

        # 情况 3：HIGH / MEDIUM → 需要审批
        if risk_level in (RiskLevel.HIGH, RiskLevel.MEDIUM):
            l0_l4 = risk_level_to_l0_l4(risk_level)
            logger.info(
                f"decide: risk={risk_level.value}({l0_l4}), "
                f"decision=needs_approval"
            )
            return {
                "decision": "needs_approval",
                "reasoning": (
                    f"命令风险等级 {risk_level.value}({l0_l4})，"
                    f"需用户审批后执行"
                ),
                "hitl_status": "waiting_approval",
                "confidence": confidence,
                "anti_bias_disclaimer": "",
            }

        # 情况 4：LOW + 有可复用历史案例 → use_history
        if risk_level == RiskLevel.LOW and history_case is not None:
            logger.info(
                f"decide: risk=LOW + history_case found, decision=use_history"
            )
            return {
                "decision": "use_history",
                "reasoning": (
                    f"命令风险等级 LOW，且存在 success_rating="
                    f"{history_case.get('success_rating', 0.0)} 的历史案例，"
                    f"可复用历史方案（含防偏见警示）"
                ),
                "hitl_status": "pending",
                "confidence": confidence,
                "anti_bias_disclaimer": _ANTI_BIAS_DISCLAIMER,
            }

        # 情况 5：LOW + 无历史案例 → proceed
        logger.info("decide: risk=LOW, decision=proceed")
        return {
            "decision": "proceed",
            "reasoning": "命令风险等级 LOW，可直接执行",
            "hitl_status": "pending",
            "confidence": confidence,
            "anti_bias_disclaimer": "",
        }

    return decide_node


# ============================================================================
# 节点 5: alternatives — 生成备选方案
# ============================================================================


def alternatives_node(state: DecisionState) -> dict:
    """备选方案节点

    职责：
    - 根据 decision 类型生成备选方案
    - 备选方案格式：[{"action": "...", "reason": "..."}, ...]

    备选方案生成规则：
    - proceed: [wait, abort]
    - needs_approval: [approve, reject, modify]
    - abort: [modify, escalate]
    - use_history: [verify_first, modify, proceed_with_caution]
    """
    decision = state.get("decision", "proceed")
    fix_commands = state.get("fix_commands", [])
    rollback_commands = state.get("rollback_commands", [])

    alternatives_map: dict[str, list[dict]] = {
        "proceed": [
            {"action": "wait", "reason": "等待更多证据后再执行"},
            {"action": "abort", "reason": "中止执行"},
        ],
        "needs_approval": [
            {"action": "approve", "reason": "批准并执行"},
            {"action": "reject", "reason": "拒绝执行"},
            {"action": "modify", "reason": "修改命令后重新评估"},
        ],
        "abort": [
            {"action": "modify", "reason": "修改命令后重新评估"},
            {"action": "escalate", "reason": "升级到人工处理"},
        ],
        "use_history": [
            {"action": "verify_first", "reason": "先验证历史方案是否适用当前场景"},
            {"action": "modify", "reason": "基于历史方案修改后执行"},
            {"action": "proceed_with_caution", "reason": "谨慎执行历史方案"},
        ],
    }

    alternatives = alternatives_map.get(decision, [])

    # 如有回滚命令，追加 rollback 备选
    if rollback_commands:
        alternatives.append(
            {
                "action": "rollback",
                "reason": f"使用回滚命令: {' '.join(rollback_commands[:1])}",
            }
        )

    logger.info(
        f"alternatives: decision={decision}, "
        f"generated {len(alternatives)} alternatives"
    )

    return {
        "alternatives": alternatives,
    }


# ============================================================================
# 路由函数
# ============================================================================


def route_from_intake(state: DecisionState) -> str:
    """intake 节点路由

    - decision 已设置为 abort（输入无效）→ END
    - 否则 → history_retrieve
    """
    if state.get("decision") == "abort":
        return END
    return "history_retrieve"


def route_from_alternatives(state: DecisionState) -> str:
    """alternatives 节点路由（固定到 END）"""
    return END


# ============================================================================
# 决策引擎主类
# ============================================================================


class DecisionEngine:
    """决策引擎（基于 LangGraph 重写）

    串联风险引擎、置信度计算器、历史案例检索，产出结构化决策。

    使用方式：
        engine = DecisionEngine(
            risk_engine=RiskEngine(...),
            confidence_calculator=ConfidenceCalculator(),
            history_callback=history_tool.search,
        )
        result = engine.decide(
            problem_description="nginx 启动失败",
            fix_commands=["systemctl restart nginx"],
            target_asset="demo-nginx",
        )
        # result: {"decision": "needs_approval", "alternatives": [...], ...}
    """

    def __init__(
        self,
        risk_engine: RiskEngineProtocol,
        confidence_calculator: ConfidenceCalculator | None = None,
        history_callback: HistoryRetrieveCallback | None = None,
        history_rating_threshold: float = _DEFAULT_HISTORY_RATING_THRESHOLD,
    ) -> None:
        """初始化决策引擎

        Args:
            risk_engine: 风险引擎实例（必须实现 assess 方法）
            confidence_calculator: 置信度计算器（None 时跳过置信度计算）
            history_callback: 历史案例检索回调（None 时跳过历史检索）
            history_rating_threshold: 历史案例复用阈值（默认 0.8）
        """
        self.risk_engine: RiskEngineProtocol = risk_engine
        self.confidence_calculator: ConfidenceCalculator | None = confidence_calculator
        self.history_callback: HistoryRetrieveCallback | None = history_callback
        self.history_rating_threshold: float = history_rating_threshold

        # 构建决策图
        self._graph = self._build_graph()

    def _build_graph(self):
        """构建 LangGraph 决策树

        图结构：
            START → intake → history_retrieve → risk_assess → decide → alternatives → END
                    intake → END（输入无效时）

        Returns:
            编译后的 LangGraph 可执行图
        """
        builder: StateGraph = StateGraph(DecisionState)

        # 添加 5 节点
        builder.add_node("intake", intake_node)
        builder.add_node(
            "history_retrieve",
            _make_history_retrieve_node(
                self.history_callback,
                self.history_rating_threshold,
            ),
        )
        builder.add_node(
            "risk_assess",
            _make_risk_assess_node(self.risk_engine),
        )
        builder.add_node(
            "decide",
            _make_decide_node(self.confidence_calculator),
        )
        builder.add_node("alternatives", alternatives_node)

        # 添加边
        builder.add_edge(START, "intake")
        builder.add_conditional_edges(
            "intake",
            route_from_intake,
            ["history_retrieve", END],
        )
        builder.add_edge("history_retrieve", "risk_assess")
        builder.add_edge("risk_assess", "decide")
        builder.add_edge("decide", "alternatives")
        builder.add_edge("alternatives", END)

        logger.info("DecisionEngine: built LangGraph decision tree (5 nodes)")
        return builder.compile()

    # ----------------------------------------------------------
    # 主入口：执行决策
    # ----------------------------------------------------------

    def decide(
        self,
        problem_description: str,
        fix_commands: list[str] | None = None,
        rollback_commands: list[str] | None = None,
        target_asset: str = "",
        reasoning_mode: str = "deep",
        root_cause: RootCause | None = None,
    ) -> dict[str, Any]:
        """执行决策（同步）

        Args:
            problem_description: 问题描述
            fix_commands: 修复命令列表
            rollback_commands: 回滚命令列表
            target_asset: 目标资产名称
            reasoning_mode: 推理模式（fast / deep）
            root_cause: 根因分析结果

        Returns:
            决策结果字典（含 decision / alternatives / reasoning / 等）
        """
        initial_state = create_initial_decision_state(
            problem_description=problem_description,
            fix_commands=fix_commands,
            rollback_commands=rollback_commands,
            target_asset=target_asset,
            reasoning_mode=reasoning_mode,
            root_cause=root_cause,
        )

        logger.info(
            f"DecisionEngine.decide: problem='{problem_description[:50]}', "
            f"fix_commands={len(fix_commands) if fix_commands else 0}"
        )

        final_state = self._graph.invoke(initial_state)
        return self._format_output(final_state)

    async def adecide(
        self,
        problem_description: str,
        fix_commands: list[str] | None = None,
        rollback_commands: list[str] | None = None,
        target_asset: str = "",
        reasoning_mode: str = "deep",
        root_cause: RootCause | None = None,
    ) -> dict[str, Any]:
        """执行决策（异步）

        Args 与 decide() 相同。

        Returns:
            决策结果字典
        """
        initial_state = create_initial_decision_state(
            problem_description=problem_description,
            fix_commands=fix_commands,
            rollback_commands=rollback_commands,
            target_asset=target_asset,
            reasoning_mode=reasoning_mode,
            root_cause=root_cause,
        )

        logger.info(
            f"DecisionEngine.adecide: problem='{problem_description[:50]}', "
            f"fix_commands={len(fix_commands) if fix_commands else 0}"
        )

        final_state = await self._graph.ainvoke(initial_state)
        return self._format_output(final_state)

    # ----------------------------------------------------------
    # 输出格式化
    # ----------------------------------------------------------

    @staticmethod
    def _format_output(state: DecisionState) -> dict[str, Any]:
        """格式化决策输出（dict，MCP tool 兼容）

        Args:
            state: 决策树最终状态

        Returns:
            决策结果字典
        """
        primary_risk = state.get("primary_risk")
        history_case = state.get("selected_history_case")

        return {
            "decision": state.get("decision", "proceed"),
            "alternatives": state.get("alternatives", []),
            "reasoning": state.get("reasoning", ""),
            "risk_assessment": (
                primary_risk.model_dump() if primary_risk else None
            ),
            "history_case": history_case,
            "confidence": state.get("confidence", 0.0),
            "hitl_status": state.get("hitl_status", "pending"),
            "anti_bias_disclaimer": state.get("anti_bias_disclaimer", ""),
        }

    # ----------------------------------------------------------
    # 批量风险评估（保留旧版兼容接口）
    # ----------------------------------------------------------

    def assess_fix_commands(
        self,
        commands: list[str],
        target_asset: str = "",
    ) -> list[RiskAssessment]:
        """批量评估修复命令风险

        Args:
            commands: 命令列表
            target_asset: 目标资产名称

        Returns:
            RiskAssessment 列表（与输入命令一一对应）
        """
        return [
            self.risk_engine.assess(cmd, target_asset) for cmd in commands
        ]

    # ----------------------------------------------------------
    # HITL 状态查询（保留旧版兼容接口）
    # ----------------------------------------------------------

    @staticmethod
    def determine_hitl_status(
        risk_assessment: RiskAssessment | None,
    ) -> str:
        """根据风险评估确定 HITL 初始状态

        判定规则（与旧版一致）：
        - DENY → rejected
        - HIGH / MEDIUM → waiting_approval
        - LOW → pending
        - None → pending

        Args:
            risk_assessment: 风险评估结果

        Returns:
            HITL 状态字符串
        """
        if risk_assessment is None:
            return "pending"

        adjusted = risk_assessment.adjusted_risk_level
        if adjusted == RiskLevel.DENY:
            return "rejected"
        if adjusted in (RiskLevel.HIGH, RiskLevel.MEDIUM):
            return "waiting_approval"
        return "pending"


# ============================================================================
# 模块级便捷函数
# ============================================================================


def create_decision_engine(
    risk_engine: RiskEngineProtocol,
    confidence_calculator: ConfidenceCalculator | None = None,
    history_callback: HistoryRetrieveCallback | None = None,
) -> DecisionEngine:
    """创建决策引擎实例（便捷封装）

    Args:
        risk_engine: 风险引擎实例
        confidence_calculator: 置信度计算器（可选）
        history_callback: 历史案例检索回调（可选）

    Returns:
        DecisionEngine 实例
    """
    return DecisionEngine(
        risk_engine=risk_engine,
        confidence_calculator=confidence_calculator,
        history_callback=history_callback,
    )
