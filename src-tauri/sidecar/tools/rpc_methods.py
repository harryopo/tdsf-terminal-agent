"""
tools/rpc_methods.py — 为前端暴露 risk/confidence/decision JSON-RPC 入口
============================================================================
背景:
  - risk.py / confidence.py 只提供 invoke_*_tool(params) 作为 MCP tool 入口
    （同时供现役 Strands 工具包装器复用）
  - 前端 riskClient.ts 的 evaluateRisk() 直接调 "risk.evaluate" JSON-RPC
  - 旧版缺少 JSON-RPC 入口，导致前端 fail-open 回退到本地 TS 评估
  - confidence.score 同理缺失

本模块:
  - 注册 risk.evaluate / confidence.score / decision.list 三个 JSON-RPC 方法
  - 复用现有 invoke_*_tool 函数，避免重复实现
  - 解决端到端测试发现的 Method not found 问题

调用方式（在 main.py 中）:
    from tools import rpc_methods
    rpc_methods.register_methods(dispatcher)
"""
from __future__ import annotations

from typing import Any

from tools.confidence import invoke_confidence_tool
from tools.risk import invoke_risk_tool


def register_methods(dispatcher: Any) -> None:
    """注册前端可直调的 risk/confidence/decision JSON-RPC 方法"""

    def _risk_evaluate(command: str, target_asset: str = "") -> dict[str, Any]:
        """评估单条命令的风险等级（前端 useRiskGuard 调用）

        前端协议（riskClient.ts payloadToAssessment）:
        - level: "L0"~"L4" 字符串
        - risk_level: low/medium/high/deny
        - require_approval: bool
        - reason: 描述

        Args:
            command: 待评估命令
            target_asset: 目标资产（默认空）

        Returns:
            风险评估结果字典（与 invoke_risk_tool 一致）
        """
        try:
            return invoke_risk_tool({"command": command, "target_asset": target_asset})
        except ValueError as e:
            return {"error": str(e), "level": "L0", "risk_level": "low"}
        except Exception as e:
            return {"error": f"risk engine error: {e}", "level": "L0", "risk_level": "low"}

    def _confidence_score(
        text: str | None = None,
        method: str = "D-S+PCR5",
        evidences: list[dict] | None = None,
        message: str | None = None,
        history: list | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        """Return a session evidence state or fuse explicit caller evidence.

        ``text`` / ``message`` / ``history`` remain accepted only for wire
        compatibility.  They are intentionally never used as evidence.
        """
        if evidences is None:
            if session_id:
                from strands_backend.evidence import assess_session_evidence

                return assess_session_evidence(session_id)
            return {
                "tier": "unverified",
                "reason": "需要会话工具证据；不会根据模型文本推断置信度。",
                "evidence_count": 0,
                "sources": [],
                "scope": "session",
            }
        try:
            return invoke_confidence_tool(
                {"evidences": evidences, "method": method},
            )
        except Exception as e:
            return {"error": f"confidence error: {e}"}

    def _decision_list(
        session_id: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        """列出决策记录（前端可观测性面板调用）

        Args:
            session_id: 会话 ID（必填，ProjectService 不支持全局查询）
            limit: 返回数量上限

        Returns:
            {"decisions": [...], "total": N, "session_id": "..."}
        """
        if not session_id:
            return {
                "decisions": [],
                "total": 0,
                "session_id": None,
                "warning": "session_id is required (ProjectService 不支持跨会话全局查询)",
            }
        try:
            from project_service import ProjectService
            svc = ProjectService.instance()
            decisions = svc.list_decisions(session_id, limit=limit)
            return {
                "decisions": decisions,
                "total": len(decisions),
                "session_id": session_id,
            }
        except Exception as e:
            return {"decisions": [], "total": 0, "error": str(e)}

    dispatcher.register("risk.evaluate", _risk_evaluate)
    dispatcher.register("confidence.score", _confidence_score)
    dispatcher.register("decision.list", _decision_list)
