"""Evidence regressions for early returns from the real SSH executor."""
from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from needs_you import NeedsYouStatus

from strands_backend.evidence import (
    assess_session_evidence,
    get_global_tracker,
    reset_global_tracker,
)
from strands_backend.tools import ToolContext, execute_via_ssh


class RecordingEventBus:
    def __init__(self) -> None:
        self.tool_calls: list[dict] = []

    def emit_tool_call(self, **event: object) -> None:
        self.tool_calls.append(event)


class FakeBridge:
    def __init__(
        self,
        result: dict | None = None,
        *,
        error: Exception | None = None,
        sessions: list[dict] | None = None,
    ) -> None:
        self.result = result or {"ok": True, "output": "ready", "exit_code": 0}
        self.error = error
        self.sessions = sessions
        self.calls: list[str] = []

    def ipc_invoke(self, method: str, _params: dict, *, timeout: float | None = None) -> dict:
        self.calls.append(method)
        if method == "ssh_status":
            return self.sessions if self.sessions is not None else [
                {
                    "sessionId": 7,
                    "host": "example.test",
                    "port": 22,
                    "user": "dev",
                    "state": "connected",
                }
            ]
        if self.error:
            raise self.error
        result = dict(self.result)
        if _params.get("operationId"):
            result.setdefault("operationId", _params["operationId"])
        return result


@pytest.fixture(autouse=True)
def reset_evidence() -> None:
    reset_global_tracker()
    yield
    reset_global_tracker()


def _allow(*, decision: str = "allow", risk_l: int = 1) -> dict:
    return {
        "decision": decision,
        "risk": {"level": f"L{risk_l}", "high_risk": risk_l >= 3},
        "impact": {"segments": [], "max_risk_l": risk_l},
        "risk_l": risk_l,
        "reason": "test decision",
    }


def _context(bus: RecordingEventBus, bridge: object = None, **kwargs: object) -> ToolContext:
    return ToolContext(
        event_bus=bus,
        rust_bridge=bridge,
        session_id="executor-evidence-session",
        ssh_session_id="7",
        **kwargs,
    )


def _assert_one_closed_evidence(bus: RecordingEventBus, expected_status: str) -> None:
    evidence = get_global_tracker().list("executor-evidence-session")
    assert len(evidence) == 1
    assert evidence[0]["status"] == expected_status
    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
    assert bus.tool_calls[0]["tool_call_id"] == bus.tool_calls[1]["tool_call_id"]
    assert evidence[0]["tool_call_id"] == bus.tool_calls[0]["tool_call_id"]


@pytest.mark.parametrize(
    ("approval_status", "business_status", "evidence_status"),
    [
        (NeedsYouStatus.REJECTED, "rejected", "rejected"),
        (NeedsYouStatus.CANCELLED, "cancelled", "cancelled"),
        (NeedsYouStatus.TIMEOUT, "needs_approval", "needs_approval"),
        (None, "needs_approval", "needs_approval"),
    ],
)
def test_approval_early_returns_keep_business_result_and_record_evidence(
    approval_status: NeedsYouStatus | None, business_status: str, evidence_status: str
) -> None:
    from types import SimpleNamespace

    bus = RecordingEventBus()
    bridge = FakeBridge()
    ctx = _context(bus, bridge, mode="confirm")
    with patch(
        "strands_backend.tools.assess_command",
        return_value=_allow(decision="confirm"),
    ), patch(
        "strands_backend.tools.request_approval_and_wait",
        return_value=SimpleNamespace(status=approval_status, response={"reason": "test"})
        if approval_status else None,
    ), patch("strands_backend.tools._audit_append"):
        result = execute_via_ssh(ctx, "systemctl restart example")

    assert result["status"] == business_status
    assert "ssh_command" not in bridge.calls
    _assert_one_closed_evidence(bus, evidence_status)


def test_missing_rust_bridge_records_unavailable_evidence() -> None:
    bus = RecordingEventBus()
    ctx = _context(bus)
    with patch("strands_backend.tools.assess_command", return_value=_allow()):
        result = execute_via_ssh(ctx, "uptime")

    assert result["status"] == "unavailable"
    assert result["reason"] == "rust_bridge_not_injected"
    _assert_one_closed_evidence(bus, "unavailable")


def test_ipc_exception_records_error_evidence_and_preserves_return() -> None:
    bus = RecordingEventBus()
    bridge = FakeBridge(error=RuntimeError("bridge failed"))
    ctx = _context(bus, bridge)
    with patch("strands_backend.tools.assess_command", return_value=_allow()), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "uptime")

    assert result["status"] == "error"
    assert result["error"] == "ipc_invoke 异常: bridge failed"
    _assert_one_closed_evidence(bus, "error")


def test_success_and_blocked_paths_still_record_exactly_once() -> None:
    success_bus = RecordingEventBus()
    with patch("strands_backend.tools.assess_command", return_value=_allow()), patch(
        "strands_backend.tools._audit_append"
    ):
        success = execute_via_ssh(_context(success_bus, FakeBridge()), "uptime")
    success_evidence = get_global_tracker().list("executor-evidence-session")
    assert success["status"] == "success"
    assert len(success_evidence) == 1
    assert success_evidence[0]["status"] == "completed"
    assert assess_session_evidence("executor-evidence-session")["tier"] == "grounded"
    assert [event["status"] for event in success_bus.tool_calls] == ["started", "completed"]

    reset_global_tracker()
    blocked_bus = RecordingEventBus()
    with patch(
        "strands_backend.tools.assess_command",
        return_value=_allow(decision="blocked"),
    ), patch(
        "strands_backend.tools._audit_append"
    ):
        blocked = execute_via_ssh(_context(blocked_bus, FakeBridge()), "rm -rf /")
    blocked_evidence = get_global_tracker().list("executor-evidence-session")
    assert blocked["status"] == "command_blocked"
    assert len(blocked_evidence) == 1
    assert blocked_evidence[0]["status"] == "blocked"
    assert [event["status"] for event in blocked_bus.tool_calls] == ["started", "error"]


@pytest.mark.parametrize(
    ("context_session", "bridge", "kwargs", "expected_status", "evidence_status", "dispatched"),
    [
        ("not-an-id", FakeBridge(), {}, "error", "error", False),
        ("", FakeBridge(), {}, "unavailable", "unavailable", False),
        ("0", FakeBridge(), {}, "command_blocked", "blocked", False),
        (
            "7",
            FakeBridge(
                sessions=[
                    {
                        "sessionId": 7,
                        "host": "example.test",
                        "port": 22,
                        "user": "dev",
                        "state": "closed",
                    }
                ]
            ),
            {},
            "command_blocked",
            "blocked",
            False,
        ),
        (
            "7",
            FakeBridge(),
            {"require_operation_ledger": True},
            "unavailable",
            "unavailable",
            False,
        ),
        ("7", FakeBridge({"status": "error", "reason": "rust error"}), {}, "error", "error", True),
        (
            "7",
            FakeBridge({"status": "unavailable", "reason": "bridge offline"}),
            {},
            "unavailable",
            "unavailable",
            True,
        ),
        (
            "7",
            FakeBridge({"status": "indeterminate", "reason": "unknown"}),
            {"execution_channel": "visible-terminal"},
            "indeterminate",
            "indeterminate",
            False,
        ),
    ],
)
def test_other_executor_early_returns_keep_their_status_and_single_evidence(
    context_session: str,
    bridge: FakeBridge,
    kwargs: dict,
    expected_status: str,
    evidence_status: str,
    dispatched: bool,
) -> None:
    bus = RecordingEventBus()
    ctx = _context(bus, bridge, **kwargs)
    ctx.ssh_session_id = context_session
    with patch("strands_backend.tools.assess_command", return_value=_allow()), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "uptime", ssh_session_id=context_session)

    assert result["status"] == expected_status
    assert ("ssh_command" in bridge.calls) is dispatched
    evidence = get_global_tracker().list("executor-evidence-session")
    assert len(evidence) == 1
    assert evidence[0]["status"] == evidence_status
    if evidence_status != "completed":
        assert assess_session_evidence("executor-evidence-session")["tier"] != "grounded"
    assert len({event["tool_call_id"] for event in bus.tool_calls}) == 1
    assert evidence[0]["tool_call_id"] == bus.tool_calls[0]["tool_call_id"]


@pytest.mark.parametrize(
    ("response", "risk_l", "expected"),
    [
        ({"status": "timed_out"}, 1, "indeterminate"),
        ({"status": "interrupted"}, 1, "indeterminate"),
        ({"status": "unavailable", "reason": "no_visible_terminal"}, 1, "unavailable"),
        (
            {"status": "reroute", "channel": "background", "reason": "no_shell_integration"},
            3,
            "indeterminate",
        ),
    ],
)
def test_visible_terminal_early_returns_are_recorded_without_replay(
    response: dict, risk_l: int, expected: str
) -> None:
    bus, bridge = RecordingEventBus(), FakeBridge(response)
    with patch("strands_backend.tools.assess_command", return_value=_allow(risk_l=risk_l)), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(
            _context(bus, bridge, execution_channel="visible-terminal"),
            "uptime",
            ssh_session_id="7",
        )

    assert result["status"] == expected
    assert "ssh_command" not in bridge.calls
    evidence = get_global_tracker().list("executor-evidence-session")
    assert len(evidence) == 1 and evidence[0]["status"] == expected


def test_strict_host_mismatch_blocks_before_dispatch() -> None:
    class StatusUnavailableBridge(FakeBridge):
        def ipc_invoke(self, method: str, params: dict, *, timeout: float | None = None) -> dict:
            if method == "ssh_status":
                self.calls.append(method)
                raise RuntimeError("status unavailable")
            return super().ipc_invoke(method, params, timeout=timeout)

    bus = RecordingEventBus()
    bridge = StatusUnavailableBridge()
    ctx = _context(bus, bridge, ssh_host="dev@example.test")
    ctx.ssh_session_id = "7"
    with patch("strands_backend.tools.assess_command", return_value=_allow()), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "uptime", ssh_session_id="8")

    assert result["status"] == "command_blocked"
    evidence = get_global_tracker().list(ctx.session_id)
    assert len(evidence) == 1 and evidence[0]["status"] == "blocked"
    assert "ssh_status" in bridge.calls
    assert "ssh_command" not in bridge.calls
    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]


def test_operation_id_mismatch_records_indeterminate_after_dispatch() -> None:
    class OperationService:
        def create_operation(self, **_kwargs: object) -> dict:
            return {"id": "op-expected"}

        def transition_operation(self, *_args: object, **_kwargs: object) -> bool:
            return True

    bus = RecordingEventBus()
    bridge = FakeBridge({"ok": True, "output": "ran", "exit_code": 0, "operationId": "op-other"})
    ctx = _context(bus, bridge, operation_service=OperationService())
    with patch("strands_backend.tools.assess_command", return_value=_allow()), patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "uptime", ssh_session_id="7")

    assert result["status"] == "indeterminate"
    assert result["reason"] == "operation_id_mismatch"
    assert "ssh_command" in bridge.calls
    evidence = get_global_tracker().list(ctx.session_id)
    assert len(evidence) == 1 and evidence[0]["status"] == "indeterminate"
    assert evidence[0]["operation_id"] == "op-expected"


@pytest.mark.parametrize(
    ("decision", "approval", "expected"),
    [("allow", None, "success"), ("confirm", NeedsYouStatus.REJECTED, "rejected")],
)
def test_real_sdk_stream_early_return_has_one_executor_owned_evidence(
    decision: str, approval: NeedsYouStatus | None, expected: str
) -> None:
    from types import SimpleNamespace
    from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
    from strands_backend.adapter import ToolCallLimitHook
    from strands_backend.tools.ssh_command import make_ssh_command_tool

    bus = RecordingEventBus()
    ctx = _context(bus, FakeBridge(), mode="confirm")
    tool_fn = make_ssh_command_tool(ctx)
    tool_use = {
        "toolUseId": f"sdk-executor-{expected}",
        "name": "ssh_command",
        "input": {
            "command": "uptime",
            "ssh_session_id": "7",
            "explanation": "check",
            "timeout": 30,
        },
    }
    state: dict = {"agent": object()}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=ctx.session_id)
    with patch(
        "strands_backend.tools.assess_command",
        return_value=_allow(decision=decision),
    ), patch(
        "strands_backend.tools.request_approval_and_wait",
        return_value=SimpleNamespace(id="req-sdk", status=approval, response={"reason": "fixture"})
        if approval else None,
    ), patch("strands_backend.tools.complete_approval_execution"), patch(
        "strands_backend.tools._audit_append"
    ):
        hook._before_tool_call(
            BeforeToolCallEvent(
                agent=None,
                selected_tool=None,
                tool_use=tool_use,
                invocation_state=state,
            )
        )

        async def run_stream() -> dict:
            events = [event async for event in tool_fn.stream(tool_use, state)]
            return events[-1].tool_result

        sdk_result = asyncio.run(run_stream())
        hook._after_tool_call(
            AfterToolCallEvent(
                agent=None,
                selected_tool=None,
                tool_use=tool_use,
                invocation_state=state,
                result=sdk_result,
            )
        )

    payload = ToolCallLimitHook._tool_payload(sdk_result)
    assert payload["status"] == expected
    evidence = get_global_tracker().list(ctx.session_id)
    assert len(evidence) == 1
    assert evidence[0]["status"] == (
        "completed" if expected == "success" else "rejected"
    )
    assert assess_session_evidence(ctx.session_id)["tier"] == (
        "grounded" if expected == "success" else "unverified"
    )
    assert [event["status"] for event in bus.tool_calls] == (
        ["started", "completed"] if expected == "success" else ["started", "error"]
    )
    assert evidence[0]["tool_call_id"] == bus.tool_calls[0]["tool_call_id"]
    assert bus.tool_calls[0]["tool_call_id"] == bus.tool_calls[1]["tool_call_id"]


@pytest.mark.parametrize(
    ("failure_state", "decision", "expected", "dispatched"),
    [
        ("none", "confirm", "success", True),
        ("create", "allow", "unavailable", False),
        ("awaiting_approval", "confirm", "error", False),
        ("approved", "confirm", "error", False),
        ("dispatching", "allow", "error", False),
        ("dispatched", "allow", "indeterminate", True),
        ("succeeded", "allow", "indeterminate", True),
    ],
)
def test_operation_transition_early_returns_are_recorded_and_gate_released(
    failure_state: str, decision: str, expected: str, dispatched: bool
) -> None:
    from types import SimpleNamespace

    class OperationService:
        def create_operation(self, **_kwargs: object) -> dict:
            if failure_state == "create":
                raise RuntimeError("operation creation failed")
            return {"id": "op-17"}

        def transition_operation(self, _operation_id: str, state: str, **_kwargs: object) -> bool:
            if state == failure_state:
                raise RuntimeError(f"transition failed: {state}")
            return True

    bus, bridge = RecordingEventBus(), FakeBridge()
    ctx = _context(bus, bridge, mode="confirm", operation_service=OperationService())
    request = SimpleNamespace(id="req-op", status=NeedsYouStatus.APPROVED)
    with patch(
        "strands_backend.tools.assess_command",
        return_value=_allow(decision=decision),
    ), patch(
        "strands_backend.tools.request_approval_and_wait", return_value=request
    ), patch("strands_backend.tools.complete_approval_execution") as release, patch(
        "strands_backend.tools._audit_append"
    ):
        result = execute_via_ssh(ctx, "uptime")

    assert result["status"] == expected
    assert ("ssh_command" in bridge.calls) is dispatched
    assert release.call_count == (1 if failure_state in ("approved", "none") else 0)
    evidence = get_global_tracker().list(ctx.session_id)
    evidence_status = "completed" if expected == "success" else expected
    assert len(evidence) == 1 and evidence[0]["status"] == evidence_status
    assert evidence[0].get("operation_id") == (
        None if failure_state == "create" else "op-17"
    )


@pytest.mark.parametrize("raises", [False, True])
def test_evidence_storage_failure_keeps_result_or_original_exception(raises: bool) -> None:
    bus = RecordingEventBus()
    tracker = get_global_tracker()
    bridge = FakeBridge()
    error = RuntimeError("assessment failed")
    with patch(
        "strands_backend.evidence.EvidenceTracker.record",
        side_effect=RuntimeError("storage failed"),
    ), patch(
        "strands_backend.tools.assess_command",
        side_effect=error if raises else None,
        return_value=None if raises else _allow(),
    ), patch("strands_backend.tools._audit_append"):
        if raises:
            with pytest.raises(RuntimeError) as caught:
                execute_via_ssh(_context(bus, bridge), "uptime")
            assert caught.value is error
            assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
        else:
            result = execute_via_ssh(_context(bus, bridge), "uptime")
            assert result["status"] == "success"
            assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
    assert tracker.list("executor-evidence-session") == []
    assert bus.tool_calls[0]["tool_call_id"] == bus.tool_calls[1]["tool_call_id"]


def test_uncaught_executor_exception_is_recorded_then_reraised_unchanged() -> None:
    bus = RecordingEventBus()
    error = RuntimeError("assessment failed")
    with patch("strands_backend.tools.assess_command", side_effect=error), patch(
        "strands_backend.tools._audit_append"
    ):
        with pytest.raises(RuntimeError) as caught:
            execute_via_ssh(_context(bus, FakeBridge()), "uptime")

    assert caught.value is error
    evidence = get_global_tracker().list("executor-evidence-session")
    assert len(evidence) == 1 and evidence[0]["status"] == "error"
    assert all(
        key not in evidence[0]
        for key in ("target_endpoint", "operation_id", "ssh_session_id")
    )
    assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
    assert evidence[0]["tool_call_id"] == bus.tool_calls[0]["tool_call_id"]


def test_sdk_before_hook_cancellation_records_only_one_evidence_item() -> None:
    from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
    from strands_backend.adapter import ToolCallLimitHook

    bus = RecordingEventBus()
    tool_use = {
        "toolUseId": "sdk-cancel-before-22",
        "name": "ssh_command",
        "input": {"command": "uptime"},
    }
    state: dict = {"agent": object()}
    hook = ToolCallLimitHook(
        agent_name="main",
        event_bus=bus,
        session_id="executor-evidence-session",
    )
    hook.cancelled = True
    before = BeforeToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use=tool_use,
        invocation_state=state,
    )
    hook._before_tool_call(before)
    assert before.cancel_tool
    hook._after_tool_call(
        AfterToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state=state,
            result={"status": "success", "output": ""},
            cancel_message="cancelled before execution",
        )
    )

    evidence = get_global_tracker().list("executor-evidence-session")
    assert len(evidence) == 1 and evidence[0]["status"] == "cancelled"
    assert evidence[0]["sdk_tool_use_id"] == "sdk-cancel-before-22"
