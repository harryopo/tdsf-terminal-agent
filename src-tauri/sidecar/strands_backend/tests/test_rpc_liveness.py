from __future__ import annotations

import threading
from copy import deepcopy
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
    reset_agent_log()
    reset_fix_loop()
    reset_for_test()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_for_test()


class _PollWorker:
    def __init__(self, clock, alive_polls: int) -> None:
        self.clock = clock
        self.alive_polls = alive_polls
        self.polls = 0

    def join(self, timeout) -> None:
        self.polls += 1
        self.clock[0] += timeout

    def is_alive(self) -> bool:
        return self.polls <= self.alive_polls


def _watchdog(monkeypatch, bus, *, owner=None, session_id="rpc-liveness", polls=2):
    import strands_backend.adapter as adapter_module

    clock = [0.0]
    monkeypatch.setattr(
        adapter_module, "time", SimpleNamespace(monotonic=lambda: clock[0])
    )
    monkeypatch.setattr(adapter_module, "_watchdog_thresholds", lambda: (100, 1))
    adapter = adapter_module.StrandsAgentAdapter(
        event_bus=bus, backend_enabled=True, strands_model=MagicMock()
    )
    return adapter._wait_with_watchdog(
        _PollWorker(clock, polls), lambda: 0, "main", session_id,
        wait_owner=owner,
    )


def test_real_watchdog_emits_liveness_for_active_agent_rpc(monkeypatch):
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    with agent_request_scope(701):
        timed_out = _watchdog(monkeypatch, bus, polls=2)

    assert not timed_out
    assert sent == [
        ("agent.rpc_liveness", {"schema_version": 1, "rpc_request_id": 701, "seq": 1, "phase": "working"}),
        ("agent.rpc_liveness", {"schema_version": 1, "rpc_request_id": 701, "seq": 2, "phase": "working"}),
    ]


def test_event_bus_rejects_invalid_liveness_and_requires_active_id():
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    emit = bus.emit_rpc_liveness
    assert not emit(1, "working")
    for seq, phase in ((True, "working"), (0, "working"), (1, "unknown"), (1, "waiting_user")):
        assert not emit(seq, phase)
    with agent_request_scope(True):
        assert not emit(1, "working")
    with agent_request_scope(702):
        assert emit(1, "working")
    assert len(sent) == 1
    assert not EventBus().emit_rpc_liveness(1, "working")


def test_event_bus_validates_sequence_and_phase_inside_active_scope():
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    invalid = (
        (True, "working"),
        (0, "working"),
        (-1, "working"),
        (1.0, "working"),
        ("1", "working"),
        (1 << 64, "working"),
        (1, "unknown"),
    )
    with agent_request_scope(709):
        for seq, phase in invalid:
            assert not bus.emit_rpc_liveness(seq, phase), (seq, phase)
        assert bus.emit_rpc_liveness(1, "working")
        assert bus.emit_rpc_liveness(2, "waiting_user")
    assert [params["seq"] for _, params in sent] == [1, 2]
    assert [params["phase"] for _, params in sent] == ["working", "waiting_user"]


def test_unrelated_real_waiters_do_not_change_watchdog_phase(monkeypatch):
    from event_bus import EventBus
    from needs_you import get_global_service, response_wait_scope
    from rpc_request_context import agent_request_scope

    service = get_global_service()
    same_session = service.request_question("Same", "other owner", session_id="phase-session")
    other_session = service.request_question("Other", "other session", session_id="elsewhere")
    unrelated_owner = object()
    same_done = threading.Event()
    other_done = threading.Event()

    def wait(req_id, done):
        try:
            service.wait_for_response(req_id, timeout=None)
        finally:
            done.set()

    with response_wait_scope(unrelated_owner):
        same_context = copy_context()
    same_waiter = threading.Thread(
        target=same_context.run, args=(wait, same_session.id, same_done)
    )
    other_waiter = threading.Thread(
        target=wait, args=(other_session.id, other_done)
    )
    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    try:
        same_waiter.start()
        other_waiter.start()
        assert _wait_until(
            lambda: service.has_response_waiter("phase-session", owner=unrelated_owner)
        )
        assert _wait_until(lambda: service.has_response_waiter("elsewhere"))
        with agent_request_scope(710):
            _watchdog(
                monkeypatch, bus, owner=object(), session_id="phase-session", polls=2
            )
        assert [params["phase"] for _, params in sent] == ["working", "working"]
    finally:
        service.cancel(same_session.id, "test cleanup")
        service.cancel(other_session.id, "test cleanup")
        same_waiter.join(timeout=1)
        other_waiter.join(timeout=1)
        assert same_done.is_set() and other_done.is_set()
        assert not same_waiter.is_alive() and not other_waiter.is_alive()


def test_liveness_does_not_touch_event_bus_history_stats_or_subscribers():
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    observed = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    bus.subscribe(lambda event: observed.append(event))
    before_history = list(bus._history)
    before_stats = deepcopy(bus._stats)
    before_subscribers = list(bus._subscribers)
    with agent_request_scope(711):
        assert bus.emit_rpc_liveness(1, "working")
    assert len(sent) == 1
    assert list(bus._history) == before_history
    assert bus._stats == before_stats
    assert bus._subscribers == before_subscribers
    assert observed == []


def test_watchdog_reports_waiting_user_only_for_its_own_waiter(monkeypatch):
    from event_bus import EventBus
    from needs_you import get_global_service, response_wait_scope
    from rpc_request_context import agent_request_scope

    service = get_global_service()
    own = service.request_question("Own", "wait", session_id="own-session")
    other = service.request_question("Other", "wait", session_id="other-session")
    owner = object()
    own_done = threading.Event()
    other_done = threading.Event()

    def wait(req_id, done):
        try:
            service.wait_for_response(req_id, timeout=None)
        finally:
            done.set()

    with response_wait_scope(owner):
        own_context = copy_context()
    own_waiter = threading.Thread(target=own_context.run, args=(wait, own.id, own_done))
    other_waiter = threading.Thread(target=wait, args=(other.id, other_done))
    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    try:
        own_waiter.start()
        other_waiter.start()
        assert _wait_until(lambda: service.has_response_waiter("own-session", owner=owner))
        assert _wait_until(lambda: service.has_response_waiter("other-session"))
        with agent_request_scope(703):
            _watchdog(monkeypatch, bus, owner=owner, session_id="own-session", polls=2)
        assert [item[1]["phase"] for item in sent] == ["waiting_user", "waiting_user"]
        assert [item[1]["seq"] for item in sent] == [1, 2]
    finally:
        service.cancel(own.id, "test cleanup")
        service.cancel(other.id, "test cleanup")
        own_waiter.join(timeout=1)
        other_waiter.join(timeout=1)
        assert own_done.is_set() and other_done.is_set()
        assert not own_waiter.is_alive() and not other_waiter.is_alive()


def _wait_until(predicate, timeout: float = 1) -> bool:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def test_rpc_liveness_notifier_failure_does_not_break_watchdog(monkeypatch, caplog):
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    def broken(*_args):
        raise RuntimeError("private notifier detail")

    bus = EventBus(rust_notifier=broken)
    with agent_request_scope(704):
        assert not _watchdog(monkeypatch, bus, polls=2)
    assert "private notifier detail" not in caplog.text
    assert any("rpc liveness" in record.message.lower() for record in caplog.records)


def test_watchdog_stops_liveness_at_timeout_and_after_worker_finishes(monkeypatch):
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    import strands_backend.adapter as adapter_module

    clock = [0.0]
    monkeypatch.setattr(adapter_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(adapter_module, "_watchdog_thresholds", lambda: (1, 1))
    adapter = adapter_module.StrandsAgentAdapter(event_bus=bus, backend_enabled=True, strands_model=MagicMock())
    with agent_request_scope(705):
        assert adapter._wait_with_watchdog(_PollWorker(clock, 10), lambda: 0, "main", "timeout")
    assert [params["seq"] for _, params in sent] == [1]

    sent.clear()
    clock[0] = 0
    with agent_request_scope(706):
        assert not adapter._wait_with_watchdog(_PollWorker(clock, 0), lambda: 0, "main", "done")
    assert sent == []


def test_rpc_liveness_can_emit_while_model_callback_count_is_idle(monkeypatch):
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    with agent_request_scope(707):
        assert not _watchdog(monkeypatch, bus, polls=3)
    assert len(sent) == 3
    assert all(params["phase"] == "working" for _, params in sent)


def test_inactive_request_scope_does_not_send_from_copied_worker_context():
    from event_bus import EventBus
    from rpc_request_context import agent_request_scope

    sent = []
    bus = EventBus(rust_notifier=lambda method, params: sent.append((method, params)))
    with agent_request_scope(708):
        context = copy_context()
    assert not context.run(bus.emit_rpc_liveness, 1, "working")
    assert sent == []
