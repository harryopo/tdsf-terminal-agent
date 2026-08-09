"""confidence 工具 — Strands 路径可信度评估（包装 core/confidence.py）

TDSF 魔改 (2026-08-09): 方案书集成度补齐。
将 sidecar/tools/confidence.py 的 MCP tool 包装为 Strands tool，
让 Sidecar agent 也能调用可信度评估。

核心计算逻辑复用 core/confidence.py 的 DSPCR5ConfidenceCalculator。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.confidence_tool")


def invoke_confidence_assessment(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """评估推理链或证据的可信度

    Args:
        params:
            - evidences (list[dict]): 证据列表，每项含:
                - content (str): 证据内容
                - source (str): 来源（如 "ssh_command", "manual", "inference"）
                - reliability (float, 可选): 来源可靠度 0-1，默认 0.7
            - method (str, 可选): "baseline" | "D-S" | "D-S+PCR5"，默认 "D-S+PCR5"
        ctx: ToolContext

    Returns:
        dict: {score: float, method: str, conflict: float, evidence_count: int}
    """
    evidences = params.get("evidences", [])
    if not isinstance(evidences, list) or not evidences:
        return {"score": 0.0, "method": "none", "conflict": 0.0,
                "evidence_count": 0, "message": "no evidences provided"}

    method = str(params.get("method", "D-S+PCR5")).strip()

    try:
        # 复用已有的 invoke_confidence_tool（sidecar/tools/confidence.py）
        import sys
        import os
        sidecar_tools = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "tools")
        if sidecar_tools not in sys.path:
            sys.path.insert(0, sidecar_tools)

        from confidence import invoke_confidence_tool  # type: ignore[import-not-found]

        result = invoke_confidence_tool({
            "method": method,
            "evidences": evidences,
        })

        return {
            "score": result.get("score", 0.0),
            "method": result.get("method", method),
            "conflict": result.get("conflict", 0.0),
            "evidence_count": result.get("evidence_count", len(evidences)),
            "grounded_count": result.get("grounded_count", 0),
        }
    except Exception as e:
        logger.warning(f"confidence assessment failed: {e}")
        return {"score": 0.0, "method": "error", "conflict": 0.0,
                "evidence_count": len(evidences), "error": str(e)}


def make_confidence_tool(ctx: ToolContext):
    """构建 confidence 可信度评估工具"""

    @tool
    def assess_confidence(
        evidences: list[dict[str, Any]],
        method: str = "D-S+PCR5",
    ) -> dict:
        """评估证据链或推理结论的可信度。

        使用 Dempster-Shafer 证据理论 + PCR5 冲突重分配计算综合可信度分数。
        分数范围 0-1，越高越可信。

        Args:
            evidences (list): 证据列表，每项含:
                - content (str): 证据内容描述
                - source (str): 来源类型（如 "ssh_command", "manual", "inference"）
                - reliability (float): 来源可靠度 0-1（默认 0.7）
            method (str): 计算方法 "baseline" | "D-S" | "D-S+PCR5"（默认 D-S+PCR5）。

        Returns:
            dict: {score, method, conflict, evidence_count, grounded_count}
        """
        return invoke_confidence_assessment(
            {"evidences": evidences, "method": method},
            ctx,
        )

    assess_confidence.__name__ = "assess_confidence"
    return assess_confidence
