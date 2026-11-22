"""Live-mode RPC updates must stay scoped to an active agent invocation."""
from __future__ import annotations

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest

STREAM_ID = "00000000-0000-4000-8000-000000000001"
OTHER_STREAM_ID = "00000000-0000-4000-8000-000000000002"
QUEUED_STREAM_ID = "00000000-0000-4000-8000-000000000003"


@pytest.fixture(autouse=True)
def _isolate_agent_state(tmp_path, monkeypatch):
    import agent_facade
    import needs_you

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    agent_facade.reset_for_test()
    needs_you.reset_for_test()
    yield
    agent_facade.reset_for_test()
    needs_you.reset_for_test()


def _adapter(operation_service=None):
    from strands_backend.adapter import StrandsAgentAdapter

    return StrandsAgentAdapter(
        event_bus=MagicMock(),
        backend_enabled=False,
        strands_model=None,
        operation_service=operation_service,
    )


def _register(adapter, state=None, stream_id=STREAM_ID):
    session_id = str(uuid.uuid4())
    cancelled = adapter._register_invocation(
        session_id,
        state=state or {"live": {"agentMode": "confirm", "teach": False}},
        stream_id=stream_id,
    )
    return session_id, cancelled


def test_live_mode_rpc_is_registered_on_real_dispatcher_and_stays_fast():
    import agent_facade
    import main

    adapter = _adapter()
    agent_facade.set_strands_adapter(adapter)
    agent_facade.set_backend(adapter.invoke)
    dispatcher = main.MethodDispatcher()
    agent_facade.register_methods(dispatcher)

    assert "agent.set_mode" in dispatcher.list_methods()
    assert "agent.set_mode" not in main._slow_methods
    session_id, _cancelled = _register(adapter)
    result = dispatcher.dispatch(
        "agent.set_mode",
        {"session_id": session_id, "stream_id": STREAM_ID, "mode": "auto", "revision": 1},
    )
    assert result == {"ok": True, "mode": "auto", "revision": 1}


def test_mode_revisions_are_monotonic_idempotent_and_per_stream():
    adapter = _adapter()
    session_id, _cancelled = _register(adapter)
    other_session, _other_cancelled = _register(adapter, stream_id=OTHER_STREAM_ID)

    first = adapter.set_mode(session_id, STREAM_ID, "auto", 2)
    assert first == {"ok": True, "mode": "auto", "revision": 2}
    assert adapter.set_mode(session_id, STREAM_ID, "auto", 2) == first
    assert adapter.set_mode(session_id, STREAM_ID, "confirm", 1) == {
        "ok": False,
        "reason": "stale_revision",
    }
    assert adapter.set_mode(other_session, STREAM_ID, "auto", 3) == {
        "ok": False,
        "reason": "not_active",
    }


@pytest.mark.parametrize(
    ("mode", "revision"),
    [("unknown", 2), ("auto", True), ("auto", -1), ("auto", 0), ("auto", 1.5)],
)
def test_invalid_mode_or_revision_is_rejected_without_advancing(mode, revision):
    adapter = _adapter()
    session_id, _cancelled = _register(adapter)

    with pytest.raises(ValueError):
        adapter.set_mode(session_id, STREAM_ID, mode, revision)

    assert adapter.set_mode(session_id, STREAM_ID, "auto", 1) == {
        "ok": True,
        "mode": "auto",
        "revision": 1,
    }


@pytest.mark.parametrize(
    ("state", "requested"),
    [
        ({"live": {"agentMode": "observe", "teach": False}}, "confirm"),
        ({"live": {"agentMode": "confirm", "teach": True}}, "auto"),
    ],
)
def test_observe_or_teach_requires_a_new_turn_without_mutating_context(state, requested):
    from strands_backend.modes import AgentMode

    adapter = _adapter()
    session_id, _cancelled = _register(adapter, state=state)
    mode = AgentMode(state["live"]["agentMode"])
    ctx = adapter._build_tool_context("main", session_id, state, mode=mode, teach=state["live"]["teach"])

    result = adapter.set_mode(session_id, STREAM_ID, requested, 1)

    assert result == {"ok": False, "reason": "requires_new_turn"}
    assert ctx.mode == mode
    assert ctx.teach is state["live"]["teach"]
    assert state == {"live": {"agentMode": mode.value, "teach": ctx.teach}}


def test_mode_update_does_not_rewrite_current_high_risk_policy_context():
    from strands_backend.modes import AgentMode, decide

    adapter = _adapter()
    session_id, _cancelled = _register(adapter)
    ctx = adapter._build_tool_context(
        "main", session_id, {"live": {"agentMode": "confirm", "teach": False}},
        mode=AgentMode.CONFIRM,
    )

    assert adapter.set_mode(session_id, STREAM_ID, "auto", 1)["ok"] is True
    assert decide(2, ctx.mode) == "confirm"
    assert decide(2, AgentMode.AUTO) == "allow"


def test_unknown_finished_and_cancelled_invocations_are_not_active():
    adapter = _adapter()
    session_id, cancelled = _register(adapter)

    legacy_cancelled = adapter._register_invocation(
        session_id,
        state={"live": {"agentMode": "confirm", "teach": False}},
        stream_id="not-a-uuid",
    )
    assert legacy_cancelled in adapter._invocations[session_id]
    assert legacy_cancelled not in adapter._invocation_modes
    assert adapter.set_mode(session_id, "not-a-uuid", "auto", 1) == {
        "ok": False,
        "reason": "not_active",
    }
    assert not legacy_cancelled.is_set()
    adapter._unregister_invocation(session_id, legacy_cancelled)
    assert cancelled in adapter._invocations[session_id]
    assert legacy_cancelled not in adapter._invocations[session_id]
    assert legacy_cancelled not in adapter._invocation_modes
    assert adapter.set_mode(session_id, STREAM_ID, "auto", 1) == {
        "ok": True,
        "mode": "auto",
        "revision": 1,
    }
    assert adapter.set_mode(session_id, OTHER_STREAM_ID, "auto", 1) == {
        "ok": False,
        "reason": "not_active",
    }
    adapter._unregister_invocation(session_id, cancelled)
    assert session_id not in adapter._invocations
    assert adapter.set_mode(session_id, STREAM_ID, "auto", 1) == {
        "ok": False,
        "reason": "not_active",
    }

    cancelled_session, cancelled_event = _register(adapter, stream_id=OTHER_STREAM_ID)
    assert adapter.set_mode(cancelled_session, OTHER_STREAM_ID, "auto", 1) == {
        "ok": True,
        "mode": "auto",
        "revision": 1,
    }
    cancelled_event.set()
    assert adapter.set_mode(cancelled_session, OTHER_STREAM_ID, "auto", 2) == {
        "ok": False,
        "reason": "not_active",
    }


def test_slow_request_registers_stream_state_before_pool_submission(monkeypatch):
    import agent_facade
    import main

    adapter = _adapter()
    agent_facade.set_strands_adapter(adapter)
    agent_facade.set_backend(adapter.invoke)
    dispatcher = main.MethodDispatcher()
    agent_facade.register_methods(dispatcher)
    session_id = str(uuid.uuid4())
    state = {
        "session_id": session_id,
        "input": "do not invoke while queued",
        "live": {"agentMode": "confirm", "teach": False},
        "_rpc_stream_id": QUEUED_STREAM_ID,
    }
    registered = []
    original_register = adapter._register_invocation

    def capture_registration(session, state=None, stream_id=None):
        registered.append((session, state, stream_id))
        return original_register(session, state=state, stream_id=stream_id)

    monkeypatch.setattr(adapter, "_register_invocation", capture_registration)
    executor = ThreadPoolExecutor(max_workers=1)
    started = threading.Event()
    release = threading.Event()

    def hold_worker():
        started.set()
        release.wait(5)

    blocker = executor.submit(hold_worker)
    future = None
    monkeypatch.setattr(main, "_main_executor", executor)
    try:
        assert started.wait(3), "executor worker did not reach barrier"
        future = main._submit_slow_request(
            dispatcher,
            "agent.invoke",
            {"name": "main", "state": state},
            915,
            False,
        )
        assert not future.running()
        assert registered == [(session_id, state, QUEUED_STREAM_ID)]
        assert adapter.set_mode(session_id, QUEUED_STREAM_ID, "auto", 1)["ok"] is True
        assert future.cancel()
        assert adapter.set_mode(session_id, QUEUED_STREAM_ID, "confirm", 2) == {
            "ok": False,
            "reason": "not_active",
        }
    finally:
        release.set()
        if future is not None:
            future.cancel()
        blocker.result(timeout=5)
        executor.shutdown(wait=True, cancel_futures=True)


def test_switching_mode_does_not_approve_cancel_or_wake_pending_needs_you(monkeypatch):
    import needs_you

    service = needs_you.get_global_service()
    operation_service = MagicMock()
    adapter = _adapter(operation_service=operation_service)
    session_id, _cancelled = _register(adapter)
    request = service.request_approval(
        "confirm before running",
        "dangerous command",
        session_id=session_id,
        timeout=30,
        execution_gate=True,
    )
    waiting = threading.Event()
    finished = threading.Event()
    result = []
    original_wait = service._wait_for_response

    def mark_waiting(req_id, timeout):
        waiting.set()
        return original_wait(req_id, timeout)

    monkeypatch.setattr(service, "_wait_for_response", mark_waiting)

    def wait_for_approval():
        result.append(service.wait_for_response(request.id, timeout=30))
        finished.set()

    waiter = threading.Thread(target=wait_for_approval, daemon=True)
    waiter.start()
    try:
        assert waiting.wait(3), "needs_you waiter did not start"
        assert service.has_response_waiter(session_id)
        assert adapter.set_mode(session_id, STREAM_ID, "auto", 1) == {
            "ok": True,
            "mode": "auto",
            "revision": 1,
        }
        assert request.status == needs_you.NeedsYouStatus.PENDING
        assert request.response is None
        assert not request._event.is_set()
        assert not finished.is_set()
        assert operation_service.mock_calls == []
    finally:
        service.cancel(request.id, reason="test cleanup")
        assert finished.wait(3), "cleanup did not wake needs_you waiter"
        waiter.join(timeout=3)
