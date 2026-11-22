from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_timeout_state(tmp_path, monkeypatch):
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_IDLE_SECS", "0.08")
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_POLL_SECS", "0.01")
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()


class _Handler:
    def __init__(self) -> None:
        self._stats = {"events_received": 0}

    def begin_turn(self, **_kwargs: object) -> None:
        pass


class _BlockedAgent:
    def __init__(self, release: threading.Event, hook) -> None:
        self.callback_handler = _Handler()
        self.messages: list = []
        self.release = release
        self.hook = hook
        self.late_tool_cancelled = threading.Event()
        self.tool_executions = 0

    def __call__(self, _prompt: str) -> str:
        self.release.wait(timeout=3)
        event = SimpleNamespace(
            tool_use={"name": "ssh_command", "input": {"command": "printf late"}},
            cancel_tool=False,
            exception=None,
        )
        self.hook._before_tool_call(event)
        if not event.cancel_tool:
            self.tool_executions += 1
        self.late_tool_cancelled.set()
        return "late model response"


class _ReturningAgent:
    def __init__(self, hook) -> None:
        self.callback_handler = _Handler()
        self.messages: list = []
        self.hook = hook
        self.tool_executions = 0

    def __call__(self, _prompt: str) -> str:
        event = SimpleNamespace(
            tool_use={"name": "read_file", "input": {"path": "README.md"}},
            cancel_tool=False,
            exception=None,
        )
        self.hook._before_tool_call(event)
        if not event.cancel_tool:
            self.tool_executions += 1
        return "next turn completed"


def _adapter():
    from strands_backend.adapter import StrandsAgentAdapter

    return StrandsAgentAdapter(
        event_bus=MagicMock(),
        backend_enabled=True,
        strands_model=MagicMock(),
    )


def test_watchdog_retires_stalled_turn_and_keeps_late_tools_cancelled():
    from needs_you import NeedsYouStatus, get_global_service
    from strands_backend.adapter import ToolCallLimitHook

    session_id = "timeout-session"
    adapter = _adapter()
    hook = ToolCallLimitHook(agent_name="main", event_bus=MagicMock(), session_id=session_id)
    adapter._limit_hooks[("main", session_id)] = hook
    other_session = "other-session"
    other_hook = ToolCallLimitHook(agent_name="main", event_bus=MagicMock(), session_id=other_session)
    adapter._limit_hooks[("main", other_session)] = other_hook
    service = get_global_service()
    request = service.request_approval(
        title="Confirm command",
        description="A command awaits approval",
        session_id=session_id,
    )
    other_question = service.request_question(
        title="Question for another session",
        description="Should remain pending",
        session_id=other_session,
    )
    same_question = service.request_question(
        title="Question in timed-out session",
        description="Must be settled on timeout",
        session_id=session_id,
    )
    waiter_result = {}

    def wait_for_approval() -> None:
        response = service.wait_for_response(request.id, timeout=3)
        waiter_result["status"] = response.status if response else None

    waiter = threading.Thread(target=wait_for_approval, daemon=True)
    release = threading.Event()
    blocked_agent = _BlockedAgent(release, hook)
    adapter._get_or_create_agent = lambda *_args, **_kwargs: blocked_agent
    try:
        waiter.start()
        deadline = time.monotonic() + 1
        while request.id not in {row["id"] for row in service.list_pending(session_id=session_id)}:
            assert time.monotonic() < deadline, "approval did not become pending"
            threading.Event().wait(0.01)

        result = adapter.invoke("main", "continue", {"session_id": session_id})

        assert result.get("degraded_reason") == "invoke_watchdog_timeout"
        assert hook.cancelled is True
        assert hook.cancel_reason == "AI 调用无活动超时"
        assert other_hook.cancelled is False
        assert other_question.is_pending
        waiter.join(timeout=1)
        assert not waiter.is_alive(), "timeout did not settle the pending approval"
        assert waiter_result["status"] == NeedsYouStatus.CANCELLED
        assert same_question.status == NeedsYouStatus.CANCELLED
        assert session_id in adapter._cancel_notes
        assert adapter._cancel_notes[session_id]["reason"] == "AI 调用无活动超时"

        release.set()
        assert blocked_agent.late_tool_cancelled.wait(timeout=2)
        assert blocked_agent.tool_executions == 0
        assert hook.cancelled is True
        deadline = time.monotonic() + 2
        while ("main", session_id) in adapter._stalled_sessions:
            assert time.monotonic() < deadline, "released worker did not clear stalled state"
            threading.Event().wait(0.01)

        next_agent = _ReturningAgent(hook)
        adapter._get_or_create_agent = lambda *_args, **_kwargs: next_agent
        next_result = adapter.invoke("main", "new turn", {"session_id": session_id})
        assert next_result.get("observation") == "next turn completed"
        assert hook.cancelled is False
        assert next_agent.tool_executions == 1
    finally:
        release.set()
        service.cancel(request.id, "test cleanup")
        service.cancel(same_question.id, "test cleanup")
        service.cancel(other_question.id, "test cleanup")
        waiter.join(timeout=1)
        blocked_agent.late_tool_cancelled.wait(timeout=2)
        deadline = time.monotonic() + 2
        while ("main", session_id) in adapter._stalled_sessions and time.monotonic() < deadline:
            threading.Event().wait(0.01)
