"""SSH SDK calls retain the identity of their UI card and evidence."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import patch

import pytest
from needs_you import NeedsYouStatus
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.tools.registry import ToolRegistry

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import DefaultRustBridge, ToolContext, wrap_tool_for_teach_mode
from strands_backend.tools.ssh_command import invoke_ssh_command_tool, make_ssh_command_tool
from strands_backend.tools.tool_lifecycle import take_reference_tool_call_id


class EventBus:
    def __init__(self) -> None:
        self.cards: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.cards.append(event)

    def emit_loop_progress(self, **event: Any) -> None:
        self.progress.append(event)


class FakeRust:
    def __init__(self, *, exit_code: int = 0) -> None:
        self.exit_code = exit_code
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((method, params))
        if method == "ssh_status":
            assert params == {}
            return [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                     "user": "qa", "state": "connected"}]
        assert method == "ssh_command"
        result = {
            "ok": True,
            "exitCode": self.exit_code,
            "output": "qa output\n",
            "stderr": "qa diagnostic\n" if self.exit_code else "",
            "duration": 0.01,
        }
        if "operationId" in params:
            result["operationId"] = params["operationId"]
        return result


def _sdk_result(tool_fn: Any, tool_use: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    async def run_stream():
        return [event async for event in tool_fn.stream(tool_use, state)]

    return asyncio.run(run_stream())[-1].tool_result


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    for block in result["content"]:
        if isinstance(block.get("json"), dict):
            return block["json"]
        if isinstance(block.get("text"), str):
            value = json.loads(block["text"])
            assert isinstance(value, dict)
            return value
    pytest.fail("SDK result has no business payload")


def _invoke_sdk(
    tool_fn: Any,
    bus: EventBus,
    state: dict[str, Any],
    sdk_id: str,
    *,
    command: str = "pwd",
    before_after: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
    state.setdefault("agent", object())
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry["ssh_command"].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]) == {"command", "ssh_session_id", "explanation", "timeout"}
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in schema["required"]

    tool_use = {
        "toolUseId": sdk_id,
        "name": "ssh_command",
        "input": {"command": command, "ssh_session_id": "17", "explanation": "检查状态"},
    }
    card_offset = len(bus.cards)
    evidence_before = len([
        item for item in get_global_tracker().list("ssh-sdk-identity")
        if item.get("tool_name") == "ssh_command"
    ])
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="ssh-sdk-identity")
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state,
    ))
    result = _sdk_result(tool_fn, tool_use, state)
    if before_after is not None:
        before_after(tool_use, state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state, result=result,
    ))

    cards = [event for event in bus.cards[card_offset:]
             if event.get("tool_name") == "ssh_command"]
    evidence = [item for item in get_global_tracker().list("ssh-sdk-identity")
                if item.get("tool_name") == "ssh_command"][evidence_before:]
    assert len(cards) == 2
    assert cards[0]["tool_call_id"] == cards[1]["tool_call_id"]
    assert cards[0]["tool_call_id"] != sdk_id
    assert len(evidence) == 1
    assert evidence[0]["tool_call_id"] == cards[0]["tool_call_id"]
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    assert hook.tool_log[-1]["tool_call_id"] == cards[0]["tool_call_id"]
    assert bus.progress
    return tool_use, cards, evidence[0], result


@pytest.fixture(autouse=True)
def _reset_evidence():
    reset_global_tracker()
    yield
    reset_global_tracker()


@pytest.mark.parametrize(
    ("command", "exit_code", "expected"),
    [("pwd", 0, "success"), ("ls /qa/missing", 2, "success")],
    ids=["success", "readonly-nonzero"],
)
def test_ssh_sdk_success_and_readonly_nonzero_keep_sdk_identity(command, exit_code, expected):
    rust, bus = FakeRust(exit_code=exit_code), EventBus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="ssh-sdk-identity",
                      ssh_session_id="17", mode="confirm")
    tool_fn = make_ssh_command_tool(ctx)
    tool_use, cards, evidence, sdk_result = _invoke_sdk(
        tool_fn, bus, {}, "qa-sdk-call-ssh_command", command=command,
    )
    payload = _payload(sdk_result)
    assert payload["status"] == expected and payload["exit_code"] == exit_code
    assert evidence["sdk_tool_use_id"] == tool_use["toolUseId"]
    assert [method for method, _ in rust.calls].count("ssh_command") == 1
    assert [event["status"] for event in cards] == ["started", "completed"]


@pytest.mark.parametrize(
    ("command", "mode", "approval", "bridge", "expected", "dispatches"),
    [
        ("rm -rf /", "confirm", None, "fake", "command_blocked", 0),
        ("touch /qa/marker", "confirm", NeedsYouStatus.REJECTED, "fake", "rejected", 0),
        ("touch /qa/marker", "confirm", NeedsYouStatus.CANCELLED, "fake", "cancelled", 0),
        ("pwd", "confirm", None, "unavailable", "unavailable", 0),
    ],
    ids=["blocked", "rejected", "cancelled", "unavailable"],
)
def test_ssh_sdk_non_success_outcomes_keep_identity(
    command, mode, approval, bridge, expected, dispatches,
):
    rust = DefaultRustBridge() if bridge == "unavailable" else FakeRust()
    bus = EventBus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="ssh-sdk-identity",
                      ssh_session_id="17", mode=mode)
    tool_fn = make_ssh_command_tool(ctx)
    approved = SimpleNamespace(status=approval, response=None) if approval else None
    with patch("strands_backend.tools.request_approval_and_wait", return_value=approved):
        tool_use, cards, evidence, sdk_result = _invoke_sdk(
            tool_fn, bus, {}, "qa-sdk-call-ssh_command", command=command,
        )
    assert _payload(sdk_result)["status"] == expected
    assert evidence["sdk_tool_use_id"] == tool_use["toolUseId"]
    assert [event["status"] for event in cards] == ["started", "error"]
    assert len(getattr(rust, "calls", [])) == dispatches


def test_two_same_command_sdk_calls_do_not_share_identity_and_wrong_owner_is_rejected():
    rust, bus = FakeRust(), EventBus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="ssh-sdk-identity",
                      ssh_session_id="17", mode="confirm")
    tool_fn = make_ssh_command_tool(ctx)
    state: dict[str, Any] = {"agent": object()}
    def reject_wrong_owner(tool_use: dict[str, Any], invocation_state: dict[str, Any]) -> None:
        sdk_id = tool_use["toolUseId"]
        calls = invocation_state.get("_tdsf_reference_tool_calls", {})
        assert sdk_id in calls
        assert take_reference_tool_call_id(
            tool_use, invocation_state, session_id="other-session", agent_name="main",
        ) is None
        assert take_reference_tool_call_id(
            tool_use, invocation_state, session_id="ssh-sdk-identity", agent_name="wrong-agent",
        ) is None

    first = _invoke_sdk(tool_fn, bus, state, "qa-sdk-call-ssh_command-1",
                        before_after=reject_wrong_owner)[0]
    first_card = bus.cards[-1]["tool_call_id"]
    second = _invoke_sdk(tool_fn, bus, state, "qa-sdk-call-ssh_command-2",
                         before_after=reject_wrong_owner)[0]
    second_card = bus.cards[-1]["tool_call_id"]
    assert first_card != second_card
    assert first["toolUseId"] != second["toolUseId"]


def test_direct_core_call_remains_compatible_without_sdk_context():
    rust, bus = FakeRust(), EventBus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="ssh-sdk-direct",
                      ssh_session_id="17", mode="confirm")
    result = invoke_ssh_command_tool({"command": "pwd"}, ctx)
    assert result["status"] == "success"
    assert result["exit_code"] == 0
    assert [event["status"] for event in bus.cards] == ["started", "completed"]


def test_teach_sdk_wrapper_preserves_schema_and_hides_injected_context():
    rust, bus = FakeRust(), EventBus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="ssh-sdk-teach",
                      ssh_session_id="17", mode="confirm", teach=True)
    original = make_ssh_command_tool(ctx)
    wrapped = wrap_tool_for_teach_mode(original, ctx)
    registry = ToolRegistry()
    registry.process_tools([wrapped])
    assert registry.registry["ssh_command"].tool_spec["inputSchema"] == original.tool_spec["inputSchema"]
    tool_use = {
        "toolUseId": "qa-sdk-call-ssh-command-teach",
        "name": "ssh_command",
        "input": {"command": "pwd", "ssh_session_id": "17", "explanation": "检查状态"},
    }
    result = _payload(_sdk_result(wrapped, tool_use, {"agent": object()}))
    assert result["status"] == "teach_command" and result["command"] == "pwd"
    assert rust.calls == []
    assert [event["status"] for event in bus.cards] == ["started", "completed"]
    assert all("sdk_tool_context" not in event["params"] for event in bus.cards)
