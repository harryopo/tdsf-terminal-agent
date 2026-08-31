"""todo_write 工具 — Sidecar 路径任务规划（驱动前端 TodoStrip UI）

TDSF 魔改 (2026-08-09): 让 Python Sidecar 路径也能驱动前端 TodoStrip。
前端 Vercel SDK 路径有完整的 todo_write → TodoStore → TodoStrip 链路，
但 Sidecar 路径不经过 buildTools，TodoStrip 收不到更新。

方案：创建 Python todo_write 工具，通过 rust_bridge.send_notification
发 update_todos 事件 → Rust 转发 sidecar:update_todos → 前端监听更新 TodoStore。

T3 规划-执行回环 (2026-08-31, spec add-agent-loop-closure):
- per-session todo 状态镜像（_session_todos）：todo_write 是全量替换式更新，
  镜像最新列表供 adapter.invoke 收尾校验（_maybe_todo_followup）查询
  "当前会话是否有未完成项"——不查前端 store（sidecar 无法直接读前端状态）。
- completedAt 时间戳：status=completed 的项写入完成时间（ISO 8601 本地时区）。
  todo_write 是全量替换且 LLM 不维护 completedAt，采用"合并旧值"策略：
  新列表项与旧列表（同 session）按 id（无 id 按 title）匹配，旧项同为
  completed → 复用旧 completedAt（刷新列表不重置完成时间）；否则 now()。

工具签名（Strands 从 docstring + 类型标注自动生成工具描述）：
    todo_write(todos) -> dict

数据结构与前端 todos.ts Todo 类型对齐：
    Todo = { id: str, title: str, description: str,
             status: "pending"|"in_progress"|"completed", completedAt?: str|null }
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.todo_write")

# ============================================================================
# T3: per-session todo 状态镜像（adapter 收尾校验数据源）
# ============================================================================

# session_id -> 最新 todo 列表（normalized dict，含 completedAt）
_session_todos: dict[str, list[dict[str, Any]]] = {}
_todos_lock = threading.Lock()

# 未完成状态集合（T3 收尾校验判定口径）
UNFINISHED_STATUSES = ("pending", "in_progress")


def get_session_todos(session_id: str) -> list[dict[str, Any]]:
    """读取指定会话的当前 todo 列表（T3 收尾校验数据源）

    返回内部列表的浅拷贝（调用方修改不影响镜像）。
    """
    with _todos_lock:
        return list(_session_todos.get(session_id, []))


def get_unfinished_todos(session_id: str) -> list[dict[str, Any]]:
    """读取指定会话的未完成 todo（pending/in_progress）"""
    return [
        t for t in get_session_todos(session_id)
        if t.get("status") in UNFINISHED_STATUSES
    ]


def reset_session_todos(session_id: str | None = None) -> None:
    """清空 todo 镜像（测试隔离用；session_id 为 None 时全清）"""
    with _todos_lock:
        if session_id is None:
            _session_todos.clear()
        else:
            _session_todos.pop(session_id, None)


def _merge_completed_at(
    todos: list[dict[str, Any]],
    previous: list[dict[str, Any]],
) -> None:
    """为 completed 项填 completedAt（原地），复用旧列表的完成时间

    匹配规则（LLM 全量重写列表时 id/title 语义稳定）：
    - 有 id：按 id 匹配旧项
    - 无 id：按 title 匹配旧项
    旧项同为 completed 且带 completedAt → 复用；否则取当前时间。
    """
    import time

    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    prev_by_id = {t.get("id"): t for t in previous if t.get("id")}
    prev_by_title = {t.get("title"): t for t in previous}
    for t in todos:
        if t.get("status") != "completed":
            continue
        old = prev_by_id.get(t.get("id")) or prev_by_title.get(t.get("title"))
        t["completedAt"] = (
            old.get("completedAt") if old and old.get("completedAt") else now
        )



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

    # T3: 旧列表快照（completedAt 合并基准）——在归一化前取
    session_id = ctx.session_id or ""
    previous = get_session_todos(session_id) if session_id else []

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

    # T3: completed 项填 completedAt（合并旧值——全量替换不重置完成时间）
    _merge_completed_at(normalized, previous)

    # 校验：至多一项 in_progress
    if in_progress_count > 1:
        return {"ok": False, "error": "at most one todo can be in_progress"}

    # T3: per-session 镜像（adapter 收尾校验数据源；校验通过才落）
    if session_id:
        with _todos_lock:
            _session_todos[session_id] = list(normalized)

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
                （completedAt 完成时间由系统自动维护，无需传入）

        Returns:
            dict: {ok: bool, count: int, in_progress: str|null}
        """
        return invoke_todo_write_tool(
            params={"todos": todos},
            ctx=ctx,
        )

    todo_write.__name__ = "todo_write"
    return todo_write
