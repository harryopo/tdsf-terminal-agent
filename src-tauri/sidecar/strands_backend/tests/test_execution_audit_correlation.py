"""Execution audit records retain approval and call correlation metadata."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from needs_you import NeedsYouService, reset_for_test
from project_service import ProjectService
from strands_backend.audit_chain import reset_global_chain
from strands_backend.modes import AgentMode
from strands_backend.tools import ToolContext, execute_via_ssh


@pytest.fixture
def audit_chain(tmp_path):
    chain = reset_global_chain(str(tmp_path / "audit-chain.jsonl"))
    yield chain
    reset_global_chain()


@pytest.fixture(autouse=True)
def isolate_needs_you():
    reset_for_test()
    yield
    reset_for_test()


@pytest.fixture
def operation_service(tmp_path):
    service = ProjectService(db_path=tmp_path / "operations.db")
    service.init_db()
    yield service
    service.close()


def _context(operation_service, response=None, on_dispatch=None):
    bridge = MagicMock()
    dispatched = []

    def invoke(method, params, **_kwargs):
        if method == "ssh_status":
            return "unrecognized live-session response"
        if method == "ssh_command":
            dispatched.append(params)
            if on_dispatch:
                on_dispatch(params)
            result = dict(response or {"output": "ok", "exit_code": 0})
            if "operationId" in params:
                result["operationId"] = params["operationId"]
            return result
        raise AssertionError(f"unexpected IPC method: {method}")

    bridge.ipc_invoke.side_effect = invoke
    ctx = ToolContext(
        event_bus=MagicMock(),
        rust_bridge=bridge,
        agent_name="audit-test-agent",
        session_id="audit-test-session",
        ssh_session_id="17",
        mode=AgentMode.CONFIRM,
        operation_service=operation_service,
    )
    return ctx, bridge, dispatched


def _assessment(decision="allow", risk_l=0, trust_source=None):
    value = {
        "decision": decision,
        "risk": {"level": f"L{risk_l}"},
        "impact": {"segments": [], "max_risk_l": risk_l},
        "risk_l": risk_l,
    }
    if trust_source:
        value["trust_source"] = trust_source
    return value


def _immediate_approval_service(ctx, approved):
    service = NeedsYouService(approval_timeout=5, event_bus=ctx.event_bus)
    wait_for_response = service.wait_for_response

    def respond_then_wait(req_id, timeout=None):
        request = (
            service.approve(req_id)
            if approved
            else service.reject(req_id, reason="synthetic rejection")
        )
        assert request is not None
        return wait_for_response(req_id, timeout)

    service.wait_for_response = respond_then_wait
    return service


def _entries(chain):
    assert chain.verify() == (True, [])
    records = [
        json.loads(line)
        for line in Path(chain.path).read_text(encoding="utf-8").splitlines()
        if line
    ]
    return [record["entry"] for record in records]


def test_approved_audit_precedes_dispatch_and_matches_operation(audit_chain, operation_service):
    dispatch_observations = []

    def on_dispatch(params):
        dispatch_observations.extend(_entries(audit_chain))
        assert params["operationId"]

    ctx, bridge, dispatched = _context(operation_service, on_dispatch=on_dispatch)
    service = _immediate_approval_service(ctx, approved=True)
    with patch(
        "strands_backend.tools.assess_command", return_value=_assessment("confirm", 2)
    ), patch("needs_you.get_global_service", return_value=service):
        result = execute_via_ssh(ctx, "mysql -u root -pSyntheticOnly")

    assert result["status"] == "success"
    approvals = [entry for entry in dispatch_observations if entry.get("event") == "approval"]
    assert len(approvals) == 1
    approval = approvals[0]
    assert approval["decision"] == "approved"
    assert approval["risk_l"] == 2
    assert approval["trust_source"] == "approval"
    assert approval["operation_id"] == result["operation_id"]
    call_id = dispatched[0]["toolCallId"]
    assert approval["tool_call_id"] == call_id
    assert "SyntheticOnly" not in approval["command"]
    assert "***" in approval["command"]
    executed = next(
        entry for entry in _entries(audit_chain)
        if entry.get("event") == "command_executed"
    )
    assert executed["trust_source"] == "approval"
    assert executed["operation_id"] == approval["operation_id"]
    assert executed["tool_call_id"] == approval["tool_call_id"]
    assert len([entry for entry in _entries(audit_chain) if entry.get("event") == "approval"]) == 1
    bridge.ipc_invoke.assert_any_call("ssh_command", {
        "sessionId": 17,
        "command": "mysql -u root -pSyntheticOnly",
        "timeout": 30,
        "conversationSessionId": "audit-test-session",
        "toolName": "ssh_command",
        "operationId": result["operation_id"],
        "toolCallId": call_id,
    })


def test_approved_audit_survives_ledger_transition_failure_without_dispatch(
    audit_chain, operation_service
):
    original_transition = operation_service.transition_operation

    def fail_approved(operation_id, state, **kwargs):
        if state == "approved":
            raise RuntimeError("synthetic ledger failure")
        return original_transition(operation_id, state, **kwargs)

    operation_service.transition_operation = fail_approved
    ctx, bridge, _dispatched = _context(operation_service)
    service = _immediate_approval_service(ctx, approved=True)
    with patch(
        "strands_backend.tools.assess_command", return_value=_assessment("confirm", 2)
    ), patch("needs_you.get_global_service", return_value=service):
        result = execute_via_ssh(ctx, "systemctl restart example")

    assert result["status"] == "error"
    assert bridge.ipc_invoke.call_count == 0
    approvals = [entry for entry in _entries(audit_chain) if entry.get("event") == "approval"]
    assert len(approvals) == 1
    assert approvals[0]["decision"] == "approved"
    assert approvals[0]["risk_l"] == 2
    assert approvals[0]["trust_source"] == "approval"
    assert approvals[0]["operation_id"] == result["operation_id"]
    assert approvals[0]["tool_call_id"] == ctx.event_bus.emit_tool_call.call_args_list[0].kwargs["tool_call_id"]
    assert not any(entry.get("event") == "command_executed" for entry in _entries(audit_chain))


@pytest.mark.parametrize(
    "decision,risk_l,trust_source,skip_approval",
    [
        ("allow", 0, None, False),
        ("allow", 1, "whitelist", False),
        ("allow", 1, "session_readonly", False),
        ("allow", 2, "session_prefix", False),
        ("confirm", 2, None, True),
    ],
)
def test_execution_audit_records_trust_source_without_approval(
    audit_chain, operation_service, decision, risk_l, trust_source, skip_approval
):
    ctx, bridge, dispatched = _context(operation_service)
    with patch(
        "strands_backend.tools.assess_command",
        return_value=_assessment(decision, risk_l, trust_source),
    ), patch("strands_backend.tools.request_approval_and_wait") as approval:
        result = execute_via_ssh(
            ctx,
            "printf audit",
            skip_approval=skip_approval,
        )

    assert result["status"] == "success"
    events = _entries(audit_chain)
    assert not any(entry.get("event") == "approval" for entry in events)
    executed = next(entry for entry in events if entry.get("event") == "command_executed")
    assert executed["risk_l"] == risk_l
    assert executed["trust_source"] == (trust_source or ("preapproved" if skip_approval else "mode"))
    assert executed["operation_id"] == result["operation_id"]
    assert executed["tool_call_id"] == dispatched[0]["toolCallId"]
    approval.assert_not_called()
    assert any(call.args[0] == "ssh_command" for call in bridge.ipc_invoke.call_args_list)


@pytest.mark.parametrize(
    "response,risk_l,expected_status,expected_event",
    [
        ({"output": "ok"}, 0, "indeterminate", "command_indeterminate"),
        ({"output": "unknown", "exit_code": -1}, 0, "indeterminate", "command_indeterminate"),
        ({"output": "write failed", "exit_code": 2}, 2, "error", "command_failed"),
        ({"output": "ok", "exit_code": 0}, 0, "success", "command_executed"),
        ({"output": "no match", "exit_code": 1}, 0, "success", "command_executed"),
    ],
)
def test_execution_terminal_audit_has_correlation_metadata(
    audit_chain, operation_service, response, risk_l, expected_status, expected_event
):
    ctx, _bridge, dispatched = _context(operation_service, response=response)
    with patch(
        "strands_backend.tools.assess_command", return_value=_assessment("allow", risk_l)
    ):
        result = execute_via_ssh(ctx, "printf audit")

    assert result["status"] == expected_status
    entry = next(item for item in _entries(audit_chain) if item.get("event") == expected_event)
    assert entry["risk_l"] == risk_l
    assert entry["trust_source"] == "mode"
    assert entry["operation_id"] == result["operation_id"]
    assert entry["tool_call_id"] == dispatched[0]["toolCallId"]


def test_rejected_approval_has_no_approved_audit_or_dispatch(audit_chain, operation_service):
    ctx, bridge, _dispatched = _context(operation_service)
    service = _immediate_approval_service(ctx, approved=False)
    with patch(
        "strands_backend.tools.assess_command", return_value=_assessment("confirm", 2)
    ), patch("needs_you.get_global_service", return_value=service):
        result = execute_via_ssh(ctx, "systemctl restart example")

    assert result["status"] == "rejected"
    assert bridge.ipc_invoke.call_count == 0
    approval = next(item for item in _entries(audit_chain) if item.get("event") == "approval")
    assert approval["decision"] == "rejected"
    assert not any(
        item.get("event") == "approval" and item.get("decision") == "approved"
        for item in _entries(audit_chain)
    )


def test_audit_append_failure_does_not_change_execution(audit_chain, operation_service):
    ctx, bridge, _dispatched = _context(operation_service)
    with patch.object(audit_chain, "append", side_effect=OSError("audit unavailable")):
        with patch(
            "strands_backend.tools.assess_command", return_value=_assessment("allow", 0)
        ):
            result = execute_via_ssh(ctx, "printf audit")

    assert result["status"] == "success"
    assert any(call.args[0] == "ssh_command" for call in bridge.ipc_invoke.call_args_list)
