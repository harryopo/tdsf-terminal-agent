"""Composite SSH tools must preserve the child command's real outcome."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from needs_you import NeedsYouStatus
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.tools.registry import ToolRegistry

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.backup_restore import make_backup_restore_tool
from strands_backend.tools.config_diff import make_config_diff_tool


class _Bus:
    def __init__(self) -> None:
        self.cards: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.cards.append(event)

    def emit_loop_progress(self, **_event: Any) -> None:
        pass


class _Rust:
    def __init__(self, outcomes: list[dict[str, Any]]) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any:
        self.calls.append((method, params))
        if method == "ssh_status":
            assert params == {}
            return [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                     "user": "qa", "state": "connected"}]
        assert method == "ssh_command", f"unexpected Rust method: {method}"
        outcome = dict(self.outcomes.pop(0)) if self.outcomes else {
            "ok": True, "exitCode": 0, "output": "restore ok\n", "stderr": "", "duration": 0.01,
        }
        if "operationId" in params:
            outcome.setdefault("operationId", params["operationId"])
        return outcome


def _sdk_payload(result: dict[str, Any]) -> dict[str, Any]:
    for block in result["content"]:
        if isinstance(block.get("json"), dict):
            return block["json"]
        if isinstance(block.get("text"), str):
            value = json.loads(block["text"])
            assert isinstance(value, dict)
            return value
    pytest.fail("SDK result has no structured business payload")


def _stream(tool_fn: Any, tool_use: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    async def run():
        return [event async for event in tool_fn.stream(tool_use, state)]
    return asyncio.run(run())[-1].tool_result


def _run(
    tool_fn: Any, tool_name: str, args: dict[str, Any], bus: _Bus,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry[tool_name].tool_spec["inputSchema"]["json"]
    expected = ({"file_a", "file_b", "ssh_session_id"} if tool_name == "config_diff"
                else {"action", "file_path", "backup_path", "ssh_session_id"})
    assert set(schema["properties"]) == expected
    tool_use = {"toolUseId": f"qa-sdk-{tool_name}", "name": tool_name, "input": args}
    state: dict[str, Any] = {"agent": object()}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="composite-sdk")
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state,
    ))
    result = _stream(tool_fn, tool_use, state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state, result=result,
    ))
    payload = _sdk_payload(result)
    if "status" in payload:
        assert hook.tool_log[-1]["status"] == payload["status"]
    cards = [row for row in bus.cards if row.get("tool_name") == tool_name]
    evidence = [row for row in get_global_tracker().list("composite-sdk")
                if row.get("tool_name") == tool_name]
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in schema["required"]
    assert hook.tool_log[-1]["name"] == tool_name
    return tool_use, cards, evidence, result


@pytest.fixture(autouse=True)
def _clean_evidence():
    reset_global_tracker()
    yield
    reset_global_tracker()


@pytest.mark.parametrize(
    "tool_name,args",
    [
        ("config_diff", {"file_a": "", "file_b": "/qa/b.conf"}),
        ("config_diff", {"file_a": "/qa/a.conf", "file_b": ""}),
        ("backup_restore", {"action": "backup", "file_path": "", "backup_path": ""}),
        ("backup_restore", {"action": "delete", "file_path": "/qa/a.conf", "backup_path": ""}),
    ],
    ids=["diff-empty-a", "diff-empty-b", "backup-empty-path", "backup-invalid-action"],
)
def test_composite_invalid_inputs_fail_without_ssh_or_fabricated_exit(tool_name, args):
    rust, bus = _Rust([]), _Bus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="composite-sdk",
                      ssh_session_id="17", mode="auto")
    tool_fn = make_config_diff_tool(ctx) if tool_name == "config_diff" else make_backup_restore_tool(ctx)
    _, cards, evidence, result = _run(tool_fn, tool_name, args, bus)
    payload = _sdk_payload(result)
    assert payload["status"] == "error"
    assert payload.get("exit_code") is None
    if tool_name == "config_diff":
        assert payload.get("identical") is None
    assert not any(method == "ssh_command" for method, _ in rust.calls)
    assert cards == [] and evidence == []


@pytest.mark.parametrize(
    "code,output,stderr,expected_status,identical",
    [(0, "", "", "success", True),
     (1, "--- a\n+++ b\n", "", "success", False),
     (2, "", "diff: /qa/missing: No such file\n", "error", None),
     (-1, "", "transport timeout\n", "indeterminate", None),
     (None, "", "", "indeterminate", None)],
    ids=["identical", "different", "diff-domain-error", "no-exit", "missing-exit"],
)
def test_config_diff_uses_only_verified_exit_outcomes(code, output, stderr,
                                                       expected_status, identical):
    response = {"ok": True, "output": output, "stderr": stderr, "duration": 0.01}
    if code is not None:
        response["exitCode"] = code
    rust, bus = _Rust([response]), _Bus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="composite-sdk",
                      ssh_session_id="17", mode="auto")
    _, cards, evidence, sdk_result = _run(
        make_config_diff_tool(ctx), "config_diff",
        {"file_a": "/qa/a.conf", "file_b": "/qa/b.conf"}, bus,
    )
    payload = _sdk_payload(sdk_result)
    assert payload["identical"] is identical
    assert payload["status"] == expected_status
    expected_code = code if isinstance(code, int) and code >= 0 else None
    assert payload.get("exit_code") == expected_code
    if stderr:
        assert payload.get("stderr") == stderr
    assert len(cards) == 2 and cards[0]["tool_call_id"] == cards[1]["tool_call_id"]
    assert len(evidence) == 1
    assert rust.calls[-1][1]["toolName"] == "config_diff"
    assert rust.calls[-1][1]["command"] == "diff -u /qa/a.conf /qa/b.conf 2>&1"


@pytest.mark.parametrize(
    "decision,expected,dispatches",
    [("approve", "success", 1), ("reject", "rejected", 0), ("cancel", "cancelled", 0)],
)
def test_backup_preserves_success_rejection_and_cancellation(decision, expected, dispatches):
    rust, bus = _Rust([{"ok": True, "exitCode": 0, "output": "backup ok\n",
                        "stderr": "", "duration": 0.01}]), _Bus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="composite-sdk",
                      ssh_session_id="17", mode="confirm")
    tool_fn = make_backup_restore_tool(ctx)
    approval = SimpleNamespace(status={"approve": NeedsYouStatus.APPROVED,
                                       "reject": NeedsYouStatus.REJECTED,
                                       "cancel": NeedsYouStatus.CANCELLED}[decision],
                               response=None)
    with patch("strands_backend.tools.request_approval_and_wait", return_value=approval):
        _, cards, evidence, sdk_result = _run(
            tool_fn, "backup_restore",
            {"action": "backup", "file_path": "/qa/config.conf", "backup_path": "/qa/config.conf.bak.1"},
            bus,
        )
    payload = _sdk_payload(sdk_result)
    assert payload["status"] == expected
    assert payload["ok"] is (decision == "approve")
    assert sum(method == "ssh_command" for method, _ in rust.calls) == dispatches
    assert [row["status"] for row in cards] == ["started", "completed" if dispatches else "error"]
    assert len(evidence) == 1


def test_backup_nonzero_is_not_success_and_keeps_diagnostic():
    rust, bus = _Rust([{"ok": True, "exitCode": 2, "output": "", "stderr": "cp: denied\n",
                        "duration": 0.01}]), _Bus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="composite-sdk",
                      ssh_session_id="17", mode="confirm")
    with patch("strands_backend.tools.request_approval_and_wait",
               return_value=SimpleNamespace(status=NeedsYouStatus.APPROVED, response=None)):
        _, _, _, result = _run(make_backup_restore_tool(ctx), "backup_restore",
            {"action": "backup", "file_path": "/qa/config.conf", "backup_path": "/qa/config.conf.bak.1"}, bus)
    payload = _sdk_payload(result)
    assert payload["ok"] is False
    assert payload["status"] == "error"
    assert payload["exit_code"] == 2 and "denied" in payload["stderr"]


@pytest.mark.parametrize(
    "code,output,expected",
    [(-1, "/qa/config.conf.bak.1\n", "indeterminate"), (0, "", "error")],
    ids=["partial-unknown", "empty-success"],
)
def test_restore_discovery_must_be_successful_and_nonempty(code, output, expected):
    rust, bus = _Rust([{"ok": True, "exitCode": code, "output": output,
                        "stderr": "", "duration": 0.01}]), _Bus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="composite-sdk",
                      ssh_session_id="17", mode="confirm")
    approved = SimpleNamespace(status=NeedsYouStatus.APPROVED, response=None)
    with patch("strands_backend.tools.request_approval_and_wait", return_value=approved):
        _, _, evidence, result = _run(make_backup_restore_tool(ctx), "backup_restore",
            {"action": "restore", "file_path": "/qa/config.conf", "backup_path": ""}, bus)
    payload = _sdk_payload(result)
    assert sum(method == "ssh_command" for method, _ in rust.calls) == 1
    assert payload["status"] == expected
    assert payload["ok"] is False
    assert len(evidence) == 1


def test_restore_requires_verified_discovery_and_correlates_two_successful_children():
    rust, bus = _Rust([
        {"ok": True, "exitCode": 0, "output": "/qa/config.conf.bak.1\n", "stderr": "", "duration": 0.01},
        {"ok": True, "exitCode": 0, "output": "restore ok\n", "stderr": "", "duration": 0.01},
    ]), _Bus()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="composite-sdk",
                      ssh_session_id="17", mode="confirm")
    with patch("strands_backend.tools.request_approval_and_wait",
               return_value=SimpleNamespace(status=NeedsYouStatus.APPROVED, response=None)):
        _, cards, evidence, result = _run(make_backup_restore_tool(ctx), "backup_restore",
            {"action": "restore", "file_path": "/qa/config.conf", "backup_path": ""}, bus)
    assert _sdk_payload(result)["ok"] is True
    child_cards = [event for event in bus.cards if event.get("tool_name") == "backup_restore"]
    assert len(child_cards) == 4
    first, second = child_cards[0]["tool_call_id"], child_cards[2]["tool_call_id"]
    assert first != second
    assert [event["status"] for event in child_cards] == ["started", "completed"] * 2
    assert len(evidence) == 2
    assert {item["tool_call_id"] for item in evidence} == {first, second}
    assert [params["command"].split()[0] for method, params in rust.calls
            if method == "ssh_command"] == ["ls", "cp"]
