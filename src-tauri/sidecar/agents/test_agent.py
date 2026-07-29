"""
agents/test_agent.py — Test Agent（T-P4-01）
================================================

职责：
- 测试用例生成 + 测试执行 + 测试覆盖率分析
- 调用 risk tool 评估测试命令风险
- 调用 decision tool 推荐测试策略
- 调用 confidence tool 评估测试结果可信度

工具集：
- risk:       评估测试命令风险
- decision:   推荐测试策略（单元/集成/E2E）
- confidence: 评估测试覆盖率可信度

设计：
- 单一职责：只处理"测试"相关任务
- 重写 plan_task：测试任务 3 步（评估风险 → 推荐策略 → 验证可信度）
"""

from __future__ import annotations

import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.test")


class TestAgent(BaseAgent):
    """Test Agent — 测试用例生成 + 测试执行

    场景示例：
        用户输入："为这个函数写单元测试"
        主 Agent 路由到 Test Agent
        Test Agent:
          1. plan: ["调用 risk 评估测试命令风险", "调用 decision 推荐测试策略", "调用 confidence 评估测试可信度"]
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="test",
            role="测试用例生成与执行 Agent",
            description=(
                "负责测试用例生成、测试执行、测试覆盖率分析任务。"
                "通过 risk tool 评估测试命令风险，"
                "通过 decision tool 推荐测试策略（单元/集成/E2E），"
                "通过 confidence tool 评估测试结果可信度。"
            ),
            tools=["risk", "decision", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    def build_system_prompt_base(self) -> str:
        """Test Agent 专属 system prompt"""
        return (
            "You are Test Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is test case generation, test execution, and coverage analysis.\n\n"
            "Capabilities:\n"
            "- Evaluate test command risk via `risk` tool.\n"
            "- Recommend test strategy via `decision` tool (unit / integration / e2e).\n"
            "- Evaluate test coverage confidence via `confidence` tool.\n\n"
            "Constraints:\n"
            "- ALWAYS run tests in isolation (avoid side effects).\n"
            "- Prefer unit tests over integration tests when possible.\n"
            "- NEVER recommend destructive test commands without risk evaluation.\n"
            "- Output format: test plan with strategy + expected coverage.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """测试任务规划：评估 → 决策 → 验证"""
        input_lower = user_input.lower()

        # 复杂测试：先评估风险 → 决策策略 → 验证可信度
        if any(kw in user_input for kw in ["测试", "test", "单元测试", "集成测试"]) or \
           any(kw in input_lower for kw in ["test", "unit test", "integration", "coverage"]):
            return [
                "调用 risk 评估测试命令风险",
                f"调用 decision 推荐测试策略: {user_input[:60]}",
                "调用 confidence 评估测试可信度",
            ]

        # 简单测试：评估 + 决策
        if any(kw in user_input for kw in ["验证", "检查"]) or \
           any(kw in input_lower for kw in ["verify", "check"]):
            return [
                "调用 risk 评估操作风险",
                f"调用 decision 推荐验证策略: {user_input[:60]}",
            ]

        # 默认：单步决策
        return [f"调用 decision 推荐测试策略: {user_input[:60]}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具"""
        task_lower = task.lower()
        command = state.get("input", task)

        if "risk" in task_lower or "风险" in task:
            return {
                "tool_name": "risk",
                "params": {
                    "command": command,
                    "context": {"agent": "test"},
                },
            }

        if "confidence" in task_lower or "可信度" in task:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "test_agent", "value": 0.8}],
                    "context": {"agent": "test"},
                },
            }

        return {
            "tool_name": "decision",
            "params": {
                "input": task,
                "command": command,
                "context": {"agent": "test"},
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
            return f"测试风险评估: 等级={level}, 原因={reason}"

        if tool_name == "decision":
            decision = result.get("decision", "unknown")
            alternatives = result.get("alternatives", [])
            return f"测试策略: {decision}, 备选={alternatives}"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            method = result.get("method", "")
            return f"测试可信度: {score:.2f} (方法={method})"

        return f"工具 {tool_name} 完成: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """Test Agent 反思"""
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        if not plan or current_idx >= len(plan) - 1:
            return {
                "next_step": "done",
                "reflection": f"测试任务完成（agent={self.name}）",
            }

        return {
            "next_step": "continue",
            "reflection": f"测试步骤 {current_idx + 1}/{len(plan)} 完成，继续",
        }
