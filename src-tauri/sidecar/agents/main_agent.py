"""
agents/main_agent.py — 主 Agent（T-P1-11.3 + T-P4-01 扩展）
==============================================================

职责（spec DEC-V321-③，P4 扩展）：
- PAOR 监督循环（Plan-Act-Observe-Reflect）
- 路由到 8 子 Agent（coding / explore / history / teach / debug / refactor / test / deploy）
- 汇总子 Agent 结果
- 处理多轮 PAOR 迭代（plan 有多个子任务时）

设计：
- 主 Agent 的"工具"实际上是 8 个子 Agent
- 重写 invoke()：实现 PAOR 监督循环
  1. plan：拆解任务 + 选择子 Agent
  2. act：调用子 Agent（通过 invoke_agent）
  3. observe：汇总子 Agent 结果
  4. reflect：决定下一步（done / continue / error）
- 路由策略：基于关键词 + LLM 决策（LLM 不可用时使用规则路由）

路由规则（规则路由，与 graph/nodes.py 的 _mock_plan_task 对齐）：
- 教学（"解释" / "讲解" / "教学" / "什么是"）→ teach Agent
- 探索（"查找" / "搜索" / "查" / "找"）→ explore Agent
- 历史（"历史" / "上次" / "之前"）→ history Agent
- 编码（"代码" / "修改" / "编辑" / "写"）→ coding Agent
- 调试（"排查" / "根因" / "错误" / "失败"）→ debug Agent — T-P4-01 新增
- 重构（"重构" / "拆分" / "提取" / "简化"）→ refactor Agent — T-P4-01 新增
- 测试（"测试" / "test" / "验证"）→ test Agent — T-P4-01 新增
- 部署（"部署" / "发布" / "上线" / "deploy"）→ deploy Agent — T-P4-01 新增
- 运维（"nginx" / "systemctl" / "service"）→ main Agent（自身处理）
- 默认 → main Agent

场景示例（多轮 PAOR）：
    用户输入："修复 nginx.conf 的语法错误并讲解 nginx 配置"
    主 Agent:
      1. plan: ["调用 coding agent 修复", "调用 teach agent 讲解配置"]
      2. act: invoke_agent("coding", state) → 修复结果
      3. observe: coding 完成
      4. reflect: 还有任务，continue
      5. act: invoke_agent("teach", state) → 教学内容
      6. observe: teach 完成
      7. reflect: 所有任务完成，done
"""

from __future__ import annotations

import logging
import time
from typing import Any

from agents.base import AgentResult, BaseAgent

logger = logging.getLogger("sidecar.agents.main")


class MainAgent(BaseAgent):
    """主 Agent — PAOR 监督循环 + 路由到 4 子 Agent

    主 Agent 不直接调用 MCP tools，而是路由到 4 子 Agent。
    主 Agent 自身处理简单运维任务（如 nginx / systemctl 故障排查）。
    """

    def __init__(self, event_bus: Any = None, llm_call: Any = None) -> None:
        super().__init__(
            name="main",
            role="主 Agent（PAOR 监督 + 路由）",
            description=(
                "主调度 Agent，负责 PAOR 监督循环和路由到 4 子 Agent。"
                "基于任务类型智能选择 CodingAgent / ExploreAgent / HistoryAgent / TeachAgent。"
                "自身处理简单运维任务（nginx / systemctl 故障排查等）。"
            ),
            # 主 Agent 的"工具"是 4 子 Agent，但通过 invoke_agent 调用而非 invoke_tool
            # tools 列表保留 risk/decision 用于自身处理运维任务
            tools=["risk", "decision", "confidence"],
            event_bus=event_bus,
            llm_call=llm_call,
        )

    # ========================================================================
    # 钩子方法重写
    # ========================================================================

    def build_system_prompt_base(self) -> str:
        """主 Agent 专属 system prompt"""
        return (
            "You are Main Agent for the TDSF Terminal Assistant.\n"
            "Your responsibility is PAOR supervision and routing to 8 sub-agents.\n\n"
            "Sub-agents (route based on task type):\n"
            "- CodingAgent:   code generation, modification, syntax fixing\n"
            "- ExploreAgent:  code exploration, file search, knowledge retrieval\n"
            "- HistoryAgent:  historical query, case retrieval, context compression\n"
            "- TeachAgent:    Linux operations teaching, tutorial generation\n"
            "- DebugAgent:    fault localization, root cause analysis (P4)\n"
            "- RefactorAgent: code refactoring, extract/inline/simplify (P4)\n"
            "- TestAgent:     test case generation, test execution (P4)\n"
            "- DeployAgent:   deployment orchestration, build/release/verify (P4)\n\n"
            "Routing rules (keyword-based, LLM-enhanced):\n"
            '- "解释" / "讲解" / "teach" → TeachAgent\n'
            '- "查找" / "搜索" / "search" → ExploreAgent\n'
            '- "历史" / "上次" / "history" → HistoryAgent\n'
            '- "排查" / "根因" / "debug" → DebugAgent\n'
            '- "重构" / "拆分" / "refactor" → RefactorAgent\n'
            '- "测试" / "test" → TestAgent\n'
            '- "部署" / "发布" / "deploy" → DeployAgent\n'
            '- "代码" / "修改" / "code" → CodingAgent\n'
            '- "nginx" / "systemctl" → MainAgent (self-handle)\n'
            "- default → MainAgent\n\n"
            "Constraints:\n"
            "- Use `risk` tool before recommending any service operations.\n"
            "- Aggregate sub-agent results into a coherent response.\n"
            "- Handle multi-step plans (iterate PAOR for each step).\n"
        )

    def plan_task(self, user_input: str, state: dict[str, Any]) -> list[str]:
        """主 Agent 任务规划：拆解 + 路由

        根据用户输入关键词识别任务类型，拆解为子任务列表。
        每个子任务前缀标识目标 Agent（如 "[teach]" / "[coding]"）。

        路由优先级（避免歧义，P4 扩展）：
        1. 复合任务（编码+教学 / 探索+编码 / 调试+测试）
        2. 教学任务（解释/讲解/教学）
        3. 调试任务（排查/根因/诊断）— T-P4-01 新增，必须在探索之前（"排查" 含 "查"）
        4. 探索任务（查找/搜索）
        5. 历史任务（历史/上次）
        6. 重构任务（重构/拆分/提取/简化）— T-P4-01 新增
        7. 测试任务（测试/验证/check）— T-P4-01 新增
        8. 部署任务（部署/发布/上线）— T-P4-01 新增
        9. 编码任务（修复/修改/编辑/写）— 优先于运维
        10. 运维任务（nginx/systemctl）— 主 Agent 自处理
        11. 默认 → 主 Agent
        """
        input_lower = user_input.lower()

        # 复合任务：编码 + 教学
        if (any(kw in user_input for kw in ["修复", "修改", "改正"]) and
            any(kw in user_input for kw in ["解释", "讲解", "教学"])):
            return [
                f"[coding] 修复代码: {user_input[:60]}",
                f"[teach] 讲解相关知识点: {user_input[:60]}",
            ]

        # 复合任务：探索 + 编码
        if (any(kw in user_input for kw in ["查找", "搜索", "定位"]) and
            any(kw in user_input for kw in ["修改", "修复", "编辑"])):
            return [
                f"[explore] 探索代码位置: {user_input[:60]}",
                f"[coding] 修改代码: {user_input[:60]}",
            ]

        # 复合任务：调试 + 测试 — T-P4-01 新增
        if (any(kw in user_input for kw in ["排查", "根因", "定位故障", "调试"]) and
            any(kw in user_input for kw in ["测试", "验证", "test"])):
            return [
                f"[debug] 排查故障: {user_input[:60]}",
                f"[test] 验证修复: {user_input[:60]}",
            ]

        # 教学任务
        if any(kw in user_input for kw in ["解释", "讲解", "教学", "什么是", "怎么用"]) or \
           any(kw in input_lower for kw in ["explain", "teach", "what is", "how to"]):
            return [f"[teach] {user_input}"]

        # 调试任务 — T-P4-01 新增（必须在探索任务之前，避免 "排查" 被 "查" 抢匹配）
        if any(kw in user_input for kw in ["排查", "根因", "诊断", "调试"]) or \
           any(kw in input_lower for kw in ["debug", "diagnose", "root cause", "troubleshoot"]):
            return [f"[debug] {user_input}"]

        # 探索任务
        if any(kw in user_input for kw in ["查找", "搜索", "查", "找", "定位"]) or \
           any(kw in input_lower for kw in ["search", "find", "locate"]):
            return [f"[explore] {user_input}"]

        # 历史任务
        if any(kw in user_input for kw in ["历史", "上次", "之前", "之前"]) or \
           any(kw in input_lower for kw in ["history", "previous", "last"]):
            return [f"[history] {user_input}"]

        # 重构任务 — T-P4-01 新增
        if any(kw in user_input for kw in ["重构", "拆分", "提取", "内联", "简化"]) or \
           any(kw in input_lower for kw in ["refactor", "extract", "inline", "simplify"]):
            return [f"[refactor] {user_input}"]

        # 测试任务 — T-P4-01 新增
        if any(kw in user_input for kw in ["测试", "单元测试", "集成测试", "验证"]) or \
           any(kw in input_lower for kw in ["test", "unit test", "integration", "coverage"]):
            return [f"[test] {user_input}"]

        # 部署任务 — T-P4-01 新增
        if any(kw in user_input for kw in ["部署", "发布", "上线"]) or \
           any(kw in input_lower for kw in ["deploy", "release", "publish", "rollout"]):
            return [f"[deploy] {user_input}"]

        # 编码任务（修复/修改/编辑/写/实现）— 优先于运维任务
        if any(kw in user_input for kw in ["修复", "修改", "编辑", "写", "实现", "代码"]) or \
           any(kw in input_lower for kw in ["code", "edit", "write", "implement", "fix", "repair"]):
            return [f"[coding] {user_input}"]

        # 运维任务（主 Agent 自处理）
        if any(kw in user_input for kw in ["nginx", "systemctl", "service", "启动", "失败", "错误"]) or \
           any(kw in input_lower for kw in ["nginx", "systemctl", "service", "fail", "error"]):
            return [
                "[main] 调用 risk 工具评估命令风险",
                "[main] 调用 decision 工具给出决策建议",
            ]

        # 默认：主 Agent 单步处理
        return [f"[main] {user_input}"]

    def select_tool(self, task: str, state: dict[str, Any]) -> dict[str, Any]:
        """主 Agent 选择工具（仅当 task 前缀为 [main] 时调用）

        对于 [main] 前缀的任务，根据 task 内容选择 risk / decision 工具。
        对于其他前缀（[coding] / [explore] 等），主 Agent 不直接调用工具，
        而是通过 invoke() 中重写的逻辑调用子 Agent。
        """
        task_lower = task.lower()

        # 提取命令
        command = state.get("input", task)

        if "风险" in task or "risk" in task_lower:
            return {
                "tool_name": "risk",
                "params": {
                    "command": command,
                    "context": {"agent": "main"},
                },
            }

        if "决策" in task or "decision" in task_lower:
            return {
                "tool_name": "decision",
                "params": {
                    "problem_description": task,
                    "command": command,
                    "context": {"agent": "main"},
                },
            }

        # 默认：调用 decision 工具
        return {
            "tool_name": "decision",
            "params": {
                "problem_description": task,
                "command": command,
                "context": {"agent": "main"},
            },
        }

    def format_observation(
        self,
        tool_result: dict[str, Any],
        state: dict[str, Any],
    ) -> str:
        """主 Agent 格式化观察结果"""
        if not tool_result or not tool_result.get("success", True):
            return f"工具调用失败: {tool_result.get('error', 'unknown error')}"

        tool_name = tool_result.get("tool_name", "unknown")
        result = tool_result.get("result", {})

        if tool_name == "risk":
            level = result.get("level", "unknown")
            reason = result.get("reason", "")
            return f"风险评估: 等级={level}, 原因={reason}"

        if tool_name == "decision":
            decision = result.get("decision", "unknown")
            alternatives = result.get("alternatives", [])
            return f"决策建议: {decision}, 备选={alternatives}"

        if tool_name == "confidence":
            score = result.get("score", 0.0)
            return f"置信度: {score:.2f}"

        return f"工具 {tool_name} 完成: {result}"

    # ========================================================================
    # 重写 invoke：PAOR 监督 + 子 Agent 路由
    # ========================================================================

    def invoke(self, state: dict[str, Any]) -> dict[str, Any]:
        """主 Agent 重写 invoke：实现 PAOR 监督 + 子 Agent 路由

        流程：
        1. plan_task：拆解任务（每子任务前缀标识目标 Agent）
        2. 遍历 plan：
           a. 解析前缀，决定调用子 Agent 还是自身工具
           b. act：调用子 Agent 或工具
           c. observe：汇总结果
        3. reflect：所有任务完成 → done

        与 BaseAgent.invoke() 的差异：
        - 不调用 BaseAgent.invoke()（避免双重 plan/act/observe/reflect）
        - 直接实现 PAOR 循环，每轮调用对应子 Agent
        """
        start_time = time.time()
        self._stats["invocations"] += 1
        session_id = state.get("session_id", "")
        iteration = state.get("iteration", 0)

        logger.info(
            f"main_agent.invoke: iter={iteration}, session={session_id}"
        )

        try:
            # === 1. Plan 阶段 ===
            self._emit_mood("thinking", session_id)

            user_input = state.get("input", "")
            existing_plan = state.get("plan", [])

            # TDSF 魔改 2026-07-29: 启动时推送 "main" agent_switch
            # 前端 AgentStatusPill 实时显示"统一主 Agent 调度中"
            if iteration == 0:
                self._emit_agent_switch("main", user_input, session_id)

            # 首轮：生成 plan
            if iteration == 0 or not existing_plan:
                plan = self.plan_task(user_input, state)
                self._emit_message(
                    f"规划完成，共 {len(plan)} 个子任务",
                    "thinking",
                    session_id,
                )
            else:
                # 后续轮：使用已有 plan
                plan = existing_plan

            current_idx = state.get("current_task_index", 0)

            # 所有任务完成
            if current_idx >= len(plan):
                logger.info("main_agent: all tasks completed")
                # TDSF 魔改 2026-07-29: 完成时回退到 main
                self._emit_agent_switch("main", "所有任务已完成", session_id)
                return {
                    "plan": plan,
                    "current_task_index": current_idx,
                    "next_step": "done",
                    "done": True,
                    "mood": "done",
                    "reflection": "所有任务已完成",
                    "observation": "所有任务已完成",
                }

            current_task = plan[current_idx]
            logger.info(
                f"main_agent: task {current_idx + 1}/{len(plan)}: {current_task[:80]}"
            )

            # === 2. Act 阶段：解析前缀 + 路由 ===
            self._emit_mood("working", session_id)

            agent_prefix, task_content = self._parse_task_prefix(current_task)

            # TDSF 魔改 2026-07-29: 路由到子 Agent 时推送 agent_switch 事件
            # 前端 AgentStatusPill 实时显示当前路由到的子 Agent
            # （main 表示主 Agent 自处理，不算真正路由到子 Agent）
            if agent_prefix != "main":
                self._emit_agent_switch(agent_prefix, task_content, session_id)

            sub_agent_result: dict[str, Any] = {}
            observation = ""

            if agent_prefix == "main":
                # 主 Agent 自处理：调用 MCP tool
                tool_selection = self.select_tool(task_content, state)
                if tool_selection.get("tool_name"):
                    tool_result = self.call_tool(
                        tool_selection["tool_name"],
                        tool_selection.get("params", {}),
                    )
                    observation = self.format_observation(tool_result, state)
                    sub_agent_result = {
                        "agent": "main",
                        "tool_result": tool_result,
                        "observation": observation,
                    }
                else:
                    observation = "无工具调用"
                    sub_agent_result = {
                        "agent": "main",
                        "observation": observation,
                    }
            else:
                # 路由到子 Agent
                sub_agent_update = self._invoke_sub_agent(
                    agent_prefix, task_content, state
                )
                observation = sub_agent_update.get("observation", "")
                sub_agent_result = {
                    "agent": agent_prefix,
                    "result": sub_agent_update.get("sub_agent_result", {}),
                    "observation": observation,
                }
                # TDSF 魔改 2026-07-28: 透传 sub-agent 的 sub_steps / teaching_content
                # 修复 P0-1 收尾: _invoke_sub_agent 已经循环跑完 sub-agent 多步,
                # 这里的 sub_steps 是 sub-agent 内每一步的状态 (含 teaching_content),
                # 必须透传, 否则前端看到 teach agent 1 步就 done (实际多步内容被吞)。
                _sub_steps = sub_agent_update.get("sub_steps")
                _teaching = sub_agent_update.get("teaching_content")
                _reflection = sub_agent_update.get("reflection")

            # === 3. Observe 阶段 ===
            intermediate_results = [{
                "task": current_task,
                "result": sub_agent_result,
                "observation": observation,
                "agent": agent_prefix,
                "iteration": iteration,
                "success": True,
                "timestamp": time.time(),
            }]

            # === 4. Reflect 阶段 ===
            new_idx = current_idx + 1
            if new_idx >= len(plan):
                # 所有任务完成
                reflection = (
                    f"所有 {len(plan)} 个任务已完成。"
                    f"最后观察: {observation[:100]}"
                )
                mood = "done"
                next_step = "done"
                done = True
            else:
                # 还有任务
                reflection = (
                    f"任务 {current_idx + 1}/{len(plan)} 完成，"
                    f"继续下一任务"
                )
                mood = "working"
                next_step = "continue"
                done = False

            self._emit_mood(mood, session_id)

            duration = time.time() - start_time
            self._stats["total_duration"] += duration
            logger.info(
                f"main_agent.invoke done: duration={duration:.3f}s, "
                f"next_step={next_step}, mood={mood}"
            )

            return {
                "plan": plan,
                "current_task_index": new_idx,
                "current_task": plan[new_idx] if new_idx < len(plan) else "",
                "selected_agent": agent_prefix,
                "observation": observation,
                "reflection": reflection,
                "next_step": next_step,
                "done": done,
                "mood": mood,
                "intermediate_results": intermediate_results,
                "sub_agent_result": sub_agent_result,
                "iteration": iteration + 1 if next_step == "continue" else iteration,
                # TDSF 魔改 2026-07-28: 透传 sub-agent 多步细节到前端
                # 修复 P0-1: 不透传的话前端永远只看到 sub-agent 跑 1 步的快照
                **({"sub_steps": _sub_steps, "sub_steps_count": len(_sub_steps)}
                   if agent_prefix != "main" and _sub_steps else {}),
                **({"teaching_content": _teaching}
                   if agent_prefix != "main" and _teaching else {}),
                **({"sub_reflection": _reflection}
                   if agent_prefix != "main" and _reflection else {}),
            }

        except Exception as e:
            self._stats["errors"] += 1
            duration = time.time() - start_time
            self._stats["total_duration"] += duration
            logger.exception(
                f"main_agent.invoke error: {e}, duration={duration:.3f}s"
            )
            self._emit_mood("error", session_id)
            return {
                "observation": f"主 Agent 执行出错: {e}",
                "next_step": "error",
                "mood": "error",
                "error": str(e),
                "intermediate_results": [{
                    "task": state.get("current_task", ""),
                    "result": {},
                    "agent": "main",
                    "iteration": iteration,
                    "success": False,
                    "error": str(e),
                    "timestamp": time.time(),
                }],
            }

    # ========================================================================
    # 辅助方法
    # ========================================================================

    def _parse_task_prefix(self, task: str) -> tuple[str, str]:
        """解析任务前缀：[agent_name] task_content

        Args:
            task: 任务字符串（如 "[coding] 修复 nginx.conf"）

        Returns:
            (agent_name, task_content)
            agent_name: "main" / "coding" / "explore" / "history" / "teach"
                       / "debug" / "refactor" / "test" / "deploy" (P4 扩展)
            task_content: 去除前缀后的任务描述
        """
        if task.startswith("[") and "]" in task:
            end = task.find("]")
            prefix = task[1:end].strip().lower()
            content = task[end + 1:].strip()
            # P4 扩展：支持 9 个 Agent 前缀
            valid_prefixes = (
                "main", "coding", "explore", "history", "teach",
                "debug", "refactor", "test", "deploy",
            )
            if prefix in valid_prefixes:
                return prefix, content
        return "main", task

    def _invoke_sub_agent(
        self,
        agent_name: str,
        task_content: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        """调用子 Agent 并跑完其 PAOR 多步 (TDSF 魔改 2026-07-28, 修复 P0-1)

        Args:
            agent_name: 子 Agent 名（coding / explore / history / teach）
            task_content: 任务内容（去除前缀）
            state: AgentState

        Returns:
            子 Agent 跑完所有步骤后的最终状态更新 dict

        修复前 (P0-1):
            只调用 invoke_agent() 一次就返回, sub-agent 的 plan 多步被吞掉,
            Teach Agent 永远停在第 1 步, 教学内容和 plan=[] 矛盾。

        修复后:
            在 sub-agent 返回 next_step != "continue" 前循环调用,
            每次累加 iteration, 把 sub-agent 的 plan 状态真实推进。
            设 MAX_SUB_ITER 兜底防止死循环 (默认 5)。
        """
        # 延迟导入，避免循环依赖
        from agents import invoke_agent

        # 构建子 Agent 的输入 state（继承父 state 的关键字段）
        sub_state: dict[str, Any] = {
            **state,
            "input": task_content,
            "current_task": task_content,
            "iteration": 0,  # 子 Agent 从 0 开始
            "plan": [],  # 让子 Agent 自己规划
            "current_task_index": 0,
        }

        self._emit_message(
            f"路由到 {agent_name} Agent: {task_content[:60]}",
            "thinking",
            state.get("session_id", ""),
            extra={"sub_agent": agent_name},
        )

        # TDSF 魔改 2026-07-28: 循环推进 sub-agent 的 PAOR 多步
        # 上限 5 步防死循环, 同时记录每步结果用于前端 streaming
        MAX_SUB_ITER = 5
        all_sub_steps: list[dict[str, Any]] = []
        update: dict[str, Any] = {}
        try:
            for step_idx in range(MAX_SUB_ITER):
                update = invoke_agent(agent_name, sub_state)
                step_record = {
                    "sub_iter": step_idx,
                    "observation": update.get("observation", "")[:200],
                    "next_step": update.get("next_step", "?"),
                    "mood": update.get("mood", "?"),
                }
                # 保留 teach_content / reflection 透传字段
                if "teaching_content" in update:
                    step_record["teaching_content"] = update["teaching_content"]
                if "reflection" in update:
                    step_record["reflection"] = update["reflection"]
                all_sub_steps.append(step_record)
                self._emit_message(
                    f"子 Agent {agent_name} 第 {step_idx + 1} 步: "
                    f"{update.get('next_step', '?')}",
                    "tool_call",
                    state.get("session_id", ""),
                    extra={
                        "sub_agent": agent_name,
                        "step": step_idx + 1,
                        "next_step": update.get("next_step"),
                    },
                )
                # 累加 iteration 推进 sub-state, 让 sub-agent 看到自己 step+1
                sub_state["iteration"] = sub_state.get("iteration", 0) + 1
                # 把 sub-agent 的状态合并到 sub_state (plan, current_task_index 等)
                for k in ("plan", "current_task_index", "current_task"):
                    if k in update:
                        sub_state[k] = update[k]
                # 退出条件: done / error / plan 已走完
                if update.get("next_step") in ("done", "error"):
                    break
            else:
                # 5 步还没完 → 超限强制停手 (P0-1 防死循环兜底)
                logger.warning(
                    f"sub-agent '{agent_name}' hit MAX_SUB_ITER={MAX_SUB_ITER}, "
                    f"force stopping"
                )
                update = {
                    **update,
                    "next_step": "error",
                    "observation": (
                        f"子 Agent {agent_name} 超过 {MAX_SUB_ITER} 步仍为 continue, "
                        f"强制停手"
                    ),
                }

            # 汇总所有 sub-steps 给前端流式展示
            update["sub_steps"] = all_sub_steps
            update["sub_steps_count"] = len(all_sub_steps)
            logger.info(
                f"sub-agent '{agent_name}' completed {len(all_sub_steps)} step(s), "
                f"next_step={update.get('next_step', '?')}"
            )
            return update
        except Exception as e:
            logger.exception(f"sub-agent '{agent_name}' failed: {e}")
            return {
                "observation": f"子 Agent {agent_name} 调用失败: {e}",
                "next_step": "error",
                "sub_agent_result": {
                    "agent": agent_name,
                    "error": str(e),
                },
                "sub_steps": all_sub_steps,
                "sub_steps_count": len(all_sub_steps),
            }
