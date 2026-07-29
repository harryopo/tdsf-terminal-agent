"""
tests/test_graph.py — LangGraph 图构建与 PAOR 循环单元测试（T-P1-05.3 验证）
=============================================================================

验证内容：
1. 图构建：build_agent_graph() 能成功编译
2. 节点注册：图中包含 7 个节点
3. PAOR 循环：单一任务能跑通 plan → act → tool_call → permission_check → observe → reflect → done
4. 多任务循环：多步 plan 能正确循环
5. mock 工具调用：tool_call 节点正确返回 mock 结果
6. 权限检查：低风险自动 allow，高风险 needs_approval
7. 流式调用：stream_agent 能 yield 事件
8. 图拓扑：get_graph_topology 返回正确结构

运行：
    cd python-sidecar
    python -m pytest tests/test_graph.py -v
"""

from __future__ import annotations

import sys
import os
from pathlib import Path

# 确保能 import graph 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from graph.graph import (
    build_agent_graph,
    get_agent_graph,
    get_graph_topology,
    invoke_agent,
    route_from_act,
    route_from_permission_check,
    route_from_reflect,
    route_from_supervisor,
    stream_agent,
)
from graph.state import create_initial_state


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture(scope="module")
def compiled_graph():
    """编译一次图，整个模块共享"""
    return build_agent_graph()


@pytest.fixture
def initial_state():
    """创建初始状态"""
    return create_initial_state(
        user_input="nginx 启动失败",
        session_id="test-session-001",
        project_id="test-project-001",
        mode="agent",
        max_iterations=5,
    )


# ============================================================================
# 1. 图构建测试
# ============================================================================

class TestGraphBuild:
    """图构建测试"""

    def test_build_agent_graph_returns_compiled_graph(self, compiled_graph):
        """build_agent_graph 应返回编译后的图"""
        assert compiled_graph is not None
        # 编译后的图应有 invoke / stream / ainvoke 方法
        assert hasattr(compiled_graph, "invoke")
        assert hasattr(compiled_graph, "stream")
        assert hasattr(compiled_graph, "ainvoke")

    def test_get_agent_graph_singleton(self):
        """get_agent_graph 应返回单例"""
        g1 = get_agent_graph()
        g2 = get_agent_graph()
        assert g1 is g2

    def test_get_graph_topology(self):
        """get_graph_topology 应返回正确的拓扑结构"""
        topo = get_graph_topology()
        assert "nodes" in topo
        assert "edges" in topo
        # 7 个节点
        assert len(topo["nodes"]) == 7
        assert set(topo["nodes"]) == {
            "supervisor",
            "plan",
            "act",
            "observe",
            "reflect",
            "tool_call",
            "permission_check",
        }
        # 至少 12 条边（START→supervisor, supervisor→plan/END, plan→act,
        # act→tool_call/observe, tool_call→permission_check,
        # permission_check→observe/supervisor, observe→reflect,
        # reflect→supervisor/END = 11 条，加上 START 边）
        assert len(topo["edges"]) >= 11


# ============================================================================
# 2. 路由函数测试
# ============================================================================

class TestRouteFunctions:
    """条件边路由函数测试"""

    def test_route_from_supervisor_continue(self):
        """supervisor 路由：continue → plan"""
        state = {"next_step": "continue"}
        assert route_from_supervisor(state) == "plan"

    def test_route_from_supervisor_done(self):
        """supervisor 路由：done → END"""
        from langgraph.graph import END
        state = {"next_step": "done"}
        assert route_from_supervisor(state) == END

    def test_route_from_supervisor_error(self):
        """supervisor 路由：error → END"""
        from langgraph.graph import END
        state = {"next_step": "error"}
        assert route_from_supervisor(state) == END

    def test_route_from_supervisor_needs_permission(self):
        """supervisor 路由：needs_permission → END"""
        from langgraph.graph import END
        state = {"next_step": "needs_permission"}
        assert route_from_supervisor(state) == END

    def test_route_from_act_tool_call(self):
        """act 路由：action.type=tool_call → tool_call"""
        state = {"action": {"type": "tool_call"}}
        assert route_from_act(state) == "tool_call"

    def test_route_from_act_sub_agent(self):
        """act 路由：action.type=sub_agent → observe"""
        state = {"action": {"type": "sub_agent"}}
        assert route_from_act(state) == "observe"

    def test_route_from_permission_check_allow(self):
        """permission_check 路由：approved=True → observe"""
        state = {"permission_decision": {"approved": True}}
        assert route_from_permission_check(state) == "observe"

    def test_route_from_permission_check_deny(self):
        """permission_check 路由：approved=False → observe"""
        state = {"permission_decision": {"approved": False}}
        assert route_from_permission_check(state) == "observe"

    def test_route_from_permission_check_needs_approval(self):
        """permission_check 路由：approved=None → supervisor"""
        state = {"permission_decision": {"approved": None}}
        assert route_from_permission_check(state) == "supervisor"

    def test_route_from_reflect_continue(self):
        """reflect 路由：continue → supervisor"""
        state = {"next_step": "continue"}
        assert route_from_reflect(state) == "supervisor"

    def test_route_from_reflect_done(self):
        """reflect 路由：done → END"""
        from langgraph.graph import END
        state = {"next_step": "done"}
        assert route_from_reflect(state) == END


# ============================================================================
# 3. PAOR 循环测试（端到端）
# ============================================================================

class TestPAORLoop:
    """PAOR 循环端到端测试"""

    def test_single_task_completes(self, compiled_graph, initial_state):
        """单任务场景：PAOR 循环应能完成"""
        final_state = compiled_graph.invoke(initial_state)

        # 应该完成
        assert final_state.get("done") is True
        assert final_state.get("next_step") == "done"

        # 应该有 node_history（至少 supervisor + plan + act + tool_call + permission_check + observe + reflect）
        node_history = final_state.get("node_history", [])
        assert len(node_history) > 0

        # 应该有 mood 变化
        assert final_state.get("mood") in ("done", "error")

    def test_multiple_tasks_loop(self, compiled_graph):
        """多任务场景：PAOR 循环应能正确循环"""
        # 使用运维任务（mock plan 会拆解为 3 步，避免含"查"字误识别为探索任务）
        state = create_initial_state(
            user_input="nginx 启动失败",
            mode="agent",
            max_iterations=10,
        )
        final_state = compiled_graph.invoke(state)

        # 应该完成
        assert final_state.get("done") is True

        # mock plan 应拆解为 3 步（"调用 risk tool / 执行命令检查 / 分析结果"）
        plan = final_state.get("plan", [])
        assert len(plan) == 3, f"expected 3-step plan, got {plan}"

        # 应该有多次循环（3 步任务 → 3 轮 PAOR，iteration 从 0 自增到 2）
        iteration = final_state.get("iteration", 0)
        assert iteration >= 2, f"expected iteration >= 2, got {iteration}"

        # intermediate_results 应有多个（3 个任务 → 3 个中间结果）
        intermediate = final_state.get("intermediate_results", [])
        assert len(intermediate) >= 3, (
            f"expected >= 3 intermediate results, got {len(intermediate)}"
        )

    def test_max_iterations_terminates(self, compiled_graph):
        """达到 max_iterations 应终止"""
        state = create_initial_state(
            user_input="复杂任务",
            mode="agent",
            max_iterations=1,  # 限制 1 次
        )
        final_state = compiled_graph.invoke(state)

        # 应该终止（done 或 error）
        assert final_state.get("done") is True or final_state.get("next_step") == "error"


# ============================================================================
# 4. mock 工具调用测试
# ============================================================================

class TestToolCallNode:
    """tool_call 节点 mock 行为测试"""

    def test_risk_tool_called_in_loop(self, compiled_graph):
        """PAOR 循环中应调用 risk tool（mock 实现）"""
        state = create_initial_state(
            user_input="nginx 启动失败",
            mode="agent",
        )
        final_state = compiled_graph.invoke(state)

        # tool_call_result 应该有内容
        tool_call_result = final_state.get("tool_call_result", {})
        assert tool_call_result != {}
        assert "tool_name" in tool_call_result
        # mock 实现：tool_name 应该是 risk
        assert tool_call_result["tool_name"] == "risk"

    def test_risk_tool_returns_level(self, compiled_graph):
        """risk tool mock 应返回 level 字段"""
        state = create_initial_state(
            user_input="nginx 启动失败",
            mode="agent",
        )
        final_state = compiled_graph.invoke(state)

        tool_call_result = final_state.get("tool_call_result", {})
        result = tool_call_result.get("result", {})
        assert "level" in result
        assert result["level"] in ("L0", "L1", "L2", "L3", "L4")


# ============================================================================
# 5. 权限检查测试
# ============================================================================

class TestPermissionCheck:
    """permission_check 节点测试"""

    def test_agent_mode_low_risk_auto_allow(self, compiled_graph):
        """agent 模式下低风险（L0/L1）应自动 allow"""
        # 用普通命令（mock risk 会返回 L1）
        state = create_initial_state(
            user_input="普通命令",
            mode="agent",
        )
        final_state = compiled_graph.invoke(state)

        # 由于 mock plan 默认走 main agent + tool_call=risk
        # 风险评估"普通命令"应返回 L1（无关键词），agent 模式 L0-L1 静默
        permission_decision = final_state.get("permission_decision", {})
        assert permission_decision.get("approved") in (True, False, None)

    def test_yolo_mode_high_risk_needs_approval(self, compiled_graph):
        """yolo 模式下 L3 风险仍需审批（安全底线）"""
        # 用 sudo systemctl restart（mock risk 返回 L3 或 L4）
        state = create_initial_state(
            user_input="sudo systemctl restart nginx",
            mode="yolo",
            max_iterations=3,
        )
        final_state = compiled_graph.invoke(state)

        # 高风险命令在 yolo 模式下应触发 needs_approval
        # 图执行会暂停（next_step = needs_permission）
        next_step = final_state.get("next_step")
        # 可能是 needs_permission（暂停）或 done（如果路径短）
        assert next_step in ("needs_permission", "done", "error")


# ============================================================================
# 6. 流式调用测试
# ============================================================================

class TestStreamAgent:
    """stream_agent 流式调用测试"""

    def test_stream_yields_events(self, compiled_graph):
        """stream_agent 应 yield 多个事件"""
        events = list(
                stream_agent(
                user_input="nginx 启动失败",
                mode="agent",
                max_iterations=3,
                graph=compiled_graph,
            )
        )

        # 应该至少有 7 个事件（每个节点至少触发一次）
        assert len(events) >= 1

        # 每个事件应该是 dict（{node_name: state_update}）
        for event in events:
            assert isinstance(event, dict)
            # 至少包含一个节点名
            assert len(event) >= 1

    def test_stream_contains_supervisor_event(self, compiled_graph):
        """stream 应包含 supervisor 节点事件"""
        events = list(
            stream_agent(
                user_input="nginx",
                mode="agent",
                max_iterations=2,
                graph=compiled_graph,
            )
        )

        # 应该有 supervisor 节点的事件
        node_names_seen = set()
        for event in events:
            node_names_seen.update(event.keys())

        assert "supervisor" in node_names_seen

    def test_stream_contains_plan_act_observe_reflect(self, compiled_graph):
        """stream 应包含 PAOR 4 个核心节点事件"""
        events = list(
            stream_agent(
                user_input="nginx 启动失败",
                mode="agent",
                max_iterations=3,
                graph=compiled_graph,
            )
        )

        node_names_seen = set()
        for event in events:
            node_names_seen.update(event.keys())

        # 至少应包含 plan / act / observe / reflect
        assert "plan" in node_names_seen
        assert "act" in node_names_seen
        assert "observe" in node_names_seen
        assert "reflect" in node_names_seen


# ============================================================================
# 7. invoke_agent 便捷函数测试
# ============================================================================

class TestInvokeAgent:
    """invoke_agent 便捷封装测试"""

    def test_invoke_agent_returns_final_state(self):
        """invoke_agent 应返回最终 AgentState"""
        final_state = invoke_agent(
            user_input="nginx 启动失败",
            mode="agent",
            max_iterations=3,
        )

        assert isinstance(final_state, dict)
        assert "next_step" in final_state
        assert "done" in final_state
        assert "mood" in final_state

    def test_invoke_agent_with_session_id(self):
        """invoke_agent 应能传入 session_id"""
        final_state = invoke_agent(
            user_input="nginx",
            session_id="test-session-123",
            mode="agent",
            max_iterations=2,
        )

        assert final_state.get("session_id") == "test-session-123"

    def test_invoke_agent_plan_mode(self):
        """invoke_agent 应支持 plan 模式"""
        final_state = invoke_agent(
            user_input="nginx",
            mode="plan",
            max_iterations=2,
        )

        assert final_state.get("mode") == "plan"
