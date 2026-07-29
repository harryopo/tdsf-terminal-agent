"""
tools/rpc_methods.py — 为前端暴露 risk/confidence/decision JSON-RPC 入口
============================================================================
背景:
  - risk.py / confidence.py 只提供 invoke_*_tool(params) 作为 MCP tool 入口
    （被 graph/nodes.py 的 tool_call_node 内部调用）
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
    ) -> dict[str, Any]:
        """计算 AI 文本的置信度

        TDSF 魔改: 支持两种调用方式
        1. 简单模式: 直接传 text，用启发式规则构造 evidence
        2. 完整模式: 传 evidences 列表（与 invoke_confidence_tool 一致）

        Args:
            text: 待评估的 AI 文本（简单模式）
            method: 融合方法 baseline/D-S/D-S+PCR5
            evidences: 完整证据列表（完整模式）

        Returns:
            置信度评分结果
        """
        # 完整模式: 透传 evidences
        if evidences is not None:
            try:
                return invoke_confidence_tool(
                    {"evidences": evidences, "method": method},
                )
            except Exception as e:
                return {"error": f"confidence error: {e}", "score": 0.5}

        # 简单模式: text → 启发式 evidence 构造
        if not text:
            return {"score": 0.5, "method": method, "error": "text is required"}
        try:
            # 构造 5 维启发式 evidence
            has_quote = '"' in text or '"' in text or '"' in text
            has_man = "man" in text.lower() or "manual" in text.lower()
            has_doc = "http" in text or "doc" in text.lower() or "wiki" in text.lower()
            has_term = any(kw in text for kw in (
                "Linux", "kernel", "system", "kernel", "module",
                "service", "process", "file", "directory",
            ))

            from core.schemas import Evidence, EvidenceSource
            ev = [
                Evidence(
                    source=EvidenceSource.SYSLOG if has_man else EvidenceSource.UNKNOWN,
                    raw_text=text[:200],
                    source_prior=0.95 if has_man else 0.65,
                    grounded=has_man or has_doc,
                ),
                Evidence(
                    source=EvidenceSource.APP_LOG if has_doc else EvidenceSource.UNKNOWN,
                    raw_text=text[:200],
                    source_prior=0.85 if has_doc else 0.55,
                    grounded=has_doc,
                ),
                Evidence(
                    source=EvidenceSource.UNKNOWN,
                    raw_text=text,
                    source_prior=0.60,
                    grounded=has_term,
                ),
            ]
            return invoke_confidence_tool({"evidences": ev, "method": method})
        except Exception as e:
            return {"score": 0.5, "method": method, "error": f"confidence error: {e}"}

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
