"""
tools/risk.py — 风险评估 MCP tool（T-P1-07.1）
=================================================

包装 ``core.risk_engine.RiskEngine``，提供 MCP tool 接口。

spec 要求：
- 输入：命令字符串 + 上下文
- 输出：``{"level": "L0-L4", "reason": "...", "require_approval": bool}``

输入格式（params）：
    {
        "command": "sudo systemctl restart nginx",
        "target_asset": "demo-nginx",   # 可选
        "context": {"agent": "main"}     # 可选，保留字段
    }

输出格式：
    {
        "level": "L0" | "L1" | "L2" | "L3" | "L4",
        "risk_level": "low" | "medium" | "high" | "deny",  # 原 4 档
        "reason": "sudo + systemctl + restart",
        "require_approval": true,
        "require_audit_log": false,
        "is_irreversible": false,
        "syntax_valid": true,
        "syntax_error": "",
        "matched_rule_name": "systemctl_restart",
        "target_asset": "demo-nginx",
        "environment_criticality": "medium",
        "adjusted_risk_level": "medium"
    }
"""

from __future__ import annotations

import logging
from typing import Any

from core.risk_engine import RiskEngine
from core.schemas import risk_level_to_l0_l4

logger = logging.getLogger("sidecar.tools.risk")


# ============================================================================
# 模块级单例
# ============================================================================

_engine_instance: RiskEngine | None = None
_DEFAULT_RISK_RULES_PATH: str = "config/risk_rules.yaml"
_DEFAULT_ASSETS_PATH: str = "config/assets.yaml"


# ============================================================================
# 工具初始化
# ============================================================================


def get_risk_engine(
    risk_rules_path: str | None = None,
    assets_path: str | None = None,
    force_rebuild: bool = False,
) -> RiskEngine:
    """获取 RiskEngine 单例（懒加载）

    Args:
        risk_rules_path: 风险规则配置文件路径（None 时使用默认）
        assets_path: 资产配置文件路径（None 时使用默认）
        force_rebuild: 强制重建实例

    Returns:
        RiskEngine 实例
    """
    global _engine_instance

    if _engine_instance is None or force_rebuild:
        rules = risk_rules_path or _DEFAULT_RISK_RULES_PATH
        assets = assets_path or _DEFAULT_ASSETS_PATH
        _engine_instance = RiskEngine(risk_rules_path=rules, assets_path=assets)
        logger.info(f"get_risk_engine: built RiskEngine (rules={rules})")

    return _engine_instance


def reset_risk_engine() -> None:
    """重置 RiskEngine 单例"""
    global _engine_instance
    _engine_instance = None
    logger.info("reset_risk_engine: cleared singleton")


# ============================================================================
# MCP tool 接口
# ============================================================================


def invoke_risk_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：调用 RiskEngine 评估命令风险

    Args:
        params: 工具参数字典，包含：
            - command (str, 必填): 待评估的命令
            - target_asset (str, 可选): 目标资产名称
            - context (dict, 可选): 上下文信息（保留字段）

    Returns:
        风险评估结果字典

    Raises:
        ValueError: 必填参数缺失或类型错误
    """
    # === 参数校验 ===
    command = params.get("command", "")
    if not command:
        raise ValueError("command is required")

    if not isinstance(command, str):
        raise ValueError(
            f"command must be str, got {type(command).__name__}"
        )

    target_asset = params.get("target_asset", "")
    if not isinstance(target_asset, str):
        raise ValueError(
            f"target_asset must be str, got {type(target_asset).__name__}"
        )

    # === 调用 RiskEngine ===
    engine = get_risk_engine()
    assessment = engine.assess(command, target_asset)

    # === 格式化输出 ===
    l0_l4 = risk_level_to_l0_l4(assessment.adjusted_risk_level)
    result = {
        "level": l0_l4,
        "risk_level": assessment.risk_level.value,
        "reason": assessment.matched_rule_name or "no rule matched",
        "require_approval": assessment.requires_confirmation,
        "require_audit_log": assessment.requires_audit_log,
        "is_irreversible": assessment.is_irreversible,
        "syntax_valid": assessment.syntax_valid,
        "syntax_error": assessment.syntax_error,
        "matched_rule_name": assessment.matched_rule_name,
        "target_asset": assessment.target_asset,
        "environment_criticality": assessment.environment_criticality,
        "adjusted_risk_level": assessment.adjusted_risk_level.value,
    }

    logger.info(
        f"invoke_risk_tool: cmd='{command[:40]}', level={l0_l4}, "
        f"approval={result['require_approval']}"
    )

    return result


# ============================================================================
# 工具元数据
# ============================================================================


TOOL_METADATA: dict[str, Any] = {
    "name": "risk",
    "description": (
        "风险评估：4 层风控管道（语法/规则/确认/审计），"
        "输出 L0-L4 风险等级 + 是否需要审批。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "待评估的命令（必填）"},
            "target_asset": {"type": "string", "description": "目标资产名称（可选）"},
            "context": {"type": "object", "description": "上下文信息（可选，保留）"},
        },
        "required": ["command"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "level": {"type": "string", "enum": ["L0", "L1", "L2", "L3", "L4"]},
            "risk_level": {
                "type": "string",
                "enum": ["low", "medium", "high", "deny"],
            },
            "reason": {"type": "string"},
            "require_approval": {"type": "boolean"},
            "require_audit_log": {"type": "boolean"},
            "is_irreversible": {"type": "boolean"},
            "syntax_valid": {"type": "boolean"},
            "syntax_error": {"type": "string"},
            "matched_rule_name": {"type": "string"},
            "target_asset": {"type": "string"},
            "environment_criticality": {"type": "string"},
            "adjusted_risk_level": {
                "type": "string",
                "enum": ["low", "medium", "high", "deny"],
            },
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return TOOL_METADATA
