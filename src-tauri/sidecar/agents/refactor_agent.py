"""
agents/refactor_agent.py — Refactor Agent（T-P4-01）
=====================================================

职责：
- 代码重构（提取函数 / 内联变量 / 简化逻辑 / 模式应用）
- 调用 risk tool 评估重构操作风险
- 调用 decision tool 推荐重构策略
- 调用 confidence tool 评估重构后代码可信度

工具集：
- risk:       评估重构涉及命令的风险
- decision:   推荐重构方案（基于历史案例 + 决策树）
- confidence: 评估重构后代码可信度（D-S + PCR5）

设计：
- 单一职责：只处理"重构"任务
- 重写 plan_task：重构任务 3 步（评估风险 → 决策方案 → 验证可信度）
- 重写 select_tool：根据 task 关键词选择 risk/decision/confidence
"""

from __future__ import annotations

import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.refactor")


class RefactorAgent(BaseAgent):
    """Refactor Agent — 代码重构

    场景示例：
        用户输入："把这个函数拆分成多个小函数"
        主 Agent 路由到 Refactor Agent
        Refactor Agent:
          1. plan: ["调用 risk 评估重构风险", "调用 decision 推荐重构方案", "调用 confidence 评估重构后可信度"]
          2. act: 调用 risk tool
          3. observe: 风险 L1
          4. reflect: 继续决策
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="refactor",
            role="代码重构 Agent",
            description=(
                "负责代码重构任务，包括提取函数、内联变量、简化逻辑、应用设计模式。"
                "通过 risk tool 评估重构操作风险，"
                "通过 decision tool 推荐重构策略，"
                "通过 confidence tool 评估重构后代码可信度。"
            ),
            tools=["risk", "decision", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """Refactor Agent 专属 system prompt"""
        return (
            "You are Refactor Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is code refactoring (extract / inline / simplify / pattern).\n\n"
            "Capabilities:\n"
            "- Evaluate refactoring risk via `risk` tool.\n"
            "- Recommend refactoring strategy via `decision` tool.\n"
            "- Evaluate refactored code confidence via `confidence` tool.\n\n"
            "Constraints:\n"
            "- Preserve behavior: refactoring MUST NOT change external behavior.\n"
            "- Prefer small, incremental refactors over large rewrites.\n"
            "- ALWAYS call `risk` tool before recommending file deletions or moves.\n"
            "- Output format: step-by-step refactor plan with risk evaluation.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """重构任务规划：评估 → 决策 → 验证"""
        input_lower = user_input.lower()

        # 复杂重构：先评估风险 → 决策方案 → 验证可信度
        if any(kw in user_input for kw in ["重构", "拆分", "提取", "内联", "简化"]) or \
           any(kw in input_lower for kw in ["refactor", "extract", "inline", "simplify"]):
            return [
                "调用 risk 评估重构操作风险",
                f"调用 decision 推荐重构方案: {user_input[:60]}",
                "调用 confidence 评估重构后可信度",
            ]

        # 简单重构：评估 + 决策
        if any(kw in user_input for kw in ["修改", "调整", "整理"]) or \
           any(kw in input_lower for kw in ["modify", "adjust", "clean"]):
            return [
                "调用 risk 评估操作风险",
                f"调用 decision 推荐方案: {user_input[:60]}",
            ]

        # 默认：单步决策
        return [f"调用 decision 推荐重构方案: {user_input[:60]}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具"""
        task_lower = task.lower()
        command = state.get("input", task)

        if "risk" in task_lower or "风险" in task:
            return {
                "tool_name": "risk",
                "params": {
                    "command": command,
                    "context": {"agent": "refactor"},
                },
            }

        if "confidence" in task_lower or "可信度" in task:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "refactor_agent", "value": 0.75}],
                    "context": {"agent": "refactor"},
                },
            }

        # 默认：decision tool
        return {
            "tool_name": "decision",
            "params": {
                "input": task,
                "command": command,
                "context": {"agent": "refactor"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "risk":
            level = result.get("level", "unknown")
            reason = result.get("reason", "")
            return f"重构风险评估: 等级={level}, 原因={reason}"

        if tool_name == "decision":
            decision = result.get("decision", "unknown")
            alternatives = result.get("alternatives", [])
            return f"重构方案: {decision}, 备选={alternatives}"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            method = result.get("method", "")
            return f"重构可信度: {score:.2f} (方法={method})"

        return f"工具 {tool_name} 完成: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """Refactor Agent 反思"""
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        if not plan or current_idx >= len(plan) - 1:
            return {
                "next_step": "done",
                "reflection": f"重构任务完成（agent={self.name}）",
            }

        return {
            "next_step": "continue",
            "reflection": f"重构步骤 {current_idx + 1}/{len(plan)} 完成，继续",
        }
