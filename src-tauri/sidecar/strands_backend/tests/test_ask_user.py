from __future__ import annotations

import threading
import time

from needs_you import get_global_service
from strands_backend.tools import ToolContext
from strands_backend.tools.ask_user import invoke_ask_user_tool


def _ctx() -> ToolContext:
    return ToolContext(agent_name="main", session_id="chat-1")


def test_ask_user_blocks_until_question_is_answered() -> None:
    service = get_global_service()
    service.reset()

    def respond() -> None:
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            pending = service.list_pending()
            if pending:
                service.respond(pending[0]["id"], {"answer": "桥接模式"})
                return
            time.sleep(0.01)
        raise AssertionError("question request was not created")

    worker = threading.Thread(target=respond, daemon=True)
    worker.start()
    result = invoke_ask_user_tool(
        {"question": "选择执行方式", "options": ["桥接模式", "NAT"]},
        _ctx(),
    )
    worker.join(timeout=2)

    assert result == {"status": "success", "answer": "桥接模式"}


def test_ask_user_rejects_more_than_four_options() -> None:
    try:
        invoke_ask_user_tool(
            {"question": "选择", "options": ["1", "2", "3", "4", "5"]},
            _ctx(),
        )
    except ValueError as error:
        assert "最多 4 项" in str(error)
    else:
        raise AssertionError("expected ValueError")
