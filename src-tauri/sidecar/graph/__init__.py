"""
graph/ — LangGraph 7 节点 + PAOR 监督循环（T-P1-05）
=====================================================

模块组织:
- state.py:  AgentState TypedDict 定义（PAOR 状态字段）
- nodes.py:  7 节点实现（supervisor / plan / act / observe / reflect / tool_call / permission_check）
- graph.py:  LangGraph 图构建（StateGraph + add_node + add_edge + 条件路由）

PAOR 监督循环（Plan-Act-Observe-Reflect）:
  supervisor → plan → act → observe → reflect → (done | plan) → ...
  act 调用 tool_call 节点（如需工具）
  act 调用 permission_check 节点（如需权限检查）

7 节点职责:
1. supervisor:        监督节点，根据状态路由到 plan/act/observe/reflect
2. plan:              规划节点，拆解任务 + 选择 Agent
3. act:               执行节点，调用工具 / 子 Agent
4. observe:           观察节点，收集结果 + 更新状态
5. reflect:           反思节点，评估结果 + 决定下一步（done/continue）
6. tool_call:         工具调用节点，执行 MCP tools
7. permission_check:  权限检查节点，4 档 × 3 mode 融合
"""
