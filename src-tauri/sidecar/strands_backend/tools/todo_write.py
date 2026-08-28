"""todo_write 工具 — Sidecar 路径任务规划（驱动前端 TodoStrip UI）

TDSF 魔改 (2026-08-09): 让 Python Sidecar 路径也能驱动前端 TodoStrip。
前端 Vercel SDK 路径有完整的 todo_write → TodoStore → TodoStrip 链路，
但 Sidecar 路径不经过 buildTools，TodoStrip 收不到更新。

方案：创建 Python todo_write 工具，通过 rust_bridge.send_notification
发 update_todos 事件 → Rust 转发 sidecar:update_todos → 前端监听更新 TodoStore。

工具签名（Strands 从 docstring + 类型标注自动生成工具描述）：
    todo_write(todos) -> dict

数据结构与前端 todos.ts Todo 类型对齐：
    Todo = { id: str, title: str, description: str, status: "pending"|"in_progress"|"completed" }
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.todo_write")


def invoke_todo_write_tool(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """todo_write 工具核心实现

    Args:
        params: 工具参数 dict
            - todos (list[dict], 必填): 完整任务列表（非增量）
                每项: {id?, title, description?, status}
        ctx: ToolContext

    Returns:
        dict: {ok: bool, count: int, in_progress: str|null}
    """
    todos_raw = params.get("todos", [])
    if not isinstance(todos_raw, list):
        return {"ok": False, "error": "todos must be a list"}

    # 规范化 + 校验
    import time
    import random

    valid_statuses = {"pending", "in_progress", "completed"}
    normalized: list[dict[str, Any]] = []
    in_progress_count = 0

    for item in todos_raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title", "")).strip()
        if not title:
            continue
        status = str(item.get("status", "pending")).strip()
        if status not in valid_statuses:
            status = "pending"
        if status == "in_progress":
            in_progress_count += 1
        normalized.append({
            "id": str(item.get("id", f"t-{int(time.time()*1000):x}-{random.randint(0,9999):x}")),
            "title": title,
            "description": str(item.get("description", "")) or None,
            "status": status,
        })

    # 校验：至多一项 in_progress
    if in_progress_count > 1:
        return {"ok": False, "error": "at most one todo can be in_progress"}

    # 通过 rust_bridge 发 notification 给前端
    if ctx.rust_bridge is not None:
        try:
            ctx.rust_bridge.send_notification("update_todos", {
                "sessionId": ctx.session_id or "",
                "todos": normalized,
            })
        except Exception as e:
            # 通知失败 = 前端 TodoStrip 不更新，必须可见（warning 而非 debug）
            logger.warning(f"update_todos notification failed: {e}")

    # 推送 tool_call 事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="todo_write",
                params={"count": len(normalized)},
                result={"ok": True, "count": len(normalized)},
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.todo_write",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call todo_write failed: {e}")

    in_progress_title = next(
        (t["title"] for t in normalized if t["status"] == "in_progress"),
        None,
    )

    return {
        "ok": True,
        "count": len(normalized),
        "in_progress": in_progress_title,
    }


def make_todo_write_tool(ctx: ToolContext):
    """构建 todo_write 工具（带 ctx 闭包）"""

    @tool
    def todo_write(
        todos: list[dict[str, Any]],
    ) -> dict:
        """更新当前任务列表。用于多步骤任务规划。

        替换之前的完整列表——始终传完整列表，不是增量。
        工作时将恰好一项标记为 in_progress；完成后改为 completed 并将下一项改为 in_progress。
        自动执行（无需审批）。

        Args:
            todos (list): 完整任务列表。每项含：
                - title (str, 必填): 任务标题
                - status (str): "pending" | "in_progress" | "completed"
                - description (str, 可选): 任务描述
                - id (str, 可选): 稳定 id（复用以保持 UI 稳定）

        Returns:
            dict: {ok: bool, count: int, in_progress: str|null}
        """
        return invoke_todo_write_tool(
            params={"todos": todos},
            ctx=ctx,
        )

    todo_write.__name__ = "todo_write"
    return todo_write
