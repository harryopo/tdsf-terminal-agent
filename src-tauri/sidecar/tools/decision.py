"""
tools/decision.py — 决策 MCP tool（T-P1-07.4）
=================================================

包装 ``core.decision_engine.DecisionEngine``，提供 MCP tool 接口。

spec 要求：
- 调用迁移后的 DecisionEngine（T-P1-06.4 LangGraph 重写版）
- 输出：``{"decision": "...", "alternatives": [...]}``

输入格式（params）：
    {
        "problem_description": "nginx 启动失败",
        "fix_commands": ["systemctl restart nginx"],
        "rollback_commands": ["systemctl stop nginx"],
        "target_asset": "demo-nginx",
        "reasoning_mode": "deep",
        "root_cause": {...}  # 可选，RootCause.model_dump()
    }

输出格式：
    {
        "decision": "proceed" | "needs_approval" | "abort" | "use_history",
        "alternatives": [{"action": "...", "reason": "..."}, ...],
        "reasoning": "决策理由",
        "risk_assessment": {...} | None,
        "history_case": {...} | None,
        "confidence": 0.0-1.0,
        "hitl_status": "pending" | "waiting_approval" | "rejected",
        "anti_bias_disclaimer": "..."
    }

集成点：
- 被 graph/nodes.py 的 tool_call_node 调用（tool_name == "decision"）
- 通过 ``invoke_decision_tool`` 函数注册到 MCP tool 注册表
"""

from __future__ import annotations

import logging
from typing import Any

from core.confidence import ConfidenceCalculator
from core.decision_engine import DecisionEngine, HistoryRetrieveCallback
from core.risk_engine import RiskEngine
from core.schemas import RootCause

logger = logging.getLogger("sidecar.tools.decision")


# ============================================================================
# 模块级单例（懒加载，避免重复初始化开销）
# ============================================================================

# 全局 DecisionEngine 实例（首次访问时构建）
_engine_instance: DecisionEngine | None = None

# 默认配置文件路径（与 risk_engine 一致）
_DEFAULT_RISK_RULES_PATH: str = "config/risk_rules.yaml"
_DEFAULT_ASSETS_PATH: str = "config/assets.yaml"


# ============================================================================
# 工具初始化
# ============================================================================


def get_decision_engine(
    risk_engine: RiskEngine | None = None,
    confidence_calculator: ConfidenceCalculator | None = None,
    history_callback: HistoryRetrieveCallback | None = None,
    force_rebuild: bool = False,
) -> DecisionEngine:
    """获取 DecisionEngine 单例（懒加载）

    Args:
        risk_engine: 风险引擎实例（None 时使用默认 RiskEngine）
        confidence_calculator: 置信度计算器（None 时使用默认）
        history_callback: 历史案例检索回调（None 时跳过历史检索）
        force_rebuild: 强制重建实例（用于配置变更后重新初始化）

    Returns:
        DecisionEngine 实例
    """
    global _engine_instance

    if _engine_instance is None or force_rebuild:
        # 默认 RiskEngine（如未注入）
        if risk_engine is None:
            risk_engine = RiskEngine(
                risk_rules_path=_DEFAULT_RISK_RULES_PATH,
                assets_path=_DEFAULT_ASSETS_PATH,
            )
            logger.info(
                f"get_decision_engine: created default RiskEngine "
                f"(rules={_DEFAULT_RISK_RULES_PATH})"
            )

        # 默认 ConfidenceCalculator（如未注入）
        if confidence_calculator is None:
            confidence_calculator = ConfidenceCalculator()
            logger.info("get_decision_engine: created default ConfidenceCalculator")

        _engine_instance = DecisionEngine(
            risk_engine=risk_engine,
            confidence_calculator=confidence_calculator,
            history_callback=history_callback,
        )
        logger.info("get_decision_engine: built DecisionEngine singleton")

    return _engine_instance


def reset_decision_engine() -> None:
    """重置 DecisionEngine 单例（用于测试或配置变更）"""
    global _engine_instance
    _engine_instance = None
    logger.info("reset_decision_engine: cleared singleton")


# ============================================================================
# MCP tool 接口
# ============================================================================


def invoke_decision_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：调用 DecisionEngine 执行决策

    Args:
        params: 工具参数字典，包含：
            - problem_description (str, 必填): 问题描述
            - fix_commands (list[str], 可选): 修复命令列表
            - rollback_commands (list[str], 可选): 回滚命令列表
            - target_asset (str, 可选): 目标资产名称
            - reasoning_mode (str, 可选): 推理模式（默认 deep）
            - root_cause (dict, 可选): 根因分析结果（RootCause.model_dump()）

    Returns:
        决策结果字典（含 decision / alternatives / reasoning / 等）

    Raises:
        ValueError: 必填参数缺失或类型错误
    """
    # === 参数校验 ===
    problem_description = params.get("problem_description", "")
    if not problem_description:
        raise ValueError("problem_description is required")

    if not isinstance(problem_description, str):
        raise ValueError(
            f"problem_description must be str, got {type(problem_description).__name__}"
        )

    fix_commands = params.get("fix_commands", [])
    if not isinstance(fix_commands, list):
        raise ValueError(
            f"fix_commands must be list, got {type(fix_commands).__name__}"
        )

    rollback_commands = params.get("rollback_commands", [])
    if not isinstance(rollback_commands, list):
        raise ValueError(
            f"rollback_commands must be list, got {type(rollback_commands).__name__}"
        )

    target_asset = params.get("target_asset", "")
    reasoning_mode = params.get("reasoning_mode", "deep")
    root_cause_dump = params.get("root_cause")

    # === 转换 root_cause ===
    root_cause: RootCause | None = None
    if root_cause_dump is not None:
        try:
            root_cause = RootCause.model_validate(root_cause_dump)
        except Exception as e:
            logger.warning(f"invoke_decision_tool: invalid root_cause, ignoring: {e}")
            root_cause = None

    # === 调用 DecisionEngine ===
    engine = get_decision_engine()
    result = engine.decide(
        problem_description=problem_description,
        fix_commands=fix_commands,
        rollback_commands=rollback_commands,
        target_asset=target_asset,
        reasoning_mode=reasoning_mode,
        root_cause=root_cause,
    )

    logger.info(
        f"invoke_decision_tool: decision={result.get('decision')}, "
        f"hitl={result.get('hitl_status')}"
    )

    return result


# ============================================================================
# 工具元数据（供 MCP tool 注册表使用）
# ============================================================================


TOOL_METADATA: dict[str, Any] = {
    "name": "decision",
    "description": (
        "决策引擎：综合风险评估、历史案例、置信度，输出 proceed/needs_approval/"
        "abort/use_history 决策，并提供备选方案。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "problem_description": {
                "type": "string",
                "description": "问题描述（必填）",
            },
            "fix_commands": {
                "type": "array",
                "items": {"type": "string"},
                "description": "修复命令列表（可选）",
            },
            "rollback_commands": {
                "type": "array",
                "items": {"type": "string"},
                "description": "回滚命令列表（可选）",
            },
            "target_asset": {
                "type": "string",
                "description": "目标资产名称（用于环境关键性判定，可选）",
            },
            "reasoning_mode": {
                "type": "string",
                "enum": ["fast", "deep"],
                "description": "推理模式（默认 deep）",
            },
            "root_cause": {
                "type": "object",
                "description": "根因分析结果（RootCase model dump，可选）",
            },
        },
        "required": ["problem_description"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "decision": {
                "type": "string",
                "enum": ["proceed", "needs_approval", "abort", "use_history"],
            },
            "alternatives": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                },
            },
            "reasoning": {"type": "string"},
            "risk_assessment": {"type": ["object", "null"]},
            "history_case": {"type": ["object", "null"]},
            "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "hitl_status": {
                "type": "string",
                "enum": ["pending", "waiting_approval", "rejected"],
            },
            "anti_bias_disclaimer": {"type": "string"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据（供 MCP tool 注册表使用）"""
    return TOOL_METADATA


# ============================================================================
# 集成到 LangGraph tool_call 节点
# ============================================================================


def register_to_graph_nodes() -> None:
    """将 decision tool 注册到 graph/nodes.py 的 tool_call_node

    在 graph/nodes.py 的 tool_call_node 中，当 tool_name == "decision" 时，
    调用 invoke_decision_tool(params) 替代 mock 实现。

    使用方式（在 graph/nodes.py 中）：
        from tools.decision import invoke_decision_tool

        if tool_name == "decision":
            result = invoke_decision_tool(params)

    本函数提供显式注册接口（便于初始化时调用），
    但实际集成建议直接在 graph/nodes.py 中导入 invoke_decision_tool。
    """
    # 注册信号：导入本模块即视为注册（避免循环依赖）
    logger.info("register_to_graph_nodes: decision tool ready for integration")
