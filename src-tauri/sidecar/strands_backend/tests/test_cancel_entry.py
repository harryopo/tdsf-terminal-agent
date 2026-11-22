"""入口初始化期间的取消竞态回归。"""
from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()


class _FakeAgent:
    callback_handler = None

    def __init__(self, adapter, session_id, model_calls, tool_calls, entered=None, release=None):
        self.adapter = adapter
        self.session_id = session_id
        self.model_calls = model_calls
        self.tool_calls = tool_calls
        self.entered = entered
        self.release = release
        self.messages = []

    def __call__(self, prompt):
        self.model_calls.append(prompt)
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            assert self.release.wait(3), "test did not release model barrier"
        hook = self.adapter._limit_hooks[("main", self.session_id)]
        event = SimpleNamespace(tool_use={"name": "probe_tool"}, cancel_tool=False)
        hook._before_tool_call(event)
        if not event.cancel_tool:
            self.tool_calls.append(self.session_id)
        return "done"


def _adapter():
    from strands_backend.adapter import StrandsAgentAdapter

    return StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=object()
    )


def _assert_worker_stopped(session_id):
    names = [
        thread.name
        for thread in threading.enumerate()
        if thread.name == f"tdsf-invoke-{session_id}"
    ]
    assert names == [], f"internal worker still running: {names}"


def test_cancel_during_initialization_without_hook_skips_model_and_tool(monkeypatch):
    """没有 hook 的初始化空窗也要登记并记住本轮取消。"""
    adapter = _adapter()
    entered_init = threading.Event()
    release_init = threading.Event()
    model_calls = []
    tool_calls = []
    agent = _FakeAgent(adapter, "entry-s1", model_calls, tool_calls)

    def blocked_init(_agent_id, _ctx, **_kwargs):
        entered_init.set()
        assert release_init.wait(3), "test did not release initialization barrier"
        adapter._get_limit_hook("main", "entry-s1")
        return agent

    monkeypatch.setattr(adapter, "_get_or_create_agent", blocked_init)
    results = []
    caller = threading.Thread(
        target=lambda: results.append(
            adapter.invoke("main", "检查服务", {"session_id": "entry-s1"})
        ),
        daemon=True,
    )
    caller.start()
    try:
        assert entered_init.wait(3), "invoke never reached the initialization barrier"
        assert ("main", "entry-s1") not in adapter._limit_hooks

        cancelled = adapter.request_cancel("entry-s1", "用户点击停止")
        assert cancelled["cancelled"] is True

        release_init.set()
        caller.join(5)
        assert not caller.is_alive(), "invoke did not finish after initialization release"
        _assert_worker_stopped("entry-s1")
        assert model_calls == [], "cancelled entry still called this turn's model"
        assert tool_calls == [], "cancelled entry still executed this turn's tool"
        assert results
        assert results[0]["next_step"] == "done"
        assert results[0]["mood"] == "done"
        assert "已停止" in results[0]["observation"]
        assert "不会自动撤销" in results[0]["observation"]
    finally:
        release_init.set()
        caller.join(5)


def test_cancel_after_hook_creation_is_not_erased_by_worker_reset(monkeypatch):
    """worker reset 不能清掉初始化期间已登记的取消。"""
    import needs_you

    adapter = _adapter()
    entered_init = threading.Event()
    release_init = threading.Event()
    model_calls = []
    tool_calls = []
    agent = _FakeAgent(adapter, "entry-s2", model_calls, tool_calls)

    def blocked_init(_agent_id, _ctx, **_kwargs):
        adapter._get_limit_hook("main", "entry-s2")
        entered_init.set()
        assert release_init.wait(3), "test did not release initialization barrier"
        return agent

    monkeypatch.setattr(adapter, "_get_or_create_agent", blocked_init)
    results = []
    caller = threading.Thread(
        target=lambda: results.append(
            adapter.invoke("main", "检查服务", {"session_id": "entry-s2"})
        ),
        daemon=True,
    )
    caller.start()
    try:
        assert entered_init.wait(3), "invoke never reached initialized-hook barrier"
        hook = adapter._limit_hooks[("main", "entry-s2")]
        assert hook.cancelled is False
        service = needs_you.get_global_service()
        request = service.request_question(
            title="需要确认",
            description="继续检查服务状态",
            session_id="entry-s2",
        )
        cancelled = adapter.request_cancel("entry-s2", "用户点击停止")
        assert cancelled["cancelled"] is True
        assert cancelled["requests"] == 1
        assert service.get(request.id)["status"] == "cancelled"
        assert hook.cancelled is True

        release_init.set()
        caller.join(5)
        assert not caller.is_alive(), "invoke did not finish after initialization release"
        _assert_worker_stopped("entry-s2")
        assert model_calls == [], "cancelled initialized turn still called the model"
        assert tool_calls == [], "cancelled initialized turn still executed a tool"
        assert results
    finally:
        release_init.set()
        caller.join(5)


class _ObservedLock:
    """Signal when a caller reaches a lock it must wait to acquire."""

    def __init__(self, lock, attempted, acquired=None):
        self.lock = lock
        self.attempted = attempted
        self.acquired = acquired

    def __enter__(self):
        self.attempted.set()
        self.lock.acquire()
        if self.acquired is not None:
            self.acquired.set()
        return self

    def __exit__(self, *_exc):
        self.lock.release()


def test_cancel_while_worker_is_really_queued_skips_queued_turn(monkeypatch):
    """取消时第二个内部 worker 已到达并阻塞于同一真实 agent lock。"""
    adapter = _adapter()
    first_model_entered = threading.Event()
    release_first_model = threading.Event()
    queued_lock_attempted = threading.Event()
    model_calls = []
    tool_calls = []
    agent = _FakeAgent(
        adapter,
        "queued-s1",
        model_calls,
        tool_calls,
        entered=first_model_entered,
        release=release_first_model,
    )

    def get_or_create(_agent_id, _ctx, **_kwargs):
        adapter._get_limit_hook("main", "queued-s1")
        return agent

    monkeypatch.setattr(adapter, "_get_or_create_agent", get_or_create)
    first_result = []
    first = threading.Thread(
        target=lambda: first_result.append(
            adapter.invoke("main", "第一轮", {"session_id": "queued-s1"})
        ),
        daemon=True,
    )
    second_result = []
    second = None
    first.start()
    try:
        assert first_model_entered.wait(3), "first invoke did not enter its model call"
        assert adapter._agent_locks, "invoke did not create its per-agent lock"
        lock_key, lock = next(iter(adapter._agent_locks.items()))
        adapter._agent_locks[lock_key] = _ObservedLock(lock, queued_lock_attempted)

        second = threading.Thread(
            target=lambda: second_result.append(
                adapter.invoke("main", "排队轮", {"session_id": "queued-s1"})
            ),
            daemon=True,
        )
        second.start()
        assert queued_lock_attempted.wait(3), "second worker never attempted the agent lock"
        assert second.is_alive(), "second worker reached lock but was not queued"
        assert len(model_calls) == 1, "queued turn unexpectedly reached the model before cancel"

        adapter.request_cancel("queued-s1", "用户点击停止")
        release_first_model.set()
        first.join(5)
        second.join(5)
        assert not first.is_alive() and not second.is_alive(), "invoke callers failed to finish"
        _assert_worker_stopped("queued-s1")
        assert len(model_calls) == 1, "queued cancelled turn still called the model"
        assert tool_calls == [], "cancelled session executed a tool after the stop request"
        assert first_result and second_result
    finally:
        release_first_model.set()
        first.join(5)
        if second is not None:
            second.join(5)


def test_cancelled_turn_preserves_one_shot_handoff_and_other_sessions(monkeypatch):
    """新显式回合收到一次中断说明，其他 session 正常调用，说明不复用。"""
    adapter = _adapter()
    entered_init = threading.Event()
    release_init = threading.Event()
    model_calls = []
    tool_calls = []
    agent_a = _FakeAgent(adapter, "handoff-s1", model_calls, tool_calls)
    agent_b = _FakeAgent(adapter, "handoff-s2", model_calls, tool_calls)

    def blocked_init(agent_id, ctx, **kwargs):
        session_id = ctx.session_id
        adapter._get_limit_hook(agent_id, session_id)
        if session_id == "handoff-s1" and not entered_init.is_set():
            entered_init.set()
            assert release_init.wait(3), "test did not release initialization barrier"
        return agent_a if session_id == "handoff-s1" else agent_b

    monkeypatch.setattr(adapter, "_get_or_create_agent", blocked_init)
    cancelled_result = []
    caller = threading.Thread(
        target=lambda: cancelled_result.append(
            adapter.invoke("main", "被打断", {"session_id": "handoff-s1"})
        ),
        daemon=True,
    )
    caller.start()
    try:
        assert entered_init.wait(3), "invoke never reached handoff initialization barrier"
        adapter.request_cancel("handoff-s1", "用户点击停止")
        release_init.set()
        caller.join(5)
        assert not caller.is_alive(), "cancelled invoke did not finish"
        _assert_worker_stopped("handoff-s1")
        assert model_calls == [], "cancelled turn consumed the interruption prompt"

        adapter.invoke("main", "继续", {"session_id": "handoff-s1"})
        assert len(model_calls) == 1 and "<interrupted_task>" in model_calls[0]
        adapter.invoke("main", "另一会话", {"session_id": "handoff-s2"})
        assert len(model_calls) == 2 and "<interrupted_task>" not in model_calls[1]
        adapter.invoke("main", "再继续", {"session_id": "handoff-s1"})
        assert len(model_calls) == 3 and "<interrupted_task>" not in model_calls[2]
        assert tool_calls == ["handoff-s1", "handoff-s2", "handoff-s1"]
        assert cancelled_result
    finally:
        release_init.set()
        caller.join(5)


def test_cancel_waiting_for_hook_reset_stops_tool_and_allows_next_turn(monkeypatch):
    """reset 与取消串行；取消 ACK 后真实 hook 必须阻止工具入口。"""
    adapter = _adapter()
    cancel_lock_attempted = threading.Event()
    cancel_lock_acquired = threading.Event()
    adapter._cancel_lock = _ObservedLock(
        adapter._cancel_lock, cancel_lock_attempted, cancel_lock_acquired
    )
    reset_entered = threading.Event()
    release_reset = threading.Event()
    model_entered = threading.Event()
    release_model = threading.Event()
    model_calls = []
    tool_calls = []
    agent = _FakeAgent(
        adapter,
        "reset-s1",
        model_calls,
        tool_calls,
        entered=model_entered,
        release=release_model,
    )
    reset_spy_installed = False

    def get_or_create(_agent_id, _ctx, **_kwargs):
        nonlocal reset_spy_installed
        hook = adapter._get_limit_hook("main", "reset-s1")
        if not reset_spy_installed:
            actual_reset = hook.reset

            def blocked_reset():
                cancel_lock_attempted.clear()
                cancel_lock_acquired.clear()
                reset_entered.set()
                assert release_reset.wait(3), "test did not release hook reset barrier"
                actual_reset()

            hook.reset = blocked_reset
            reset_spy_installed = True
        return agent

    monkeypatch.setattr(adapter, "_get_or_create_agent", get_or_create)
    results = []
    caller = threading.Thread(
        target=lambda: results.append(
            adapter.invoke("main", "检查", {"session_id": "reset-s1"})
        ),
        daemon=True,
    )
    cancel_done = threading.Event()
    canceller = None
    caller.start()
    try:
        assert reset_entered.wait(3), "worker did not reach real hook reset"

        def cancel():
            adapter.request_cancel("reset-s1", "用户点击停止")
            cancel_done.set()

        canceller = threading.Thread(target=cancel, name="cancel-request", daemon=True)
        canceller.start()
        assert cancel_lock_attempted.wait(3), "cancel call never attempted its shared lock"
        assert not cancel_lock_acquired.wait(0.05), "cancel acquired lock before hook reset completed"

        release_reset.set()
        assert cancel_lock_acquired.wait(3), "cancel did not acquire lock after reset released"
        assert model_entered.wait(3), "worker did not reach the fake model boundary"
        assert cancel_done.wait(3), "cancel did not ACK after hook reset released"
        assert adapter._limit_hooks[("main", "reset-s1")].cancelled is True
        release_model.set()
        caller.join(5)
        canceller.join(5)
        assert not caller.is_alive() and not canceller.is_alive()
        _assert_worker_stopped("reset-s1")
        assert len(model_calls) == 1
        assert tool_calls == [], "tool ran after cancellation ACK"

        next_turn = adapter.invoke("main", "新的任务", {"session_id": "reset-s1"})
        assert next_turn["next_step"] == "done"
        assert len(model_calls) == 2
        assert tool_calls == ["reset-s1"], "new explicit turn did not reset the real hook"
    finally:
        release_reset.set()
        release_model.set()
        caller.join(5)
        if canceller is not None:
            canceller.join(5)


def test_watchdog_cancel_survives_caller_unregister_while_worker_is_queued(monkeypatch):
    """watchdog返回清登记后，排队worker仍保留已取消Event并真正退场。"""
    import strands_backend.adapter as adapter_module

    adapter = _adapter()
    session_id = "watchdog-queued-s1"
    model_calls = []
    tool_calls = []
    agent = _FakeAgent(adapter, session_id, model_calls, tool_calls)

    def get_or_create(_agent_id, _ctx, **_kwargs):
        adapter._get_limit_hook("main", session_id)
        return agent

    monkeypatch.setattr(adapter, "_get_or_create_agent", get_or_create)
    monkeypatch.setattr(adapter_module, "_watchdog_thresholds", lambda: (0.03, 0.001))
    state = {"session_id": session_id}
    ctx = adapter._build_tool_context(
        "main", session_id, state, mode=adapter_module.parse_mode(None), teach=False
    )
    lock = threading.RLock()
    lock.acquire()
    attempted = threading.Event()
    adapter._agent_locks[("main", ctx.session_id, ctx.permission_level)] = _ObservedLock(
        lock, attempted
    )

    results = []
    result_ready = threading.Event()

    def invoke_and_signal():
        results.append(adapter.invoke("main", "排队任务", state))
        result_ready.set()

    caller = threading.Thread(
        target=invoke_and_signal,
        daemon=True,
    )
    worker = None
    lock_held = True
    caller.start()
    try:
        assert attempted.wait(3), "worker never reached the pre-held agent lock"
        # Observe caller completion without relying on the lock release as proof.
        assert result_ready.wait(3), "watchdog did not return the blocked caller"
        caller.join(3)
        worker = next(
            thread
            for thread in threading.enumerate()
            if thread.name == f"tdsf-invoke-{session_id}"
        )
        assert caller.is_alive() is False
        assert worker.is_alive(), "queued internal worker already exited before lock release"
        assert session_id not in adapter._invocations, "caller did not unregister its event"
        assert result_ready.is_set() and results[0]["degraded_reason"] == "invoke_watchdog_timeout"

        lock.release()
        lock_held = False
        worker.join(5)
        assert not worker.is_alive(), "worker did not truly exit after queued lock release"
        assert model_calls == [], "watchdog-cancelled queued worker called the model"
        assert tool_calls == [], "watchdog-cancelled queued worker executed a tool"
    finally:
        if lock_held:
            lock.release()
        caller.join(5)
        if worker is not None:
            worker.join(5)


def test_degraded_and_exception_entries_do_not_leave_cancel_state(monkeypatch):
    """入口快速降级或初始化异常都必须释放本轮登记。"""
    degraded = _adapter()
    degraded.backend_enabled = False
    degraded_result = degraded.invoke("main", "问候", {"session_id": "cleanup-s1"})
    assert degraded_result["degraded"] is True
    assert degraded.request_cancel("cleanup-s1", "之后停止")["cancelled"] is False

    failed = _adapter()

    def broken_init(*_args, **_kwargs):
        raise RuntimeError("fake initialization failure")

    monkeypatch.setattr(failed, "_get_or_create_agent", broken_init)
    failure_result = failed.invoke("main", "检查", {"session_id": "cleanup-s2"})
    assert failure_result["next_step"] == "error"
    assert failed.request_cancel("cleanup-s2", "之后停止")["cancelled"] is False
