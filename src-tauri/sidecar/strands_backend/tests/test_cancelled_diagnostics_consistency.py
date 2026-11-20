"""Business cancellation must agree across SDK cards, progress, evidence and export."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from strands import Agent, tool
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.models.model import Model
from strands.tools.executors import SequentialToolExecutor
from strands.tools.registry import ToolRegistry

from event_bus import EventBus, EventType
from needs_you import NeedsYouService
from strands_backend.adapter import ToolCallLimitHook
from strands_backend.agent_log import _handle_bus_event, reset_for_test, tail
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.ask_user import make_ask_user_tool


class RecordingEventBus(EventBus):
    """Use the real EventBus delivery path while retaining assertions locally."""

    def __init__(self) -> None:
        super().__init__(rust_notifier=lambda *_args: None)
        self.tool_calls: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []
        self.subscribe(
            _handle_bus_event,
            event_type=EventType.TOOL_CALL.value,
            name="test-agent-log-tool-call",
        )
        self.subscribe(
            _handle_bus_event,
            event_type=EventType.LOOP_PROGRESS.value,
            name="test-agent-log-progress",
        )

    def emit_tool_call(self, **event: Any) -> None:
        self.tool_calls.append(event)
        super().emit_tool_call(**event)

    def emit_loop_progress(self, **event: Any) -> None:
        self.progress.append(event)
        super().emit_loop_progress(**event)


class NoModel(Model):
    def update_config(self, **model_config: Any) -> None:
        pass

    def get_config(self) -> dict[str, Any]:
        return {"model": "offline-test"}

    async def structured_output(self, *args: Any, **kwargs: Any):
        raise AssertionError("unexpected model call")
        yield None

    async def stream(self, *args: Any, **kwargs: Any):
        raise AssertionError("unexpected model call")
        yield {}


def _make_agent(hook: ToolCallLimitHook, tool_fn: Any) -> Agent:
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    agent = Agent(model=NoModel(), tools=[tool_fn], tool_executor=SequentialToolExecutor())
    hook.register_hooks(agent.hooks)
    return agent


def _execute(agent: Agent, tool_name: str, tool_input: dict[str, Any], sdk_id: str) -> dict[str, Any]:
    async def run():
        events = [
            event async for event in agent.tool_executor._stream(
                agent,
                {"toolUseId": sdk_id, "name": tool_name, "input": tool_input},
                [],
                {},
            )
        ]
        from strands.types._events import ToolResultEvent

        results = [event.tool_result for event in events if isinstance(event, ToolResultEvent)]
        assert len(results) == 1
        return results[0]

    return asyncio.run(run())


@pytest.fixture(autouse=True)
def _isolated_logs(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    reset_global_tracker()
    yield
    reset_for_test()
    reset_global_tracker()


def _assert_trace(
    session_id: str,
    sdk_id: str,
    expected: str,
    sdk_result: dict[str, Any],
    *,
    expected_sdk_status: str = "success",
) -> None:
    evidence = get_global_tracker().list(session_id)
    assert len(evidence) == 1
    assert evidence[0]["status"] == expected
    assert evidence[0]["result_status"] == expected
    assert evidence[0]["sdk_tool_use_id"] == sdk_id

    entries = tail(session_id=session_id, lines=30)["lines"]
    result_line = [entry for entry in entries if entry["type"] == "tool_result"][-1]
    progress_line = [entry for entry in entries if entry["type"] == "loop_progress"][-1]
    assert result_line["meta"]["tool_call_id"] == evidence[0]["tool_call_id"]
    assert progress_line["meta"]["sdk_tool_use_id"] == sdk_id
    assert progress_line["meta"]["status"] == expected
    assert sdk_result["status"] == expected_sdk_status
    assert sdk_result["content"]


@pytest.mark.parametrize("content_kind", ["text", "json"])
def test_business_cancelled_text_or_json_content_is_consistent_and_exported(content_kind: str) -> None:
    session_id = f"cancel-{content_kind}"
    sdk_id = f"sdk-cancel-{content_kind}"

    @tool
    def ask_user() -> dict[str, str]:
        """Return a deterministic business cancellation."""
        return {"status": "cancelled", "message": "user cancelled question"}

    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    if content_kind == "json":
        # Feed Strands' supported structured content-block representation through
        # the actual HookEvent classes and the same production hook callback.
        agent = Agent(model=NoModel(), tools=[ask_user], tool_executor=SequentialToolExecutor())
        registry = ToolRegistry()
        registry.process_tools([ask_user])
        assert "ask_user" in registry.registry
        hook.register_hooks(agent.hooks)
        tool_use = {"toolUseId": sdk_id, "name": "ask_user", "input": {}}
        hook._before_tool_call(BeforeToolCallEvent(
            agent=agent, selected_tool=None, tool_use=tool_use, invocation_state={},
        ))
        sdk_result = {
            "toolUseId": sdk_id,
            "status": "success",
            "content": [{"json": {"status": "cancelled", "message": "user cancelled question"}}],
        }
        hook._after_tool_call(AfterToolCallEvent(
            agent=agent, selected_tool=None, tool_use=tool_use,
            invocation_state={}, result=sdk_result,
        ))
    else:
        agent = _make_agent(hook, ask_user)
        sdk_result = _execute(agent, "ask_user", {}, sdk_id)

    _assert_trace(session_id, sdk_id, "cancelled", sdk_result)
    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert bus.tool_calls[-1]["result"]["status"] == "cancelled"
    assert bus.progress[-1]["status"] == "cancelled"
    assert hook.tool_log[-1]["status"] == "cancelled"
    assert hook.tool_log[-1]["tool_call_id"] == sdk_id

    indeterminate_id = "sdk-export-indeterminate"
    indeterminate_use = {"toolUseId": indeterminate_id, "name": "ask_user", "input": {}}
    hook._before_tool_call(BeforeToolCallEvent(
        agent=agent, selected_tool=None, tool_use=indeterminate_use, invocation_state={},
    ))
    indeterminate_result = {
        "toolUseId": indeterminate_id,
        "status": "success",
        "content": [{"json": {"status": "indeterminate", "exit_code": -1}}],
    }
    hook._after_tool_call(AfterToolCallEvent(
        agent=agent, selected_tool=None, tool_use=indeterminate_use,
        invocation_state={}, result=indeterminate_result,
    ))

    from strands_backend.diagnostics import export_snapshot

    log_snapshot = tail(session_id=session_id, lines=30)
    snapshot = {
        "schema_version": 1,
        "session_id": session_id,
        "sources": {
            "journal": {"status": "ready", "data": log_snapshot},
            "evidence": {"status": "ready", "data": get_global_tracker().list(session_id)},
        },
    }
    exported = export_snapshot(session_id, snapshot)
    saved = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
    exported_evidence = saved["sources"]["evidence"]["data"]
    assert [item["status"] for item in exported_evidence] == ["cancelled", "indeterminate"]
    assert [item["result_status"] for item in exported_evidence] == ["cancelled", "indeterminate"]
    assert all("exit_code" not in item for item in exported_evidence)
    assert sdk_result["status"] == "success"
    assert sdk_result["content"]


def test_real_ask_user_needs_you_cancel_is_recorded_as_business_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    from strands_backend.tools import ask_user as ask_user_module

    session_id = "ask-user-cancel"

    class CancelOnCreatedBus(RecordingEventBus):
        service: NeedsYouService

        def emit_needs_you(self, **event: Any) -> int:
            count = super().emit_needs_you(**event)
            if event.get("event") == "created":
                self.service.cancel(event["request"]["id"], reason="test cancellation")
            return count

    bus = CancelOnCreatedBus()
    service = NeedsYouService(event_bus=bus)
    bus.service = service
    monkeypatch.setattr(ask_user_module, "get_global_service", lambda: service)
    tool_fn = make_ask_user_tool(ToolContext(event_bus=bus, agent_name="main", session_id=session_id))
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    agent = _make_agent(hook, tool_fn)
    sdk_id = "sdk-real-ask-user-cancel"

    sdk_result = _execute(agent, "ask_user", {"question": "Continue?"}, sdk_id)
    assert sdk_result["status"] == "success"
    payload = hook._tool_payload(sdk_result)
    assert payload["status"] == "cancelled"
    _assert_trace(session_id, sdk_id, "cancelled", sdk_result)
    assert hook.failures_by_tool["ask_user"] == 1


def test_direct_cancelled_status_and_sdk_cancel_message_are_distinct_fallbacks() -> None:
    session_id = "cancel-direct-sdk"
    sdk_id = "sdk-direct-cancel"
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    tool_use = {"toolUseId": sdk_id, "name": "ask_user", "input": {"question": "Continue?"}}
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={},
    ))
    sdk_result = {"toolUseId": sdk_id, "status": "cancelled", "content": [{"text": "cancelled"}]}
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={}, result=sdk_result,
    ))
    _assert_trace(
        session_id, sdk_id, "cancelled", sdk_result, expected_sdk_status="cancelled",
    )

    cancel_session = "cancel-sdk-wrapper"
    cancel_id = "sdk-cancel-wrapper"
    cancel_hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=cancel_session)
    cancel_use = {"toolUseId": cancel_id, "name": "ask_user", "input": {}}
    cancel_hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=cancel_use, invocation_state={},
    ))
    wrapped_result = {"toolUseId": cancel_id, "status": "error", "content": [{"text": "stopped"}]}
    cancel_hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=cancel_use, invocation_state={},
        result=wrapped_result, cancel_message="user stopped",
    ))
    evidence = get_global_tracker().list(cancel_session)
    assert len(evidence) == 1
    assert evidence[0]["status"] == "cancelled"
    assert evidence[0]["result_status"] == "cancelled"
    assert cancel_hook.tool_log[-1]["status"] == "cancelled"
    assert bus.progress[-1]["status"] == "cancelled"
    assert wrapped_result["status"] == "error"


@pytest.mark.parametrize(
    ("business_status", "expected_evidence", "expected_progress"),
    [("indeterminate", "indeterminate", "indeterminate"), ("error", "error", "failed"), ("success", "completed", "success")],
)
def test_other_business_outcomes_keep_their_existing_evidence_status(
    business_status: str, expected_evidence: str, expected_progress: str,
) -> None:
    session_id = f"outcome-{business_status}"
    sdk_id = f"sdk-{business_status}"
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    tool_use = {"toolUseId": sdk_id, "name": "ask_user", "input": {}}
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={},
    ))
    sdk_result = {"toolUseId": sdk_id, "status": "success", "content": [{"json": {"status": business_status}}]}
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={}, result=sdk_result,
    ))
    evidence = get_global_tracker().list(session_id)
    assert len(evidence) == 1
    assert evidence[0]["status"] == expected_evidence
    assert evidence[0]["result_status"] == business_status
    assert bus.progress[-1]["status"] == expected_progress
    assert hook.tool_log[-1]["status"] == business_status
    assert sdk_result["status"] == "success"


def test_via_ssh_executor_owned_cancelled_evidence_is_not_duplicated() -> None:
    session_id = "ssh-owned-cancel"
    sdk_id = "sdk-ssh-owned-cancel"
    tracker = get_global_tracker()
    tracker.record(
        session_id=session_id,
        tool_name="ssh_command",
        status="cancelled",
        result={"status": "cancelled", "message": "execution cancelled"},
        sdk_tool_use_id=sdk_id,
    )
    hook = ToolCallLimitHook(agent_name="main", session_id=session_id)
    tool_use = {"toolUseId": sdk_id, "name": "ssh_command", "input": {"command": "safe fixture"}}
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={},
        result={"toolUseId": sdk_id, "status": "success", "content": [{"json": {"status": "cancelled"}}]},
    ))
    evidence = tracker.list(session_id)
    assert len(evidence) == 1
    assert evidence[0]["status"] == "cancelled"


def test_exception_remains_error_over_business_cancel_payload() -> None:
    session_id = "exception-over-cancel"
    sdk_id = "sdk-exception-over-cancel"
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    tool_use = {"toolUseId": sdk_id, "name": "ask_user", "input": {}}
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={},
    ))
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state={},
        result={
            "toolUseId": sdk_id,
            "status": "success",
            "content": [{"json": {"status": "cancelled", "message": "business cancel payload"}}],
        },
        exception=RuntimeError("real failure"),
    ))
    evidence = get_global_tracker().list(session_id)
    assert len(evidence) == 1
    assert evidence[0]["status"] == "error"
    assert evidence[0]["result_status"] == "error"
    assert hook.tool_log[-1]["status"] == "error"
    assert bus.progress[-1]["status"] == "failed"
    assert bus.tool_calls[-1]["status"] == "error"
