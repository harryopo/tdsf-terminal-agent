from __future__ import annotations

import json
import threading
import time
from contextvars import copy_context
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_needs_you(tmp_path, monkeypatch):
    from needs_you import reset_for_test
    from fix_loop import reset_for_test as reset_fix_loop
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_IDLE_SECS", "0.12")
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_POLL_SECS", "0.01")
    reset_agent_log()
    reset_fix_loop()
    reset_for_test()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_for_test()


class _Handler:
    def __init__(self) -> None:
        self._stats = {"events_received": 0}

    def begin_turn(self, **_kwargs) -> None:
        pass


def _ask_user_via_sdk(session_id: str) -> dict:
    from strands._async import run_async
    from strands_backend.tools import ToolContext
    from strands_backend.tools.ask_user import make_ask_user_tool

    ask_user = make_ask_user_tool(ToolContext(agent_name="main", session_id=session_id))
    assert set(ask_user.tool_spec["inputSchema"]["json"]["properties"]) == {"question", "options"}

    async def run_tool():
        events = [event async for event in ask_user.stream(
            {"toolUseId": "sdk-ask", "name": "ask_user", "input": {"question": "Which option?"}},
            {},
        )]
        return json.loads(events[-1].tool_result["content"][0]["text"])

    return run_async(run_tool)


class _AskUserAgent:
    """Fake only the model boundary; the tool and NeedsYou service are real."""

    def __init__(self, session_id: str, after_response: float = 0) -> None:
        self.callback_handler = _Handler()
        self.messages: list = []
        self.session_id = session_id
        self.after_response = after_response
        self.finished = threading.Event()

    def __call__(self, _prompt: str) -> str:
        try:
            result = _ask_user_via_sdk(self.session_id)
            assert result["status"] == "success"
            if self.after_response:
                time.sleep(self.after_response)
            return result["answer"]
        finally:
            self.finished.set()


class _CancelThenHangAgent(_AskUserAgent):
    def __init__(self, session_id: str) -> None:
        super().__init__(session_id)
        self.tool_returned = threading.Event()
        self.release = threading.Event()

    def __call__(self, _prompt: str) -> str:
        try:
            result = _ask_user_via_sdk(self.session_id)
            self.tool_returned.set()
            self.release.wait(timeout=3)
            return result["status"]
        finally:
            self.finished.set()


class _HangingAgent:
    def __init__(self, release: threading.Event) -> None:
        self.callback_handler = _Handler()
        self.messages: list = []
        self.release = release
        self.finished = threading.Event()

    def __call__(self, _prompt: str) -> str:
        try:
            self.release.wait(timeout=3)
            return "late"
        finally:
            self.finished.set()


def _wait_until(predicate, timeout: float = 1) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_real_ask_user_wait_is_not_counted_as_model_idle():
    from needs_you import get_global_service
    from strands_backend.adapter import StrandsAgentAdapter

    session_id = "human-wait-session"
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    agent = _AskUserAgent(session_id, after_response=0.07)
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    result_box: dict = {}

    def invoke() -> None:
        result_box.update(
            adapter.invoke("main", "ask me", {"session_id": session_id})
        )

    worker = threading.Thread(target=invoke, name="test-human-wait-invoke")
    try:
        worker.start()
        service = get_global_service()
        deadline = time.monotonic() + 1
        pending = []
        while time.monotonic() < deadline:
            pending = service.list_pending(session_id=session_id)
            if pending:
                break
            time.sleep(0.005)
        assert pending, "real ask_user tool did not create its question"

        # Exceed several idle windows while the real tool blocks for the user.
        time.sleep(0.3)
        assert worker.is_alive(), "invoke returned while ask_user still awaited a response"
        assert ("main", session_id) not in adapter._stalled_sessions

        service.respond(
            pending[0]["id"], response={"answer": "A"}, responded_by="test"
        )
        worker.join(timeout=1)
        assert not worker.is_alive(), "invoke did not resume after the user responded"
        assert result_box.get("observation") == "A"
        assert not result_box.get("degraded")
    finally:
        service = get_global_service()
        for row in service.list_pending(session_id=session_id):
            service.cancel(row["id"], "test cleanup")
        worker.join(timeout=2)
        agent.finished.wait(timeout=2)
        deadline = time.monotonic() + 2
        while ("main", session_id) in adapter._stalled_sessions and time.monotonic() < deadline:
            time.sleep(0.005)
        assert not worker.is_alive(), "test leaked invoke worker"
        assert agent.finished.is_set(), "test leaked fake model worker"
        assert ("main", session_id) not in adapter._stalled_sessions


def test_other_session_waiter_does_not_mask_this_session_idle():
    from needs_you import get_global_service
    from strands_backend.adapter import StrandsAgentAdapter

    service = get_global_service()
    other = service.request_question("Other", "waiting", session_id="other-session")

    def wait_other() -> None:
        service.wait_for_response(other.id, timeout=None)

    waiter = threading.Thread(target=wait_other, name="other-session-waiter")
    release = threading.Event()
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    agent = _HangingAgent(release)
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    invoke_result: dict = {}
    caller = threading.Thread(
        target=lambda: invoke_result.update(
            adapter.invoke("main", "hang", {"session_id": "idle-session"})
        ),
        name="idle-session-invoke",
    )
    try:
        waiter.start()
        assert _wait_until(lambda: service.has_response_waiter("other-session"))
        caller.start()
        caller.join(timeout=1)
        assert not caller.is_alive(), "another session's wait hid this session's idle"
        assert invoke_result.get("degraded_reason") == "invoke_watchdog_timeout"
    finally:
        release.set()
        service.cancel(other.id, "test cleanup")
        waiter.join(timeout=1)
        caller.join(timeout=2)
        deadline = time.monotonic() + 2
        while ("main", "idle-session") in adapter._stalled_sessions and time.monotonic() < deadline:
            time.sleep(0.005)
        assert agent.finished.wait(timeout=1), "test leaked fake model worker"
        assert not waiter.is_alive(), "test leaked needs-you waiter"
        assert not caller.is_alive(), "test leaked invoke caller"
        assert ("main", "idle-session") not in adapter._stalled_sessions


def test_same_session_pending_question_without_waiter_does_not_mask_idle():
    from needs_you import get_global_service
    from strands_backend.adapter import StrandsAgentAdapter

    session_id = "pending-without-waiter"
    service = get_global_service()
    pending = service.request_question("Pending", "no consumer", session_id=session_id)
    release = threading.Event()
    agent = _HangingAgent(release)
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    result: dict = {}
    caller = threading.Thread(
        target=lambda: result.update(
            adapter.invoke("main", "hang", {"session_id": session_id})
        ),
        name="pending-no-waiter-invoke",
    )
    try:
        assert not service.has_response_waiter(session_id)
        caller.start()
        caller.join(timeout=1)
        assert not caller.is_alive(), "pending notification hid genuine model idle"
        assert result.get("degraded_reason") == "invoke_watchdog_timeout"
    finally:
        release.set()
        service.cancel(pending.id, "test cleanup")
        caller.join(timeout=2)
        assert agent.finished.wait(timeout=1), "test leaked fake model worker"
        deadline = time.monotonic() + 2
        while ("main", session_id) in adapter._stalled_sessions and time.monotonic() < deadline:
            time.sleep(0.005)
        assert not caller.is_alive(), "test leaked invoke caller"
        assert ("main", session_id) not in adapter._stalled_sessions


def test_response_waiter_is_only_reported_while_pending_wait_is_active():
    from needs_you import get_global_service

    service = get_global_service()
    req = service.request_question("Question", "wait", session_id="waiter-session")
    assert not service.has_response_waiter("waiter-session")

    done = threading.Event()

    def wait() -> None:
        try:
            service.wait_for_response(req.id, timeout=None)
        finally:
            done.set()

    thread = threading.Thread(target=wait, name="question-waiter")
    try:
        thread.start()
        assert _wait_until(lambda: service.has_response_waiter("waiter-session"))
        service.respond(req.id, {"answer": "ok"})
        thread.join(timeout=1)
        assert not thread.is_alive(), "response did not wake waiter"
        assert not service.has_response_waiter("waiter-session")
    finally:
        service.cancel(req.id, "test cleanup")
        thread.join(timeout=1)
        assert not thread.is_alive(), "test leaked needs-you waiter"


def test_cancel_ends_human_wait_then_idle_watchdog_resumes():
    from needs_you import get_global_service
    from strands_backend.adapter import StrandsAgentAdapter

    session_id = "cancelled-human-wait"
    service = get_global_service()
    agent = _CancelThenHangAgent(session_id)
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    result: dict = {}
    caller = threading.Thread(
        target=lambda: result.update(
            adapter.invoke("main", "ask", {"session_id": session_id})
        ),
        name="cancel-human-wait-invoke",
    )
    try:
        caller.start()
        deadline = time.monotonic() + 1
        pending = []
        while time.monotonic() < deadline:
            pending = service.list_pending(session_id=session_id)
            if pending:
                break
            time.sleep(0.005)
        assert pending, "ask_user did not create a pending question"
        assert _wait_until(lambda: service.has_response_waiter(session_id))
        service.cancel(pending[0]["id"], "test cancel")
        assert agent.tool_returned.wait(1), "ask_user did not return after cancellation"
        assert not service.has_response_waiter(session_id)

        caller.join(timeout=1)
        assert not caller.is_alive(), "idle watchdog did not resume after cancellation"
        assert result.get("degraded_reason") == "invoke_watchdog_timeout"
    finally:
        agent.release.set()
        for row in service.list_pending(session_id=session_id):
            service.cancel(row["id"], "test cleanup")
        caller.join(timeout=2)
        agent.finished.wait(timeout=2)
        deadline = time.monotonic() + 2
        while ("main", session_id) in adapter._stalled_sessions and time.monotonic() < deadline:
            time.sleep(0.005)
        assert not caller.is_alive(), "test leaked invoke caller"
        assert agent.finished.is_set(), "test leaked fake model worker"
        assert ("main", session_id) not in adapter._stalled_sessions


def test_one_timed_out_waiter_does_not_clear_another_waiter_on_same_request():
    from needs_you import get_global_service

    service = get_global_service()
    req = service.request_question("Question", "wait", session_id="multi-waiter")
    short_done = threading.Event()
    long_done = threading.Event()

    def short_wait() -> None:
        try:
            service.wait_for_response(req.id, timeout=0.06)
        finally:
            short_done.set()

    def long_wait() -> None:
        try:
            service.wait_for_response(req.id, timeout=None)
        finally:
            long_done.set()

    long = threading.Thread(target=long_wait, name="long-response-waiter")
    short = threading.Thread(target=short_wait, name="short-response-waiter")
    try:
        long.start()
        assert _wait_until(lambda: service.has_response_waiter("multi-waiter"))
        short.start()
        assert short_done.wait(1), "explicit wait timeout did not return"
        assert not long_done.is_set()
        assert service.has_response_waiter("multi-waiter"), (
            "one waiter's exit cleared the other active waiter"
        )
        service.respond(req.id, {"answer": "done"})
        long.join(timeout=1)
        assert not long.is_alive()
        assert not service.has_response_waiter("multi-waiter")
    finally:
        service.cancel(req.id, "test cleanup")
        short.join(timeout=1)
        long.join(timeout=1)
        assert not short.is_alive(), "test leaked short waiter"
        assert not long.is_alive(), "test leaked long waiter"


def test_waiter_registry_clears_when_wait_raises(monkeypatch):
    from needs_you import get_global_service

    service = get_global_service()
    req = service.request_question("Question", "wait", session_id="exception-wait")

    def fail_wait(_req_id, _timeout):
        raise RuntimeError("simulated wait failure")

    monkeypatch.setattr(service, "_wait_for_response", fail_wait)
    with pytest.raises(RuntimeError, match="simulated wait failure"):
        service.wait_for_response(req.id, timeout=None)
    assert not service.has_response_waiter("exception-wait")
    service.cancel(req.id, "test cleanup")


def test_approval_deadline_still_auto_rejects_during_response_wait():
    from needs_you import NeedsYouStatus, get_global_service

    service = get_global_service()
    req = service.request_approval(
        "Approve?", "deadline check", session_id="approval-deadline", timeout=0.08
    )
    result: dict = {}
    done = threading.Event()

    def wait() -> None:
        try:
            result["request"] = service.wait_for_response(req.id, timeout=None)
        finally:
            done.set()

    thread = threading.Thread(target=wait, name="approval-deadline-waiter")
    try:
        thread.start()
        assert _wait_until(lambda: service.has_response_waiter("approval-deadline"))
        assert done.wait(1), "approval's own deadline was extended by waiting"
        # The service records its deadline terminal state as TIMEOUT; tool
        # approval handling treats this fail-closed state as rejection.
        assert result["request"].status == NeedsYouStatus.TIMEOUT
        assert result["request"].responded_by == "system_timeout"
        assert not service.has_response_waiter("approval-deadline")
    finally:
        service.cancel(req.id, "test cleanup")
        thread.join(timeout=1)
        assert not thread.is_alive(), "test leaked approval waiter"


def test_leaving_owned_wait_starts_a_full_idle_window(monkeypatch):
    import strands_backend.adapter as adapter_module
    from needs_you import get_global_service, response_wait_scope

    service = get_global_service()
    req = service.request_question("Question", "wait", session_id="fresh-budget")
    owner = object()
    with response_wait_scope(owner):
        context = copy_context()
    waiter = threading.Thread(target=context.run, args=(service.wait_for_response, req.id))
    clock = [0.0]
    samples: list[float] = []
    steps = iter([10.0, 30.0, 100.0, 109.0, 111.0])

    class PollWorker:
        def join(self, timeout):
            clock[0] = next(steps)
            samples.append(clock[0])
            if clock[0] == 100.0:
                service.respond(req.id, {"answer": "done"})
                waiter.join(timeout=1)
                assert not waiter.is_alive()

        def is_alive(self):
            return True

    adapter = adapter_module.StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    monkeypatch.setattr(adapter_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(adapter_module, "_watchdog_thresholds", lambda: (10, 0.01))
    try:
        waiter.start()
        assert _wait_until(lambda: service.has_response_waiter("fresh-budget", owner=owner))
        assert not service.has_response_waiter("fresh-budget", owner=object())
        assert adapter._wait_with_watchdog(
            PollWorker(), lambda: 0, "main", "fresh-budget", wait_owner=owner
        )
        # Waiting past 30s is healthy; after response at 100s, 109s is still
        # within the new window. Only 111s exceeds its 10s idle budget.
        assert samples == [10.0, 30.0, 100.0, 109.0, 111.0]
    finally:
        service.cancel(req.id, "test cleanup")
        waiter.join(timeout=1)
        assert not waiter.is_alive(), "test leaked owned response waiter"


def test_watchdog_uses_monotonic_clock_not_wall_clock(monkeypatch):
    import strands_backend.adapter as adapter_module

    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_IDLE_SECS", "0.12")
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_POLL_SECS", "0.01")
    # Replace only adapter's clock namespace. A frozen wall clock must not
    # prevent monotonic idle duration from expiring.
    monkeypatch.setattr(
        adapter_module,
        "time",
        SimpleNamespace(monotonic=time.monotonic, time=lambda: 10**12),
    )
    adapter = adapter_module.StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    finished = threading.Event()
    worker = threading.Thread(target=lambda: finished.wait(timeout=2))
    worker.start()
    try:
        assert adapter._wait_with_watchdog(
            worker, lambda: 0, "main", "monotonic-session"
        )
    finally:
        finished.set()
        worker.join(timeout=1)
        assert not worker.is_alive(), "test leaked watchdog worker"
