# Python ↔ LangGraph 接口切面文档（DEC-V32-05）

> **版本**：v1.0.0
> **最后更新**：2026-07-26
> **对应 spec**：T-P2-12.1 / DEC-V32-05 / T-P1-05
> **代码基线**：`python-sidecar/graph/{state,nodes,graph}.py` + `python-sidecar/agents/{base,main_agent}.py`
> **框架**：LangGraph（StateGraph + conditional_edges + Annotated reducers）

---

## 0. 文档目的

本文档作为 **Python 业务层（agents / needs_you / permissions）↔ LangGraph 图引擎** 之间的接口切面契约，覆盖以下内容：

- LangGraph 7 节点定义（supervisor / plan / act / observe / reflect / tool_call / permission_check）
- PAOR（Plan-Act-Observe-Reflect）监督循环
- AgentState TypedDict 完整字段说明
- 条件路由规则（conditional_edges）
- 图构建 API（StateGraph + add_node + add_edge）
- invoke / stream 调用模式
- Agent 与节点的集成方式
- 完整状态流转示例（nginx 故障排查）

**与 python-mcp.md 的分层**：
- `python-mcp.md`：Agent ↔ Tools 函数调用
- **本文档**：Python 业务层 ↔ LangGraph 图执行

---

## 1. 接口总览

### 1.1 LangGraph 7 节点架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         LangGraph PAOR 监督循环                          │
│                                                                         │
│                         START                                           │
│                           │                                             │
│                           ▼                                             │
│                     ┌───────────┐                                       │
│         ┌─────────►│ supervisor │ ◄─────────────┐                       │
│         │           └─────┬─────┘               │                       │
│         │                 │                     │                       │
│         │   ┌─────────────┼─────────────┐       │                       │
│         │   │             │             │       │                       │
│         │   ▼ continue    ▼ done/error  ▼ needs_permission              │
│         │ ┌─────┐       END           ┌──────────────┐                  │
│         │ │ plan│                     │ 图暂停        │                  │
│         │ └──┬─┘                       │ 等待用户审批 │                  │
│         │    │                          └──────────────┘                  │
│         │    ▼                                                            │
│         │  ┌─────┐                                                       │
│         │  │ act │                                                       │
│         │  └──┬─┘                                                       │
│         │     │                                                          │
│         │     ├─────► tool_call ──┐                                      │
│         │     │                   │                                      │
│         │     │     ┌─────────────▼──────────┐                          │
│         │     │     │  permission_check       │                          │
│         │     │     │  (allow / deny /        │                          │
│         │     │     │   require_approval)     │                          │
│         │     │     └─────────────┬──────────┘                          │
│         │     │                   │                                      │
│         │     ▼                   ▼                                      │
│         │  ┌─────────┐                                               │
│         │  │ observe │ ◄─────────────────────────────────┘              │
│         │  └────┬────┘                                               │
│         │       │                                                    │
│         │       ▼                                                    │
│         │  ┌─────────┐                                               │
│         │  │ reflect │                                               │
│         │  └────┬────┘                                               │
│         │       │                                                    │
│         │       ├──(continue)──► supervisor (next iter)               │
│         │       │                                                    │
│         │       └──(done/error)──► END                               │
│         │                                                            │
│         └─────────────── (next iteration) ─────────────────────────┘
│
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 7 节点职责矩阵

| 节点 | 职责 | 输入字段 | 输出字段 | 路由 |
|------|------|----------|----------|------|
| `supervisor` | 监督路由 + mood 更新 + max_iter 检查 | `next_step` / `iteration` | `mood` / `node_history` | → plan / END |
| `plan` | 任务拆解 + Agent 选择 | `input` / `iteration` | `plan` / `current_task` / `selected_agent` | → act |
| `act` | 工具选择 + action 生成 | `current_task` / `selected_agent` | `action` / `tool_call_request` | → tool_call |
| `tool_call` | 执行 MCP tool | `tool_call_request` | `tool_call_result` | → permission_check |
| `permission_check` | 4 档 × 3 mode 融合 | `tool_call_result` / `mode` | `permission_decision` / `permission_request` | → observe / supervisor |
| `observe` | 收集结果 + 格式化观察 | `tool_call_result` | `observation` / `intermediate_results` | → reflect |
| `reflect` | 评估 + 决定下一步 | `plan` / `current_task_index` / `observation` | `reflection` / `next_step` / `done` | → supervisor / END |

### 1.3 PAOR 循环与节点对应

| PAOR 阶段 | 对应节点 | 执行频率 |
|-----------|----------|----------|
| **P**lan | plan_node | 首次（iteration=0） |
| **A**ct | act_node + tool_call_node + permission_check_node | 每轮 |
| **O**bserve | observe_node | 每轮 |
| **R**eflect | reflect_node | 每轮 |

---

## 2. AgentState 完整定义

### 2.1 TypedDict 结构

```python
# python-sidecar/graph/state.py
class AgentState(TypedDict, total=False):
    """LangGraph Agent 状态（所有字段可选，便于增量更新）"""

    # === 输入字段（用户提供）===
    input: str                    # 用户输入（如 "nginx 启动失败"）
    session_id: str               # 会话 ID
    project_id: str               # 项目 ID
    mode: Mode                    # 操作模式 plan/agent/yolo

    # === 消息历史 ===
    messages: Annotated[list, add_messages]  # LangGraph 标准消息列表

    # === Plan 阶段 ===
    plan: list[str]               # 子任务列表
    current_task_index: int       # 当前任务索引
    current_task: str             # 当前任务内容
    selected_agent: AgentName     # main/coding/explore/history/teach
    plan_reasoning: str           # 规划理由

    # === Act 阶段 ===
    action: dict[str, Any]        # 待执行动作
    tool_call_request: dict[str, Any]   # 工具调用请求
    tool_call_result: dict[str, Any]    # 工具调用结果
    sub_agent_result: dict[str, Any]    # 子 Agent 结果

    # === Observe 阶段 ===
    observation: str              # 当前观察结果
    intermediate_results: Annotated[list, lambda x, y: x + y]  # 累积中间结果

    # === Reflect 阶段 ===
    reflection: str               # 反思内容
    next_step: NextStep           # continue/done/error/needs_permission
    done: bool                    # 是否完成
    error: str                    # 错误信息

    # === 权限 ===
    permission_request: dict[str, Any]   # 权限请求
    permission_decision: dict[str, Any]  # 权限决策

    # === Mood ===
    mood: Mood                    # thinking/working/done/error

    # === 元数据 ===
    iteration: int                # PAOR 循环轮次
    max_iterations: int           # 最大循环次数（防无限循环）
    created_at: str               # 创建时间
    updated_at: str               # 更新时间
    node_history: Annotated[list, lambda x, y: x + y]  # 节点访问历史
```

### 2.2 Annotated Reducer 说明

```python
# messages 字段：使用 LangGraph 的 add_messages reducer
# 同 ID 消息覆盖，不同 ID 消息追加
messages: Annotated[list, add_messages]

# intermediate_results 字段：自定义 list 拼接 reducer
# 每轮 PAOR 的中间结果自动累积
intermediate_results: Annotated[list, lambda x, y: x + y]

# node_history 字段：同上，节点访问历史累积
node_history: Annotated[list, lambda x, y: x + y]
```

### 2.3 状态字段分组与生命周期

```
 ┌──────────────────────────────────────────────────────────────┐
 │  输入字段（用户启动时一次性设置，后续只读）                   │
 │  input / session_id / project_id / mode / max_iterations     │
 └──────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────┐
 │  Plan 字段（plan_node 设置一次，后续只读）                    │
 │  plan / selected_agent / plan_reasoning                      │
 └──────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────┐
 │  循环字段（每轮 PAOR 更新）                                   │
 │  current_task_index / current_task / iteration / mood        │
 │  action / tool_call_request / tool_call_result / observation │
 │  reflection / next_step                                      │
 └──────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────┐
 │  累积字段（Annotated reducer 自动追加）                       │
 │  messages / intermediate_results / node_history              │
 └──────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────┐
 │  终态字段（reflect 节点设置后退出图）                         │
 │  done / error / permission_request                           │
 └──────────────────────────────────────────────────────────────┘
```

---

## 3. 节点详解

### 3.1 supervisor_node — 监督节点

**职责**：路由 + mood 更新 + 最大循环次数检查。

```python
def supervisor_node(state: AgentState) -> dict:
    """监督节点：根据 next_step 路由到下一节点"""
    next_step = state.get("next_step", "continue")
    iteration = state.get("iteration", 0)
    max_iter = state.get("max_iterations", 10)

    # 检查最大循环次数（防无限循环）
    if is_max_iterations_reached(state):
        return {
            "mood": "error",
            "next_step": "done",
            "done": True,
            "error": f"max iterations ({max_iter}) reached",
        }

    # 根据 next_step 更新 mood
    mood_map = {
        "continue": "thinking" if iteration == 0 else "working",
        "needs_permission": "working",
        "done": "done",
        "error": "error",
    }
    return {"mood": mood_map.get(next_step, "thinking")}
```

**输入字段**：`next_step` / `iteration` / `max_iterations`
**输出字段**：`mood` / `node_history`
**路由**：通过 `route_from_supervisor` 条件边决定下一节点

### 3.2 plan_node — 规划节点

**职责**：拆解任务 + 选择 Agent（首次规划 + 后续轮次取下一任务）。

```python
def plan_node(state: AgentState) -> dict:
    """规划节点：拆解任务 + 选择 Agent"""
    user_input = state.get("input", "")
    iteration = state.get("iteration", 0)
    current_idx = state.get("current_task_index", 0)

    if iteration == 0:
        # 首次：调用 main_agent.plan_task 生成 plan
        plan, selected_agent, reasoning = _real_plan_task(user_input, state)
        current_task = plan[0] if plan else ""
    else:
        # 后续：从 plan 取下一任务
        plan = state.get("plan", [])
        current_task = plan[current_idx] if current_idx < len(plan) else ""
        selected_agent, _ = _parse_task_prefix(current_task)

    return {
        "plan": plan,
        "current_task_index": current_idx,
        "current_task": current_task,
        "selected_agent": selected_agent,
        "plan_reasoning": reasoning,
        "mood": "working",
    }
```

**任务前缀解析**：plan 中的任务可带 `[agent]` 前缀，如 `[coding] 修复 nginx.conf`。

```python
def _parse_task_prefix(task: str) -> tuple[str, str]:
    """解析 [agent_name] task_content → (agent_name, task_content)"""
    if task.startswith("[") and "]" in task:
        end = task.find("]")
        prefix = task[1:end].strip().lower()
        content = task[end + 1:].strip()
        if prefix in ("main", "coding", "explore", "history", "teach"):
            return prefix, content
    return "main", task
```

### 3.3 act_node — 执行节点

**职责**：调用 Agent.select_tool 选择工具 + 生成 action。

```python
def act_node(state: AgentState) -> dict:
    """执行节点：决定调用工具还是子 Agent"""
    current_task = state.get("current_task", "")
    selected_agent = state.get("selected_agent", "main")

    # 调用对应 Agent 的 select_tool
    tool_selection = _real_select_tool(selected_agent, current_task, state)

    if tool_selection.get("tool_name"):
        # 路由 A：调用 MCP tool
        action = {"type": "tool_call", "tool": ..., "params": ...}
        tool_call_request = {
            "tool_name": tool_selection["tool_name"],
            "params": tool_selection["params"],
            "require_permission": _needs_permission_check(tool_name),
        }
    else:
        # 路由 B：无工具调用（如 Teach Agent 直接生成内容）
        action = {"type": "sub_agent", "agent": selected_agent, "input": current_task}
        tool_call_request = {}

    return {"action": action, "tool_call_request": tool_call_request, "mood": "working"}
```

**工具权限判定**：
```python
def _needs_permission_check(tool_name: str) -> bool:
    """risk / decision 工具需要权限检查；其他只读工具不需要"""
    return tool_name in ("risk", "decision")
```

### 3.4 tool_call_node — 工具调用节点

**职责**：执行 MCP tool，包装结果。

```python
def tool_call_node(state: AgentState) -> dict:
    """工具调用节点：执行 MCP tool"""
    request = state.get("tool_call_request", {})
    tool_name = request.get("tool_name", "unknown")
    params = request.get("params", {})

    # 接入真实 tools.invoke_tool（T-P1-07 完成）
    from tools import invoke_tool
    result = invoke_tool(tool_name, params)

    tool_call_result = {
        "tool_name": tool_name,
        "params": params,
        "result": result,
        "duration": round(duration, 3),
        "success": "error" not in result,
    }
    return {"tool_call_result": tool_call_result}
```

### 3.5 permission_check_node — 权限检查节点

**职责**：4 档风险 × 3 mode 融合矩阵，决定 allow / require_approval / deny。

```python
def permission_check_node(state: AgentState) -> dict:
    """权限检查节点：4 档 × 3 mode 融合"""
    tool_call_result = state.get("tool_call_result", {})
    mode = state.get("mode", "agent")

    # 从 tool_call_result 提取风险等级
    risk_result = tool_call_result.get("result", {})
    risk_level = risk_result.get("level", "L1")

    # 调用 permissions.check_permission(mode, risk_level)
    perm_result: PermissionResult = check_permission(mode, risk_level)

    if perm_result.decision == PermissionDecision.REQUIRE_APPROVAL:
        # 生成 needs-you 请求，图暂停等待用户响应
        return {
            "permission_request": {
                "needs_you_id": f"perm-{uuid4().hex[:12]}",
                "risk_level": perm_result.risk_level,
                "command": ...,
                "reason": perm_result.reason,
            },
            "permission_decision": {"approved": None, "decision": "require_approval"},
            "next_step": "needs_permission",  # 图暂停
        }

    # allow / deny → 直接返回决策
    approved = perm_result.decision == PermissionDecision.ALLOW
    return {
        "permission_decision": {"approved": approved, "decision": ...},
    }
```

**4 档 × 3 mode 融合矩阵**：

| 风险 \ mode | plan | agent | yolo |
|-------------|------|-------|------|
| L0 (low) | allow | allow | allow |
| L1 (low) | allow | allow | allow |
| L2 (medium) | require_approval | allow | allow |
| L3 (high) | require_approval | require_approval | allow |
| L4 (deny) | deny | deny | require_approval |

### 3.6 observe_node — 观察节点

**职责**：收集 act 结果 + 调用 Agent.format_observation 格式化。

```python
def observe_node(state: AgentState) -> dict:
    """观察节点：收集 act 阶段的结果"""
    tool_call_result = state.get("tool_call_result", {})
    selected_agent = state.get("selected_agent", "main")

    # 调用对应 Agent 的 format_observation
    observation = _real_format_observation(selected_agent, tool_call_result, state)

    # 追加到 intermediate_results（Annotated reducer 自动累积）
    return {
        "observation": observation,
        "intermediate_results": [{
            "task": state.get("current_task", ""),
            "result": tool_call_result,
            "success": True,
            "iteration": state.get("iteration", 0),
        }],
    }
```

### 3.7 reflect_node — 反思节点

**职责**：评估结果 + 决定下一步（continue / done / error）。

```python
def reflect_node(state: AgentState) -> dict:
    """反思节点：评估结果，决定下一步"""
    plan = state.get("plan", [])
    current_idx = state.get("current_task_index", 0)
    selected_agent = state.get("selected_agent", "main")

    # 调用对应 Agent 的 reflect_on_result
    reflection_result = _real_reflect_on_result(selected_agent, state)
    next_step = reflection_result.get("next_step", "continue")

    new_idx = current_idx + 1

    # 所有任务完成
    if next_step == "done" or new_idx >= len(plan):
        return {
            "reflection": reflection_result.get("reflection", ""),
            "next_step": "done",
            "done": True,
            "mood": "done",
            "current_task_index": new_idx,
        }

    # 还有任务，继续
    return {
        "reflection": reflection_result.get("reflection", ""),
        "next_step": "continue",
        "done": False,
        "mood": "working",
        "current_task_index": new_idx,
        "iteration": state.get("iteration", 0) + 1,
    }
```

---

## 4. 图构建与路由

### 4.1 StateGraph 构建

```python
# python-sidecar/graph/graph.py
from langgraph.graph import END, START, StateGraph

def build_agent_graph() -> Any:
    """构建 PAOR 监督循环的 LangGraph 图"""
    graph = StateGraph(AgentState)

    # === 添加 7 节点 ===
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("plan", plan_node)
    graph.add_node("act", act_node)
    graph.add_node("tool_call", tool_call_node)
    graph.add_node("permission_check", permission_check_node)
    graph.add_node("observe", observe_node)
    graph.add_node("reflect", reflect_node)

    # === 添加边 ===
    # 入口 → supervisor
    graph.add_edge(START, "supervisor")

    # supervisor 条件路由
    graph.add_conditional_edges(
        "supervisor",
        route_from_supervisor,
        {
            "plan": "plan",
            END: END,
        },
    )

    # plan → act
    graph.add_edge("plan", "act")

    # act 条件路由：有 tool_call_request → tool_call；否则 → observe
    graph.add_conditional_edges(
        "act",
        route_from_act,
        {
            "tool_call": "tool_call",
            "observe": "observe",
        },
    )

    # tool_call → permission_check
    graph.add_edge("tool_call", "permission_check")

    # permission_check 条件路由
    graph.add_conditional_edges(
        "permission_check",
        route_from_permission_check,
        {
            "observe": "observe",
            "supervisor": "supervisor",  # needs_permission → 回 supervisor 终止
        },
    )

    # observe → reflect
    graph.add_edge("observe", "reflect")

    # reflect 条件路由
    graph.add_conditional_edges(
        "reflect",
        route_from_reflect,
        {
            "supervisor": "supervisor",  # continue → 下一轮 PAOR
            END: END,                     # done/error → 退出
        },
    )

    return graph.compile()
```

### 4.2 路由函数

```python
def route_from_supervisor(state: AgentState) -> str:
    """supervisor → plan 或 END"""
    next_step = state.get("next_step", "continue")
    if next_step == "continue":
        return "plan"
    return END  # done / error / needs_permission

def route_from_act(state: AgentState) -> str:
    """act → tool_call（有 tool_call_request）或 observe（无工具）"""
    request = state.get("tool_call_request", {})
    if request.get("tool_name"):
        return "tool_call"
    return "observe"

def route_from_permission_check(state: AgentState) -> str:
    """permission_check → observe（allow）或 supervisor（needs_permission）"""
    next_step = state.get("next_step", "continue")
    if next_step == "needs_permission":
        return "supervisor"  # supervisor 会路由到 END
    return "observe"

def route_from_reflect(state: AgentState) -> str:
    """reflect → supervisor（continue）或 END（done/error）"""
    next_step = state.get("next_step", "continue")
    if next_step == "continue":
        return "supervisor"
    return END
```

---

## 5. 图调用模式

### 5.1 invoke 模式（阻塞，等待完成）

```python
# 一次性执行到 done/error
graph = build_agent_graph()
initial_state = create_initial_state(
    user_input="nginx 启动失败",
    session_id="sess-123",
    mode="agent",
    max_iterations=10,
)
final_state = graph.invoke(initial_state)
# final_state 包含完整的 AgentState（含所有中间结果）
```

### 5.2 stream 模式（流式，逐节点输出）

```python
# 每个节点执行完毕后产生一个事件
for event in graph.stream(initial_state):
    # event 是 {node_name: state_update} 字典
    node_name = list(event.keys())[0]
    state_update = event[node_name]
    print(f"[{node_name}] mood={state_update.get('mood')}")

# 输出示例:
# [supervisor] mood=thinking
# [plan] mood=working
# [act] mood=working
# [tool_call] mood=working
# [permission_check] mood=working
# [observe] mood=working
# [reflect] mood=done
```

### 5.3 needs_permission 暂停与恢复

```python
# 第一次 invoke：图在 permission_check 暂停（next_step=needs_permission）
state = graph.invoke(initial_state)
# state["next_step"] == "needs_permission"
# state["permission_request"]["needs_you_id"] == "perm-abc123"

# 等待用户审批（通过 needs_you.respond）
needs_you_service.approve("perm-abc123", comment="approved")

# 恢复执行：更新 state 后再次 invoke
state["next_step"] = "continue"
state["permission_decision"] = {"approved": True}
final_state = graph.invoke(state, config={"recursion_limit": 20})
```

---

## 6. Agent 与节点的集成

### 6.1 Agent 钩子方法（4 个）

```python
# python-sidecar/agents/base.py
class BaseAgent:
    def plan_task(self, user_input: str, state: dict) -> list[str]:
        """规划子任务（plan_node 调用）"""

    def select_tool(self, task: str, state: dict) -> dict:
        """选择工具（act_node 调用）
        返回: {"tool_name": "risk", "params": {...}} 或 {}（不调用工具）
        """

    def format_observation(self, tool_result: dict, state: dict) -> str:
        """格式化观察结果（observe_node 调用）"""

    def reflect_on_result(self, state: dict) -> dict:
        """反思并决定下一步（reflect_node 调用）
        返回: {"next_step": "continue|done|error", "reflection": str}
        """
```

### 6.2 5 个 Agent 工具配置

| Agent | tools | 主要职责 |
|-------|-------|----------|
| `MainAgent` | `risk` / `decision` / `confidence` | 监督 + 路由 + 运维任务 |
| `CodingAgent` | `risk` / `decision` / `confidence` | 代码生成 + 修改 |
| `ExploreAgent` | `ground` / `history` / `credibility` | 代码探索 + 搜索 |
| `HistoryAgent` | `history` | 历史查询 + 上下文压缩 |
| `TeachAgent` | `ground` | Linux 运维教学讲解 |

### 6.3 节点 → Agent 调用链

```
 plan_node(state)
   │
   ▼
 _real_plan_task(user_input, state)
   │
   ▼
 agents.get_agent("main").plan_task(user_input, state)
   │
   ▼
 MainAgent.plan_task(...)  # 5 类任务规划（教学/探索/历史/编码/运维）
   │
   ▼
 return ["[coding] 修复代码", "[teach] 讲解知识点"]
```

---

## 7. 完整状态流转示例

### 7.1 示例：nginx 故障排查

**用户输入**：`"nginx 启动失败"`

**初始状态**：
```python
initial_state = {
    "input": "nginx 启动失败",
    "session_id": "sess-123",
    "mode": "agent",
    "max_iterations": 10,
    "iteration": 0,
    "next_step": "continue",
    # ... 其他字段默认值
}
```

**节点流转**（iteration 0）：

```
┌─ supervisor (iter=0)
│  mood=thinking, next_step=continue
│
├─ plan (iter=0)
│  MainAgent.plan_task("nginx 启动失败")
│  → plan = ["调用 risk tool 评估命令风险",
│            "执行命令检查服务状态",
│            "分析结果并给出建议"]
│  selected_agent = "main"
│  current_task = "调用 risk tool 评估命令风险"
│
├─ act (iter=0)
│  MainAgent.select_tool("调用 risk tool 评估命令风险", state)
│  → {"tool_name": "risk", "params": {"command": "systemctl status nginx"}}
│  tool_call_request = {"tool_name": "risk", "params": {...},
│                       "require_permission": True}
│
├─ tool_call (iter=0)
│  invoke_tool("risk", {"command": "systemctl status nginx"})
│  → {"level": "L2", "require_approval": True, ...}
│  tool_call_result = {"tool_name": "risk", "result": {...}, "success": True}
│
├─ permission_check (iter=0)
│  check_permission("agent", "L2") → REQUIRE_APPROVAL
│  permission_request = {"needs_you_id": "perm-abc123", "risk_level": "L2", ...}
│  next_step = "needs_permission"  # 图暂停！
│
└─ supervisor (再次进入)
   next_step=needs_permission → 路由到 END
   图执行终止，等待用户审批
```

**用户审批后恢复**（iteration 1）：

```
┌─ supervisor (iter=1)
│  mood=working, next_step=continue
│
├─ plan (iter=1)
│  从 plan 取下一任务：current_task_index=0（继续当前任务）
│  current_task = "调用 risk tool 评估命令风险"（已审批）
│
├─ act (iter=1)
│  选择新工具：{"tool_name": "decision", "params": {...}}
│
├─ tool_call (iter=1)
│  invoke_tool("decision", {...})
│  → {"decision": "proceed", "reasoning": "..."}
│
├─ permission_check (iter=1)
│  L1 风险 + agent mode → ALLOW
│  permission_decision = {"approved": True, "decision": "allow"}
│
├─ observe (iter=1)
│  MainAgent.format_observation(tool_call_result, state)
│  → "工具 decision 执行完成，决策: proceed"
│  intermediate_results 追加一条
│
└─ reflect (iter=1)
   current_task_index: 0 → 1
   plan 还有 2 个任务 → next_step="continue"
   iteration: 1 → 2

[继续下一轮 PAOR，直到所有任务完成]
```

**最终状态**（done）：

```python
final_state = {
    "input": "nginx 启动失败",
    "plan": ["调用 risk tool...", "执行命令...", "分析结果..."],
    "current_task_index": 3,  # 超出 plan 长度
    "iteration": 3,
    "next_step": "done",
    "done": True,
    "mood": "done",
    "intermediate_results": [
        {"task": "调用 risk tool...", "result": {...}, "iteration": 0},
        {"task": "执行命令...", "result": {...}, "iteration": 1},
        {"task": "分析结果...", "result": {...}, "iteration": 2},
    ],
    "reflection": "所有 3 个任务已完成，最后观察: nginx.conf 第 45 行语法错误",
    "node_history": [
        {"node": "supervisor", "timestamp": ...},
        {"node": "plan", "timestamp": ...},
        # ... 共约 21 个节点访问记录（7 节点 × 3 轮）
    ],
}
```

---

## 8. 边界情况与错误处理

### 8.1 max_iterations 检查

```python
# supervisor_node 首先检查
if is_max_iterations_reached(state):
    return {
        "mood": "error",
        "next_step": "done",
        "done": True,
        "error": f"max iterations ({max_iter}) reached",
    }
```

**默认 max_iterations=10**，可在 `create_initial_state` 时自定义。

### 8.2 Agent 未配置的 fallback

```python
def _real_plan_task(user_input, state):
    try:
        from agents import get_agent, _agent_instances
        if "main" not in _agent_instances:
            return _mock_plan_task(user_input)  # fallback 到 mock
        main_agent = get_agent("main")
        plan = main_agent.plan_task(user_input, state)
        ...
    except Exception as e:
        logger.warning(f"_real_plan_task failed, fallback to mock: {e}")
        return _mock_plan_task(user_input)
```

### 8.3 工具调用失败的 fallback

```python
def tool_call_node(state):
    try:
        from tools import invoke_tool
        result = invoke_tool(tool_name, params)
    except Exception as e:
        # fallback 到 mock 实现（避免图执行中断）
        result = _mock_tool(tool_name, params)
```

### 8.4 权限检查输入无效

```python
try:
    perm_result = check_permission(mode, risk_level)
except (ValueError, TypeError) as e:
    # fail-safe：默认 require_approval
    perm_result = PermissionResult(
        decision=PermissionDecision.REQUIRE_APPROVAL,
        reason=f"权限检查输入无效，安全起见需审批（{e}）",
        ...
    )
```

---

## 9. 性能与调优

### 9.1 节点执行耗时基线

| 节点 | 平均耗时 | 主要开销 |
|------|----------|----------|
| `supervisor` | < 1ms | 无 IO |
| `plan` | 50-200ms | Agent.plan_task（含 LLM 调用） |
| `act` | 10-50ms | Agent.select_tool |
| `tool_call` | 5-200ms | 取决于具体 tool |
| `permission_check` | < 5ms | 矩阵查表 |
| `observe` | 5-20ms | Agent.format_observation |
| `reflect` | 10-50ms | Agent.reflect_on_result |

### 9.2 单轮 PAOR 总耗时

- **纯 mock 模式**（无 LLM）：50-100ms
- **真实 LLM 模式**：500ms - 2s（取决于 LLM 响应时间）
- **多轮 PAOR**（3 轮）：1.5s - 6s

### 9.3 recursion_limit 调整

```python
# LangGraph 默认 recursion_limit=25
# 复杂任务可调高
final_state = graph.invoke(state, config={"recursion_limit": 50})
```

---

## 10. 测试策略

### 10.1 测试覆盖

| 测试文件 | 覆盖内容 | 测试数 |
|---------|----------|--------|
| `tests/test_graph.py` | 图构建 + 路由 + 节点 | 32 |
| `tests/test_agents.py` | 5 个 Agent + BaseAgent | 45 |

### 10.2 测试用例示例

```python
def test_graph_simple_task():
    """简单任务应完成单轮 PAOR"""
    graph = build_agent_graph()
    state = create_initial_state(user_input="hello", mode="agent")
    final_state = graph.invoke(state)
    assert final_state["done"] is True
    assert final_state["next_step"] == "done"

def test_graph_max_iterations():
    """超过 max_iterations 应强制 done"""
    state = create_initial_state(
        user_input="...",
        max_iterations=2,
    )
    final_state = graph.invoke(state)
    assert final_state["done"] is True
    assert "max iterations" in final_state.get("error", "")
```

---

## 11. 调试技巧

### 11.1 节点访问历史查询

```python
final_state = graph.invoke(initial_state)
for entry in final_state["node_history"]:
    print(f"[{entry['timestamp']:.3f}] {entry['node']}")
# 输出:
# [1234567890.123] supervisor
# [1234567890.234] plan
# [1234567890.345] act
# ...
```

### 11.2 stream 模式实时观察

```python
for event in graph.stream(initial_state):
    node = list(event.keys())[0]
    update = event[node]
    print(f"[{node}] next_step={update.get('next_step')}, mood={update.get('mood')}")
```

### 11.3 单节点独立测试

```python
from graph.nodes import plan_node
state = create_initial_state(user_input="nginx 故障", mode="agent")
update = plan_node(state)
print(update["plan"])  # ["调用 risk tool...", "执行命令...", ...]
```

---

## 12. 版本兼容性

### 12.1 LangGraph 版本

| 字段 | 当前值 | 备注 |
|------|--------|------|
| LangGraph | >= 0.2.0 | pip 依赖 |
| Python | >= 3.13 | TypedDict + Annotated |
| StateGraph API | stable | LangGraph 0.2+ 稳定 |

### 12.2 状态字段兼容性

- 新增字段 **可选**（TypedDict total=False）
- 字段语义 **不可变更**（如 `next_step` 始终为 4 值之一）
- Annotated reducer **不可移除**（否则状态累积失效）

---

## 13. 安全考量

### 13.1 防无限循环

- `max_iterations=10`（默认）
- `recursion_limit=25`（LangGraph 内置）
- supervisor_node 每轮检查 `is_max_iterations_reached`

### 13.2 权限分离

- `tool_call_node` 仅执行工具，不做权限判定
- `permission_check_node` 独立判定，可被审计
- `act_node` 不直接执行命令，仅生成 action

### 13.3 状态隔离

- 每次 `graph.invoke` 使用独立的 state 副本
- 多会话并发不共享状态
- `intermediate_results` 通过 Annotated reducer 累积（不可篡改历史）

---

## 14. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0.0 | 2026-07-26 | 初始版本：7 节点 + AgentState + 路由 + Agent 集成 + 完整流转示例 |

---

## 15. 参考文档

- `specs/02-architecture.md` 第 2 节：LangGraph 架构
- `specs/04-api-contract.md`：API 契约（state 字段权威来源）
- `python-sidecar/graph/state.py`：AgentState 定义
- `python-sidecar/graph/nodes.py`：7 节点实现
- `python-sidecar/graph/graph.py`：图构建
- `python-sidecar/agents/base.py`：BaseAgent 钩子方法
- LangGraph 官方文档：https://langchain-ai.github.io/langgraph/
