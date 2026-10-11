"""Real SDK tool-executor results must agree across diagnostic records."""
from __future__ import annotations

import asyncio
import json
from typing import Any
from collections.abc import AsyncGenerator, AsyncIterable

import pytest
from strands import Agent, tool
from strands.hooks.events import AfterToolCallEvent
from strands.models.model import Model
from strands.tools.executors import SequentialToolExecutor

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.knowledge_search import make_knowledge_search_tool


class RecordingBus:
    def __init__(self) -> None:
        self.tool_calls: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        from types import SimpleNamespace
        from strands_backend.agent_log import _handle_bus_event

        self.tool_calls.append(event)
        _handle_bus_event(SimpleNamespace(
            event_type="tool_call",
            payload=event,
            session_id=event.get("session_id"),
            source=event.get("source"),
        ))

    def emit_loop_progress(self, **event: Any) -> None:
        self.progress.append(event)


class NoModel(Model):
    def update_config(self, **model_config: Any) -> None:
        pass

    def get_config(self) -> dict[str, Any]:
        return {"model": "offline-test"}

    async def structured_output(self, *args: Any, **kwargs: Any) -> AsyncGenerator[Any, None]:
        raise AssertionError("structured model call unexpectedly reached")
        yield None

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncIterable[Any]:
        raise AssertionError("model stream unexpectedly reached")
        yield {}


async def _execute(agent: Agent, tool_use: dict[str, Any]) -> list[Any]:
    return [
        event
        async for event in agent.tool_executor._stream(
            agent, tool_use, [], {},
        )
    ]


def _make_agent(hook: ToolCallLimitHook, fn: Any) -> Agent:
    agent = Agent(
        model=NoModel(),
        tools=[fn],
        tool_executor=SequentialToolExecutor(),
    )
    hook.register_hooks(agent.hooks)
    return agent


def _tool_result(events: list[Any]) -> dict[str, Any]:
    from strands.types._events import ToolResultEvent

    result_events = [event for event in events if isinstance(event, ToolResultEvent)]
    assert len(result_events) == 1
    return result_events[0].tool_result


@pytest.fixture(autouse=True)
def _isolated_data(monkeypatch: pytest.MonkeyPatch, tmp_path: Any):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    from strands_backend.agent_log import reset_for_test

    reset_for_test()
    reset_global_tracker()
    yield
    reset_for_test()
    reset_global_tracker()


def test_sdk_cancel_keeps_sdk_error_but_diagnostics_agree_on_cancel() -> None:
    called: list[bool] = []

    @tool
    def assess_confidence(value: str) -> dict[str, str]:
        """Return a deterministic local fixture result."""
        called.append(True)
        return {"status": "success", "value": value}

    bus = RecordingBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="trace-cancel")
    hook.request_user_stop("fixture stop")
    agent = _make_agent(hook, assess_confidence)
    sdk_id = "sdk-cancel-101"
    events = asyncio.run(_execute(agent, {
        "toolUseId": sdk_id,
        "name": "assess_confidence",
        "input": {"value": "fixture"},
    }))

    sdk_result = _tool_result(events)
    assert sdk_result["status"] == "error"
    assert "fixture stop" in sdk_result["content"][0]["text"]
    assert not called
    assert bus.tool_calls[-1]["result"]["status"] == "cancelled"
    assert hook.tool_log[-1]["status"] == "cancelled"
    assert hook.tool_log[-1]["success"] is False
    assert bus.progress[-1]["status"] == "cancelled"
    evidence = get_global_tracker().list("trace-cancel")
    assert len(evidence) == 1
    assert evidence[0]["status"] == "cancelled"
    assert evidence[0]["result_status"] == "cancelled"
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert hook.failures_by_tool["assess_confidence"] == 1
    assert "duration_ms" not in hook.tool_log[-1]
    progress = _logged_progress("trace-cancel")[-1]
    assert progress["meta"]["status"] == "cancelled"
    assert progress["meta"]["tool_call_id"] == sdk_id
    assert progress["meta"]["sdk_tool_use_id"] == sdk_id
    assert "duration_ms" not in progress["meta"]
    logged_result = [
        line for line in _logged_tool_calls("trace-cancel")
        if line["type"] == "tool_result"
    ][-1]
    assert json.loads(logged_result["content"])["status"] == "cancelled"


def test_success_calls_keep_distinct_ids_in_logs_progress_and_evidence() -> None:
    @tool
    def assess_confidence(value: str) -> dict[str, str]:
        """Return a deterministic local fixture result."""
        return {"status": "success", "value": value}

    bus = RecordingBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="trace-success")
    agent = _make_agent(hook, assess_confidence)
    sdk_ids = ["sdk-success-201", "sdk-success-202"]
    for sdk_id in sdk_ids:
        events = asyncio.run(_execute(agent, {
            "toolUseId": sdk_id,
            "name": "assess_confidence",
            "input": {"value": "fixture"},
        }))
        assert _tool_result(events)["status"] == "success"

    assert len(hook.tool_log) == 2
    assert len(bus.progress) == 2
    assert all(entry["duration_ms"] >= 0 for entry in hook.tool_log)
    assert [entry["sdk_tool_use_id"] for entry in hook.tool_log] == sdk_ids
    assert [entry["tool_call_id"] for entry in hook.tool_log] == sdk_ids
    assert [entry["status"] for entry in hook.tool_log] == ["success", "success"]
    logged = _logged_progress("trace-success")
    progress_ids = [entry["meta"].get("sdk_tool_use_id") for entry in logged]
    assert progress_ids == sdk_ids
    tool_lines = _logged_tool_calls("trace-success")
    assert [line["meta"].get("tool_call_id") for line in tool_lines if line["type"] == "tool_result"] == sdk_ids
    evidence = get_global_tracker().list("trace-success")
    assert [item["sdk_tool_use_id"] for item in evidence] == sdk_ids
    assert [item["tool_call_id"] for item in evidence] == [
        event["tool_call_id"] for event in bus.tool_calls if event["status"] == "started"
    ]


def _logged_progress(session_id: str) -> list[dict[str, Any]]:
    from strands_backend.agent_log import tail

    return [line for line in tail(session_id=session_id, lines=20)["lines"] if line["type"] == "loop_progress"]


def _logged_tool_calls(session_id: str) -> list[dict[str, Any]]:
    from strands_backend.agent_log import tail

    return [line for line in tail(session_id=session_id, lines=40)["lines"] if line["type"] in {"tool_call", "tool_result"}]


def test_sdk_exception_and_indeterminate_remain_distinct() -> None:
    @tool
    def assess_confidence(value: str) -> dict[str, str]:
        """Return a deterministic local fixture outcome."""
        if value == "raise":
            raise RuntimeError("fixture failure")
        return {"status": "indeterminate", "exit_code": -1, "value": value}

    bus = RecordingBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="trace-outcomes")
    agent = _make_agent(hook, assess_confidence)
    for sdk_id, value in (("sdk-error-301", "raise"), ("sdk-unknown-302", "unknown")):
        events = asyncio.run(_execute(agent, {
            "toolUseId": sdk_id,
            "name": "assess_confidence",
            "input": {"value": value},
        }))
        assert _tool_result(events)["status"] == ("error" if value == "raise" else "success")

    assert hook.tool_log[0]["status"] == "error"
    assert bus.progress[0]["status"] == "failed"
    assert hook.failures_by_tool["assess_confidence"] == 1
    assert hook.tool_log[1]["status"] == "indeterminate"
    assert bus.progress[1]["status"] == "indeterminate"
    assert hook.failures_by_tool["assess_confidence"] == 1
    unknown_result = bus.tool_calls[-1]["result"]
    assert unknown_result["exit_code"] == -1
    assert get_global_tracker().list("trace-outcomes")[1]["result_status"] == "indeterminate"
    assert "exit_code" not in get_global_tracker().list("trace-outcomes")[1]


def test_reference_tool_call_keeps_its_uuid_distinct_from_sdk_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "fixture", "content": "local result"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingBus()
    session_id = "trace-reference"
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    tool_fn = make_knowledge_search_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id=session_id)
    )
    agent = _make_agent(hook, tool_fn)
    sdk_id = "sdk-reference-401"
    result = _tool_result(asyncio.run(_execute(agent, {
        "toolUseId": sdk_id,
        "name": "knowledge_search",
        "input": {"query": "fixture"},
    })))

    assert result["status"] == "success"
    started, completed = bus.tool_calls
    reference_id = started["tool_call_id"]
    assert reference_id != sdk_id
    assert completed["tool_call_id"] == reference_id
    assert hook.tool_log[-1]["tool_call_id"] == reference_id
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    progress = _logged_progress(session_id)[-1]["meta"]
    assert progress["tool_call_id"] == reference_id
    assert progress["sdk_tool_use_id"] == sdk_id
    logged_results = [line for line in _logged_tool_calls(session_id) if line["type"] == "tool_result"]
    assert logged_results[-1]["meta"]["tool_call_id"] == reference_id
    evidence = get_global_tracker().list(session_id)
    assert len(evidence) == 1
    assert evidence[0]["tool_call_id"] == reference_id
    assert evidence[0]["sdk_tool_use_id"] == sdk_id


def test_after_event_without_a_card_does_not_invent_card_identity() -> None:
    bus = RecordingBus()
    session_id = "trace-unmapped"
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    sdk_id = "sdk-unmapped-501"
    hook._after_tool_call(AfterToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": sdk_id, "name": "fixture_unmapped", "input": {}},
        invocation_state={},
        result={"toolUseId": sdk_id, "status": "success", "content": [{"text": "ok"}]},
    ))

    assert bus.tool_calls == []
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    assert "tool_call_id" not in hook.tool_log[-1]
    progress = _logged_progress(session_id)[-1]["meta"]
    assert progress["sdk_tool_use_id"] == sdk_id
    assert "tool_call_id" not in progress
    evidence = get_global_tracker().list(session_id)
    assert len(evidence) == 1
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert "tool_call_id" not in evidence[0]
