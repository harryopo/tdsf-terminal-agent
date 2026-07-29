"""
task_protocol.py — 14 步 TaskProtocol 状态机（T-P4-11）
=========================================================

实现 14 步任务状态机：
- 14 个状态：intake, plan, approve_plan, execute, monitor, review,
              approve_result, deliver, complete, cancel, retry,
              escalate, handoff, resume
- 状态转换规则（事件驱动）
- 非法转换被拒绝（抛出 ValueError 或返回 ok=False）
- 任务历史记录

状态机示意图：
    intake → plan → approve_plan → execute → monitor → review → approve_result
                                                                                     ↓
                                          complete ← deliver ← approve_result
                                                                                     ↓
                                                                                  cancel
              ↑                                                          ↓
              └──────── retry (从 plan/execute 重新进入) ────────────────┘
                                                          ↓
                                                      escalate
                                                          ↓
                                                       handoff
                                                          ↓
                                                        resume

使用方式：
    from task_protocol import TaskProtocol

    proto = TaskProtocol()
    result = proto.advance("task-1", "approve")  # intake → plan
    print(result)
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger("sidecar.task_protocol")


# ============================================================================
# 14 步状态枚举
# ============================================================================

# 14 个状态（按顺序）
TASK_STATES: tuple[str, ...] = (
    "intake",           # 1. 任务接收
    "plan",             # 2. 任务规划
    "approve_plan",     # 3. 计划审批
    "execute",          # 4. 执行任务
    "monitor",          # 5. 执行监控
    "review",           # 6. 结果审查
    "approve_result",   # 7. 结果审批
    "deliver",          # 8. 交付
    "complete",         # 9. 完成
    "cancel",           # 10. 取消
    "retry",            # 11. 重试
    "escalate",         # 12. 升级
    "handoff",          # 13. 移交
    "resume",           # 14. 恢复
)

# 终态（不可再转换）
TERMINAL_STATES: frozenset[str] = frozenset({"complete", "cancel"})

# 事件 → 状态转换表
# 格式：{current_state: {event: next_state}}
TRANSITION_TABLE: dict[str, dict[str, str]] = {
    "intake": {
        "plan": "plan",
        "cancel": "cancel",
    },
    "plan": {
        "approve": "approve_plan",
        "cancel": "cancel",
        "escalate": "escalate",
    },
    "approve_plan": {
        "approve": "execute",
        "reject": "plan",
        "cancel": "cancel",
    },
    "execute": {
        "monitor": "monitor",
        "review": "review",
        "error": "retry",
        "cancel": "cancel",
        "escalate": "escalate",
    },
    "monitor": {
        "review": "review",
        "error": "retry",
        "cancel": "cancel",
    },
    "review": {
        "approve": "approve_result",
        "reject": "execute",
        "escalate": "escalate",
    },
    "approve_result": {
        "approve": "deliver",
        "reject": "execute",
        "cancel": "cancel",
    },
    "deliver": {
        "complete": "complete",
        "cancel": "cancel",
    },
    "complete": {},  # 终态
    "cancel": {},    # 终态
    "retry": {
        "restart": "plan",
        "cancel": "cancel",
        "escalate": "escalate",
    },
    "escalate": {
        "handoff": "handoff",
        "cancel": "cancel",
    },
    "handoff": {
        "resume": "resume",
        "cancel": "cancel",
    },
    "resume": {
        "restart": "plan",
        "execute": "execute",
        "cancel": "cancel",
    },
}


# ============================================================================
# TaskProtocol — 14 步任务状态机
# ============================================================================

class TaskProtocol:
    """14 步任务状态机

    管理任务状态转换，记录历史。
    """

    def __init__(self) -> None:
        # task_id → 当前状态
        self._task_states: dict[str, str] = {}
        # task_id → 转换历史
        self._task_history: dict[str, list[dict[str, Any]]] = {}

    def create_task(self, task_id: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        """创建新任务（初始状态 = intake）

        Args:
            task_id: 任务 ID
            metadata: 任务元数据（可选）

        Returns:
            创建结果 dict

        Raises:
            ValueError: 任务已存在
        """
        if task_id in self._task_states:
            raise ValueError(f"task already exists: {task_id}")

        self._task_states[task_id] = "intake"
        self._task_history[task_id] = [{
            "state": "intake",
            "event": "create",
            "timestamp": time.time(),
            "metadata": metadata or {},
        }]

        logger.info(f"task_protocol.create: {task_id} → intake")
        return {
            "task_id": task_id,
            "state": "intake",
            "history": self._task_history[task_id],
        }

    def advance(
        self,
        task_id: str,
        event: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """推进任务状态

        Args:
            task_id: 任务 ID
            event: 触发事件（如 "approve" / "reject" / "cancel"）
            metadata: 附加元数据（可选）

        Returns:
            {
                "task_id": str,
                "state": str,           # 新状态
                "previous_state": str,  # 原状态
                "event": str,
                "next_actions": list[str],  # 可用的下一步事件
                "ok": bool,
                "error": str (optional),
            }
        """
        if task_id not in self._task_states:
            return {
                "task_id": task_id,
                "state": "",
                "previous_state": "",
                "event": event,
                "next_actions": [],
                "ok": False,
                "error": f"task not found: {task_id}",
            }

        current_state = self._task_states[task_id]

        # 终态不可再转换
        if current_state in TERMINAL_STATES:
            return {
                "task_id": task_id,
                "state": current_state,
                "previous_state": current_state,
                "event": event,
                "next_actions": [],
                "ok": False,
                "error": f"task is in terminal state: {current_state}",
            }

        # 查找转换规则
        transitions = TRANSITION_TABLE.get(current_state, {})
        if event not in transitions:
            return {
                "task_id": task_id,
                "state": current_state,
                "previous_state": current_state,
                "event": event,
                "next_actions": list(transitions.keys()),
                "ok": False,
                "error": (
                    f"invalid transition: state='{current_state}', "
                    f"event='{event}', allowed={list(transitions.keys())}"
                ),
            }

        next_state = transitions[event]
        self._task_states[task_id] = next_state

        # 记录历史
        self._task_history[task_id].append({
            "state": next_state,
            "previous_state": current_state,
            "event": event,
            "timestamp": time.time(),
            "metadata": metadata or {},
        })

        # 计算下一步可用事件
        next_transitions = TRANSITION_TABLE.get(next_state, {})
        next_actions = list(next_transitions.keys())

        logger.info(
            f"task_protocol.advance: {task_id} "
            f"{current_state} --{event}--> {next_state}"
        )

        return {
            "task_id": task_id,
            "state": next_state,
            "previous_state": current_state,
            "event": event,
            "next_actions": next_actions,
            "ok": True,
        }

    def get_state(self, task_id: str) -> dict[str, Any]:
        """获取任务当前状态"""
        if task_id not in self._task_states:
            return {
                "task_id": task_id,
                "state": "",
                "ok": False,
                "error": f"task not found: {task_id}",
            }
        return {
            "task_id": task_id,
            "state": self._task_states[task_id],
            "ok": True,
        }

    def get_history(self, task_id: str) -> list[dict[str, Any]]:
        """获取任务转换历史"""
        return self._task_history.get(task_id, [])

    def get_next_actions(self, task_id: str) -> list[str]:
        """获取任务可用的下一步事件"""
        if task_id not in self._task_states:
            return []
        current_state = self._task_states[task_id]
        transitions = TRANSITION_TABLE.get(current_state, {})
        return list(transitions.keys())

    def list_tasks(self) -> list[dict[str, Any]]:
        """列出所有任务"""
        return [
            {
                "task_id": tid,
                "state": state,
                "history_count": len(self._task_history.get(tid, [])),
            }
            for tid, state in self._task_states.items()
        ]

    def delete_task(self, task_id: str) -> bool:
        """删除任务"""
        if task_id not in self._task_states:
            return False
        del self._task_states[task_id]
        self._task_history.pop(task_id, None)
        return True


# ============================================================================
# 模块级单例
# ============================================================================

_global_protocol: TaskProtocol | None = None


def get_global_protocol() -> TaskProtocol:
    """获取全局 TaskProtocol 实例（懒加载）"""
    global _global_protocol
    if _global_protocol is None:
        _global_protocol = TaskProtocol()
    return _global_protocol


def reset_for_test() -> None:
    """重置全局状态（测试用）"""
    global _global_protocol
    _global_protocol = None
