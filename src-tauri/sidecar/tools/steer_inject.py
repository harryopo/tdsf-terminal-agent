"""
tools/steer_inject.py — SteerInject MCP tool（T-P4-06）
=========================================================

实现运行时向 Agent 注入指令：
- 向运行中的 Agent 推送 steer 指令（不中断当前执行）
- 通过 event_bus 推送 steer.inject 事件，由 Agent 在下次迭代时读取
- 支持 mock 模式（无需真实 event_bus，仅返回 ok=True）

输入格式（params）：
    {
        "agent_name": "coding",       # 目标 Agent 名
        "instruction": "use type hints",  # 注入的指令
        "session_id": "sess-xxx",     # 会话 ID
        "priority": "high"            # 可选：low/normal/high，默认 normal
    }

输出格式：
    {
        "ok": True,
        "agent_name": "coding",
        "instruction": "use type hints",
        "session_id": "sess-xxx",
        "queued": True,
        "timestamp": 1234567890.123
    }
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger("sidecar.tools.steer_inject")


# ============================================================================
# 模块级单例：注入队列（按 agent_name + session_id 索引）
# ============================================================================

# 队列结构：{(agent_name, session_id): [instruction1, instruction2, ...]}
_inject_queue: dict[tuple[str, str], list[dict[str, Any]]] = {}


def invoke_steer_inject_tool(params: dict[str, Any]) -> dict[str, Any]:
    """SteerInject MCP tool 入口

    Args:
        params: 工具参数，包含：
            - agent_name (str, 必填): 目标 Agent 名
            - instruction (str, 必填): 注入的指令
            - session_id (str, 可选): 会话 ID，默认 ""
            - priority (str, 可选): 优先级 low/normal/high，默认 normal

    Returns:
        注入结果字典

    Raises:
        ValueError: 参数校验失败
    """
    # === 参数校验 ===
    agent_name = params.get("agent_name", "")
    if not isinstance(agent_name, str):
        raise ValueError(
            f"agent_name must be str, got {type(agent_name).__name__}"
        )
    if not agent_name:
        raise ValueError("agent_name must not be empty")

    instruction = params.get("instruction", "")
    if not isinstance(instruction, str):
        raise ValueError(
            f"instruction must be str, got {type(instruction).__name__}"
        )
    if not instruction:
        raise ValueError("instruction must not be empty")

    session_id = params.get("session_id", "")
    if not isinstance(session_id, str):
        raise ValueError(
            f"session_id must be str, got {type(session_id).__name__}"
        )

    priority = params.get("priority", "normal")
    valid_priorities = ("low", "normal", "high")
    if priority not in valid_priorities:
        raise ValueError(
            f"priority must be one of {valid_priorities}, got '{priority}'"
        )

    # === 入队 ===
    timestamp = time.time()
    queue_key = (agent_name, session_id)
    queue_item = {
        "instruction": instruction,
        "priority": priority,
        "timestamp": timestamp,
    }
    if queue_key not in _inject_queue:
        _inject_queue[queue_key] = []
    _inject_queue[queue_key].append(queue_item)

    logger.info(
        f"steer_inject: agent={agent_name}, session={session_id}, "
        f"priority={priority}, instruction_len={len(instruction)}"
    )

    # === 推送事件（如果 event_bus 可用）===
    _emit_steer_event(agent_name, instruction, session_id, priority)

    return {
        "ok": True,
        "agent_name": agent_name,
        "instruction": instruction,
        "session_id": session_id,
        "priority": priority,
        "queued": True,
        "queue_size": len(_inject_queue[queue_key]),
        "timestamp": timestamp,
    }


def get_pending_instructions(
    agent_name: str,
    session_id: str = "",
) -> list[dict[str, Any]]:
    """获取指定 Agent 待处理的注入指令（Agent 在下次迭代时调用）

    Args:
        agent_name: Agent 名
        session_id: 会话 ID

    Returns:
        待处理指令列表（按入队顺序），同时清空队列
    """
    queue_key = (agent_name, session_id)
    if queue_key not in _inject_queue:
        return []
    items = _inject_queue.pop(queue_key)
    # 按优先级排序：high > normal > low
    priority_order = {"high": 0, "normal": 1, "low": 2}
    items.sort(key=lambda x: priority_order.get(x.get("priority", "normal"), 1))
    return items


def clear_queue(agent_name: str | None = None, session_id: str | None = None) -> int:
    """清空注入队列（测试用）

    Args:
        agent_name: 指定 Agent 名（None 表示所有）
        session_id: 指定会话 ID（None 表示所有）

    Returns:
        清空的队列项数量
    """
    global _inject_queue
    if agent_name is None and session_id is None:
        count = sum(len(v) for v in _inject_queue.values())
        _inject_queue = {}
        return count

    keys_to_remove = [
        k for k in _inject_queue
        if (agent_name is None or k[0] == agent_name)
        and (session_id is None or k[1] == session_id)
    ]
    count = sum(len(_inject_queue[k]) for k in keys_to_remove)
    for k in keys_to_remove:
        del _inject_queue[k]
    return count


def _emit_steer_event(
    agent_name: str,
    instruction: str,
    session_id: str,
    priority: str,
) -> None:
    """推送 steer.inject 事件到 event_bus（可选）

    Args:
        agent_name: Agent 名
        instruction: 注入指令
        session_id: 会话 ID
        priority: 优先级
    """
    try:
        # 延迟导入，避免循环依赖
        from event_bus import EventBus, Event, EventType

        # 尝试获取全局 event_bus 实例
        bus = _get_global_event_bus()
        if bus is None:
            return

        event = Event(
            event_type="steer.inject",
            payload={
                "agent_name": agent_name,
                "instruction": instruction,
                "priority": priority,
            },
            session_id=session_id or None,
            source="steer_inject_tool",
        )
        bus.publish(event)
        logger.debug(
            f"steer event emitted: agent={agent_name}, priority={priority}"
        )
    except Exception as e:
        logger.debug(f"emit steer event failed (degraded): {e}")


def _get_global_event_bus() -> Any:
    """获取全局 event_bus 实例（从 main 模块）"""
    try:
        # 通过 main.py 模块级变量获取（main.py 启动时设置）
        import main as _main
        return getattr(_main, "_global_event_bus", None)
    except Exception:
        return None


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return {
        "name": "steer_inject",
        "description": (
            "运行时向 Agent 注入指令：通过 event_bus 推送 steer.inject 事件，"
            "由 Agent 在下次迭代时读取。支持优先级 low/normal/high。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "agent_name": {
                    "type": "string",
                    "description": "目标 Agent 名（main/coding/explore/...）",
                },
                "instruction": {
                    "type": "string",
                    "description": "注入的指令内容",
                },
                "session_id": {
                    "type": "string",
                    "description": "会话 ID（可选）",
                },
                "priority": {
                    "type": "string",
                    "enum": ["low", "normal", "high"],
                    "default": "normal",
                },
            },
            "required": ["agent_name", "instruction"],
        },
        "output_schema": {
            "type": "object",
            "properties": {
                "ok": {"type": "boolean"},
                "agent_name": {"type": "string"},
                "instruction": {"type": "string"},
                "queued": {"type": "boolean"},
                "timestamp": {"type": "number"},
            },
        },
    }
