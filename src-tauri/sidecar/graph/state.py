"""
graph/state.py — AgentState TypedDict（T-P1-05.1）
==================================================

定义 LangGraph 图的状态结构（AgentState），包含 PAOR 各阶段状态字段。

设计要点：
- TypedDict + total=False：所有字段可选，便于增量更新
- 每个节点只返回需要更新的字段（LangGraph 会自动 merge）
- messages 字段使用 add_messages reducer（追加而非覆盖）
- 历史记录字段使用 list + 自定义 reducer（追加）

状态字段分组：
- 输入: input / session_id / mode
- Plan 阶段: plan / tasks / current_task / selected_agent
- Act 阶段: action / tool_call_request / tool_call_result
- Observe 阶段: observation / intermediate_results
- Reflect 阶段: reflection / next_step / done / error
- 权限: permission_request / permission_decision
- Mood: mood（thinking / working / done / error）
- 元数据: iteration / max_iterations / created_at / updated_at
"""

from __future__ import annotations

from typing import Annotated, Any, TypedDict

from langgraph.graph.message import add_messages


# ============================================================================
# 枚举类型（用 Literal 或 str，便于 JSON 序列化）
# ============================================================================

# 心情状态（与 event_bus.EventType.MOOD_CHANGE 对齐）
Mood = str  # "thinking" | "working" | "done" | "error"

# 操作模式（与 permissions.py 对齐）
Mode = str  # "plan" | "agent" | "yolo"

# 风险等级（4 档：L0-L4）
RiskLevel = str  # "L0" | "L1" | "L2" | "L3" | "L4"

# Agent 名称（与 agents/ 模块对齐）
AgentName = str  # "main" | "coding" | "explore" | "history" | "teach"

# 下一步路由（reflect 节点决定）
NextStep = str  # "continue" | "done" | "error" | "needs_permission"

# 节点名称（supervisor 路由用）
NodeName = str  # "plan" | "act" | "observe" | "reflect" | "tool_call" | "permission_check"


# ============================================================================
# AgentState — LangGraph 图状态
# ============================================================================

class AgentState(TypedDict, total=False):
    """LangGraph Agent 状态（所有字段可选，便于增量更新）

    设计：
    - 每个节点返回 dict（只包含需要更新的字段）
    - LangGraph 自动 merge 到 AgentState
    - messages 字段使用 add_messages reducer（追加而非覆盖）
    - 历史记录字段使用 list + 自定义 reducer（追加）
    """

    # ========================================================================
    # 输入字段（用户提供）
    # ========================================================================

    # 用户输入（自然语言指令，如 "nginx 启动失败"）
    input: str

    # 会话 ID（关联 project_service.sessions 表）
    session_id: str

    # 项目 ID（关联 project_service.projects 表）
    project_id: str

    # 操作模式（plan / agent / yolo，影响权限融合）
    mode: Mode

    # ========================================================================
    # 消息历史（LangGraph 标准字段，使用 add_messages reducer）
    # ========================================================================

    # 消息列表（BaseMessage 集合，支持 HumanMessage / AIMessage / SystemMessage / ToolMessage）
    # add_messages reducer 自动追加，相同 ID 的消息会被覆盖
    messages: Annotated[list, add_messages]

    # ========================================================================
    # Plan 阶段状态
    # ========================================================================

    # 任务规划（拆解后的子任务列表）
    # 例: ["检查 nginx 状态", "查看错误日志", "重启 nginx"]
    plan: list[str]

    # 当前任务索引（指向 plan 列表）
    current_task_index: int

    # 当前任务内容（plan[current_task_index]）
    current_task: str

    # 选择的 Agent（执行当前任务的 Agent）
    # 可选值: "main" / "coding" / "explore" / "history" / "teach"
    selected_agent: AgentName

    # 规划理由（LLM 输出的解释，便于调试）
    plan_reasoning: str

    # ========================================================================
    # Act 阶段状态
    # ========================================================================

    # 待执行动作（结构化描述）
    # 例: {"type": "tool_call", "tool": "risk", "params": {"command": "..."}}
    #     {"type": "sub_agent", "agent": "coding", "input": "..."}
    action: dict[str, Any]

    # 工具调用请求（act 节点生成，tool_call 节点消费）
    # 例: {"tool_name": "risk", "params": {...}, "require_permission": True}
    tool_call_request: dict[str, Any]

    # 工具调用结果（tool_call 节点生成，observe 节点消费）
    # 例: {"tool_name": "risk", "result": {"level": "L3"}, "duration": 0.5}
    tool_call_result: dict[str, Any]

    # 子 Agent 调用结果
    sub_agent_result: dict[str, Any]

    # ========================================================================
    # Observe 阶段状态
    # ========================================================================

    # 当前观察结果（act 完成后的状态描述）
    observation: str

    # 中间结果列表（PAOR 循环每轮的结果累积）
    # 例: [{"task": "检查 nginx 状态", "result": {...}, "success": True}, ...]
    intermediate_results: Annotated[list, lambda x, y: x + y]

    # ========================================================================
    # T-P3-08 知识卡注入（observe_node 自动检索相关知识点）
    # ========================================================================
    # 知识卡列表（每张卡含 title/source/snippet/url/score）
    # observe_node 调用 knowledge.search(query) 注入到 state
    # 通过 event_bus 推送到 AgentPanel.tsx 显示
    # 注：覆盖式更新（每轮 observe 重新检索），不用追加 reducer
    # 例: [{"title": "nginx 启动失败排查", "source": "nginx-docs",
    #       "snippet": "检查 nginx.conf...", "url": "...", "score": 0.85}]
    knowledge_cards: list

    # ========================================================================
    # Reflect 阶段状态
    # ========================================================================

    # 反思内容（LLM 评估结果输出）
    reflection: str

    # 下一步路由（reflect 节点决定）
    # "continue": 继续下一轮 PAOR 循环
    # "done": 任务完成，退出循环
    # "error": 出错，退出循环
    # "needs_permission": 需要用户审批，暂停等待
    next_step: NextStep

    # 任务是否完成（next_step == "done" 时为 True）
    done: bool

    # 错误信息（next_step == "error" 时填充）
    error: str

    # ========================================================================
    # 权限相关（permission_check 节点）
    # ========================================================================

    # 权限请求（permission_check 节点生成，发送到 needs_you）
    # 例: {"risk_level": "L3", "command": "sudo systemctl restart nginx",
    #      "reason": "sudo + systemctl + restart", "needs_you_id": "..."}
    permission_request: dict[str, Any]

    # 权限决策（用户响应，从 needs_you 收件箱获取）
    # 例: {"approved": True, "user_id": "...", "comment": "..."}
    permission_decision: dict[str, Any]

    # ========================================================================
    # Mood 状态（与 event_bus.EventType.MOOD_CHANGE 对齐）
    # ========================================================================

    # 当前心情（thinking / working / done / error）
    # supervisor 节点更新，通过 event_bus 推送到前端
    mood: Mood

    # ========================================================================
    # 元数据
    # ========================================================================

    # 当前 PAOR 循环轮次（从 0 开始）
    iteration: int

    # 最大循环次数（防止无限循环，默认 10）
    max_iterations: int

    # 创建时间（ISO 8601 字符串）
    created_at: str

    # 最后更新时间（ISO 8601 字符串）
    updated_at: str

    # 节点访问历史（调试用，记录每个节点的执行时间）
    # 例: [{"node": "supervisor", "timestamp": 1234567890.0}, ...]
    node_history: Annotated[list, lambda x, y: x + y]


# ============================================================================
# 初始状态工厂函数
# ============================================================================

def create_initial_state(
    user_input: str,
    session_id: str | None = None,
    project_id: str | None = None,
    mode: Mode = "agent",
    max_iterations: int = 10,
) -> AgentState:
    """创建 AgentState 初始状态

    Args:
        user_input: 用户输入（自然语言指令）
        session_id: 会话 ID（关联 project_service）
        project_id: 项目 ID
        mode: 操作模式（plan / agent / yolo）
        max_iterations: 最大 PAOR 循环次数（防无限循环）

    Returns:
        AgentState 初始状态（包含 input / mode / iteration=0 等）
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return AgentState(
        input=user_input,
        session_id=session_id or "",
        project_id=project_id or "",
        mode=mode,
        messages=[],
        plan=[],
        current_task_index=0,
        current_task="",
        selected_agent="main",
        plan_reasoning="",
        action={},
        tool_call_request={},
        tool_call_result={},
        sub_agent_result={},
        observation="",
        intermediate_results=[],
        knowledge_cards=[],  # T-P3-08: 知识卡注入
        reflection="",
        next_step="continue",
        done=False,
        error="",
        permission_request={},
        permission_decision={},
        mood="thinking",
        iteration=0,
        max_iterations=max_iterations,
        created_at=now,
        updated_at=now,
        node_history=[],
    )


# ============================================================================
# 状态访问辅助函数
# ============================================================================

def get_current_task(state: AgentState) -> str:
    """获取当前任务（基于 current_task_index 从 plan 中取）"""
    plan = state.get("plan", [])
    idx = state.get("current_task_index", 0)
    if not plan or idx >= len(plan):
        return ""
    return plan[idx]


def advance_task(state: AgentState) -> int:
    """前进到下一个任务，返回新的 index"""
    return state.get("current_task_index", 0) + 1


def is_max_iterations_reached(state: AgentState) -> bool:
    """检查是否达到最大循环次数"""
    iteration = state.get("iteration", 0)
    max_iter = state.get("max_iterations", 10)
    return iteration >= max_iter


def append_intermediate_result(
    state: AgentState,
    task: str,
    result: Any,
    success: bool = True,
) -> dict:
    """追加中间结果（返回部分状态更新，供节点使用）

    用法：
        return append_intermediate_result(state, "检查 nginx", {"status": "down"}, True)
    """
    return {
        "intermediate_results": [
            {
                "task": task,
                "result": result,
                "success": success,
                "iteration": state.get("iteration", 0),
            }
        ]
    }


def append_node_history(state: AgentState, node_name: str) -> dict:
    """追加节点访问历史（返回部分状态更新，供节点使用）"""
    import time

    return {
        "node_history": [
            {"node": node_name, "timestamp": time.time()}
        ]
    }
