"""Tool cards from real Strands hook events should have one owner per call.

secret-scan: fixture — the long credential-shaped token below is synthetic test data.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.tools import ToolContext
from strands_backend.tools.registry import TOOL_REGISTRY


class RecordingEventBus:
    def __init__(self) -> None:
        self.tool_calls: list[dict] = []

    def emit_tool_call(self, **event: object) -> None:
        self.tool_calls.append(event)

    def emit_loop_progress(self, **_: object) -> None:
        pass


def _before(tool_name: str, call_id: str, tool_input: dict) -> BeforeToolCallEvent:
    return BeforeToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": call_id, "name": tool_name, "input": tool_input},
        invocation_state={},
    )


def _after(
    tool_name: str,
    call_id: str,
    result: dict,
    *,
    exception: Exception | None = None,
    cancel_message: str | None = None,
) -> AfterToolCallEvent:
    return AfterToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": call_id, "name": tool_name, "input": {"query": "status"}},
        invocation_state={},
        result={
            "toolUseId": call_id,
            "status": "success",
            "content": [{"text": json.dumps(result, ensure_ascii=False)}],
        },
        exception=exception,
        cancel_message=cancel_message,
    )


def test_non_owner_tool_emits_started_and_business_result_with_same_sdk_id() -> None:
    spec = TOOL_REGISTRY["assess_confidence"]
    assert not spec.emits_tool_events and not spec.policy.via_ssh_executor

    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="card-coverage-success")
    tool_input = {"evidences": [{"source": "log", "text": "service active"}]}
    call_id = "sdk-call-42"
    hook._before_tool_call(_before("assess_confidence", call_id, tool_input))
    result = {"status": "success", "score": 0.82, "method": "D-S+PCR5", "evidence_count": 1}
    hook._after_tool_call(_after("assess_confidence", call_id, result))

    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert [event["tool_call_id"] for event in bus.tool_calls] == [call_id, call_id]
    assert bus.tool_calls[-1]["result"] == result


def test_get_terminal_output_real_sdk_events_preserve_and_redact_json_payload() -> None:
    spec = TOOL_REGISTRY["get_terminal_output"]
    assert not spec.emits_tool_events and not spec.policy.via_ssh_executor

    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="card-terminal-output")
    call_id = "sdk-terminal-12"
    token = "sk-proj-abcdefghijklmnopqrstuvwxyz012345"
    tool_input = {"lines": 37, "query": f"Authorization: Bearer {token}"}
    hook._before_tool_call(_before("get_terminal_output", call_id, tool_input))
    business_result = {
        "output": f"Authorization: Bearer {token}",
        "available": True,
        "lines_returned": 37,
        "metadata": {"attempt": 2, "labels": ["terminal", f"token={token}"]},
    }
    hook._after_tool_call(AfterToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": call_id, "name": "get_terminal_output", "input": tool_input},
        invocation_state={},
        result={
            "toolUseId": call_id,
            "status": "success",
            "content": [{"json": business_result}],
        },
    ))

    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert [event["tool_call_id"] for event in bus.tool_calls] == [call_id, call_id]
    started_params = bus.tool_calls[0]["params"]
    completed_result = bus.tool_calls[-1]["result"]
    assert started_params["lines"] == 37
    assert started_params["query"].startswith("Authorization: Bearer <REDACTED")
    assert completed_result["available"] is True
    assert completed_result["lines_returned"] == 37
    assert completed_result["metadata"]["attempt"] == 2
    assert completed_result["metadata"]["labels"][0] == "terminal"
    assert token not in json.dumps(completed_result)
    assert "<REDACTED" in completed_result["output"]


def test_tool_with_existing_event_owner_is_not_emitted_again_by_hook() -> None:
    spec = TOOL_REGISTRY["read_remote_file"]
    assert spec.emits_tool_events

    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="card-coverage-owner")
    call_id = "sdk-owner-9"
    hook._before_tool_call(_before("read_remote_file", call_id, {"path": "/etc/os-release"}))
    hook._after_tool_call(_after("read_remote_file", call_id, {"status": "success", "content": "ok"}))

    assert bus.tool_calls == []


def test_tool_routed_through_ssh_executor_is_not_emitted_again_by_hook() -> None:
    spec = TOOL_REGISTRY["ssh_command"]
    assert spec.policy.via_ssh_executor

    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="card-coverage-ssh-owner")
    call_id = "sdk-ssh-owner-4"
    hook._before_tool_call(_before("ssh_command", call_id, {"command": "uptime"}))
    hook._after_tool_call(_after("ssh_command", call_id, {"status": "success", "output": "up"}))

    assert bus.tool_calls == []


def test_every_shell_mapped_tool_has_an_existing_card_owner() -> None:
    unmapped = sorted(
        spec.name
        for spec in TOOL_REGISTRY.values()
        if spec.to_shell_command
        and not (spec.emits_tool_events or spec.policy.via_ssh_executor)
    )
    assert not unmapped, f"shell-mapped tools without a card owner: {unmapped}"


def test_sdk_exception_closes_the_started_card_as_error() -> None:
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="card-coverage-error")
    call_id = "sdk-error-3"
    hook._before_tool_call(_before("assess_confidence", call_id, {}))
    hook._after_tool_call(
        _after("assess_confidence", call_id, {}, exception=RuntimeError("tool failed"))
    )

    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
    assert {event["tool_call_id"] for event in bus.tool_calls} == {call_id}
    assert bus.tool_calls[-1]["result"]["status"] == "error"
    assert "tool failed" in bus.tool_calls[-1]["result"]["message"]


def test_sdk_cancellation_closes_the_started_card_with_cancel_result() -> None:
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="card-coverage-cancel")
    call_id = "sdk-cancel-5"
    hook._before_tool_call(_before("assess_confidence", call_id, {}))
    after = _after(
        "assess_confidence", call_id, {}, cancel_message="cancelled by user"
    )
    hook._after_tool_call(after)

    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert {event["tool_call_id"] for event in bus.tool_calls} == {call_id}
    assert bus.tool_calls[-1]["result"] == {
        "status": "cancelled",
        "message": "cancelled by user",
    }


def test_python_run_factory_pairs_started_and_completed_uuid(tmp_path: Path) -> None:
    import importlib

    python_run_module = importlib.import_module("strands_backend.tools.python_run")
    from strands_backend.tools.python_run import make_python_run_tool

    bus = RecordingEventBus()
    ctx = ToolContext(
        event_bus=bus,
        agent_name="main",
        session_id="factory-python-success",
        workspace=str(tmp_path),
    )
    result = {"status": "success", "exit_code": 0, "stdout": "ok", "stderr": ""}
    with patch.object(python_run_module, "_execute_python", return_value=result) as execute:
        tool = make_python_run_tool(ctx)
        returned = tool(code="print('ok')")

    execute.assert_called_once()
    assert returned == result
    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert len({event["tool_call_id"] for event in bus.tool_calls}) == 1
    assert bus.tool_calls[0]["tool_call_id"]


def test_python_run_factory_exception_emits_error_with_started_uuid(tmp_path: Path) -> None:
    import importlib

    python_run_module = importlib.import_module("strands_backend.tools.python_run")
    from strands_backend.tools.python_run import make_python_run_tool

    bus = RecordingEventBus()
    ctx = ToolContext(
        event_bus=bus,
        agent_name="main",
        session_id="factory-python-error",
        workspace=str(tmp_path),
    )
    with patch.object(python_run_module, "_execute_python", side_effect=RuntimeError("executor failed")):
        tool = make_python_run_tool(ctx)
        try:
            tool(code="print('ok')")
        except RuntimeError as error:
            assert str(error) == "executor failed"
        else:
            raise AssertionError("python_run factory must propagate the executor exception")

    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
    assert len({event["tool_call_id"] for event in bus.tool_calls}) == 1
    assert "executor failed" in bus.tool_calls[-1]["result"]["message"]


def test_suggest_command_factory_pairs_started_and_completed_uuid() -> None:
    from strands_backend.tools.suggest_command import make_suggest_command_tool

    bus = RecordingEventBus()
    ctx = ToolContext(event_bus=bus, agent_name="main", session_id="factory-suggest-success")
    tool = make_suggest_command_tool(ctx)
    result = tool(intent="查看内存使用", target_os="windows")

    assert result["status"] == "success"
    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert len({event["tool_call_id"] for event in bus.tool_calls}) == 1
    assert bus.tool_calls[0]["tool_call_id"]
    assert bus.tool_calls[0]["params"]["path"] == ""


def test_suggest_command_factory_exception_emits_error_with_started_uuid() -> None:
    import importlib

    suggest_module = importlib.import_module("strands_backend.tools.suggest_command")
    from strands_backend.tools.suggest_command import make_suggest_command_tool

    bus = RecordingEventBus()
    ctx = ToolContext(event_bus=bus, agent_name="main", session_id="factory-suggest-error")
    with patch.object(suggest_module, "_match_suggestion", side_effect=RuntimeError("matcher failed")):
        tool = make_suggest_command_tool(ctx)
        try:
            tool(intent="查看内存使用", target_os="windows")
        except RuntimeError as error:
            assert str(error) == "matcher failed"
        else:
            raise AssertionError("suggest_command factory must propagate the matcher exception")

    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
    assert len({event["tool_call_id"] for event in bus.tool_calls}) == 1
    assert "matcher failed" in bus.tool_calls[-1]["result"]["message"]
