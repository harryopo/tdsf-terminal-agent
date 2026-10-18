"""Regression coverage for command and exception text in dispatch logs."""
from __future__ import annotations

import ast
import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from needs_you import NeedsYouStatus
from strands_backend.tools import (
    DefaultRustBridge,
    RiskChecker,
    ToolContext,
    execute_via_ssh,
    request_approval_and_wait,
)


MARKER = "LOG-PRIVACY-MARKER-7f31"
COMMAND = f"printf '{MARKER}'\nprintf second-line"


def _assessment(decision: str) -> dict:
    return {
        "decision": decision,
        "risk": {"level": "L3", "matched_rules": ["test_rule"]},
        "impact": None,
        "risk_l": 3,
        "reason": "test decision",
    }


def _assert_command_result(result: dict) -> None:
    assert result["command"] == COMMAND


def _assert_diagnostic_log(caplog, *expected_fragments: str) -> None:
    assert caplog.records
    assert all(fragment in caplog.text for fragment in expected_fragments)


def test_real_approval_request_keeps_command_payload_out_of_logs(caplog):
    request = SimpleNamespace(id="request-1")
    wait_result = object()
    service = MagicMock()
    service.request_approval.return_value = request
    service.wait_for_response.return_value = wait_result

    with patch("needs_you.get_global_service", return_value=service), caplog.at_level(
        logging.INFO, logger="sidecar.strands_backend.tools"
    ):
        result = request_approval_and_wait(
            ToolContext(agent_name="privacy-test", session_id="session-1"),
            COMMAND,
            {"matched_rules": ["test_rule"], "level": "L3"},
        )

    assert result is wait_result
    service.request_approval.assert_called_once()
    assert service.request_approval.call_args.kwargs["command"] == COMMAND
    _assert_diagnostic_log(caplog, "approval requested", f"command_chars={len(COMMAND)}")
    assert MARKER not in caplog.text


@pytest.mark.parametrize(
    ("decision", "approval_status", "bridge_present", "expected_status"),
    [
        ("confirm", NeedsYouStatus.APPROVED, True, "success"),
        ("confirm", NeedsYouStatus.REJECTED, True, "rejected"),
        ("confirm", NeedsYouStatus.CANCELLED, True, "rejected"),
        ("confirm", NeedsYouStatus.TIMEOUT, True, "needs_approval"),
        ("deny", None, True, "command_blocked"),
        ("blocked", None, True, "command_blocked"),
        ("confirm", NeedsYouStatus.APPROVED, False, "unavailable"),
    ],
)
def test_execute_via_ssh_logs_no_command_for_gate_outcomes(
    caplog, decision, approval_status, bridge_present, expected_status
):
    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {
        "status": "success",
        "output": "ok",
        "exit_code": 0,
    }
    ctx = ToolContext(
        event_bus=None,
        rust_bridge=bridge if bridge_present else None,
        agent_name="privacy-test",
        session_id="session-1",
        ssh_session_id="1",
    )
    request = SimpleNamespace(
        id="request-2",
        status=approval_status,
        response={"reason": MARKER} if approval_status is NeedsYouStatus.REJECTED else {},
    )

    with (
        patch("strands_backend.tools.assess_command", return_value=_assessment(decision)),
        patch("strands_backend.tools.request_approval_and_wait", return_value=request) as approval,
        patch("strands_backend.tools.complete_approval_execution"),
        patch("strands_backend.tools._audit_append"),
        patch("strands_backend.tools._track_evidence"),
        caplog.at_level(logging.DEBUG, logger="sidecar.strands_backend.tools"),
    ):
        result = execute_via_ssh(ctx, COMMAND)

    assert result["status"] == expected_status
    _assert_command_result(result)
    _assert_diagnostic_log(caplog, f"command_chars={len(COMMAND)}")
    assert MARKER not in caplog.text
    if decision == "confirm":
        approval.assert_called_once()
    else:
        approval.assert_not_called()
    if approval_status is NeedsYouStatus.APPROVED and bridge_present:
        bridge.ipc_invoke.assert_called_once()
        assert bridge.ipc_invoke.call_args.args[1]["command"] == COMMAND
    if not bridge_present or decision in {"deny", "blocked"} or approval_status in {
        NeedsYouStatus.REJECTED,
        NeedsYouStatus.CANCELLED,
        NeedsYouStatus.TIMEOUT,
    }:
        bridge.ipc_invoke.assert_not_called()
    if approval_status is NeedsYouStatus.REJECTED:
        assert MARKER in result["message"]


def test_default_rust_bridge_does_not_log_callback_exception(caplog):
    bridge = DefaultRustBridge(send_request=MagicMock(side_effect=RuntimeError(MARKER)))
    with caplog.at_level(logging.ERROR, logger="sidecar.strands_backend.tools"):
        result = bridge.ipc_invoke("ssh_command", {"command": COMMAND})

    assert result["status"] == "error"
    assert result["error"] == MARKER
    _assert_diagnostic_log(caplog, "rust_bridge ipc_invoke failed", "error_type=RuntimeError")
    assert MARKER not in caplog.text


def test_custom_bridge_exception_does_not_log_command_or_exception(caplog):
    class RaisingBridge:
        def ipc_invoke(self, method, params, **kwargs):
            raise RuntimeError(MARKER)

    ctx = ToolContext(
        rust_bridge=RaisingBridge(),
        agent_name="privacy-test",
        session_id="session-1",
        ssh_session_id="1",
    )
    with (
        patch("strands_backend.tools.assess_command", return_value=_assessment("allow")),
        patch("strands_backend.tools._audit_append"),
        patch("strands_backend.tools._track_evidence"),
        caplog.at_level(logging.DEBUG, logger="sidecar.strands_backend.tools"),
    ):
        result = execute_via_ssh(ctx, COMMAND)

    assert result["status"] == "error"
    _assert_command_result(result)
    assert MARKER in result["error"]
    _assert_diagnostic_log(caplog, "execute_via_ssh ipc_invoke exception", "error_type=RuntimeError")
    assert MARKER not in caplog.text


def test_approval_creation_exception_does_not_log_exception_text(caplog):
    service = MagicMock()
    service.request_approval.side_effect = RuntimeError(MARKER)

    with patch("needs_you.get_global_service", return_value=service), caplog.at_level(
        logging.ERROR, logger="sidecar.strands_backend.tools"
    ):
        result = request_approval_and_wait(
            ToolContext(agent_name="privacy-test"), COMMAND, {"matched_rules": ["x"]}
        )

    assert result is None
    _assert_diagnostic_log(caplog, "request_approval failed", "error_type=RuntimeError")
    assert MARKER not in caplog.text


@pytest.mark.parametrize("emitter", ["risk_approval", "tool_call"])
def test_event_callback_exception_text_is_not_logged(caplog, emitter):
    event_bus = MagicMock()
    event_bus.emit_needs_you.side_effect = RuntimeError(MARKER)
    event_bus.emit_tool_call.side_effect = RuntimeError(MARKER)
    ctx = ToolContext(event_bus=event_bus)

    with caplog.at_level(logging.DEBUG, logger="sidecar.strands_backend.tools"):
        if emitter == "risk_approval":
            RiskChecker.emit_needs_you(
                event_bus,
                COMMAND,
                {"matched_rules": ["test_rule"], "level": "L3", "reason": "test"},
                "privacy-test",
                "session-1",
            )
            event_bus.emit_needs_you.assert_called_once()
            assert event_bus.emit_needs_you.call_args.kwargs["command"] == COMMAND
        else:
            from strands_backend.tools import emit_tool_call_card

            emit_tool_call_card(ctx, "ssh_command", {"command": COMMAND}, "started")
            event_bus.emit_tool_call.assert_called_once()
            assert event_bus.emit_tool_call.call_args.kwargs["params"]["command"] == COMMAND

    _assert_diagnostic_log(caplog, "error_type=RuntimeError")
    assert MARKER not in caplog.text


def test_old_command_prefix_log_expressions_are_absent_from_dispatch_modules():
    source_root = Path(__file__).parents[1]
    paths = [source_root / "tools" / "__init__.py", source_root / "tools" / "ssh_command.py"]
    legacy_sites = []
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        parents = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not isinstance(func, ast.Attribute) or not isinstance(func.value, ast.Name):
                continue
            if func.value.id != "logger":
                continue
            for child in ast.walk(node):
                if not isinstance(child, ast.Name) or child.id != "command":
                    continue
                parent = parents.get(child)
                if (
                    isinstance(parent, ast.Call)
                    and isinstance(parent.func, ast.Name)
                    and parent.func.id == "len"
                    and child in parent.args
                ):
                    continue
                legacy_sites.append(f"{path.name}:{node.lineno}")

    assert legacy_sites == []


@pytest.mark.parametrize("failure", ["publisher", "subscriber", "notifier"])
def test_real_approval_service_event_failures_keep_payload_private(caplog, failure):
    from event_bus import EventBus
    from needs_you import NeedsYouService

    received = []

    def fail_with_payload(*args, **kwargs):
        received.append((args, kwargs))
        raise RuntimeError(COMMAND)

    healthy = MagicMock()
    if failure == "publisher":
        bus = SimpleNamespace(emit_needs_you=fail_with_payload)
    else:
        bus = EventBus(rust_notifier=fail_with_payload if failure == "notifier" else None)
        if failure == "subscriber":
            bus.subscribe(fail_with_payload, name="failing-test-subscriber")
        bus.subscribe(healthy, name="healthy-test-subscriber")
    service = NeedsYouService(event_bus=bus)

    with caplog.at_level(logging.DEBUG):
        request = service.request_approval(
            title="Test approval", description="Test", command=COMMAND, session_id="test-session"
        )

    assert request.extra["command"] == COMMAND
    assert request.status is NeedsYouStatus.PENDING
    assert len(received) == 1
    if failure != "publisher":
        healthy.assert_called_once()
        assert healthy.call_args.args[0].payload["request"]["extra"]["command"] == COMMAND
    _assert_diagnostic_log(caplog, "error_type=RuntimeError")
    assert MARKER not in caplog.text


@pytest.mark.parametrize("reason", [COMMAND, "", None])
def test_cancel_reason_stays_in_response_not_runtime_log(caplog, reason):
    from needs_you import NeedsYouService

    service = NeedsYouService()
    request = service.request_approval(title="Test", description="Test", command=COMMAND)
    with caplog.at_level(logging.INFO):
        result = service.cancel(request.id, reason=reason)

    assert result is request
    assert result.status is NeedsYouStatus.CANCELLED
    assert result.response == {"cancelled_reason": reason}
    _assert_diagnostic_log(caplog, "needs_you cancelled", f"has_reason={bool(reason)}")
    assert MARKER not in caplog.text
