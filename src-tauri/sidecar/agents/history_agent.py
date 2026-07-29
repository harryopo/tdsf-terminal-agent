"""
agents/history_agent.py — History Agent（T-P1-11.4）
=====================================================

职责（spec DEC-V321-③）：
- 历史查询 + 上下文压缩
- 调用 history tool 检索历史记录（按时间 / 关键词 / session）
- 调用 confidence tool 评估历史案例的可靠性（D-S + PCR5）
- 长会话上下文压缩（提取关键信息，降低 token 消耗）

工具集：
- history:     历史记录 CRUD + 检索
- confidence:  评估历史案例可靠性
- credibility: 评估来源可信度（用于过滤低质量历史案例）

设计：
- 单一职责：只处理"历史"相关任务
- 上下文压缩：当 messages 过长时，提取关键信息生成摘要
- 重写 select_tool：默认调用 history tool
- 重写 plan_task：历史查询通常单步完成
"""

from __future__ import annotations

import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.history")


class HistoryAgent(BaseAgent):
    """History Agent — 历史查询 + 上下文压缩

    场景示例：
        用户输入："上次 nginx 故障怎么解决的？"
        主 Agent 路由到 History Agent
        History Agent:
          1. plan: ["调用 history 检索 nginx 故障记录"]
          2. act: 调用 history tool
          3. observe: 找到 3 条历史记录
          4. reflect: 任务完成
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="history",
            role="历史查询与上下文压缩 Agent",
            description=(
                "负责历史记录查询、案例检索、长会话上下文压缩。"
                "通过 history tool 检索历史记录（按时间 / 关键词 / session），"
                "通过 confidence tool 评估历史案例可靠性，"
                "通过 credibility tool 过滤低质量历史案例。"
            ),
            tools=["history", "confidence", "credibility"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """History Agent 专属 system prompt"""
        return (
            "You are History Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is historical query, case retrieval, and context compression.\n\n"
            "Capabilities:\n"
            "- Retrieve historical records via `history` tool (by time / keyword / session).\n"
            "- Evaluate case reliability via `confidence` tool (D-S + PCR5).\n"
            "- Filter low-quality cases via `credibility` tool.\n\n"
            "Constraints:\n"
            "- ALWAYS prefer `history` tool for past-experience lookup.\n"
            "- For long conversations, summarize key facts to reduce token consumption.\n"
            "- NEVER fabricate history. If no records found, return empty.\n"
            "- Output format: ranked historical cases with reliability scores.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """历史查询任务规划

        简单查询：单步检索
        复杂查询（含"对比" / "总结"）：检索 + 评估
        """
        input_lower = user_input.lower()

        # 复杂查询：检索 + 评估可靠性
        if any(kw in user_input for kw in ["对比", "总结", "汇总"]) or \
           any(kw in input_lower for kw in ["compare", "summarize", "aggregate"]):
            return [
                f"调用 history 检索: {user_input[:60]}",
                "调用 confidence 评估历史案例可靠性",
            ]

        # 默认：单步检索
        return [f"调用 history 检索: {user_input}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具

        选择逻辑：
        - 任务含"history" / "历史" / "记录" → history tool
        - 任务含"confidence" / "可靠性" → confidence tool
        - 任务含"credibility" / "可信度" → credibility tool
        - 默认 → history tool
        """
        task_lower = task.lower()

        # 提取查询关键词
        query = self._extract_query(task, state)

        # 提取 session_id（历史检索按 session 过滤）
        session_id = state.get("session_id", "")

        if "history" in task_lower or "历史" in task or "记录" in task:
            return {
                "tool_name": "history",
                "params": {
                    "query": query,
                    "limit": 10,
                    "session_id": session_id,
                    "context": {"agent": "history"},
                },
            }

        if "confidence" in task_lower or "可靠性" in task:
            return {
                "tool_name": "confidence",
                "params": {
                    "sources": [{"source": "history_agent", "value": 0.7}],
                    "context": {"agent": "history"},
                },
            }

        if "credibility" in task_lower or "可信度" in task:
            return {
                "tool_name": "credibility",
                "params": {
                    "sources": [{"source": "history_agent", "value": 0.7}],
                    "context": {"agent": "history"},
                },
            }

        # 默认：history tool
        return {
            "tool_name": "history",
            "params": {
                "query": query,
                "limit": 10,
                "session_id": session_id,
                "context": {"agent": "history"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果：突出历史记录数量 + 可靠性"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "history":
            records = result.get("records", [])
            total = result.get("total", len(records))
            if total == 0:
                return "历史检索完成: 未找到相关记录"
            return f"历史检索完成: 找到 {total} 条记录"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            method = result.get("method", "")
            return f"可靠性评估: {score:.2f} (方法={method})"

        if tool_name == "credibility":
            credibility = result.get("credibility", 0.0)
            factors = result.get("factors", {})
            return f"可信度评估: {credibility:.2f}, 因子: {factors}"

        return f"工具 {tool_name} 完成: {result}"

    def reflect_on_result(self, state: dict[str, Any]) -> dict[str, Any]:
        """历史 Agent 反思：默认单步完成"""
        # 历史 Agent 通常单步完成（不需要多轮 PAOR）
        plan = state.get("plan", [])
        current_idx = state.get("current_task_index", 0)

        if not plan or current_idx >= len(plan) - 1:
            return {
                "next_step": "done",
                "reflection": f"历史查询完成（agent={self.name}）",
            }

        return {
            "next_step": "continue",
            "reflection": f"任务 {current_idx + 1}/{len(plan)} 完成，继续",
        }

    # ========================================================================
    # 辅助方法
    # ========================================================================

    def _extract_query(self, task: str, state: dict[str, Any]) -> str:
        """从任务描述中提取查询关键词"""
        # 从 state.input 提取
        user_input = state.get("input", "")
        if user_input:
            return user_input

        # 从 task 提取冒号后内容
        if ":" in task:
            return task.split(":", 1)[1].strip()
        if "：" in task:
            return task.split("：", 1)[1].strip()

        return task

    def compress_context(self, messages: list[dict[str, Any]]) -> str:
        """上下文压缩：提取关键信息生成摘要

        当 messages 过长时（如 > 20 条），调用此方法压缩。
        默认实现：提取所有 user 消息 + assistant 的最后一条。

        Args:
            messages: 消息列表（OpenAI Chat Completions 格式）

        Returns:
            压缩后的摘要字符串
        """
        if not messages:
            return ""

        # 短对话：不压缩
        if len(messages) <= 10:
            return "\n".join(
                f"[{m.get('role', '?')}] {m.get('content', '')}"
                for m in messages
            )

        # 长对话：提取关键信息
        user_msgs = [
            m.get("content", "") for m in messages
            if m.get("role") == "user"
        ]
        last_assistant = ""
        for m in reversed(messages):
            if m.get("role") == "assistant":
                last_assistant = m.get("content", "")
                break

        summary_parts = [
            f"[Summary] {len(user_msgs)} user messages:",
            *user_msgs[:5],  # 前 5 条 user
        ]
        if len(user_msgs) > 5:
            summary_parts.append(f"... ({len(user_msgs) - 5} more)")
        summary_parts.append(f"[Last assistant] {last_assistant[:200]}")

        return "\n".join(summary_parts)
