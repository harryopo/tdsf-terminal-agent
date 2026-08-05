"""
agents/explore_agent.py — Explore Agent（T-P1-11.3）
=====================================================

职责（spec DEC-V321-③）：
- 代码探索 + 搜索（执行 Grep/Glob/Read 工具）
- 调用 ground tool 检索相关知识（向量 + 关键词双路）
- 调用 history tool 检索历史相似查询（复用经验）

工具集：
- ground:  知识接地（ChromaDB 向量 + SQLite FTS5 关键词双路检索）
- history: 历史案例检索（按时间 / 关键词 / session）
- credibility: 检索结果可信度评估（来源 + 时效 + 一致性）

设计：
- 不直接调用文件系统（实际 Grep/Glob/Read 由 Rust 侧执行）
- 通过 ground tool 检索"知识库"（已索引的文档/代码片段）
- 通过 history tool 复用历史探索经验
- 重写 select_tool：根据 task 关键词选择 ground / history
- 重写 plan_task：探索任务通常拆解为 2 步（检索 → 评估可信度）
"""

from __future__ import annotations

import logging
from typing import Any

from agents.base import BaseAgent

logger = logging.getLogger("sidecar.agents.explore")


class ExploreAgent(BaseAgent):
    """Explore Agent — 代码探索 + 搜索

    场景示例：
        用户输入："查找 nginx 配置文件"
        主 Agent 路由到 Explore Agent
        Explore Agent:
          1. plan: ["调用 ground 检索 nginx 配置位置", "评估检索结果可信度"]
          2. act: 调用 ground tool
          3. observe: 返回 5 条结果
          4. reflect: 任务完成
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="explore",
            role="代码探索与搜索 Agent",
            description=(
                "负责代码探索、文件搜索、知识检索任务。"
                "通过 ground tool 检索知识库（向量 + 关键词双路），"
                "通过 history tool 复用历史探索经验，"
                "通过 credibility tool 评估检索结果可信度。"
                "实际文件操作（Grep/Glob/Read）由 Rust 侧执行。"
            ),
            tools=["ground", "history", "credibility"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """Explore Agent 专属 system prompt"""
        return (
            "You are Explore Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is code exploration, file search, and knowledge retrieval.\n\n"
            "Capabilities:\n"
            "- Retrieve relevant knowledge via `ground` tool (ChromaDB vectors + SQLite FTS5).\n"
            "- Reuse past exploration experience via `history` tool.\n"
            "- Evaluate retrieval credibility via `credibility` tool.\n\n"
            "Constraints:\n"
            "- NEVER execute file system operations directly. Return retrieval results only.\n"
            "- ALWAYS prefer `ground` tool for knowledge lookup.\n"
            "- Use `history` tool when similar past queries may exist.\n"
            "- Output format: ranked retrieval results with credibility scores.\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """探索任务规划：检索 → 评估可信度"""
        input_lower = user_input.lower()

        # 复杂探索：先 ground 再 history 复用经验
        if any(kw in user_input for kw in ["查找", "搜索", "定位"]) or \
           any(kw in input_lower for kw in ["search", "find", "locate"]):
            return [
                f"调用 ground 检索: {user_input[:60]}",
                "调用 credibility 评估检索结果可信度",
            ]

        # 历史相关：直接调 history
        if any(kw in user_input for kw in ["历史", "之前", "上次"]) or \
           any(kw in input_lower for kw in ["history", "previous", "last"]):
            return [
                "调用 history 检索历史相似查询",
                "评估历史结果可信度",
            ]

        # 默认：单步 ground 检索
        return [f"调用 ground 检索: {user_input}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """根据任务关键词选择工具

        选择逻辑：
        - 任务含"ground" / "检索" / "知识" → ground tool
        - 任务含"history" / "历史" → history tool
        - 任务含"credibility" / "可信度" → credibility tool
        - 默认 → ground tool（探索任务默认检索）
        """
        task_lower = task.lower()

        # 提取查询关键词
        query = self._extract_query(task, state)

        if "ground" in task_lower or "检索" in task or "知识" in task:
            return {
                "tool_name": "ground",
                "params": {
                    "query": query,
                    "top_k": 5,
                    "context": {"agent": "explore"},
                },
            }

        if "history" in task_lower or "历史" in task:
            return {
                "tool_name": "history",
                "params": {
                    "query": query,
                    "limit": 5,
                    "context": {"agent": "explore"},
                },
            }

        if "credibility" in task_lower or "可信度" in task:
            return {
                "tool_name": "credibility",
                "params": {
                    "sources": [{"source": "explore_agent", "value": 0.7}],
                    "context": {"agent": "explore"},
                },
            }

        # 默认：ground tool
        return {
            "tool_name": "ground",
            "params": {
                "query": query,
                "top_k": 5,
                "context": {"agent": "explore"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """格式化观察结果：突出检索结果数量 + 来源"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "ground":
            results = result.get("results", [])
            sources = result.get("sources", [])
            if not results:
                return "知识检索完成: 未找到相关文档"
            return (
                f"知识检索完成: 找到 {len(results)} 条结果, "
                f"来源: {sources}"
            )

        if tool_name == "history":
            records = result.get("records", [])
            total = result.get("total", len(records))
            return f"历史检索完成: 找到 {total} 条记录"

        if tool_name == "credibility":
            credibility = result.get("credibility", 0.0)
            factors = result.get("factors", {})
            return (
                f"可信度评估: {credibility:.2f}, "
                f"因子: {factors}"
            )

        return f"工具 {tool_name} 完成: {result}"

    # ========================================================================
    # 辅助方法
    # ========================================================================

    def _extract_query(self, task: str, state: dict[str, Any]) -> str:
        """从任务描述中提取查询关键词

        优先级：
        1. state.input（用户原始输入）
        2. task 中冒号后的内容
        3. task 原文
        """
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
