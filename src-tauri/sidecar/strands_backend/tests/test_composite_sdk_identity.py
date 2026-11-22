"""Composite SSH tools preserve real Strands parent and child identities."""
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
from strands_backend.tools.tool_lifecycle import bind_tool_call_id, take_reference_tool_call_id


class _Bus:
    def __init__(self) -> None:
        self.cards: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.cards.append(event)

    def emit_loop_progress(self, **event: Any) -> None:
        self.progress.append(event)


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
        assert method == "ssh_command"
        result = dict(self.outcomes.pop(0)) if self.outcomes else {
            "ok": True, "exitCode": 0, "output": "qa ok\n", "stderr": "", "duration": 0.01,
        }
        if "operationId" in params:
            result.setdefault("operationId", params["operationId"])
        return result


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    for block in result["content"]:
        if isinstance(block.get("json"), dict):
            return block["json"]
        if isinstance(block.get("text"), str):
            value = json.loads(block["text"])
            assert isinstance(value, dict)
            return value
    pytest.fail("Strands returned no structured business payload")


def _stream(tool_fn: Any, tool_use: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    async def run() -> list[Any]:
        return [event async for event in tool_fn.stream(tool_use, state)]
    return asyncio.run(run())[-1].tool_result


def _setup(tool_name: str, outcomes: list[dict[str, Any]], *, mode: str = "auto"):
    bus, rust = _Bus(), _Rust(outcomes)
    session = "composite-sdk-identity"
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id=session,
                      ssh_session_id="17", mode=mode)
    tool_fn = make_config_diff_tool(ctx) if tool_name == "config_diff" else make_backup_restore_tool(ctx)
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry[tool_name].tool_spec["inputSchema"]["json"]
    expected = ({"file_a", "file_b", "ssh_session_id"} if tool_name == "config_diff"
                else {"action", "file_path", "backup_path", "ssh_session_id"})
    assert set(schema["properties"]) == expected
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in schema["required"]
    state: dict[str, Any] = {"agent": object()}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session)
    return bus, rust, tool_fn, state, hook


def _invoke(tool_fn: Any, hook: ToolCallLimitHook, state: dict[str, Any], name: str,
            sdk_id: str, args: dict[str, Any], *, between: Any = None) -> dict[str, Any]:
    tool_use = {"toolUseId": sdk_id, "name": name, "input": args}
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state,
    ))
    result = _stream(tool_fn, tool_use, state)
    if between is not None:
        between(tool_use, state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state, result=result,
    ))
    return result


@pytest.fixture(autouse=True)
def _reset_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))
    reset_global_tracker()
    yield
    reset_global_tracker()


@pytest.mark.parametrize(
    "code,output,expected",
    [(0, "", "success"), (1, "--- a\n+++ b\n", "success"), (-1, "partial\n", "indeterminate")],
    ids=["same", "different", "unknown"],
)
def test_config_diff_single_child_keeps_sdk_parent_identity(code: int, output: str, expected: str) -> None:
    bus, rust, tool_fn, state, hook = _setup("config_diff", [
        {"ok": True, "exitCode": code, "output": output, "stderr": "", "duration": 0.01},
    ])
    sdk_id = "qa-sdk-diff-" + expected
    result = _invoke(tool_fn, hook, state, "config_diff", sdk_id,
                     {"file_a": "/qa/a", "file_b": "/qa/b"})
    child_ids = [event["tool_call_id"] for event in bus.cards]
    assert len(child_ids) == 2 and child_ids[0] == child_ids[1]
    assert child_ids[0] != sdk_id
    assert hook.tool_log[-1]["tool_call_id"] == child_ids[0]
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    assert "tool_call_ids" not in hook.tool_log[-1]
    evidence = [row for row in get_global_tracker().list("composite-sdk-identity")
                if row.get("tool_name") == "config_diff"]
    assert len(evidence) == 1
    assert evidence[0]["tool_call_id"] == child_ids[0]
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert _payload(result)["status"] == expected
    assert all("sdk_tool_context" not in event["params"] for event in bus.cards)
    assert len([call for method, call in rust.calls if method == "ssh_command"]) == 1


@pytest.mark.parametrize(
    "decision,expected,dispatches",
    [("approve", "success", 1), ("reject", "rejected", 0),
     ("cancel", "cancelled", 0), ("unknown", "indeterminate", 1)],
    ids=["success", "rejected", "cancelled", "indeterminate"],
)
def test_backup_single_child_keeps_sdk_parent_identity(decision: str, expected: str,
                                                        dispatches: int) -> None:
    outcome = {"ok": True, "exitCode": -1 if decision == "unknown" else 0,
               "output": "partial\n" if decision == "unknown" else "backup ok\n",
               "stderr": "", "duration": 0.01}
    bus, rust, tool_fn, state, hook = _setup("backup_restore", [outcome], mode="confirm")
    approval_status = {"approve": NeedsYouStatus.APPROVED,
                       "reject": NeedsYouStatus.REJECTED,
                       "cancel": NeedsYouStatus.CANCELLED,
                       "unknown": NeedsYouStatus.APPROVED}[decision]
    args = {"action": "backup", "file_path": "/qa/config", "backup_path": "/qa/config.bak"}
    with patch("strands_backend.tools.request_approval_and_wait",
               return_value=SimpleNamespace(status=approval_status, response=None)):
        result = _invoke(tool_fn, hook, state, "backup_restore", "qa-sdk-backup-" + decision, args)
    cards = [event for event in bus.cards if event.get("tool_name") == "backup_restore"]
    assert [event["status"] for event in cards] == [
        "started", "completed" if expected == "success" else "error",
    ]
    sdk_id = "qa-sdk-backup-" + decision
    assert hook.tool_log[-1]["tool_call_id"] == cards[0]["tool_call_id"]
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    assert "tool_call_ids" not in hook.tool_log[-1]
    evidence = [row for row in get_global_tracker().list("composite-sdk-identity")
                if row.get("tool_name") == "backup_restore"]
    assert len(evidence) == 1
    assert evidence[0]["tool_call_id"] == cards[0]["tool_call_id"]
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert _payload(result)["status"] == expected
    assert sum(method == "ssh_command" for method, _ in rust.calls) == dispatches
    assert all("sdk_tool_context" not in event["params"] for event in cards)


def test_restore_binds_two_children_to_one_sdk_parent_in_order() -> None:
    bus, rust, tool_fn, state, hook = _setup("backup_restore", [
        {"ok": True, "exitCode": 0, "output": "/qa/config.bak.1\n", "stderr": "", "duration": 0.01},
        {"ok": True, "exitCode": 0, "output": "restore ok\n", "stderr": "", "duration": 0.01},
    ], mode="confirm")
    approved = SimpleNamespace(status=NeedsYouStatus.APPROVED, response=None)
    with patch("strands_backend.tools.request_approval_and_wait", return_value=approved):
        result = _invoke(tool_fn, hook, state, "backup_restore", "qa-sdk-restore-success",
                         {"action": "restore", "file_path": "/qa/config", "backup_path": ""})
    cards = [event for event in bus.cards if event.get("tool_name") == "backup_restore"]
    child_ids = [cards[index]["tool_call_id"] for index in (0, 2)]
    assert len(cards) == 4
    assert [event["status"] for event in cards] == ["started", "completed"] * 2
    assert child_ids[0] != child_ids[1]
    assert hook.tool_log[-1]["sdk_tool_use_id"] == "qa-sdk-restore-success"
    assert hook.tool_log[-1]["tool_call_ids"] == child_ids
    assert "tool_call_id" not in hook.tool_log[-1]
    assert hook.total_calls == 1
    assert all("tool_call_ids" not in event for event in bus.cards)
    evidence = [row for row in get_global_tracker().list("composite-sdk-identity")
                if row.get("tool_name") == "backup_restore"]
    assert [row["tool_call_id"] for row in evidence] == child_ids
    assert [row["sdk_tool_use_id"] for row in evidence] == ["qa-sdk-restore-success"] * 2
    assert _payload(result)["status"] == "success"
    assert [params["command"].split()[0] for method, params in rust.calls
            if method == "ssh_command"] == ["ls", "cp"]
    assert all("sdk_tool_context" not in event["params"] for event in cards)


def test_restore_second_child_cancel_retains_both_child_ids() -> None:
    bus, rust, tool_fn, state, hook = _setup("backup_restore", [
        {"ok": True, "exitCode": 0, "output": "/qa/config.bak.1\n", "stderr": "", "duration": 0.01},
    ], mode="confirm")
    decisions = iter([NeedsYouStatus.CANCELLED])
    with patch("strands_backend.tools.request_approval_and_wait",
               side_effect=lambda *_args, **_kwargs:
               SimpleNamespace(status=next(decisions), response=None)):
        result = _invoke(tool_fn, hook, state, "backup_restore", "qa-sdk-restore-cancel",
                         {"action": "restore", "file_path": "/qa/config", "backup_path": ""})
    cards = [event for event in bus.cards if event.get("tool_name") == "backup_restore"]
    child_ids = [cards[index]["tool_call_id"] for index in (0, 2)]
    assert len(cards) == 4
    assert [event["status"] for event in cards] == ["started", "completed", "started", "error"]
    assert child_ids[0] != child_ids[1]
    assert _payload(result)["status"] == "cancelled"
    assert hook.tool_log[-1]["tool_call_ids"] == child_ids
    assert "tool_call_id" not in hook.tool_log[-1]
    assert hook.total_calls == 1
    assert all("tool_call_ids" not in event for event in bus.cards)
    evidence = [row for row in get_global_tracker().list("composite-sdk-identity")
                if row.get("tool_name") == "backup_restore"]
    assert [row["tool_call_id"] for row in evidence] == child_ids
    assert [row["sdk_tool_use_id"] for row in evidence] == ["qa-sdk-restore-cancel"] * 2
    assert [params["command"].split()[0] for method, params in rust.calls
            if method == "ssh_command"] == ["ls"]


def test_restore_unknown_discovery_does_not_copy_and_keeps_parent_identity() -> None:
    bus, rust, tool_fn, state, hook = _setup("backup_restore", [
        {"ok": True, "exitCode": -1, "output": "/qa/config.bak.1\n", "stderr": "partial", "duration": 0.01},
    ])
    result = _invoke(tool_fn, hook, state, "backup_restore", "qa-sdk-restore-unknown",
                     {"action": "restore", "file_path": "/qa/config", "backup_path": ""})
    assert _payload(result)["status"] == "indeterminate"
    assert [params["command"].split()[0] for method, params in rust.calls
            if method == "ssh_command"] == ["ls"]
    assert hook.tool_log[-1]["sdk_tool_use_id"] == "qa-sdk-restore-unknown"
    evidence = [row for row in get_global_tracker().list("composite-sdk-identity")
                if row.get("tool_name") == "backup_restore"]
    assert len(evidence) == 1
    assert evidence[0]["sdk_tool_use_id"] == "qa-sdk-restore-unknown"


def test_same_command_uses_fresh_ids_and_wrong_owner_cannot_consume_valid_binding() -> None:
    bus, _, tool_fn, state, hook = _setup("config_diff", [
        {"ok": True, "exitCode": 0, "output": "", "stderr": "", "duration": 0.01},
        {"ok": True, "exitCode": 0, "output": "", "stderr": "", "duration": 0.01},
        {"ok": True, "exitCode": 0, "output": "", "stderr": "", "duration": 0.01},
    ])
    args = {"file_a": "/qa/a", "file_b": "/qa/b"}
    def wrong_owner(tool_use: dict[str, Any], invocation_state: dict[str, Any]) -> None:
        assert take_reference_tool_call_id(
            tool_use, invocation_state, session_id="other-session", agent_name="main",
        ) is None
        assert take_reference_tool_call_id(
            {**tool_use, "name": "backup_restore"}, invocation_state,
            session_id="composite-sdk-identity", agent_name="main",
        ) is None
        assert take_reference_tool_call_id(
            tool_use, invocation_state, session_id="composite-sdk-identity", agent_name="wrong-agent",
        ) is None

    first = _invoke(tool_fn, hook, state, "config_diff", "qa-sdk-diff-1", args, between=wrong_owner)
    first_id = bus.cards[-1]["tool_call_id"]
    assert "_tdsf_reference_tool_calls" not in state
    second = _invoke(tool_fn, hook, state, "config_diff", "qa-sdk-diff-2", args)
    second_id = bus.cards[-1]["tool_call_id"]
    assert "_tdsf_reference_tool_calls" not in state
    retry = _invoke(tool_fn, hook, state, "config_diff", "qa-sdk-diff-2", args)
    retry_id = bus.cards[-1]["tool_call_id"]
    assert "_tdsf_reference_tool_calls" not in state
    assert _payload(first)["status"] == _payload(second)["status"] == _payload(retry)["status"] == "success"
    assert len({first_id, second_id, retry_id}) == 3
    assert [entry["sdk_tool_use_id"] for entry in hook.tool_log] == [
        "qa-sdk-diff-1", "qa-sdk-diff-2", "qa-sdk-diff-2",
    ]
    assert [entry["tool_call_id"] for entry in hook.tool_log] == [first_id, second_id, retry_id]
    assert len(bus.cards) == 6
    evidence = [row for row in get_global_tracker().list("composite-sdk-identity")
                if row.get("tool_name") == "config_diff"]
    assert [row["tool_call_id"] for row in evidence] == [first_id, second_id, retry_id]
    assert [row["sdk_tool_use_id"] for row in evidence] == [
        "qa-sdk-diff-1", "qa-sdk-diff-2", "qa-sdk-diff-2",
    ]


def test_binding_double_child_never_returns_a_false_singular_id() -> None:
    state: dict[str, Any] = {}
    tool_use = {"toolUseId": "qa-sdk-double", "name": "backup_restore", "input": {}}
    context = SimpleNamespace(tool_use=tool_use, invocation_state=state)
    assert bind_tool_call_id(
        context, tool_name="backup_restore", tool_call_id="qa-child-1",
        session_id="qa-session", agent_name="main",
    ) == "qa-sdk-double"
    assert bind_tool_call_id(
        context, tool_name="backup_restore", tool_call_id="qa-child-2",
        session_id="qa-session", agent_name="main",
    ) == "qa-sdk-double"
    assert take_reference_tool_call_id(
        tool_use, state, session_id="qa-session", agent_name="main",
    ) is None


def test_wrong_owner_or_malformed_binding_does_not_replace_valid_card() -> None:
    state: dict[str, Any] = {}
    tool_use = {"toolUseId": "qa-sdk-valid", "name": "config_diff", "input": {}}
    valid = SimpleNamespace(tool_use=tool_use, invocation_state=state)
    wrong_session = SimpleNamespace(tool_use=tool_use, invocation_state=state)
    wrong_agent = SimpleNamespace(tool_use=tool_use, invocation_state=state)
    assert bind_tool_call_id(
        valid, tool_name="config_diff", tool_call_id="qa-child-valid",
        session_id="qa-session", agent_name="main",
    ) == "qa-sdk-valid"
    assert bind_tool_call_id(
        wrong_session, tool_name="config_diff", tool_call_id="qa-child-wrong-session",
        session_id="other-session", agent_name="main",
    ) is None
    assert bind_tool_call_id(
        wrong_agent, tool_name="config_diff", tool_call_id="qa-child-wrong-agent",
        session_id="qa-session", agent_name="other-agent",
    ) is None
    malformed = SimpleNamespace(
        tool_use={"toolUseId": "", "name": "config_diff", "input": {}},
        invocation_state=state,
    )
    assert bind_tool_call_id(
        malformed, tool_name="config_diff", tool_call_id="qa-child-malformed",
        session_id="qa-session", agent_name="main",
    ) is None
    assert take_reference_tool_call_id(
        malformed.tool_use, state, session_id="qa-session", agent_name="main",
    ) is None
    assert take_reference_tool_call_id(
        tool_use, state, session_id="qa-session", agent_name="main",
    ) == "qa-child-valid"
