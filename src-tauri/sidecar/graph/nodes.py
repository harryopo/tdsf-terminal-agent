"""
graph/nodes.py — LangGraph 7 节点实现（T-P1-05.2）
====================================================

7 节点职责：
1. supervisor_node:        监督节点，根据 next_step 路由到 plan/act/observe/reflect
2. plan_node:              规划节点，拆解任务 + 选择 Agent
3. act_node:               执行节点，调用工具 / 子 Agent
4. observe_node:           观察节点，收集结果 + 更新状态
5. reflect_node:           反思节点，评估结果 + 决定下一步（done/continue/error）
6. tool_call_node:         工具调用节点，执行 MCP tools
7. permission_check_node:  权限检查节点，4 档 × 3 mode 融合

PAOR 循环：
  supervisor → plan → act → observe → reflect → (continue | done | error)
  act → tool_call（如需工具）→ act
  act → permission_check（如需权限）→ act

设计要点：
- 每个节点是 (state: AgentState) -> dict 的函数
- 返回 dict 是部分状态更新（LangGraph 自动 merge）
- 当前 P1-B 阶段 plan/act/observe/reflect 使用 mock 逻辑
- T-P1-11 接入真实 LLM Agent 时替换 mock 实现
- T-P1-07 接入真实 MCP tools 时替换 tool_call_node 的 mock
"""

from __future__ import annotations

import logging
import time
from typing import Any
from uuid import uuid4

from graph.state import (
    AgentState,
    advance_task,
    append_intermediate_result,
    append_node_history,
    get_current_task,
    is_max_iterations_reached,
)
from permissions import (
    PermissionDecision,
    PermissionResult,
    check_permission,
)

logger = logging.getLogger("sidecar.graph.nodes")


# ============================================================================
# 节点 1: supervisor — 监督节点（路由）
# ============================================================================

def supervisor_node(state: AgentState) -> dict:
    """监督节点：根据 next_step 路由到下一节点

    路由逻辑（实际路由在 graph.py 的 conditional_edges 中实现）：
    - next_step == "continue" 且 iteration == 0 → 进入 plan
    - next_step == "continue" 且 iteration > 0 → 进入 plan（新一轮 PAOR）
    - next_step == "needs_permission" → 等待权限（暂停）
    - next_step == "done" → 退出循环
    - next_step == "error" → 退出循环

    本节点主要负责：
    - 更新 mood（thinking / working / done / error）
    - 检查 max_iterations（防无限循环）
    - 追加 node_history
    """
    next_step = state.get("next_step", "continue")
    iteration = state.get("iteration", 0)
    max_iter = state.get("max_iterations", 10)

    # 检查最大循环次数
    if is_max_iterations_reached(state):
        logger.warning(
            f"max iterations reached ({iteration}/{max_iter}), forcing done"
        )
        return {
            "mood": "error",
            "next_step": "done",
            "done": True,
            "error": f"max iterations ({max_iter}) reached",
            **append_node_history(state, "supervisor"),
        }

    # 根据 next_step 更新 mood
    mood_map = {
        "continue": "thinking" if iteration == 0 else "working",
        "needs_permission": "working",
        "done": "done",
        "error": "error",
    }
    mood = mood_map.get(next_step, "thinking")

    logger.debug(
        f"supervisor: iter={iteration}, next_step={next_step}, mood={mood}"
    )

    return {
        "mood": mood,
        **append_node_history(state, "supervisor"),
    }


# ============================================================================
# 节点 2: plan — 规划节点（拆解任务 + 选择 Agent）
# ============================================================================

def plan_node(state: AgentState) -> dict:
    """规划节点：拆解任务 + 选择 Agent

    T-P1-11 接入真实 Agent：调用 main_agent.plan_task() 生成 plan。
    若 agents 模块未配置（如单元测试），fallback 到 mock 规划逻辑。

    主 Agent 的 plan_task 返回带 [agent] 前缀的任务列表，如：
        ["[coding] 修复代码", "[teach] 讲解知识点"]
    plan_node 解析前缀提取 selected_agent。
    """
    user_input = state.get("input", "")
    iteration = state.get("iteration", 0)
    current_idx = state.get("current_task_index", 0)

    # === T-P1-11: 接入真实 Agent ===
    # 第一次迭代：调用主 Agent 生成 plan
    if iteration == 0:
        plan, selected_agent, reasoning = _real_plan_task(user_input, state)
        current_task = plan[0] if plan else ""
        logger.info(
            f"plan: iter=0, plan={plan}, agent={selected_agent}, "
            f"task='{current_task}'"
        )
    else:
        # 后续迭代：取下一个任务
        plan = state.get("plan", [])
        new_idx = current_idx
        current_task = plan[new_idx] if new_idx < len(plan) else ""
        # 解析任务前缀获取 agent
        selected_agent, _ = _parse_task_prefix(current_task)
        reasoning = f"continue with task {new_idx + 1}: {current_task}"

        # 所有任务完成
        if new_idx >= len(plan):
            logger.info(f"plan: all tasks completed, marking done")
            return {
                "next_step": "done",
                "done": True,
                "mood": "done",
                "reflection": "all planned tasks completed",
                **append_node_history(state, "plan"),
            }

        logger.info(
            f"plan: iter={iteration}, task_idx={new_idx}, "
            f"task='{current_task}'"
        )

    return {
        "plan": plan,
        "current_task_index": current_idx,
        "current_task": current_task,
        "selected_agent": selected_agent,
        "plan_reasoning": reasoning,
        "mood": "working",
        **append_node_history(state, "plan"),
    }


def _real_plan_task(
    user_input: str,
    state: AgentState,
) -> tuple[list[str], str, str]:
    """T-P1-11: 真实 Agent 规划（调用 main_agent.plan_task）

    若 agents 模块未配置，fallback 到 _mock_plan_task。
    """
    try:
        from agents import get_agent, _agent_instances
        if "main" not in _agent_instances:
            return _mock_plan_task(user_input)
        main_agent = get_agent("main")
        plan = main_agent.plan_task(user_input, state)
        if not plan:
            return _mock_plan_task(user_input)
        # 解析第一个任务的前缀获取 selected_agent
        first_agent, first_content = _parse_task_prefix(plan[0])
        reasoning = f"主 Agent 规划：{len(plan)} 个子任务，首任务路由到 {first_agent}"
        return plan, first_agent, reasoning
    except Exception as e:
        logger.warning(f"_real_plan_task failed, fallback to mock: {e}")
        return _mock_plan_task(user_input)


def _parse_task_prefix(task: str) -> tuple[str, str]:
    """解析任务前缀：[agent_name] task_content

    Args:
        task: 任务字符串（如 "[coding] 修复 nginx.conf"）

    Returns:
        (agent_name, task_content)
        agent_name: "main" / "coding" / "explore" / "history" / "teach"
        task_content: 去除前缀后的任务描述
    """
    if task.startswith("[") and "]" in task:
        end = task.find("]")
        prefix = task[1:end].strip().lower()
        content = task[end + 1:].strip()
        if prefix in ("main", "coding", "explore", "history", "teach"):
            return prefix, content
    return "main", task


def _mock_plan_task(user_input: str) -> tuple[list[str], str, str]:
    """Mock 任务拆解逻辑（P1-B 阶段简化版）

    基于关键词识别任务类型：
    - "nginx" / "systemctl" / "service" → 运维任务
    - "代码" / "code" / "edit" → 编码任务
    - "查" / "search" / "find" → 探索任务
    - "解释" / "explain" / "teach" → 教学任务
    - 默认 → 主 Agent 处理

    T-P1-11 接入真实 LLM Agent 后替换此函数。
    """
    input_lower = user_input.lower()

    # 教学任务
    if any(kw in user_input for kw in ["解释", "讲解", "教学", "什么是"]) or \
       any(kw in input_lower for kw in ["explain", "teach", "what is"]):
        return (
            [f"调用 Teach Agent 讲解: {user_input}"],
            "teach",
            "用户请求教学讲解，路由到 Teach Agent",
        )

    # 探索任务
    if any(kw in user_input for kw in ["查找", "搜索", "查", "找"]) or \
       any(kw in input_lower for kw in ["search", "find", "grep", "glob"]):
        return (
            [f"调用 Explore Agent 搜索: {user_input}"],
            "explore",
            "用户请求搜索，路由到 Explore Agent",
        )

    # 运维任务（如 "nginx 启动失败"）
    if any(kw in user_input for kw in ["nginx", "systemctl", "service", "启动", "失败", "错误"]) or \
       any(kw in input_lower for kw in ["nginx", "systemctl", "service", "fail", "error"]):
        return (
            [
                "调用 risk tool 评估命令风险",
                "执行命令检查服务状态",
                "分析结果并给出建议",
            ],
            "main",
            "运维任务，拆解为 3 步：风险评估 → 执行 → 分析",
        )

    # 编码任务
    if any(kw in user_input for kw in ["代码", "修改", "编辑", "写"]) or \
       any(kw in input_lower for kw in ["code", "edit", "write", "fix"]):
        return (
            [
                "调用 Explore Agent 读取相关文件",
                "调用 Coding Agent 修改代码",
            ],
            "coding",
            "编码任务，先 explore 再 coding",
        )

    # 默认：单步任务
    return (
        [f"处理用户输入: {user_input}"],
        "main",
        "默认路由到主 Agent",
    )


# ============================================================================
# 节点 3: act — 执行节点（调用工具 / 子 Agent）
# ============================================================================

def act_node(state: AgentState) -> dict:
    """执行节点：决定调用工具还是子 Agent，生成 action

    T-P1-11 接入真实 Agent：调用对应 agent.select_tool() 生成 tool_call_request。
    若 agents 模块未配置（如单元测试），fallback 到 mock 决策逻辑。

    流程：
    1. 根据 selected_agent 获取对应 Agent 实例
    2. 调用 agent.select_tool(task, state) 选择工具
    3. 生成 tool_call_request（供 tool_call 节点消费）
    4. 若 agent 不需要工具（select_tool 返回空），生成 sub_agent 调用 action
    """
    current_task = state.get("current_task", "")
    selected_agent = state.get("selected_agent", "main")

    # === T-P1-11: 接入真实 Agent ===
    tool_selection = _real_select_tool(selected_agent, current_task, state)

    if tool_selection and tool_selection.get("tool_name"):
        # 路由 A：调用 MCP tool
        tool_name = tool_selection["tool_name"]
        tool_params = tool_selection.get("params", {})
        action = {
            "type": "tool_call",
            "tool": tool_name,
            "params": tool_params,
            "agent": selected_agent,
        }
        tool_call_request = {
            "tool_name": tool_name,
            "params": tool_params,
            "require_permission": _needs_permission_check(tool_name),
        }
        logger.info(
            f"act: agent={selected_agent}, task='{current_task}', "
            f"action=tool_call({tool_name})"
        )
    else:
        # 路由 B：无工具调用（如 Teach Agent 直接生成内容）
        action = {
            "type": "sub_agent",
            "agent": selected_agent,
            "input": current_task,
        }
        tool_call_request = {}
        logger.info(
            f"act: agent={selected_agent}, task='{current_task}', "
            f"action=sub_agent (no tool)"
        )

    return {
        "action": action,
        "tool_call_request": tool_call_request,
        "mood": "working",
        **append_node_history(state, "act"),
    }


def _real_select_tool(
    agent_name: str,
    task: str,
    state: AgentState,
) -> dict[str, Any]:
    """T-P1-11: 调用真实 Agent 的 select_tool

    若 agents 模块未配置或调用失败，fallback 到 mock（返回 risk tool）。
    """
    try:
        from agents import get_agent, _agent_instances
        if agent_name not in _agent_instances:
            # fallback mock
            return {
                "tool_name": "risk",
                "params": {"command": task, "context": {"agent": agent_name}},
            }
        agent = get_agent(agent_name)
        # 解析任务前缀（主 Agent 的 plan 带 [agent] 前缀）
        _, task_content = _parse_task_prefix(task)
        return agent.select_tool(task_content, state)
    except Exception as e:
        logger.warning(f"_real_select_tool failed, fallback to mock: {e}")
        return {
            "tool_name": "risk",
            "params": {"command": task, "context": {"agent": agent_name}},
        }


def _needs_permission_check(tool_name: str) -> bool:
    """判断工具是否需要权限检查

    risk / decision 工具涉及命令执行，需要权限检查。
    ground / history / confidence / credibility 工具只读，无需权限检查。
    """
    return tool_name in ("risk", "decision")


# ============================================================================
# 节点 4: observe — 观察节点（收集结果）
# ============================================================================

def observe_node(state: AgentState) -> dict:
    """观察节点：收集 act 阶段的结果，更新 observation

    T-P1-11 接入真实 Agent：调用对应 agent.format_observation() 格式化结果。
    若 agents 模块未配置（如单元测试），fallback 到 mock 观察逻辑。

    T-P3-08: 自动检索知识库（FTS5 + ChromaDB），将相关知识卡注入到 state，
    通过 event_bus 推送到 AgentPanel.tsx 显示。
    """
    tool_call_result = state.get("tool_call_result", {})
    sub_agent_result = state.get("sub_agent_result", {})
    current_task = state.get("current_task", "")
    selected_agent = state.get("selected_agent", "main")
    user_input = state.get("input", "")

    # === T-P1-11: 接入真实 Agent ===
    observation = _real_format_observation(
        selected_agent, tool_call_result, state
    )

    # 追加到中间结果
    intermediate_update = append_intermediate_result(
        state,
        task=current_task,
        result=tool_call_result or sub_agent_result,
        success=True,
    )

    # === T-P3-08: 知识卡自动注入 ===
    # 使用 user_input + current_task 作为查询语句检索知识库
    # 检索失败时静默降级（不阻塞主流程）
    knowledge_cards: list[dict[str, Any]] = _inject_knowledge_cards(
        user_input, current_task
    )

    # 推送 knowledge_cards 事件到前端（仅在有结果时推送）
    if knowledge_cards:
        try:
            from event_bus import get_global_bus
            bus = get_global_bus()
            bus.publish(
                "knowledge_cards",
                {
                    "cards": knowledge_cards,
                    "query": user_input or current_task,
                    "session_id": state.get("session_id", ""),
                },
            )
        except Exception as e:
            logger.warning(f"observe: 推送 knowledge_cards 事件失败: {e}")

    logger.info(
        f"observe: observation='{observation[:80]}...', "
        f"knowledge_cards={len(knowledge_cards)}"
    )

    return {
        "observation": observation,
        "mood": "working",
        "knowledge_cards": knowledge_cards,  # 注入知识卡（覆盖式更新由 reducer 控制）
        **intermediate_update,
        **append_node_history(state, "observe"),
    }


def _inject_knowledge_cards(
    user_input: str,
    current_task: str,
    limit: int = 3,
) -> list[dict[str, Any]]:
    """T-P3-08: 检索知识库，返回知识卡列表

    检索策略：
    1. 优先使用 user_input 作为查询语句（更贴近用户意图）
    2. user_input 为空时使用 current_task
    3. 同时查询 FTS5（关键词匹配）+ Vector（语义匹配）
    4. 合并去重后取 top-K（默认 3）

    降级策略：
    - 知识库未初始化 → 返回空列表
    - 检索异常 → 返回空列表
    - 不阻塞主流程

    Args:
        user_input: 用户原始输入
        current_task: 当前任务（user_input 为空时使用）
        limit: 返回 top-K（默认 3）

    Returns:
        知识卡列表，每项含 title/source/snippet/url/score
    """
    query: str = (user_input or current_task or "").strip()
    if not query:
        return []

    cards: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    # === FTS5 关键词检索 ===
    try:
        from knowledge.fts5 import get_global_index
        fts_index = get_global_index()
        fts_results = fts_index.search(query, limit=limit)
        for r in fts_results:
            entry_id = r.get("id", "")
            if entry_id in seen_ids:
                continue
            seen_ids.add(entry_id)
            # snippet: 截取 content 前 200 字符
            content = r.get("content", "") or ""
            snippet = content[:200] + ("..." if len(content) > 200 else "")
            cards.append({
                "title": r.get("title", ""),
                "source": r.get("source", ""),
                "snippet": snippet,
                "url": r.get("url", ""),
                "score": float(r.get("score", 0.0)),
                "match_type": "fts5",
            })
    except Exception as e:
        logger.warning(f"_inject_knowledge_cards: FTS5 检索失败: {e}")

    # === Vector 语义检索（仅当 FTS5 结果不足时补充） ===
    if len(cards) < limit:
        try:
            from knowledge.vector import (
                get_global_vector,
                generate_embedding,
            )
            vec_index = get_global_vector()
            query_emb = generate_embedding(query)
            vec_results = vec_index.search(query_emb, limit=limit)
            for r in vec_results:
                entry_id = r.get("id", "")
                if entry_id in seen_ids:
                    continue
                seen_ids.add(entry_id)
                content = r.get("content", "") or ""
                snippet = content[:200] + ("..." if len(content) > 200 else "")
                cards.append({
                    "title": r.get("title", ""),
                    "source": r.get("source", ""),
                    "snippet": snippet,
                    "url": r.get("url", ""),
                    "score": float(r.get("score", 0.0)),
                    "match_type": "vector",
                })
        except Exception as e:
            logger.warning(f"_inject_knowledge_cards: Vector 检索失败: {e}")

    # 截断到 limit
    return cards[:limit]


def _real_format_observation(
    agent_name: str,
    tool_call_result: dict[str, Any],
    state: AgentState,
) -> str:
    """T-P1-11: 调用真实 Agent 的 format_observation

    若 agents 模块未配置或调用失败，fallback 到 mock 观察逻辑。
    """
    try:
        from agents import get_agent, _agent_instances
        if agent_name in _agent_instances:
            agent = get_agent(agent_name)
            return agent.format_observation(tool_call_result, state)
    except Exception as e:
        logger.warning(f"_real_format_observation failed, fallback to mock: {e}")

    # === mock 观察逻辑 ===
    if tool_call_result:
        tool_name = tool_call_result.get("tool_name", "unknown")
        result = tool_call_result.get("result", {})
        return f"工具 {tool_name} 执行完成，结果: {result}"
    sub_agent_result = state.get("sub_agent_result", {})
    if sub_agent_result:
        agent = sub_agent_result.get("agent", "unknown")
        result = sub_agent_result.get("result", "")
        return f"子 Agent {agent} 执行完成，结果: {result}"
    return "无执行结果"


# ============================================================================
# 节点 5: reflect — 反思节点（评估 + 决定下一步）
# ============================================================================

def reflect_node(state: AgentState) -> dict:
    """反思节点：评估结果，决定下一步（done / continue / error）

    T-P1-11 接入真实 Agent：调用对应 agent.reflect_on_result() 决定下一步。
    若 agents 模块未配置（如单元测试），fallback 到 mock 反思逻辑。
    """
    plan = state.get("plan", [])
    current_idx = state.get("current_task_index", 0)
    intermediate = state.get("intermediate_results", [])
    observation = state.get("observation", "")
    selected_agent = state.get("selected_agent", "main")

    # === T-P1-11: 接入真实 Agent ===
    reflection_result = _real_reflect_on_result(selected_agent, state)
    next_step = reflection_result.get("next_step", "continue")
    reflection_text = reflection_result.get("reflection", "")

    # 前进到下一个任务
    new_idx = current_idx + 1

    # 所有任务完成
    if next_step == "done" or new_idx >= len(plan):
        reflection = reflection_text or (
            f"所有 {len(plan)} 个任务已完成，最后观察: {observation[:100]}"
        )
        logger.info(f"reflect: all done, reflection='{reflection[:80]}...'")
        return {
            "reflection": reflection,
            "next_step": "done",
            "done": True,
            "mood": "done",
            "current_task_index": new_idx,
            **append_node_history(state, "reflect"),
        }

    # 还有任务，继续
    reflection = reflection_text or (
        f"任务 {current_idx + 1}/{len(plan)} 完成，"
        f"观察: {observation[:80]}...，继续下一任务"
    )
    logger.info(f"reflect: continue, next_idx={new_idx}")

    return {
        "reflection": reflection,
        "next_step": "continue",
        "done": False,
        "mood": "working",
        "current_task_index": new_idx,
        "iteration": state.get("iteration", 0) + 1,
        **append_node_history(state, "reflect"),
    }


def _real_reflect_on_result(
    agent_name: str,
    state: AgentState,
) -> dict[str, Any]:
    """T-P1-11: 调用真实 Agent 的 reflect_on_result

    若 agents 模块未配置或调用失败，fallback 到 mock（返回 continue）。
    """
    try:
        from agents import get_agent, _agent_instances
        if agent_name in _agent_instances:
            agent = get_agent(agent_name)
            return agent.reflect_on_result(state)
    except Exception as e:
        logger.warning(f"_real_reflect_on_result failed, fallback to mock: {e}")

    # === mock 反思逻辑 ===
    plan = state.get("plan", [])
    current_idx = state.get("current_task_index", 0)
    if not plan or current_idx >= len(plan) - 1:
        return {"next_step": "done", "reflection": "任务完成"}
    return {"next_step": "continue", "reflection": "继续下一任务"}


# ============================================================================
# 节点 6: tool_call — 工具调用节点（执行 MCP tools）
# ============================================================================

def tool_call_node(state: AgentState) -> dict:
    """工具调用节点：执行 MCP tool

    当前 P1-B 阶段使用 mock 工具调用：
    - 直接返回 mock 结果
    - 不实际执行任何工具

    T-P1-07 接入真实 MCP tools 后，此处调用对应工具的 invoke 方法。
    """
    request = state.get("tool_call_request", {})
    tool_name = request.get("tool_name", "unknown")
    params = request.get("params", {})

    # === mock 工具调用 ===
    start_time = time.time()

    # 模拟不同工具的返回
    if tool_name == "risk":
        # mock 风险评估
        result = _mock_risk_tool(params)
    elif tool_name == "confidence":
        result = _mock_confidence_tool(params)
    elif tool_name == "ground":
        result = _mock_ground_tool(params)
    elif tool_name == "decision":
        result = _mock_decision_tool(params)
    elif tool_name == "credibility":
        result = _mock_credibility_tool(params)
    elif tool_name == "history":
        result = _mock_history_tool(params)
    else:
        result = {"error": f"unknown tool: {tool_name}"}

    duration = time.time() - start_time
    tool_call_result = {
        "tool_name": tool_name,
        "params": params,
        "result": result,
        "duration": round(duration, 3),
        "success": "error" not in result,
    }

    logger.info(
        f"tool_call: tool={tool_name}, duration={duration:.3f}s, "
        f"success={tool_call_result['success']}"
    )

    return {
        "tool_call_result": tool_call_result,
        **append_node_history(state, "tool_call"),
    }


# === Mock 工具实现（T-P1-07 替换为真实实现） ===

def _mock_risk_tool(params: dict) -> dict:
    """Mock risk tool（T-P1-07.1 替换）"""
    command = params.get("command", "")
    # 简单关键词匹配
    if "sudo" in command or "rm -rf" in command:
        return {
            "level": "L4",
            "reason": "sudo / rm -rf 命令",
            "require_approval": True,
        }
    if "systemctl restart" in command or "service restart" in command:
        return {
            "level": "L3",
            "reason": "服务重启",
            "require_approval": True,
        }
    if "systemctl" in command or "service" in command:
        return {
            "level": "L2",
            "reason": "服务管理",
            "require_approval": True,
        }
    return {
        "level": "L1",
        "reason": "普通命令",
        "require_approval": False,
    }


def _mock_confidence_tool(params: dict) -> dict:
    """Mock confidence tool（T-P1-07.2 替换）"""
    return {"score": 0.85, "method": "D-S+PCR5"}


def _mock_ground_tool(params: dict) -> dict:
    """Mock ground tool（T-P1-07.3 替换）"""
    return {
        "results": [{"content": "mock 知识检索结果", "source": "mock_db"}],
        "sources": ["mock_db"],
    }


def _mock_decision_tool(params: dict) -> dict:
    """Mock decision tool（T-P1-07.4 替换）"""
    return {
        "decision": "proceed",
        "alternatives": ["wait", "abort"],
        "reasoning": "mock 决策",
    }


def _mock_credibility_tool(params: dict) -> dict:
    """Mock credibility tool（T-P1-07.5 替换）"""
    return {
        "credibility": 0.8,
        "factors": {"source": 0.9, "timeliness": 0.7, "consistency": 0.8},
    }


def _mock_history_tool(params: dict) -> dict:
    """Mock history tool（T-P1-07.6 替换）"""
    return {"records": [], "total": 0}


# ============================================================================
# 节点 7: permission_check — 权限检查节点（T-P1-08.2 集成真实 permissions.py）
# ============================================================================

def permission_check_node(state: AgentState) -> dict:
    """权限检查节点：4 档 × 3 mode 融合（spec DEC-V321-01）

    职责：
    1. 从 tool_call_result 提取风险等级（L0-L4）
    2. 调用 permissions.check_permission(mode, risk_level) 应用融合矩阵
    3. 决策为 allow → 直接放行（permission_decision.approved=True）
    4. 决策为 require_approval → 生成 permission_request，发送到 needs-you
       - permission_decision.approved=None（pending）
       - next_step=needs_permission（图暂停，等待用户响应）
    5. 决策为 deny → 直接拒绝（permission_decision.approved=False）
       （当前 spec 未使用，保留分支）

    状态字段更新：
    - permission_decision: {approved: bool|None, decision: str, reason: str, ...}
    - permission_request:  仅 require_approval 时填充（发送到 needs-you）
    - next_step:           needs_permission（仅 require_approval 时）
    - mood:                working

    Args:
        state: AgentState（包含 tool_call_result / mode 等字段）

    Returns:
        dict 部分状态更新
    """
    tool_call_request = state.get("tool_call_request", {})
    tool_call_result = state.get("tool_call_result", {})
    mode = state.get("mode", "agent")

    # 从 tool_call_result 提取风险等级（risk tool 返回）
    risk_result = tool_call_result.get("result", {}) if tool_call_result else {}
    if isinstance(risk_result, dict):
        risk_level = risk_result.get("level", "L1")
        risk_reason = risk_result.get("reason", "")
    else:
        risk_level = "L1"
        risk_reason = ""

    # === 调用真实 permissions.py（T-P1-08.2 完成） ===
    try:
        perm_result: PermissionResult = check_permission(mode, risk_level)
    except (ValueError, TypeError) as e:
        # 输入无效（不应发生，但 fail-safe）：默认 require_approval
        logger.warning(
            f"permission_check: invalid input mode={mode!r} risk={risk_level!r}: {e}, "
            f"fallback to require_approval"
        )
        perm_result = PermissionResult(
            decision=PermissionDecision.REQUIRE_APPROVAL,
            reason=f"权限检查输入无效，安全起见需审批（{e}）",
            mode=__import__("permissions").PermissionMode.AGENT,
            risk_level="L1",
        )

    decision_value = perm_result.decision.value
    logger.info(
        f"permission_check: mode={mode}, risk={risk_level}, "
        f"decision={decision_value}, reason={perm_result.reason}"
    )

    # === 决策分支：require_approval → 生成 needs-you 请求 ===
    if perm_result.decision == PermissionDecision.REQUIRE_APPROVAL:
        # 用 uuid4 生成唯一 needs_you_id（防时间戳碰撞）
        needs_you_id = f"perm-{uuid4().hex[:12]}"
        permission_request = {
            "needs_you_id": needs_you_id,
            "risk_level": perm_result.risk_level,
            "command": tool_call_request.get("params", {}).get("command", ""),
            "reason": f"{perm_result.reason}" + (f" | 风险原因: {risk_reason}" if risk_reason else ""),
            "mode": perm_result.mode.value,
            "decision": decision_value,
        }
        return {
            "permission_request": permission_request,
            "permission_decision": {
                "approved": None,  # pending
                "decision": decision_value,
                "reason": perm_result.reason,
            },
            "next_step": "needs_permission",
            "mood": "working",
            **append_node_history(state, "permission_check"),
        }

    # === 决策分支：allow / deny → 直接返回决策 ===
    approved = perm_result.decision == PermissionDecision.ALLOW
    return {
        "permission_decision": {
            "approved": approved,
            "decision": decision_value,
            "reason": perm_result.reason,
        },
        "permission_request": {},
        "mood": "working",
        **append_node_history(state, "permission_check"),
    }


# ============================================================================
# 节点注册（供 graph.py 使用）
# ============================================================================

# 所有节点的注册表（name → function）
NODES: dict[str, Any] = {
    "supervisor": supervisor_node,
    "plan": plan_node,
    "act": act_node,
    "observe": observe_node,
    "reflect": reflect_node,
    "tool_call": tool_call_node,
    "permission_check": permission_check_node,
}


def get_node(name: str):
    """获取节点函数"""
    if name not in NODES:
        raise ValueError(f"unknown node: {name}, available: {list(NODES.keys())}")
    return NODES[name]


def list_nodes() -> list[str]:
    """列出所有节点名称"""
    return list(NODES.keys())
