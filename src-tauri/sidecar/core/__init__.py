"""
core/__init__.py — TDSF Terminal Agent 核心引擎模块
====================================================

模块组成（T-P1-06 迁移自 projects/src/tdsf/core/）：
- schemas:         核心数据模型（Pydantic v2）
- risk_engine:     4 层风险控制引擎（迁移复用，用户决策④）
- confidence:      证据置信度计算（α 加权 + D-S + PCR5 升级版）
- grounding:       证据溯源校验（Ground-Check）
- decision_engine: 决策引擎（T-P1-06.4，用 LangGraph 重写，不复用旧代码）

迁移原则：
1. RiskEngine + Confidence 直接复用原实现（用户决策④）
2. DecisionEngine 用 LangGraph 重写（T-P1-06.4，不复用旧代码）
3. 保留原 4 档风险等级（low/medium/high/deny），新增 L0-L4 映射方法
4. D-S + PCR5 证据融合作为 confidence 模块的升级实现（spec 要求）
"""

from __future__ import annotations

__all__ = ["schemas", "risk_engine", "confidence", "grounding", "decision_engine"]
