from __future__ import annotations

import threading
from importlib.metadata import version
from unittest.mock import MagicMock

import pytest

import main
from rpc_request_context import agent_request_scope, current_agent_request_id
from strands_backend.adapter import StrandsAgentAdapter
from strands_backend.tools import tool


@pytest.fixture(autouse=True)
def _isolate_worker_state(tmp_path, monkeypatch):
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_IDLE_SECS", "1")
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

    def begin_turn(self, **_kwargs) -> None:
        pass


class _SdkToolAgent:
    """Fake only the model boundary; exercise the real SDK tool stream."""

    def __init__(self, sdk_tool) -> None:
        self.callback_handler = _Handler()
        self.messages: list = []
        self.sdk_tool = sdk_tool

    def __call__(self, _prompt: str) -> str:
        from strands._async import run_async

        async def run_tool():
            events = [
                event
                async for event in self.sdk_tool.stream(
                    {
                        "toolUseId": "rpc-context-tool",
                        "name": "rpc_context_probe",
                        "input": {},
                    },
                    {},
                )
            ]
            return events

        events = run_async(run_tool)
        assert events
        return "fixture tool completed"


def test_adapter_worker_context_reaches_real_strands_tool_thread():
    assert version("strands-agents") == "1.53.0"
    observed = []

    @tool
    def rpc_context_probe() -> int:
        """Return the active request id for a local fixture assertion."""
        request_id = current_agent_request_id()
        observed.append(request_id)
        return request_id if request_id is not None else -1

    agent = _SdkToolAgent(rpc_context_probe)
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    dispatcher = main.MethodDispatcher()
    dispatcher.register(
        "agent.invoke",
        lambda input, state: adapter.invoke("main", input, state),
    )

    result = main._dispatch_request(
        dispatcher,
        "agent.invoke",
        {"input": "fixture prompt", "state": {"session_id": "rpc-sdk-fixture"}},
        501,
    )

    assert result["observation"] == "fixture tool completed"
    assert observed == [501]


def test_adapter_timeout_invalidates_context_copied_by_late_worker(monkeypatch):
    from strands_backend import adapter as adapter_module

    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_IDLE_SECS", "0.05")
    monkeypatch.setenv("TDSF_INVOKE_WATCHDOG_POLL_SECS", "0.01")
    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    late_ids = []
    worker_threads = []
    original_thread = threading.Thread

    class RecordingThread(original_thread):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            worker_threads.append(self)

    monkeypatch.setattr(adapter_module.threading, "Thread", RecordingThread)

    class HangingAgent:
        callback_handler = _Handler()
        messages: list = []

        def __call__(self, _prompt: str) -> str:
            try:
                started.set()
                if not release.wait(timeout=3):
                    raise AssertionError("fixture model was not released")
                late_ids.append(current_agent_request_id())
                return "late fixture result"
            finally:
                finished.set()

    agent = HangingAgent()
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    dispatcher = main.MethodDispatcher()
    dispatcher.register(
        "agent.invoke",
        lambda input, state: adapter.invoke("main", input, state),
    )

    try:
        result = main._dispatch_request(
            dispatcher,
            "agent.invoke",
            {"input": "fixture timeout", "state": {"session_id": "rpc-late-fixture"}},
            601,
        )
        assert started.wait(timeout=1)
        assert result["degraded_reason"] == "invoke_watchdog_timeout"
        assert current_agent_request_id() is None

        with agent_request_scope(602):
            assert current_agent_request_id() == 602
            release.set()
            assert finished.wait(timeout=2), "late fixture worker did not exit"
            assert late_ids == [None]
            assert current_agent_request_id() == 602
    finally:
        release.set()
        assert finished.wait(timeout=2), "late fixture worker leaked"
        for worker_thread in worker_threads:
            worker_thread.join(timeout=2)
            assert not worker_thread.is_alive(), "adapter worker thread leaked"
