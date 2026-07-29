"""
graph/graph.py — LangGraph 图构建（T-P1-05.3）
================================================

构建 PAOR 监督循环的 LangGraph 图，包含 7 节点和条件路由。

图结构（PAOR 监督循环）：

    START
      │
      ▼
    supervisor ──(continue)──► plan
      │                         │
      │ (done/error/            │
      │  needs_permission)      ▼
      │                        act
      │                         │
      │                  ┌──────┴──────┐
      │                  │             │
      │                  ▼             ▼
      │             tool_call      observe ◄─────────────┐
      │                  │             │                  │
      │                  ▼             │                  │
      │          permission_check      │                  │
      │                  │             │                  │
      │      ┌───────────┴────────┐    │                  │
      │      │ (allow)            │    │                  │
      │      ▼                    ▼    │                  │
      │    observe ◄──────────────┘    │                  │
      │      │                          │                  │
      │      ▼                           │                  │
      │    reflect                       │                  │
      │      │                           │                  │
      │      ├──(continue)──► supervisor─┤                  │
      │      │                           │                  │
      │      └──(done/error)──► END      │                  │
      │                                  │                  │
      └──────────────────────────────────┘                  │
          (needs_approval: set next_step=needs_permission,   │
           图执行终止，等待用户审批后重新启动)                │

设计要点：
1. supervisor 是中心路由节点，根据 next_step 决定下一节点
2. PAOR 循环：plan → act → observe → reflect → (back to supervisor)
3. permission_check 需要审批时回到 supervisor（supervisor 判定 needs_permission 后终止图）
4. reflect 决定继续还是结束
5. next_step 取值：continue / done / error / needs_permission

调用方式：
    graph = build_agent_graph()
    initial_state = create_initial_state("nginx 启动失败", mode="agent")
    final_state = graph.invoke(initial_state)

流式调用：
    for event in graph.stream(initial_state):
        # event 是 {node_name: state_update} 字典
        handle_event(event)
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from langgraph.graph import END, START, StateGraph

from graph.nodes import (
    act_node,
    observe_node,
    permission_check_node,
    plan_node,
    reflect_node,
    supervisor_node,
    tool_call_node,
)
from graph.state import AgentState

logger = logging.getLogger("sidecar.graph.graph")


# ============================================================================
# 路由函数（条件边的决策逻辑）
# ============================================================================

def route_from_supervisor(state: AgentState) -> str:
    """supervisor 节点的路由函数

    根据 next_step 决定下一节点：
    - "continue": 进入 plan，开始/继续 PAOR 循环
    - "done": 任务完成，退出图
    - "error": 出错，退出图
    - "needs_permission": 需要用户审批，退出图（图执行暂停，
      由 needs_you 服务处理，用户响应后重新调用 graph.invoke）

    Returns:
        下一节点名称（"plan" 或 END）
    """
    next_step = state.get("next_step", "continue")

    if next_step == "continue":
        logger.debug("route[supervisor]: continue → plan")
        return "plan"

    # done / error / needs_permission 都终止图执行
    logger.info(f"route[supervisor]: {next_step} → END")
    return END


def route_from_act(state: AgentState) -> str:
    """act 节点的路由函数

    根据 action.type 决定下一节点：
    - "tool_call": 进入 tool_call 节点执行 MCP tool
    - "sub_agent": 直接进入 observe（子 Agent 结果已就绪）
    - "direct": 直接进入 observe（无需工具调用）
    - 其他: 默认走 tool_call

    Returns:
        下一节点名称（"tool_call" 或 "observe"）
    """
    action = state.get("action", {})
    action_type = action.get("type", "tool_call")

    if action_type == "tool_call":
        logger.debug(f"route[act]: action.type={action_type} → tool_call")
        return "tool_call"

    # sub_agent / direct → observe
    logger.debug(f"route[act]: action.type={action_type} → observe")
    return "observe"


def route_from_tool_call(state: AgentState) -> str:
    """tool_call 节点的路由函数

    tool_call 执行完成后，统一进入 permission_check 节点
    （permission_check 内部会根据 mode 和 risk_level 决定 allow/needs_approval/deny）

    Returns:
        下一节点名称（固定 "permission_check"）
    """
    logger.debug("route[tool_call]: → permission_check")
    return "permission_check"


def route_from_permission_check(state: AgentState) -> str:
    """permission_check 节点的路由函数

    根据 permission_decision 决定下一节点：
    - allow / deny: 进入 observe（observe 内部根据 permission_decision 处理）
    - needs_approval: 回到 supervisor（supervisor 判定 needs_permission 后终止图）

    Returns:
        下一节点名称（"observe" 或 "supervisor"）
    """
    decision = state.get("permission_decision", {})
    approved = decision.get("approved")

    if approved is None:
        # 待审批：回到 supervisor，supervisor 会根据 next_step=needs_permission 终止图
        logger.info("route[permission_check]: needs_approval → supervisor")
        return "supervisor"

    # allow / deny: 进入 observe
    logger.debug(f"route[permission_check]: approved={approved} → observe")
    return "observe"


def route_from_reflect(state: AgentState) -> str:
    """reflect 节点的路由函数

    根据 next_step 决定下一节点：
    - "continue": 回到 supervisor，开始下一轮 PAOR 循环
    - "done": 任务完成，退出图
    - "error": 出错，退出图

    Returns:
        下一节点名称（"supervisor" 或 END）
    """
    next_step = state.get("next_step", "continue")

    if next_step == "continue":
        logger.debug("route[reflect]: continue → supervisor")
        return "supervisor"

    # done / error
    logger.info(f"route[reflect]: {next_step} → END")
    return END


# ============================================================================
# 图构建
# ============================================================================

def build_agent_graph():
    """构建 LangGraph Agent 图

    构建步骤：
    1. 创建 StateGraph（以 AgentState 为状态）
    2. 添加 7 个节点
    3. 添加边（包括条件边）
    4. 编译图

    Returns:
        编译后的 LangGraph 可执行图（支持 invoke / stream / astream）
    """
    # 1. 创建 StateGraph（以 AgentState 为状态结构）
    builder: StateGraph = StateGraph(AgentState)

    # 2. 添加 7 个节点
    builder.add_node("supervisor", supervisor_node)
    builder.add_node("plan", plan_node)
    builder.add_node("act", act_node)
    builder.add_node("observe", observe_node)
    builder.add_node("reflect", reflect_node)
    builder.add_node("tool_call", tool_call_node)
    builder.add_node("permission_check", permission_check_node)

    logger.info("graph: added 7 nodes (supervisor/plan/act/observe/reflect/tool_call/permission_check)")

    # 3. 添加边
    # 3.1 START → supervisor（图入口）
    builder.add_edge(START, "supervisor")

    # 3.2 supervisor → plan / END（条件路由）
    builder.add_conditional_edges(
        "supervisor",
        route_from_supervisor,
        # 显式声明可能的目标节点（便于 LangGraph 渲染图结构）
        ["plan", END],
    )

    # 3.3 plan → act（固定边，规划后总是执行）
    builder.add_edge("plan", "act")

    # 3.4 act → tool_call / observe（条件路由）
    builder.add_conditional_edges(
        "act",
        route_from_act,
        ["tool_call", "observe"],
    )

    # 3.5 tool_call → permission_check（固定边，工具调用后总是检查权限）
    builder.add_edge("tool_call", "permission_check")

    # 3.6 permission_check → observe / supervisor（条件路由）
    builder.add_conditional_edges(
        "permission_check",
        route_from_permission_check,
        ["observe", "supervisor"],
    )

    # 3.7 observe → reflect（固定边，观察后总是反思）
    builder.add_edge("observe", "reflect")

    # 3.8 reflect → supervisor / END（条件路由，决定继续还是结束）
    builder.add_conditional_edges(
        "reflect",
        route_from_reflect,
        ["supervisor", END],
    )

    logger.info("graph: added edges (8 edges, 4 conditional)")

    # 4. 编译图
    graph = builder.compile()
    logger.info("graph: compiled successfully")

    return graph


# ============================================================================
# 图执行辅助函数
# ============================================================================

def invoke_agent(
    user_input: str,
    session_id: str | None = None,
    project_id: str | None = None,
    mode: str = "agent",
    max_iterations: int = 10,
    graph=None,
) -> AgentState:
    """同步调用 Agent 图（便捷封装）

    Args:
        user_input: 用户输入
        session_id: 会话 ID
        project_id: 项目 ID
        mode: 操作模式（plan / agent / yolo）
        max_iterations: 最大 PAOR 循环次数
        graph: 已编译的图（None 时现场构建）

    Returns:
        最终 AgentState
    """
    from graph.state import create_initial_state

    if graph is None:
        graph = build_agent_graph()

    initial_state = create_initial_state(
        user_input=user_input,
        session_id=session_id,
        project_id=project_id,
        mode=mode,
        max_iterations=max_iterations,
    )

    logger.info(f"invoke_agent: input='{user_input[:50]}', mode={mode}")
    final_state = graph.invoke(initial_state)
    logger.info(
        f"invoke_agent: done, iterations={final_state.get('iteration', 0)}, "
        f"next_step={final_state.get('next_step')}"
    )
    return final_state


async def ainvoke_agent(
    user_input: str,
    session_id: str | None = None,
    project_id: str | None = None,
    mode: str = "agent",
    max_iterations: int = 10,
    graph=None,
) -> AgentState:
    """异步调用 Agent 图（便捷封装）

    Args:
        user_input: 用户输入
        session_id: 会话 ID
        project_id: 项目 ID
        mode: 操作模式
        max_iterations: 最大 PAOR 循环次数
        graph: 已编译的图（None 时现场构建）

    Returns:
        最终 AgentState
    """
    from graph.state import create_initial_state

    if graph is None:
        graph = build_agent_graph()

    initial_state = create_initial_state(
        user_input=user_input,
        session_id=session_id,
        project_id=project_id,
        mode=mode,
        max_iterations=max_iterations,
    )

    logger.info(f"ainvoke_agent: input='{user_input[:50]}', mode={mode}")
    final_state = await graph.ainvoke(initial_state)
    logger.info(
        f"ainvoke_agent: done, iterations={final_state.get('iteration', 0)}, "
        f"next_step={final_state.get('next_step')}"
    )
    return final_state


def stream_agent(
    user_input: str,
    session_id: str | None = None,
    project_id: str | None = None,
    mode: str = "agent",
    max_iterations: int = 10,
    graph=None,
):
    """流式调用 Agent 图（每次节点更新都 yield 事件）

    用于实时推送 mood / 工具调用 / 中间结果到前端。

    Args:
        user_input: 用户输入
        session_id: 会话 ID
        project_id: 项目 ID
        mode: 操作模式
        max_iterations: 最大 PAOR 循环次数
        graph: 已编译的图

    Yields:
        dict: {node_name: state_update} 字典
    """
    from graph.state import create_initial_state

    if graph is None:
        graph = build_agent_graph()

    initial_state = create_initial_state(
        user_input=user_input,
        session_id=session_id,
        project_id=project_id,
        mode=mode,
        max_iterations=max_iterations,
    )

    logger.info(f"stream_agent: input='{user_input[:50]}', mode={mode}")
    for event in graph.stream(initial_state):
        yield event


# ============================================================================
# 图结构可视化（调试用）
# ============================================================================

def get_graph_topology() -> dict[str, Any]:
    """获取图拓扑结构（用于调试和文档）

    Returns:
        图拓扑字典：
        {
            "nodes": ["supervisor", "plan", ...],
            "edges": [
                {"from": "START", "to": "supervisor", "type": "fixed"},
                {"from": "supervisor", "to": "plan", "type": "conditional", "condition": "continue"},
                ...
            ]
        }
    """
    return {
        "nodes": [
            "supervisor",
            "plan",
            "act",
            "observe",
            "reflect",
            "tool_call",
            "permission_check",
        ],
        "edges": [
            {"from": "START", "to": "supervisor", "type": "fixed"},
            {
                "from": "supervisor",
                "to": "plan",
                "type": "conditional",
                "condition": "next_step == 'continue'",
            },
            {
                "from": "supervisor",
                "to": "END",
                "type": "conditional",
                "condition": "next_step in ('done', 'error', 'needs_permission')",
            },
            {"from": "plan", "to": "act", "type": "fixed"},
            {
                "from": "act",
                "to": "tool_call",
                "type": "conditional",
                "condition": "action.type == 'tool_call'",
            },
            {
                "from": "act",
                "to": "observe",
                "type": "conditional",
                "condition": "action.type in ('sub_agent', 'direct')",
            },
            {"from": "tool_call", "to": "permission_check", "type": "fixed"},
            {
                "from": "permission_check",
                "to": "observe",
                "type": "conditional",
                "condition": "approved in (True, False)",
            },
            {
                "from": "permission_check",
                "to": "supervisor",
                "type": "conditional",
                "condition": "approved is None (needs_approval)",
            },
            {"from": "observe", "to": "reflect", "type": "fixed"},
            {
                "from": "reflect",
                "to": "supervisor",
                "type": "conditional",
                "condition": "next_step == 'continue'",
            },
            {
                "from": "reflect",
                "to": "END",
                "type": "conditional",
                "condition": "next_step in ('done', 'error')",
            },
        ],
    }


# ============================================================================
# 模块级单例（懒加载）
# ============================================================================

# 全局图实例（首次访问时构建，避免重复构建开销）
_graph_instance = None


def get_agent_graph():
    """获取全局图实例（懒加载单例）

    Returns:
        编译后的 LangGraph 图
    """
    global _graph_instance
    if _graph_instance is None:
        _graph_instance = build_agent_graph()
        logger.info("get_agent_graph: built singleton instance")
    return _graph_instance
