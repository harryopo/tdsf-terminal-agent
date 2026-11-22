"""Approval requests must retain the identity of their originating SSH call."""
from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest

from needs_you import NeedsYouService
from strands_backend.tools import (
    ToolContext,
    execute_via_ssh,
    request_approval_and_wait,
)


@pytest.mark.parametrize(
    "explicit_target, expected_target, ledger_id",
    [("", "17", None), ("29", "29", "operation-29")],
)
def test_executor_approval_request_carries_started_call_identity(
    explicit_target: str,
    expected_target: str,
    ledger_id: str | None,
):
    event_bus = MagicMock()
    event_bus.emit_tool_call.return_value = 1
    bridge = MagicMock()
    bridge.ipc_invoke.return_value = "unrecognized live-session response"
    ctx = ToolContext(
        event_bus=event_bus,
        rust_bridge=bridge,
        agent_name="main",
        session_id="identity-test-session",
        ssh_session_id="17",
    )
    if ledger_id:
        ctx.operation_service = MagicMock()
        ctx.operation_service.create_operation.return_value = {"id": ledger_id}
    service = NeedsYouService(approval_timeout=30, event_bus=event_bus)
    results: list[dict[str, object]] = []
    errors: list[BaseException] = []

    def run_executor() -> None:
        try:
            results.append(
                execute_via_ssh(
                    ctx,
                    "systemctl restart nginx",
                    ssh_session_id=explicit_target,
                )
            )
        except BaseException as exc:  # surfaced in the test thread below
            errors.append(exc)

    worker = threading.Thread(target=run_executor)
    with patch("needs_you.get_global_service", return_value=service), patch(
        "strands_backend.tools.assess_command",
        return_value={
            "decision": "confirm",
            "risk": {"level": "L3", "matched_rules": ["service_restart"]},
            "impact": {"segments": [], "max_risk_l": 3},
            "risk_l": 3,
        },
    ):
        worker.start()
        deadline = time.monotonic() + 3
        pending: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            pending = service.list_pending(needs_type="approval")
            if pending:
                break
            time.sleep(0.01)

        try:
            assert pending, "executor did not create a real approval request"
            created = pending[0]
            started_events = [
                call.kwargs
                for call in event_bus.emit_tool_call.call_args_list
                if call.kwargs.get("status") == "started"
            ]
            assert len(started_events) == 1
            call_id = started_events[0]["tool_call_id"]
            assert UUID(call_id).version == 4
            assert created["id"] != call_id
            assert created["extra"].get("tool_call_id") == call_id
            assert created["extra"].get("ssh_session_id") == expected_target
            assert created["extra"].get("operation_id") == ledger_id
        finally:
            if pending:
                service.reject(pending[0]["id"], reason="test cleanup")
            worker.join(timeout=3)

    assert not worker.is_alive(), "executor did not finish after approval rejection"
    assert not errors
    assert len(results) == 1
    assert results[0]["status"] == "rejected"
    assert not any(
        call.args[0] == "ssh_command"
        for call in bridge.ipc_invoke.call_args_list
    )


def test_direct_approval_helper_keeps_old_call_without_optional_identity():
    event_bus = MagicMock()
    service = NeedsYouService(approval_timeout=30, event_bus=event_bus)
    ctx = ToolContext(
        event_bus=event_bus,
        agent_name="main",
        session_id="legacy-helper-session",
    )
    results: list[object] = []
    worker = threading.Thread(
        target=lambda: results.append(
            request_approval_and_wait(
                ctx,
                "legacy operation",
                {"matched_rules": ["legacy"]},
            )
        )
    )
    with patch("needs_you.get_global_service", return_value=service):
        worker.start()
        deadline = time.monotonic() + 3
        pending: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            pending = service.list_pending(needs_type="approval")
            if pending:
                break
            time.sleep(0.01)
        try:
            assert pending, "legacy helper did not create a real approval request"
            extra = pending[0]["extra"]
            assert "tool_call_id" not in extra
            assert "operation_id" not in extra
            assert "ssh_session_id" not in extra
        finally:
            if pending:
                service.reject(pending[0]["id"], reason="test cleanup")
            worker.join(timeout=3)

    assert not worker.is_alive()
    assert len(results) == 1


def test_failed_approval_creation_remains_fail_closed():
    service = NeedsYouService(approval_timeout=30)
    service.request_approval = MagicMock(side_effect=RuntimeError("request unavailable"))
    ctx = ToolContext(session_id="failed-request-session")

    with patch("needs_you.get_global_service", return_value=service):
        request = request_approval_and_wait(
            ctx,
            "operation requiring approval",
            {"matched_rules": ["approval"]},
        )

    assert request is None
    assert not service.list_pending()
