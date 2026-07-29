"""
agents/debug_agent.py — Debug Agent（T-P4-01）
=================================================

职责：
- 故障定位 + 根因分析（Root Cause Analysis）
- 调用 risk tool 评估命令风险（避免危险操作）
- 调用 decision tool 给出修复决策（含历史案例）
- 调用 history tool 复用历史故障案例
- 通过 confidence tool 评估诊断结果可信度

工具集：
- risk:       评估待执行命令的风险等级
- decision:   基于历史案例 + 决策树推荐修复方案
- history:    历史故障案例检索
- confidence: 评估诊断结果可信度（D-S + PCR5）

设计：
- 单一职责：只处理"故障定位 / 根因分析"任务
- 重写 plan_task：调试任务通常 3 步（检索 → 评估 → 决策）
- 重写 select_tool：根据 task 关键词选择 risk/decision/history/confidence
- 重写 format_observation：突出诊断结果 + 修复建议
"""

from __future__ import annotations

import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.debug")


class DebugAgent(BaseAgent):
    """Debug Agent — 故障定位 + 根因分析

    场景示例：
        用户输入："nginx 启动失败怎么排查"
        主 Agent 路由到 Debug Agent
        Debug Agent:
          1. plan: ["调用 history 检索类似故障", "调用 risk 评估排查命令", "调用 decision 给出修复方案"]
          2. act: 调用 history tool
          3. observe: 找到 2 条相似案例
          4. reflect: 继续风险评估
          5. act: 调用 risk tool
          6. observe: systemctl restart 风险 L2
          7. reflect: 继续决策
          8. act: 调用 decision tool
          9. observe: 推荐先检查配置语法
          10. reflect: 任务完成
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="debug",
            role="故障定位与根因分析 Agent",
            description=(
                "负责故障定位、根因分析、错误排查任务。"
                "通过 history tool 复用历史故障案例，"
                "通过 risk tool 评估排查命令风险，"
                "通过 decision tool 给出修复决策建议，"
                "通过 confidence tool 评估诊断结果可信度。"
            ),
            tools=["risk", "decision", "history", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """Debug Agent 专属 system prompt"""
        return (
            "You are Debug Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is fault localization and root cause analysis.\n\n"
            "Capabilities:\n"
            "- Retrieve similar past incidents via `history` tool.\n"
            "- Evaluate command risk via `risk` tool before recommending any repair.\n"
            "- Recommend repair plan via `decision` tool (with historical cases).\n"
            "- Evaluate diagnosis confidence via `confidence` tool (D-S + PCR5).\n\n"
            "Constraints:\n"
            "- ALWAYS call `risk` tool before recommending any `sudo` / `systemctl` / `kill` commands.\n"
            "- Prefer non-invasive diagnostics first (logs / config check) before restart.\n"
            "- NEVER fabricate root causes. If uncertain, say so explicitly.\n"
            "- Output format: ranked hypotheses with evidence + recommended diagnostics.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """调试任务规划：检索 → 评估 → 决策

        根据故障复杂度返回 2-3 步计划。
        """
        input_lower = user_input.lower()

        # 复杂排查：先历史 → 风险 → 决策
        if any(kw in user_input for kw in ["排查", "根因", "定位", "诊断"]) or \
           any(kw in input_lower for kw in ["diagnose", "root cause", "troubleshoot"]):
            return [
                f"调用 history 检索类似故障: {user_input[:60]}",
                "调用 risk 评估排查命令风险",
                "调用 decision 给出修复决策建议",
            ]

        # 简单错误排查：风险评估 + 决策
        if any(kw in user_input for kw in ["错误", "失败", "异常", "报错"]) or \
           any(kw in input_lower for kw in ["error", "fail", "exception", "crash"]):
            return [
                "调用 risk 评估相关命令风险",
                "调用 decision 给出修复决策建议",
            ]

        # 默认：单步决策
        return [f"调用 decision 给出排查建议: {user_input[:60]}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具

        选择逻辑：
        - 任务含"history" / "历史" / "类似" → history tool
        - 任务含"risk" / "风险" → risk tool
        - 任务含"decision" / "决策" / "建议" → decision tool
        - 任务含"confidence" / "可信度" → confidence tool
        - 默认 → decision tool
        """
        task_lower = task.lower()
        command = state.get("input", task)

        if "history" in task_lower or "历史" in task or "类似" in task:
            query = state.get("input", "")
            return {
                "tool_name": "history",
                "params": {
                    "query": query,
                    "limit": 5,
                    "session_id": state.get("session_id", ""),
                    "context": {"agent": "debug"},
                },
            }

        if "risk" in task_lower or "风险" in task:
            return {
                "tool_name": "risk",
                "params": {
                    "command": command,
                    "context": {"agent": "debug"},
                },
            }

        if "confidence" in task_lower or "可信度" in task:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "debug_agent", "value": 0.7}],
                    "context": {"agent": "debug"},
                },
            }

        # 默认：decision tool
        return {
            "tool_name": "decision",
            "params": {
                "input": task,
                "command": command,
                "context": {"agent": "debug"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果：突出诊断 + 修复建议"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "history":
            records = result.get("records", [])
            total = result.get("total", len(records))
            if total == 0:
                return "历史检索完成: 未找到类似故障案例"
            return f"历史检索完成: 找到 {total} 条类似故障案例"

        if tool_name == "risk":
            level = result.get("level", "unknown")
            reason = result.get("reason", "")
            return f"风险评估: 等级={level}, 原因={reason}"

        if tool_name == "decision":
            decision = result.get("decision", "unknown")
            alternatives = result.get("alternatives", [])
            return f"修复决策: {decision}, 备选方案={alternatives}"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            method = result.get("method", "")
            return f"诊断可信度: {score:.2f} (方法={method})"

        return f"工具 {tool_name} 完成: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """Debug Agent 反思：多步任务默认 continue"""
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        if not plan or current_idx >= len(plan) - 1:
            return {
                "next_step": "done",
                "reflection": f"故障排查完成（agent={self.name}）",
            }

        return {
            "next_step": "continue",
            "reflection": f"调试步骤 {current_idx + 1}/{len(plan)} 完成，继续",
        }
