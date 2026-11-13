"""Real SDK regressions for model reload and per-session invoke isolation."""
from __future__ import annotations

import copy
import threading
import uuid

import pytest
from strands.models.model import Model

from rpc_request_context import agent_request_scope
from strands_backend.adapter import StrandsAgentAdapter


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


class BarrierModel(Model):
    def __init__(self, name: str, *, barrier: bool = False):
        self.name = name
        self.entered = threading.Event()
        self.release = threading.Event()
        self.barrier = barrier
        self.seen = []

    def get_config(self):
        return {"model": self.name}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        yield None

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.seen.append(copy.deepcopy(messages))
        self.entered.set()
        if self.barrier and len(self.seen) == 1:
            assert self.release.wait(10), "test did not release model barrier"
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": f"reply-{self.name}"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}}


class ObservedLock:
    def __init__(self, underlying, attempted: threading.Event):
        self.underlying = underlying
        self.attempted = attempted

    def __enter__(self):
        self.attempted.set()
        self.underlying.acquire()
        return self

    def __exit__(self, *exc):
        self.underlying.release()


def _adapter(tmp_path, monkeypatch, model):
    from unittest.mock import MagicMock

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("TDSF_LOG_DIR", str(tmp_path / "log"))
    return StrandsAgentAdapter(
        event_bus=MagicMock(), rust_bridge=MagicMock(), backend_enabled=True,
        strands_model=model,
    )


def _start(adapter, session, prompt, result, *, mode="confirm"):
    def run():
        with agent_request_scope(2001, str(uuid.uuid4())):
            result.append(adapter.invoke("main", prompt, {
                "session_id": session, "live": {"agentMode": mode},
            }))

    worker = threading.Thread(target=run, name=f"qa-{session}-{prompt}", daemon=True)
    worker.start()
    return worker


def _join(*threads):
    for worker in threads:
        worker.join(10)
        assert not worker.is_alive(), f"worker did not finish: {worker.name}"


def _assert_no_invoke_workers():
    assert not [t.name for t in threading.enumerate() if t.name.startswith("tdsf-invoke")]


@pytest.mark.parametrize("cancel_queued", [False, True])
def test_reload_preserves_queued_turn_lock_history_and_session_isolation(
    cancel_queued, tmp_path, monkeypatch,
):
    model_a = BarrierModel("A", barrier=True)
    model_b = BarrierModel("B")
    adapter = _adapter(tmp_path, monkeypatch, model_a)
    first_result, queued_result, other_result, followup_result = [], [], [], []
    workers = []
    try:
        first = _start(adapter, "same-session", "first-user", first_result)
        workers.append(first)
        assert model_a.entered.wait(5), "first turn never entered real SDK model"
        lock_key = next(key for key in adapter._agent_locks if key[1] == "same-session")
        original_lock = adapter._agent_locks[lock_key]
        attempted = threading.Event()
        observed_lock = ObservedLock(original_lock, attempted)
        adapter._agent_locks[lock_key] = observed_lock

        adapter.update_model(model_b)
        assert adapter._agent_locks.get(lock_key) is observed_lock, "model reload removed active session lock"
        queued = _start(adapter, "same-session", "queued-user", queued_result)
        workers.append(queued)
        assert attempted.wait(5), "queued turn did not attempt the real session lock"
        assert not model_b.entered.is_set(), "queued turn reached replacement model while A held lock"

        other = _start(adapter, "other-session", "other-user", other_result)
        workers.append(other)
        _join(other)
        assert other_result and "reply-B" in other_result[0]["observation"]
        assert model_b.entered.is_set(), "independent session never entered replacement model"
        if cancel_queued:
            adapter.request_cancel("same-session", "cancel queued turn")
        model_a.release.set()
        _join(first, queued)
        assert first_result
        if cancel_queued:
            assert not model_b.seen or all(
                not any("queued-user" in str(msg) for msg in call) for call in model_b.seen
            ), "cancelled queued turn reached replacement model"
            assert adapter._limit_hooks[("main", "same-session")].cancelled
            next_turn = _start(adapter, "same-session", "explicit-next", followup_result)
            workers.append(next_turn)
            _join(next_turn)
            assert followup_result and "reply-B" in followup_result[0]["observation"]
            assert "explicit-next" in str(model_b.seen[-1])
        else:
            assert queued_result and "reply-B" in queued_result[0]["observation"]
            assert any("first-user" in str(msg) for msg in model_b.seen[-1])
            assert any("reply-A" in str(msg) for msg in model_b.seen[-1])
            history = adapter._session_messages[("main", "same-session")]
            assert all(value in str(history) for value in (
                "first-user", "queued-user", "reply-A", "reply-B",
            ))
    finally:
        model_a.release.set()
        _join(*workers)
        _assert_no_invoke_workers()


def test_queued_mode_turn_does_not_refresh_agent_before_lock(
    tmp_path, monkeypatch,
):
    model = BarrierModel("stable", barrier=True)
    adapter = _adapter(tmp_path, monkeypatch, model)
    refresh_calls = []
    original_refresh = adapter._refresh_agent_runtime

    def observe_refresh(*args, **kwargs):
        refresh_calls.append((args, kwargs))
        return original_refresh(*args, **kwargs)

    monkeypatch.setattr(adapter, "_refresh_agent_runtime", observe_refresh)
    first_result, second_result = [], []
    workers = []
    try:
        first = _start(adapter, "mode-session", "first", first_result, mode="confirm")
        workers.append(first)
        assert model.entered.wait(5), "first turn never entered model"
        assert len(refresh_calls) == 1
        key = next(key for key in adapter._agent_locks if key[1] == "mode-session")
        adapter._agent_locks[key] = ObservedLock(adapter._agent_locks[key], threading.Event())
        observed = adapter._agent_locks[key].attempted
        second = _start(adapter, "mode-session", "second", second_result, mode="auto")
        workers.append(second)
        assert observed.wait(5), "second turn did not reach session lock"
        assert len(refresh_calls) == 1, "queued turn refreshed live Agent before acquiring lock"
        model.release.set()
        _join(first, second)
        assert first_result and second_result
        assert len(refresh_calls) >= 2
        from strands_backend.adapter import _compose_system_prompt
        from strands_backend.modes import AgentMode

        agent = adapter._agent_cache[key]
        assert agent.system_prompt == _compose_system_prompt(
            AgentMode.AUTO, False, base=adapter.system_prompt,
        )
    finally:
        model.release.set()
        _join(*workers)
        _assert_no_invoke_workers()


def test_queued_turn_degrades_after_model_is_removed(tmp_path, monkeypatch):
    import strands_backend.adapter as adapter_module

    model_a = BarrierModel("A", barrier=True)
    adapter = _adapter(tmp_path, monkeypatch, model_a)
    sdk_agent = adapter_module._StrandsAgent
    constructed_models = []

    def construct_agent(*args, **kwargs):
        model = kwargs.get("model")
        assert model is not None, "SDK Agent must never be constructed without a model"
        constructed_models.append(model)
        return sdk_agent(*args, **kwargs)

    monkeypatch.setattr(adapter_module, "_StrandsAgent", construct_agent)
    first_result, queued_result = [], []
    workers = []
    try:
        first = _start(adapter, "removed-model", "first-user", first_result)
        workers.append(first)
        assert model_a.entered.wait(5), "first turn never entered real SDK model"
        key = next(key for key in adapter._agent_locks if key[1] == "removed-model")
        attempted = threading.Event()
        adapter._agent_locks[key] = ObservedLock(adapter._agent_locks[key], attempted)

        queued = _start(adapter, "removed-model", "queued-user", queued_result)
        workers.append(queued)
        assert attempted.wait(5), "second turn did not queue on the real session lock"
        adapter.update_model(None)
        model_a.release.set()
        _join(first, queued)

        assert first_result
        assert queued_result and queued_result[0]["degraded"] is True
        assert queued_result[0]["degraded_reason"] == "strands_model_not_injected"
        assert len(model_a.seen) == 1, "queued turn called the removed model"
        assert constructed_models and all(model is not None for model in constructed_models)
    finally:
        model_a.release.set()
        _join(*workers)
        _assert_no_invoke_workers()
