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
