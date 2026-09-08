from __future__ import annotations

from pathlib import Path
import sys
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from strands_backend.tools.todo_write import (  # noqa: E402
    get_session_todos,
    invoke_todo_write_tool,
    reset_session_todos,
)


def test_empty_list_is_rejected_without_erasing_session_mirror() -> None:
    reset_session_todos()
    ctx = MagicMock(session_id="todo-contract", rust_bridge=None, event_bus=None)
    invoke_todo_write_tool(
        {"todos": [{"id": "keep", "title": "保留任务", "status": "pending"}]},
        ctx,
    )

    result = invoke_todo_write_tool({"todos": []}, ctx)

    assert result["ok"] is False
    assert [todo["id"] for todo in get_session_todos("todo-contract")] == ["keep"]


def test_events_are_paired_with_one_tool_call_id() -> None:
    reset_session_todos()
    bus = MagicMock()
    ctx = MagicMock(
        session_id="todo-events",
        agent_name="main",
        rust_bridge=None,
        event_bus=bus,
    )

    result = invoke_todo_write_tool(
        {"todos": [{"id": "one", "title": "检查服务", "status": "in_progress"}]},
        ctx,
    )

    assert result["ok"] is True
    assert bus.emit_tool_call.call_count == 2
    started = bus.emit_tool_call.call_args_list[0].kwargs
    completed = bus.emit_tool_call.call_args_list[1].kwargs
    assert started["status"] == "started"
    assert completed["status"] == "completed"
    assert started["tool_call_id"] == completed["tool_call_id"]


def test_validation_error_closes_started_event() -> None:
    bus = MagicMock()
    ctx = MagicMock(
        session_id="todo-error",
        agent_name="main",
        rust_bridge=None,
        event_bus=bus,
    )

    result = invoke_todo_write_tool({"todos": []}, ctx)

    assert result["ok"] is False
    assert [call.kwargs["status"] for call in bus.emit_tool_call.call_args_list] == [
        "started",
        "error",
    ]
    ids = [call.kwargs["tool_call_id"] for call in bus.emit_tool_call.call_args_list]
    assert ids[0] == ids[1]
