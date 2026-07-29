"""
tests/test_task_protocol.py — TaskProtocol 单元测试（T-P4-11）
=================================================================

验证内容：
1. 常量与状态枚举
   - TASK_STATES 包含 14 个状态
   - TERMINAL_STATES 包含 complete / cancel
2. create_task
   - 创建新任务初始状态 = intake
   - 重复创建抛 ValueError
3. advance - 正常转换
   - intake → plan → approve_plan → execute → monitor → review → approve_result → deliver → complete
   - 每次转换 next_actions 正确
4. advance - 异常处理
   - 不存在的 task_id 返回 ok=False
   - 终态不可转换
   - 非法事件返回 ok=False + next_actions
5. advance - retry / escalate / handoff / resume 路径
   - execute → error → retry → restart → plan
   - execute → escalate → handoff → resume → execute
   - plan → escalate → handoff → resume → restart → plan
6. cancel 路径
   - 任意状态可 cancel
7. get_state / get_history / get_next_actions
8. list_tasks / delete_task
9. 全局单例 get_global_protocol / reset_for_test

运行：
    cd python-sidecar
    python -m pytest tests/test_task_protocol.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import task_protocol 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from task_protocol import (
    TASK_STATES,
    TERMINAL_STATES,
    TRANSITION_TABLE,
    TaskProtocol,
    get_global_protocol,
    reset_for_test,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def protocol() -> TaskProtocol:
    """每个测试独立的 TaskProtocol"""
    return TaskProtocol()


@pytest.fixture(autouse=True)
def reset_global():
    """每个测试前后重置全局单例"""
    reset_for_test()
    yield
    reset_for_test()


# ============================================================================
# 1. 常量与状态枚举
# ============================================================================

class TestConstants:
    """常量验证"""

    def test_task_states_has_14_states(self) -> None:
        """TASK_STATES 包含 14 个状态"""
        assert len(TASK_STATES) == 14

    def test_task_states_in_order(self) -> None:
        """TASK_STATES 顺序正确"""
        expected = (
            "intake", "plan", "approve_plan", "execute", "monitor",
            "review", "approve_result", "deliver", "complete",
            "cancel", "retry", "escalate", "handoff", "resume",
        )
        assert TASK_STATES == expected

    def test_terminal_states_contains_complete_cancel(self) -> None:
        """TERMINAL_STATES 包含 complete / cancel"""
        assert "complete" in TERMINAL_STATES
        assert "cancel" in TERMINAL_STATES
        assert len(TERMINAL_STATES) == 2

    def test_transition_table_covers_all_states(self) -> None:
        """TRANSITION_TABLE 覆盖所有 14 个状态"""
        for state in TASK_STATES:
            assert state in TRANSITION_TABLE, f"state '{state}' missing from TRANSITION_TABLE"

    def test_terminal_states_have_empty_transitions(self) -> None:
        """终态无转换规则"""
        assert TRANSITION_TABLE["complete"] == {}
        assert TRANSITION_TABLE["cancel"] == {}


# ============================================================================
# 2. create_task
# ============================================================================

class TestCreateTask:
    """create_task 方法"""

    def test_create_new_task(self, protocol: TaskProtocol) -> None:
        """创建新任务"""
        result = protocol.create_task("task-1")
        assert result["task_id"] == "task-1"
        assert result["state"] == "intake"
        assert len(result["history"]) == 1
        assert result["history"][0]["state"] == "intake"
        assert result["history"][0]["event"] == "create"

    def test_create_duplicate_raises(self, protocol: TaskProtocol) -> None:
        """重复创建抛 ValueError"""
        protocol.create_task("task-1")
        with pytest.raises(ValueError, match="task already exists"):
            protocol.create_task("task-1")

    def test_create_with_metadata(self, protocol: TaskProtocol) -> None:
        """带 metadata 创建"""
        result = protocol.create_task("task-1", metadata={"user": "alice"})
        assert result["history"][0]["metadata"]["user"] == "alice"


# ============================================================================
# 3. advance - 正常转换
# ============================================================================

class TestAdvanceNormal:
    """advance 方法正常转换"""

    def test_happy_path(self, protocol: TaskProtocol) -> None:
        """happy path: intake → ... → complete"""
        protocol.create_task("task-1")
        # intake → plan
        r = protocol.advance("task-1", "plan")
        assert r["ok"] is True
        assert r["state"] == "plan"
        assert r["previous_state"] == "intake"
        # plan → approve_plan
        r = protocol.advance("task-1", "approve")
        assert r["state"] == "approve_plan"
        # approve_plan → execute
        r = protocol.advance("task-1", "approve")
        assert r["state"] == "execute"
        # execute → monitor
        r = protocol.advance("task-1", "monitor")
        assert r["state"] == "monitor"
        # monitor → review
        r = protocol.advance("task-1", "review")
        assert r["state"] == "review"
        # review → approve_result
        r = protocol.advance("task-1", "approve")
        assert r["state"] == "approve_result"
        # approve_result → deliver
        r = protocol.advance("task-1", "approve")
        assert r["state"] == "deliver"
        # deliver → complete
        r = protocol.advance("task-1", "complete")
        assert r["state"] == "complete"

    def test_next_actions_correct(self, protocol: TaskProtocol) -> None:
        """next_actions 返回正确的可用事件"""
        protocol.create_task("task-1")
        # intake 的 next_actions: plan, cancel
        r = protocol.advance("task-1", "plan")
        # 此时已进入 plan，next_actions: approve, cancel, escalate
        assert set(r["next_actions"]) == {"approve", "cancel", "escalate"}

    def test_history_records_all_transitions(self, protocol: TaskProtocol) -> None:
        """history 记录所有转换"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")
        history = protocol.get_history("task-1")
        # create + 2 transitions = 3 entries
        assert len(history) == 3
        assert history[0]["event"] == "create"
        assert history[1]["event"] == "plan"
        assert history[2]["event"] == "approve"


# ============================================================================
# 4. advance - 异常处理
# ============================================================================

class TestAdvanceErrors:
    """advance 方法异常处理"""

    def test_nonexistent_task(self, protocol: TaskProtocol) -> None:
        """不存在的 task_id 返回 ok=False"""
        r = protocol.advance("nonexistent", "approve")
        assert r["ok"] is False
        assert "task not found" in r["error"]

    def test_terminal_state_no_transition(self, protocol: TaskProtocol) -> None:
        """终态不可转换"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "cancel")
        # cancel 是终态
        r = protocol.advance("task-1", "approve")
        assert r["ok"] is False
        assert "terminal state" in r["error"]

    def test_invalid_event_for_state(self, protocol: TaskProtocol) -> None:
        """非法事件返回 ok=False + next_actions"""
        protocol.create_task("task-1")
        # intake 只允许 plan / cancel，approve 是非法
        r = protocol.advance("task-1", "approve")
        assert r["ok"] is False
        assert "invalid transition" in r["error"]
        assert "plan" in r["next_actions"]
        assert "cancel" in r["next_actions"]

    def test_advance_with_metadata(self, protocol: TaskProtocol) -> None:
        """advance 带 metadata"""
        protocol.create_task("task-1")
        r = protocol.advance("task-1", "plan", metadata={"reason": "user confirmed"})
        assert r["ok"] is True
        history = protocol.get_history("task-1")
        assert history[-1]["metadata"]["reason"] == "user confirmed"


# ============================================================================
# 5. advance - retry / escalate / handoff / resume 路径
# ============================================================================

class TestRecoveryPaths:
    """retry / escalate / handoff / resume 恢复路径"""

    def test_retry_path_from_execute(self, protocol: TaskProtocol) -> None:
        """execute → error → retry → restart → plan"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")  # → approve_plan
        protocol.advance("task-1", "approve")  # → execute
        # execute → error → retry
        r = protocol.advance("task-1", "error")
        assert r["state"] == "retry"
        # retry → restart → plan
        r = protocol.advance("task-1", "restart")
        assert r["state"] == "plan"

    def test_escalate_path_from_plan(self, protocol: TaskProtocol) -> None:
        """plan → escalate → handoff → resume → restart → plan"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")  # → plan
        # plan → escalate
        r = protocol.advance("task-1", "escalate")
        assert r["state"] == "escalate"
        # escalate → handoff
        r = protocol.advance("task-1", "handoff")
        assert r["state"] == "handoff"
        # handoff → resume
        r = protocol.advance("task-1", "resume")
        assert r["state"] == "resume"
        # resume → restart → plan
        r = protocol.advance("task-1", "restart")
        assert r["state"] == "plan"

    def test_escalate_path_from_execute(self, protocol: TaskProtocol) -> None:
        """execute → escalate → handoff → resume → execute"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "approve")  # → execute
        # execute → escalate
        r = protocol.advance("task-1", "escalate")
        assert r["state"] == "escalate"
        # escalate → handoff → resume
        protocol.advance("task-1", "handoff")
        r = protocol.advance("task-1", "resume")
        assert r["state"] == "resume"
        # resume → execute（直接继续执行）
        r = protocol.advance("task-1", "execute")
        assert r["state"] == "execute"

    def test_retry_to_escalate(self, protocol: TaskProtocol) -> None:
        """retry → escalate → handoff"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "approve")  # → execute
        protocol.advance("task-1", "error")  # → retry
        # retry → escalate
        r = protocol.advance("task-1", "escalate")
        assert r["state"] == "escalate"

    def test_reject_plan_returns_to_plan(self, protocol: TaskProtocol) -> None:
        """approve_plan reject 回到 plan"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")  # → plan
        protocol.advance("task-1", "approve")  # → approve_plan
        r = protocol.advance("task-1", "reject")  # → plan
        assert r["state"] == "plan"

    def test_review_reject_returns_to_execute(self, protocol: TaskProtocol) -> None:
        """review reject 回到 execute"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")  # approve_plan
        protocol.advance("task-1", "approve")  # execute
        protocol.advance("task-1", "monitor")  # monitor
        protocol.advance("task-1", "review")  # review
        r = protocol.advance("task-1", "reject")
        assert r["state"] == "execute"

    def test_approve_result_reject_returns_to_execute(self, protocol: TaskProtocol) -> None:
        """approve_result reject 回到 execute"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "monitor")
        protocol.advance("task-1", "review")
        protocol.advance("task-1", "approve")  # → approve_result
        r = protocol.advance("task-1", "reject")
        assert r["state"] == "execute"


# ============================================================================
# 6. cancel 路径
# ============================================================================

class TestCancelPath:
    """cancel 路径测试"""

    def test_cancel_from_intake(self, protocol: TaskProtocol) -> None:
        """从 intake cancel"""
        protocol.create_task("task-1")
        r = protocol.advance("task-1", "cancel")
        assert r["ok"] is True
        assert r["state"] == "cancel"

    def test_cancel_from_plan(self, protocol: TaskProtocol) -> None:
        """从 plan cancel"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        r = protocol.advance("task-1", "cancel")
        assert r["state"] == "cancel"

    def test_cancel_from_execute(self, protocol: TaskProtocol) -> None:
        """从 execute cancel"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "approve")
        r = protocol.advance("task-1", "cancel")
        assert r["state"] == "cancel"

    def test_cancel_from_retry(self, protocol: TaskProtocol) -> None:
        """从 retry cancel"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "approve")
        protocol.advance("task-1", "error")  # → retry
        r = protocol.advance("task-1", "cancel")
        assert r["state"] == "cancel"

    def test_cancel_from_escalate(self, protocol: TaskProtocol) -> None:
        """从 escalate cancel"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "escalate")  # → escalate
        r = protocol.advance("task-1", "cancel")
        assert r["state"] == "cancel"


# ============================================================================
# 7. get_state / get_history / get_next_actions
# ============================================================================

class TestQueryMethods:
    """查询方法测试"""

    def test_get_state_existing(self, protocol: TaskProtocol) -> None:
        """get_state 已存在任务"""
        protocol.create_task("task-1")
        result = protocol.get_state("task-1")
        assert result["ok"] is True
        assert result["state"] == "intake"

    def test_get_state_nonexistent(self, protocol: TaskProtocol) -> None:
        """get_state 不存在任务"""
        result = protocol.get_state("nonexistent")
        assert result["ok"] is False
        assert "task not found" in result["error"]

    def test_get_history_existing(self, protocol: TaskProtocol) -> None:
        """get_history 已存在任务"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "plan")
        history = protocol.get_history("task-1")
        assert len(history) == 2

    def test_get_history_nonexistent(self, protocol: TaskProtocol) -> None:
        """get_history 不存在任务返回空列表"""
        history = protocol.get_history("nonexistent")
        assert history == []

    def test_get_next_actions_intake(self, protocol: TaskProtocol) -> None:
        """get_next_actions intake 状态"""
        protocol.create_task("task-1")
        actions = protocol.get_next_actions("task-1")
        assert "plan" in actions
        assert "cancel" in actions

    def test_get_next_actions_terminal(self, protocol: TaskProtocol) -> None:
        """get_next_actions 终态返回空"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "cancel")
        actions = protocol.get_next_actions("task-1")
        assert actions == []

    def test_get_next_actions_nonexistent(self, protocol: TaskProtocol) -> None:
        """get_next_actions 不存在任务返回空"""
        actions = protocol.get_next_actions("nonexistent")
        assert actions == []


# ============================================================================
# 8. list_tasks / delete_task
# ============================================================================

class TestListDeleteTasks:
    """list_tasks / delete_task 测试"""

    def test_list_tasks_empty(self, protocol: TaskProtocol) -> None:
        """list_tasks 空列表"""
        tasks = protocol.list_tasks()
        assert tasks == []

    def test_list_tasks_multiple(self, protocol: TaskProtocol) -> None:
        """list_tasks 多个任务"""
        protocol.create_task("task-1")
        protocol.create_task("task-2")
        protocol.create_task("task-3")
        tasks = protocol.list_tasks()
        assert len(tasks) == 3
        for t in tasks:
            assert "task_id" in t
            assert "state" in t
            assert "history_count" in t

    def test_delete_task_existing(self, protocol: TaskProtocol) -> None:
        """delete_task 已存在任务"""
        protocol.create_task("task-1")
        assert protocol.delete_task("task-1") is True
        # 再次删除返回 False
        assert protocol.delete_task("task-1") is False
        # 查询应返回 not found
        assert protocol.get_state("task-1")["ok"] is False

    def test_delete_task_nonexistent(self, protocol: TaskProtocol) -> None:
        """delete_task 不存在任务返回 False"""
        assert protocol.delete_task("nonexistent") is False


# ============================================================================
# 9. 全局单例
# ============================================================================

class TestGlobalProtocol:
    """全局单例测试"""

    def test_get_global_protocol_returns_singleton(self) -> None:
        """get_global_protocol 返回单例"""
        proto1 = get_global_protocol()
        proto2 = get_global_protocol()
        assert proto1 is proto2
        assert isinstance(proto1, TaskProtocol)

    def test_reset_for_test_clears_singleton(self) -> None:
        """reset_for_test 清空单例"""
        proto1 = get_global_protocol()
        reset_for_test()
        proto2 = get_global_protocol()
        assert proto1 is not proto2


# ============================================================================
# 10. 集成场景
# ============================================================================

class TestIntegration:
    """集成场景测试"""

    def test_full_lifecycle(self, protocol: TaskProtocol) -> None:
        """完整任务生命周期"""
        # 创建
        protocol.create_task("task-1", metadata={"title": "fix nginx"})
        # 完整 happy path
        protocol.advance("task-1", "plan")
        protocol.advance("task-1", "approve")  # approve_plan
        protocol.advance("task-1", "approve")  # execute
        protocol.advance("task-1", "monitor")
        protocol.advance("task-1", "review")
        protocol.advance("task-1", "approve")  # approve_result
        protocol.advance("task-1", "approve")  # deliver
        protocol.advance("task-1", "complete")
        # 验证状态
        assert protocol.get_state("task-1")["state"] == "complete"
        # 验证历史
        history = protocol.get_history("task-1")
        # create + 8 transitions = 9 entries
        assert len(history) == 9
        # 验证终态不可转换
        r = protocol.advance("task-1", "restart")
        assert r["ok"] is False

    def test_multiple_tasks_isolated(self, protocol: TaskProtocol) -> None:
        """多任务状态隔离"""
        protocol.create_task("task-1")
        protocol.create_task("task-2")
        # task-1 推进到 plan
        protocol.advance("task-1", "plan")
        # task-2 仍在 intake
        assert protocol.get_state("task-1")["state"] == "plan"
        assert protocol.get_state("task-2")["state"] == "intake"

    def test_cancel_then_no_more_transitions(self, protocol: TaskProtocol) -> None:
        """cancel 后无法继续转换"""
        protocol.create_task("task-1")
        protocol.advance("task-1", "cancel")
        # 尝试各种事件都应失败
        for event in ["plan", "approve", "restart", "escalate"]:
            r = protocol.advance("task-1", event)
            assert r["ok"] is False
            assert "terminal state" in r["error"]
