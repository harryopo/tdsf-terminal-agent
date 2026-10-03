"""Regression coverage for evidence identity, provenance, and retained snapshots.

secret-scan: fixture -- every credential-shaped value below is synthetic test data.
"""
from __future__ import annotations

import json
from unittest.mock import patch
from uuid import UUID

import pytest

from strands_backend.evidence import (
    EvidenceTracker,
    assess_session_evidence,
    get_global_tracker,
    reset_global_tracker,
)
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands_backend.adapter import ToolCallLimitHook
from strands_backend.tools import ToolContext, execute_via_ssh


class RecordingEventBus:
    def __init__(self):
        self.tool_calls = []

    def emit_tool_call(self, **event):
        self.tool_calls.append(event)

    def emit_loop_progress(self, **_):
        pass


class FakeBridge:
    def __init__(self, command_result, on_execute=None):
        self.command_result = command_result
        self.on_execute = on_execute
        self.calls = []

    def ipc_invoke(self, method, params):
        self.calls.append((method, params))
        if method == "ssh_status":
            return [
                {"sessionId": 1, "host": "host-one", "port": 22, "user": "root", "state": "connected"},
                {"sessionId": 2, "host": "host-two", "port": 2222, "user": "deploy", "state": "connected"},
            ]
        assert method == "ssh_command"
        if self.on_execute:
            self.on_execute()
        result = dict(self.command_result)
        if params.get("operationId"):
            result.setdefault("operationId", params["operationId"])
        return result


def _allow_assessment(risk_l=0):
    return {
        "decision": "allow",
        "risk": {"level": f"L{risk_l}", "high_risk": False},
        "impact": {"segments": [], "max_risk_l": risk_l},
        "risk_l": risk_l,
    }


@pytest.fixture(autouse=True)
def isolated_tracker():
    reset_global_tracker()
    yield
    reset_global_tracker()


def _record(tracker, *, tool, detail, result=None, **metadata):
    return tracker.record(
        session_id="provenance-session",
        tool_name=tool,
        status="completed",
        detail=detail,
        result=result or {"status": "success", "output": "ok"},
        source="strands_tool",
        **metadata,
    )


@pytest.mark.parametrize(
    "read_tool,read_detail,read_host,read_session",
    [
        ("read_remote_file", "/etc/hosts", "host-a", "ssh-a"),
        ("knowledge_search", "nginx", "host-a", "ssh-a"),
        ("read_remote_file", "/etc/nginx/other.conf", "host-a", "ssh-a"),
        ("read_remote_file", "/etc/nginx/site.conf", "host-b", "ssh-b"),
        ("read_remote_file", "/etc/nginx/site.conf", "host-a", "ssh-a"),
    ],
)
def test_unrelated_read_does_not_verify_a_successful_write(
    read_tool, read_detail, read_host, read_session
):
    tracker = get_global_tracker()
    _record(
        tracker,
        tool="service_manage",
        detail="restart nginx",
        operation_id="op-1",
        target_endpoint="host-a",
        ssh_session_id="ssh-a",
    )
    _record(
        tracker,
        tool=read_tool,
        detail=read_detail,
        target_endpoint=read_host,
        ssh_session_id=read_session,
    )

    assert assess_session_evidence("provenance-session")["tier"] != "verified"


def test_matching_post_write_read_is_grounded_but_not_claim_verified():
    tracker = get_global_tracker()
    _record(
        tracker,
        tool="write_remote_file",
        detail="/etc/nginx/site.conf",
        operation_id="op-match",
        target_endpoint="host-a",
        ssh_session_id="ssh-a",
    )
    _record(
        tracker,
        tool="read_remote_file",
        detail="/etc/nginx/site.conf",
        operation_id="op-match",
        target_endpoint="host-a",
        ssh_session_id="ssh-a",
    )

    assert assess_session_evidence("provenance-session")["tier"] == "grounded"


def test_missing_target_and_same_path_only_do_not_verify():
    tracker = get_global_tracker()
    _record(tracker, tool="service_manage", detail="restart nginx", operation_id="op-x")
    _record(
        tracker,
        tool="read_remote_file",
        detail="/etc/nginx/site.conf",
    )

    assert assess_session_evidence("provenance-session")["tier"] != "verified"


def test_zero_sources_remain_unverified():
    _record(get_global_tracker(), tool="service_manage", detail="restart nginx")
    assert assess_session_evidence("provenance-session")["tier"] == "unverified"


def test_legacy_signature_unrelated_knowledge_read_does_not_verify_write():
    tracker = get_global_tracker()
    tracker.record("provenance-session", "service_manage", "completed", detail="restart nginx")
    tracker.record(
        "provenance-session",
        "knowledge_search",
        "completed",
        detail="nginx troubleshooting",
        result={"status": "success", "output": "general documentation"},
    )

    assert assess_session_evidence("provenance-session")["tier"] == "grounded"


def test_legacy_signature_read_of_another_file_does_not_verify_write():
    tracker = get_global_tracker()
    tracker.record("provenance-session", "service_manage", "completed", detail="restart nginx")
    tracker.record(
        "provenance-session",
        "read_remote_file",
        "completed",
        detail="/etc/hosts",
        result={"status": "success", "output": "127.0.0.1 localhost"},
    )

    assert assess_session_evidence("provenance-session")["tier"] == "grounded"


def test_record_and_list_dict_mutation_does_not_change_retained_evidence():
    tracker = EvidenceTracker()
    recorded = tracker.record("mutable", "ssh_command", "completed", detail="uptime")
    assert recorded is not None
    listed = tracker.list("mutable")
    original_detail = tracker.list("mutable")[0]["detail"]

    recorded["detail"] = "changed via record result"
    listed[0]["detail"] = "changed via list result"

    assert tracker.list("mutable")[0]["detail"] == original_detail


def test_detail_and_record_are_redacted_and_caller_mutation_cannot_change_storage():
    tracker = EvidenceTracker()
    secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    recorded = tracker.record(
        "secret-session",
        "ssh_command",
        "completed",
        detail=f"Authorization: Bearer {secret}",
        result={"status": "success", "output": f"token={secret}"},
    )
    assert recorded is not None
    listed = tracker.list("secret-session")
    encoded = json.dumps(listed, ensure_ascii=False)
    assert secret not in encoded

    recorded["detail"] = "caller changed this"
    listed[0]["result"] = "caller changed this too"
    retained = tracker.list("secret-session")[0]
    assert "caller changed" not in json.dumps(retained)


def test_metadata_is_optional_bounded_and_legacy_calls_do_not_invent_ids():
    tracker = EvidenceTracker()
    legacy = tracker.record("legacy", "knowledge_search", "completed", detail="x")
    assert legacy is not None
    for key in ("tool_call_id", "sdk_tool_use_id", "ssh_session_id", "target_endpoint", "operation_id"):
        assert key not in legacy

    item = tracker.record(
        "metadata",
        "ssh_command",
        "completed",
        detail="uptime",
        tool_call_id="ui-1",
        sdk_tool_use_id="sdk-1",
        ssh_session_id="ssh-1",
        target_endpoint="user@example.test",
        operation_id="op-1",
    )
    assert item is not None
    assert {key: item[key] for key in ("tool_call_id", "sdk_tool_use_id", "ssh_session_id", "target_endpoint", "operation_id")} == {
        "tool_call_id": "ui-1",
        "sdk_tool_use_id": "sdk-1",
        "ssh_session_id": "ssh-1",
        "target_endpoint": "user@example.test",
        "operation_id": "op-1",
    }

    long_id = "x" * 501
    rejected = tracker.record("long", "ssh_command", "completed", detail="uptime", operation_id=long_id)
    assert rejected is not None
    assert "operation_id" not in rejected
    at_limit = "y" * 500
    accepted = tracker.record("limit", "ssh_command", "completed", detail="uptime", operation_id=at_limit)
    assert accepted is not None
    assert accepted["operation_id"] == at_limit


@pytest.mark.parametrize("business_status", ["", "empty", "error", "not_found", "indeterminate", "rejected", "cancelled"])
def test_completed_receipt_with_non_success_business_status_is_not_a_source(business_status):
    get_global_tracker().record(
        "provenance-session",
        "read_remote_file",
        "completed",
        detail="/etc/hosts",
        result={"status": business_status, "output": "not a successful read"},
    )

    assert assess_session_evidence("provenance-session")["tier"] == "unverified"


@pytest.mark.parametrize("available,expected_tier", [(False, "unverified"), (True, "grounded")])
def test_terminal_output_availability_controls_source_status(available, expected_tier):
    get_global_tracker().record(
        "provenance-session",
        "get_terminal_output",
        "completed",
        detail="scrollback",
        result={"available": available, "output": "terminal text" if available else ""},
    )

    item = get_global_tracker().list("provenance-session")[0]
    assert item.get("result_available") is available
    assert assess_session_evidence("provenance-session")["tier"] == expected_tier


def test_structured_ok_false_completed_receipt_is_not_a_source():
    get_global_tracker().record(
        "provenance-session",
        "read_remote_file",
        "completed",
        detail="/etc/hosts",
        result={"status": "success", "ok": False, "output": "read failed"},
    )

    item = get_global_tracker().list("provenance-session")[0]
    assert item.get("result_ok") is False
    assert assess_session_evidence("provenance-session")["tier"] == "unverified"


def test_redacted_identity_metadata_is_omitted_instead_of_replaced_with_shared_id():
    item = EvidenceTracker().record(
        "identity-session",
        "ssh_command",
        "completed",
        detail="uptime",
        tool_call_id="Authorization: Bearer synthetic-ui-secret",
        sdk_tool_use_id="sdk-safe-7",
        ssh_session_id="ssh-safe-2",
        target_endpoint="Authorization: Bearer synthetic-endpoint-secret",
        operation_id="op-safe-4",
    )

    assert item is not None
    assert "tool_call_id" not in item
    assert "target_endpoint" not in item
    assert item["sdk_tool_use_id"] == "sdk-safe-7"
    assert item["ssh_session_id"] == "ssh-safe-2"
    assert item["operation_id"] == "op-safe-4"


def test_repeated_ssh_calls_keep_unique_card_evidence_ids_and_explicit_target():
    class OperationService:
        def __init__(self):
            self.created = []

        def create_operation(self, **kwargs):
            operation_id = f"op-{len(self.created) + 1}"
            self.created.append(operation_id)
            return {"id": operation_id}

        def transition_operation(self, *_args, **_kwargs):
            return None

    bus = RecordingEventBus()
    bridge = FakeBridge({"ok": True, "output": "load", "exit_code": 0, "duration": 0.1})
    ctx = ToolContext(
        event_bus=bus,
        rust_bridge=bridge,
        agent_name="main",
        session_id="ssh-provenance",
        ssh_session_id="1",
        operation_service=OperationService(),
    )
    with patch("strands_backend.tools.assess_command", return_value=_allow_assessment()), patch(
        "strands_backend.tools._audit_append"
    ):
        results = [
            execute_via_ssh(ctx, "uptime", ssh_session_id="2"),
            execute_via_ssh(ctx, "uptime", ssh_session_id="2"),
        ]

    records = get_global_tracker().list("ssh-provenance")
    assert [result["status"] for result in results] == ["success", "success"], results
    assert len(records) == 2
    assert [record["operation_id"] for record in records] == ["op-1", "op-2"]
    card_ids = [event["tool_call_id"] for event in bus.tool_calls]
    assert len(card_ids) == 4
    assert card_ids[0] == card_ids[1] == records[0]["tool_call_id"]
    assert card_ids[2] == card_ids[3] == records[1]["tool_call_id"]
    assert card_ids[0] != card_ids[2]
    assert all(UUID(call_id).version == 4 for call_id in card_ids)
    dispatches = [params for method, params in bridge.calls if method == "ssh_command"]
    assert [params["sessionId"] for params in dispatches] == [2, 2]
    assert all(record["ssh_session_id"] == "2" for record in records)
    assert all(record["target_endpoint"] == "deploy@host-two:2222" for record in records)
    assert [params["toolCallId"] for params in dispatches] == [card_ids[0], card_ids[2]]


@pytest.mark.parametrize(
    "command_result,command,risk_l,readonly,expected_status,expected_evidence",
    [
        ({"ok": True, "output": "no match", "exit_code": 1}, "grep x /etc/hosts", 1, True, "success", "completed"),
        ({"ok": True, "output": "maybe ran"}, "uptime", 0, False, "indeterminate", "indeterminate"),
        ({"ok": True, "output": "denied", "exit_code": 1}, "systemctl restart nginx", 2, False, "error", "error"),
    ],
)
def test_ssh_execution_outcomes_keep_evidence_and_card_status(
    command_result, command, risk_l, readonly, expected_status, expected_evidence
):
    bus = RecordingEventBus()
    bridge = FakeBridge(command_result)
    ctx = ToolContext(event_bus=bus, rust_bridge=bridge, session_id="ssh-outcome", ssh_session_id="1")
    with patch("strands_backend.tools.assess_command", return_value=_allow_assessment(risk_l)), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, command, readonly=readonly)

    evidence = get_global_tracker().list("ssh-outcome")
    assert result["status"] == expected_status
    assert len(evidence) == 1
    assert evidence[0]["status"] == expected_evidence
    assert [event["status"] for event in bus.tool_calls] == [
        "started",
        "completed" if expected_status == "success" else "error",
    ]
    assert {event["tool_call_id"] for event in bus.tool_calls} == {evidence[0]["tool_call_id"]}


def test_blocked_ssh_call_records_blocked_evidence_without_dispatch():
    bus = RecordingEventBus()
    bridge = FakeBridge({"ok": True, "output": "unused", "exit_code": 0})
    ctx = ToolContext(event_bus=bus, rust_bridge=bridge, session_id="ssh-blocked", ssh_session_id="1")
    blocked = {
        "decision": "blocked",
        "risk": {"level": "L4", "high_risk": True},
        "impact": {"segments": [], "max_risk_l": 4},
        "risk_l": 4,
        "reason": "denylisted",
    }
    with patch("strands_backend.tools.assess_command", return_value=blocked), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "rm -rf /")

    evidence = get_global_tracker().list("ssh-blocked")
    assert result["status"] == "command_blocked"
    assert len(evidence) == 1 and evidence[0]["status"] == "blocked"
    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
    assert len({event["tool_call_id"] for event in bus.tool_calls}) == 1
    assert bus.tool_calls[0]["tool_call_id"] == evidence[0]["tool_call_id"]
    assert not any(method == "ssh_command" for method, _ in bridge.calls)


def test_ssh_evidence_keeps_chat_and_agent_frozen_at_execution_start():
    ctx = ToolContext(
        event_bus=RecordingEventBus(),
        rust_bridge=None,
        agent_name="main",
        session_id="scope-at-start",
        ssh_session_id="1",
    )

    def change_scope():
        ctx.session_id = "scope-after"
        ctx.agent_name = "debug"

    ctx.rust_bridge = FakeBridge(
        {"ok": True, "output": "load", "exit_code": 0}, on_execute=change_scope
    )
    with patch("strands_backend.tools.assess_command", return_value=_allow_assessment()), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "uptime")

    assert result["status"] == "success"
    evidence = get_global_tracker().list("scope-at-start")
    assert len(evidence) == 1 and evidence[0]["agent"] == "main"
    assert get_global_tracker().list("scope-after") == []


def _hook_events(tool_name, sdk_id, tool_input, business_result, *, cancel_message=None):
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="sdk-provenance")
    before = BeforeToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": sdk_id, "name": tool_name, "input": tool_input},
        invocation_state={},
    )
    hook._before_tool_call(before)
    after = AfterToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": sdk_id, "name": tool_name, "input": tool_input},
        invocation_state={},
        result={"toolUseId": sdk_id, "status": "success", "content": [{"json": business_result}]},
        cancel_message=cancel_message,
    )
    hook._after_tool_call(after)
    return bus, hook


def test_real_sdk_terminal_output_hook_card_and_evidence_share_the_owned_id():
    sdk_id = "sdk-terminal-output-31"
    bus, _hook = _hook_events(
        "get_terminal_output",
        sdk_id,
        {"lines": 12},
        {"status": "success", "available": True, "output": "ready"},
    )
    evidence = get_global_tracker().list("sdk-provenance")

    assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert [event["tool_call_id"] for event in bus.tool_calls] == [sdk_id, sdk_id]
    assert len(evidence) == 1
    assert evidence[0]["tool_call_id"] == sdk_id
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert evidence[0]["result_available"] is True


@pytest.mark.parametrize(
    "business_status,cancel_message,expected_evidence",
    [("indeterminate", None, "indeterminate"), ("success", "cancelled by user", "cancelled")],
)
def test_real_sdk_uncertain_or_cancelled_call_is_not_a_completed_source(
    business_status, cancel_message, expected_evidence
):
    bus, _hook = _hook_events(
        "get_terminal_output",
        f"sdk-{expected_evidence}-33",
        {"lines": 12},
        {"status": business_status, "available": False, "output": ""},
        cancel_message=cancel_message,
    )
    evidence = get_global_tracker().list("sdk-provenance")

    assert len(evidence) == 1
    assert evidence[0]["status"] == expected_evidence
    assert assess_session_evidence("sdk-provenance")["tier"] == "unverified"


def test_real_sdk_manual_knowledge_card_does_not_masquerade_sdk_id_as_ui_id(monkeypatch):
    from knowledge import rag as rag_module
    from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

    class Rag:
        def hybrid_search(self, _query, top_k):
            return [{"id": "kb-1", "title": "nginx", "content": "local note", "source": "fixture", "tags": [], "url": "kb://nginx"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingEventBus()
    ctx = ToolContext(event_bus=bus, agent_name="main", session_id="sdk-provenance")
    invoke_knowledge_search_tool({"query": "nginx"}, ctx)

    sdk_id = "sdk-knowledge-32"
    before = BeforeToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": sdk_id, "name": "knowledge_search", "input": {"query": "nginx"}},
        invocation_state={},
    )
    after = AfterToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use={"toolUseId": sdk_id, "name": "knowledge_search", "input": {"query": "nginx"}},
        invocation_state={},
        result={"toolUseId": sdk_id, "status": "success", "content": [{"json": {"status": "success", "count": 1}}]},
    )
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="sdk-provenance")
    hook._before_tool_call(before)
    hook._after_tool_call(after)

    cards = bus.tool_calls
    knowledge_cards = [event for event in cards if event["tool_name"] == "knowledge_search"]
    ui_id = knowledge_cards[0]["tool_call_id"]
    evidence = [item for item in get_global_tracker().list("sdk-provenance") if item["tool_name"] == "knowledge_search"]
    assert [event["status"] for event in knowledge_cards] == ["started", "completed"]
    assert ui_id != sdk_id
    assert {event["tool_call_id"] for event in knowledge_cards} == {ui_id}
    assert len(evidence) == 1
    assert evidence[0].get("tool_call_id") is None
    assert evidence[0]["sdk_tool_use_id"] == sdk_id


def test_executor_owned_ssh_cancel_is_recorded_once_and_success_is_not_duplicated():
    cancel_bus, _hook = _hook_events(
        "ssh_command",
        "sdk-ssh-cancel-41",
        {"command": "uptime"},
        {"status": "success", "output": ""},
        cancel_message="cancelled before execution",
    )
    cancelled = get_global_tracker().list("sdk-provenance")
    assert len(cancelled) == 1
    assert cancelled[0]["status"] == "cancelled"
    assert cancelled[0]["sdk_tool_use_id"] == "sdk-ssh-cancel-41"
    assert cancel_bus.tool_calls == []
    assert assess_session_evidence("sdk-provenance")["tier"] == "unverified"

    reset_global_tracker()
    bridge = FakeBridge({"ok": True, "output": "load", "exit_code": 0})
    with patch("strands_backend.tools.assess_command", return_value=_allow_assessment()), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(
            ToolContext(rust_bridge=bridge, session_id="sdk-provenance", ssh_session_id="1"),
            "uptime",
        )
    assert result["status"] == "success"
    _hook_events(
        "ssh_command",
        "sdk-ssh-success-42",
        {"command": "uptime"},
        {"status": "success", "output": "load"},
    )
    completed = get_global_tracker().list("sdk-provenance")
    assert len(completed) == 1
    assert completed[0]["status"] == "completed"
    assert completed[0].get("sdk_tool_use_id") is None
