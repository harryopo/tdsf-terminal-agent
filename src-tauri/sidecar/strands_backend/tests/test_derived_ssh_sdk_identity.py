"""Derived SSH tools retain Strands tool identity through the executor."""
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
from strands_backend.tools.network_diagnostic import make_network_diagnostic_tool
from strands_backend.tools.log_analyzer import make_log_analyzer_tool
from strands_backend.tools.ops_extended import (
    make_firewall_manage_tool,
    make_package_manage_tool,
    make_performance_analyze_tool,
    make_security_audit_tool,
    make_service_manage_tool,
)
from strands_backend.tools.process_inspector import make_process_inspector_tool
from strands_backend.tools.tool_lifecycle import take_reference_tool_call_id


SESSION = "derived-ssh-sdk-identity"


class _Bus:
    def __init__(self) -> None:
        self.cards: list[dict[str, Any]] = []
        self.progress: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.cards.append(event)

    def emit_loop_progress(self, **event: Any) -> None:
        self.progress.append(event)


class _Rust:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any:
        self.calls.append((method, params))
        if method == "ssh_status":
            assert params == {}
            return [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                     "user": "qa", "state": "connected"}]
        assert method == "ssh_command"
        result = {"ok": True, "exitCode": 0, "output": "qa output\n",
                  "stderr": "", "duration": 0.01}
        if "operationId" in params:
            result["operationId"] = params["operationId"]
        return result


CASES = (
    ("service_manage", make_service_manage_tool,
     {"action": "status", "service": "nginx"},
     {"action", "service", "ssh_session_id", "timeout"},
     "systemctl status nginx --no-pager -l"),
    ("package_manage", make_package_manage_tool,
     {"action": "search", "package": "nginx", "package_manager": "dnf"},
     {"action", "package", "package_manager", "ssh_session_id", "timeout"},
     "dnf search nginx"),
    ("firewall_manage", make_firewall_manage_tool,
     {"action": "list"},
     {"action", "port", "service", "ssh_session_id", "timeout"},
     "firewall-cmd --list-all"),
    ("security_audit", make_security_audit_tool,
     {"scope": "open_ports"},
     {"scope", "ssh_session_id", "timeout"},
     "ss -tlnp | awk 'NR>1 {print $4, $6}'"),
    ("performance_analyze", make_performance_analyze_tool,
     {"metric": "load"},
     {"metric", "ssh_session_id", "timeout"},
     "uptime"),
    ("analyze_logs", make_log_analyzer_tool,
     {"log_path": "/var/log/qa.log", "mode": "tail", "lines": 7},
     {"log_path", "mode", "lines", "pattern", "ssh_session_id"},
     "tail -n 7 '/var/log/qa.log'"),
    ("inspect_processes", make_process_inspector_tool,
     {"mode": "list"},
     {"mode", "filter_user", "filter_name", "pid", "top_n", "ssh_session_id"},
     "ps aux"),
    ("network_diagnose", make_network_diagnostic_tool,
     {"mode": "ping", "target": "qa.invalid", "count": 1},
     {"mode", "target", "count", "port", "ssh_session_id"},
     "ping -c 1 -W 2 'qa.invalid'"),
)


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


def _assert_schema(tool_fn: Any, name: str, expected: set[str]) -> None:
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry[name].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]) == expected
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in schema.get("required", [])


def _run_case(name: str, factory: Any, args: dict[str, Any], schema: set[str], command: str,
              sdk_id: str, state: dict[str, Any] | None = None, between: Any = None):
    bus, rust = _Bus(), _Rust()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id=SESSION,
                      ssh_session_id="17", mode="confirm")
    tool_fn = factory(ctx)
    _assert_schema(tool_fn, name, schema)
    invocation_state = state if state is not None else {"agent": object()}
    tool_use = {"toolUseId": sdk_id, "name": name, "input": args}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=SESSION)
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=invocation_state,
    ))
    approved = SimpleNamespace(status=NeedsYouStatus.APPROVED, response=None)
    with patch("strands_backend.tools.request_approval_and_wait", return_value=approved):
        result = _stream(tool_fn, tool_use, invocation_state)
    if between is not None:
        between(tool_use, invocation_state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use,
        invocation_state=invocation_state, result=result,
    ))
    cards = [item for item in bus.cards if item.get("tool_name") == name]
    assert [item["status"] for item in cards] == ["started", "completed"]
    card_id = cards[0]["tool_call_id"]
    assert cards[1]["tool_call_id"] == card_id != sdk_id
    assert cards[0]["params"]["command"] == command
    assert all("sdk_tool_context" not in item["params"] for item in cards)
    assert hook.total_calls == 1
    assert hook.tool_log[-1]["tool_call_id"] == card_id
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    assert "tool_call_ids" not in hook.tool_log[-1]
    rows = [row for row in get_global_tracker().list(SESSION)
            if row.get("tool_name") == name and row.get("tool_call_id") == card_id]
    assert len(rows) == 1
    assert rows[0]["tool_call_id"] == card_id
    assert rows[0]["sdk_tool_use_id"] == sdk_id
    assert [params["command"] for method, params in rust.calls if method == "ssh_command"] == [command]
    assert _payload(result)["status"] == "success"
    assert sdk_id not in invocation_state.get("_tdsf_reference_tool_calls", {})
    return bus, rust, tool_fn, invocation_state, hook, tool_use, cards, result


@pytest.fixture(autouse=True)
def _reset_evidence(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))
    reset_global_tracker()
    yield
    reset_global_tracker()


@pytest.mark.parametrize("name,factory,args,schema,command", CASES, ids=[case[0] for case in CASES])
def test_derived_ssh_sdk_tools_keep_single_card_log_and_evidence_identity(
    name: str, factory: Any, args: dict[str, Any], schema: set[str], command: str,
) -> None:
    _run_case(name, factory, args, schema, command, "qa-sdk-derived-" + name)


@pytest.mark.parametrize(
    "name,factory,args,schema,command,decision,expected",
    [
        ("service_manage", make_service_manage_tool,
         {"action": "restart", "service": "nginx"},
         {"action", "service", "ssh_session_id", "timeout"},
         "systemctl restart nginx", NeedsYouStatus.REJECTED, "rejected"),
        ("package_manage", make_package_manage_tool,
         {"action": "install", "package": "nginx", "package_manager": "dnf"},
         {"action", "package", "package_manager", "ssh_session_id", "timeout"},
         "dnf install -y nginx", NeedsYouStatus.CANCELLED, "cancelled"),
        ("firewall_manage", make_firewall_manage_tool,
         {"action": "add_port", "port": "8443"},
         {"action", "port", "service", "ssh_session_id", "timeout"},
         "firewall-cmd --permanent --add-port=8443/tcp && firewall-cmd --reload",
         NeedsYouStatus.REJECTED, "rejected"),
    ],
    ids=["service-reject", "package-cancel", "firewall-reject"],
)
def test_derived_ssh_sdk_write_denial_keeps_identity_without_dispatch(
    name: str, factory: Any, args: dict[str, Any], schema: set[str], command: str,
    decision: NeedsYouStatus, expected: str,
) -> None:
    bus, rust = _Bus(), _Rust()
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id=SESSION,
                      ssh_session_id="17", mode="confirm")
    tool_fn = factory(ctx)
    _assert_schema(tool_fn, name, schema)
    tool_use = {"toolUseId": "qa-sdk-derived-write-" + name, "name": name, "input": args}
    state: dict[str, Any] = {"agent": object()}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=SESSION)
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state,
    ))
    approval = SimpleNamespace(status=decision, response=None)
    with patch("strands_backend.tools.request_approval_and_wait", return_value=approval):
        result = _stream(tool_fn, tool_use, state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state, result=result,
    ))
    cards = [item for item in bus.cards if item.get("tool_name") == name]
    assert [item["status"] for item in cards] == ["started", "error"]
    assert cards[0]["tool_call_id"] == cards[1]["tool_call_id"]
    assert cards[0]["tool_call_id"] != tool_use["toolUseId"]
    assert cards[0]["params"]["command"] == command
    assert _payload(result)["status"] == expected
    assert not any(method == "ssh_command" for method, _ in rust.calls)
    assert hook.total_calls == 1
    assert hook.tool_log[-1]["tool_call_id"] == cards[0]["tool_call_id"]
    assert hook.tool_log[-1]["sdk_tool_use_id"] == tool_use["toolUseId"]
    assert "tool_call_ids" not in hook.tool_log[-1]
    rows = [row for row in get_global_tracker().list(SESSION)
            if row.get("tool_name") == name and row.get("sdk_tool_use_id") == tool_use["toolUseId"]]
    assert len(rows) == 1
    assert rows[0]["sdk_tool_use_id"] == tool_use["toolUseId"]
    assert rows[0]["tool_call_id"] == cards[0]["tool_call_id"]
    assert all("sdk_tool_context" not in item["params"] for item in cards)
    assert "_tdsf_reference_tool_calls" not in state


@pytest.mark.parametrize("name,factory,args,schema,command", [CASES[5], CASES[7]],
                         ids=["analyze-logs", "network-diagnose"])
def test_repeated_derived_sdk_calls_get_fresh_card_ids_and_clear_binding(
    name: str, factory: Any, args: dict[str, Any], schema: set[str], command: str,
) -> None:
    state: dict[str, Any] = {"agent": object()}
    ids: list[str] = []
    sdk_ids = ["qa-sdk-repeat-one", "qa-sdk-repeat-two", "qa-sdk-repeat-two"]
    for sdk_id in sdk_ids:
        bus, rust, _tool, state, hook, tool_use, cards, result = _run_case(
            name, factory, args, schema, command, sdk_id, state,
        )
        ids.append(cards[0]["tool_call_id"])
        assert _payload(result)["status"] == "success"
        assert len([event for event in bus.cards if event.get("tool_name") == name]) == 2
    assert len(set(ids)) == len(ids)
    assert not state.get("_tdsf_reference_tool_calls")
    rows = [row for row in get_global_tracker().list(SESSION) if row.get("tool_name") == name]
    assert [row["tool_call_id"] for row in rows] == ids
    assert [row["sdk_tool_use_id"] for row in rows] == sdk_ids


def test_wrong_owner_cannot_consume_derived_tool_binding() -> None:
    name, factory, args, schema, command = CASES[5]
    state: dict[str, Any] = {"agent": object()}
    observed: list[str] = []

    def wrong_owner(tool_use: dict[str, Any], invocation_state: dict[str, Any]) -> None:
        assert take_reference_tool_call_id(
            tool_use, invocation_state, session_id="other-session", agent_name="main",
        ) is None
        assert take_reference_tool_call_id(
            tool_use, invocation_state, session_id=SESSION, agent_name="wrong-agent",
        ) is None
        observed.append(tool_use["toolUseId"])

    _bus, _rust, _tool, state, hook, tool_use, cards, _result = _run_case(
        name, factory, args, schema, command, "qa-sdk-wrong-owner", state, between=wrong_owner,
    )
    assert observed == [tool_use["toolUseId"]]
    assert cards[0]["tool_call_id"] == hook.tool_log[-1]["tool_call_id"]
