"""
agents/deploy_agent.py — Deploy Agent（T-P4-01）
==================================================

职责：
- 部署流程编排（构建 → 测试 → 发布 → 验证）
- 调用 risk tool 评估部署命令风险（L3+ 需审批）
- 调用 decision tool 推荐部署策略（蓝绿/滚动/金丝雀）
- 调用 confidence tool 评估部署结果可信度

工具集：
- risk:       评估部署命令风险
- decision:   推荐部署策略
- confidence: 评估部署可信度

设计：
- 单一职责：只处理"部署"相关任务
- 重写 plan_task：部署任务 3 步（评估风险 → 决策策略 → 验证可信度）
"""

from __future__ import annotations

import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.deploy")


class DeployAgent(BaseAgent):
    """Deploy Agent — 部署流程编排

    场景示例：
        用户输入："部署 nginx 服务到生产环境"
        主 Agent 路由到 Deploy Agent
        Deploy Agent:
          1. plan: ["调用 risk 评估部署风险", "调用 decision 推荐部署策略", "调用 confidence 评估部署可信度"]
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="deploy",
            role="部署流程编排 Agent",
            description=(
                "负责部署流程编排任务，包括构建、测试、发布、验证。"
                "通过 risk tool 评估部署命令风险（L3+ 需审批），"
                "通过 decision tool 推荐部署策略（蓝绿/滚动/金丝雀），"
                "通过 confidence tool 评估部署结果可信度。"
            ),
            tools=["risk", "decision", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    def build_system_prompt_base(self) -> str:
        """Deploy Agent 专属 system prompt"""
        return (
            "You are Deploy Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is deployment orchestration (build / test / release / verify).\n\n"
            "Capabilities:\n"
            "- Evaluate deployment risk via `risk` tool (L3+ requires approval).\n"
            "- Recommend deployment strategy via `decision` tool (blue-green / rolling / canary).\n"
            "- Evaluate deployment confidence via `confidence` tool.\n\n"
            "Constraints:\n"
            "- ALWAYS call `risk` tool before any production deployment.\n"
            "- Prefer canary / rolling updates over direct cutover.\n"
            "- NEVER bypass approval for L3+ risk commands.\n"
            "- Output format: deployment plan with strategy + rollback steps.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """部署任务规划：评估 → 决策 → 验证"""
        input_lower = user_input.lower()

        # 复杂部署：先评估风险 → 决策策略 → 验证可信度
        if any(kw in user_input for kw in ["部署", "发布", "上线", "deploy"]) or \
           any(kw in input_lower for kw in ["deploy", "release", "publish", "rollout"]):
            return [
                "调用 risk 评估部署命令风险",
                f"调用 decision 推荐部署策略: {user_input[:60]}",
                "调用 confidence 评估部署可信度",
            ]

        # 简单发布：评估 + 决策
        if any(kw in user_input for kw in ["重启", "更新", "升级"]) or \
           any(kw in input_lower for kw in ["restart", "update", "upgrade"]):
            return [
                "调用 risk 评估操作风险",
                f"调用 decision 推荐发布策略: {user_input[:60]}",
            ]

        # 默认：单步决策
        return [f"调用 decision 推荐部署策略: {user_input[:60]}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具"""
        task_lower = task.lower()
        command = state.get("input", task)

        if "risk" in task_lower or "风险" in task:
            return {
                "tool_name": "risk",
                "params": {
                    "command": command,
                    "context": {"agent": "deploy"},
                },
            }

        if "confidence" in task_lower or "可信度" in task:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "deploy_agent", "value": 0.7}],
                    "context": {"agent": "deploy"},
                },
            }

        return {
            "tool_name": "decision",
            "params": {
                "input": task,
                "command": command,
                "context": {"agent": "deploy"},
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
            require_approval = result.get("require_approval", False)
            return f"部署风险评估: 等级={level}, 需审批={require_approval}, 原因={reason}"

        if tool_name == "decision":
            decision = result.get("decision", "unknown")
            alternatives = result.get("alternatives", [])
            return f"部署策略: {decision}, 备选={alternatives}"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            method = result.get("method", "")
            return f"部署可信度: {score:.2f} (方法={method})"

        return f"工具 {tool_name} 完成: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """Deploy Agent 反思"""
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        if not plan or current_idx >= len(plan) - 1:
            return {
                "next_step": "done",
                "reflection": f"部署任务完成（agent={self.name}）",
            }

        return {
            "next_step": "continue",
            "reflection": f"部署步骤 {current_idx + 1}/{len(plan)} 完成，继续",
        }
