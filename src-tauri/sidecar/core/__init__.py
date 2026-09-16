"""
core/__init__.py — TDSF Terminal Agent 核心引擎模块
====================================================

模块组成（T-P1-06 迁移自 projects/src/tdsf/core/）：
- schemas:         核心数据模型（Pydantic v2）
- risk_engine:     4 层风险控制引擎（迁移复用，用户决策④）
- confidence:      证据置信度计算（α 加权 + D-S + PCR5 升级版）

核心约束：
1. 保留 4 档风险等级（low/medium/high/deny）与 L0-L4 映射
2. D-S + PCR5 证据融合作为 confidence 模块的升级实现
"""

from __future__ import annotations

__all__ = ["schemas", "risk_engine", "confidence"]
