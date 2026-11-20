"""Lifecycle regressions for sidecar tools that do not use execute_via_ssh."""
from __future__ import annotations

import hashlib
from unittest.mock import MagicMock, patch

import pytest
from needs_you import NeedsYouStatus

from strands_backend.tools import ToolContext


class RecordingEventBus:
    def __init__(self) -> None:
        self.tool_calls: list[dict] = []

    def emit_tool_call(self, **event: object) -> None:
        self.tool_calls.append(event)


def _ctx(*, bus: RecordingEventBus | None = None, bridge: object = None, **values: object) -> ToolContext:
    return ToolContext(
        event_bus=bus,
        rust_bridge=bridge,
        agent_name="main",
        session_id="non-ssh-lifecycle",
        **values,
    )


def _statuses(bus: RecordingEventBus) -> list[str]:
    return [str(event["status"]) for event in bus.tool_calls]


def test_read_factory_pairs_ids_and_does_not_put_file_content_in_events() -> None:
    from strands_backend.tools.remote_file import make_remote_file_tool

    secret_content = "private file body must stay out of events"
    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {"content": secret_content, "size": len(secret_content)}
    bus = RecordingEventBus()
    read = make_remote_file_tool(_ctx(bus=bus, bridge=bridge, ssh_session_id="17"))

    first = read(path="/tmp/one.txt")
    first_events = list(bus.tool_calls)
    second = read(path="/tmp/two.txt")

    assert first["status"] == second["status"] == "success"
    assert first["content"] == second["content"] == secret_content
    assert _statuses(bus) == ["started", "completed", "started", "completed"]
    ids = [event.get("tool_call_id") for event in bus.tool_calls]
    assert all(ids), f"each read transition needs a call ID: {bus.tool_calls}"
    assert ids[0] == ids[1]
    assert ids[2] == ids[3]
    assert ids[0] != ids[2]
    assert secret_content not in str(first_events)
    assert secret_content not in str(bus.tool_calls)


@pytest.mark.parametrize(
    ("bridge", "session_id", "expected_status"),
    [
        (None, "17", "unavailable"),
        (MagicMock(), "", "unavailable"),
        (MagicMock(), "17", "error"),
        (MagicMock(), "17", "binary"),
    ],
)
def test_read_factory_closes_unavailable_error_and_binary_calls(
    bridge: object, session_id: str, expected_status: str
) -> None:
    from strands_backend.tools.remote_file import make_remote_file_tool

    if bridge is not None:
        bridge.ipc_invoke.side_effect = RuntimeError("bridge failed") if expected_status == "error" else None
        if expected_status == "binary":
            bridge.ipc_invoke.return_value = b"\x00\x01"
    bus = RecordingEventBus()
    read = make_remote_file_tool(_ctx(bus=bus, bridge=bridge, ssh_session_id=session_id))

    result = read(path="/tmp/input.bin")

    assert result["status"] == expected_status
    terminal_status = "error" if expected_status == "error" else "completed"
    assert _statuses(bus) == ["started", terminal_status]
    assert bus.tool_calls[-1].get("result", {}).get("status") == expected_status
    ids = [event.get("tool_call_id") for event in bus.tool_calls]
    assert all(ids)
    assert ids[0] == ids[1]


def test_write_factory_keeps_card_operation_and_approval_identity_and_rejects_safely() -> None:
    from strands_backend.tools.remote_file import make_write_remote_file_tool

    original = b"before=value\n"
    content = "after=value\n"
    bridge = MagicMock()
    bridge.ipc_invoke.side_effect = [list(original)]
    bus = RecordingEventBus()
    operation = MagicMock()
    operation.create_operation.return_value = {"id": "op-write-23"}
    ctx = _ctx(
        bus=bus,
        bridge=bridge,
        ssh_session_id="23",
        mode="confirm",
        operation_service=operation,
    )
    approval = MagicMock(status=NeedsYouStatus.REJECTED)
    with patch(
        "strands_backend.tools.remote_file.request_approval_and_wait",
        return_value=approval,
    ) as request:
        write = make_write_remote_file_tool(ctx)
        result = write(
            path="/etc/example.conf",
            content=content,
            expected_sha256=hashlib.sha256(original).hexdigest(),
        )

    assert result["status"] == "rejected"
    assert _statuses(bus) == ["started", "error"]
    call_ids = [event.get("tool_call_id") for event in bus.tool_calls]
    assert all(call_ids) and call_ids[0] == call_ids[1]
    request_id = request.call_args.kwargs["tool_call_id"]
    assert request_id == call_ids[0]
    assert request.call_args.kwargs["operation_id"] == "op-write-23"
    assert request.call_args.kwargs["ssh_session_id"] == "23"
    assert operation.create_operation.call_args.kwargs["ssh_session_id"] == "23"
    assert bridge.ipc_invoke.call_count == 0
    assert not any(call.args[0] == "sftp_write" for call in bridge.ipc_invoke.call_args_list)


def test_python_run_approval_uses_the_factory_card_identity(tmp_path) -> None:
    import importlib

    module = importlib.import_module("strands_backend.tools.python_run")
    from strands_backend.tools.python_run import make_python_run_tool

    bus = RecordingEventBus()
    ctx = _ctx(bus=bus, workspace=str(tmp_path), mode="confirm")
    approved = MagicMock(status=NeedsYouStatus.APPROVED, response={})
    with patch.object(
        module,
        "_assess_python_risk",
        return_value={"risk_l": 3, "actions": [], "summary": "write"},
    ), patch.object(module, "request_approval_and_wait", return_value=approved) as request, patch.object(
        module, "_execute_python", return_value={"status": "success", "exit_code": 0}
    ):
        run = make_python_run_tool(ctx)
        result = run(code="open('/tmp/x', 'w').write('x')")

    assert result["status"] == "success"
    assert _statuses(bus) == ["started", "completed"]
    call_ids = [event.get("tool_call_id") for event in bus.tool_calls]
    assert all(call_ids) and call_ids[0] == call_ids[1]
    assert request.call_args.kwargs["tool_call_id"] == call_ids[0]


def test_teach_command_exception_closes_one_card_and_never_executes() -> None:
    import importlib

    module = importlib.import_module("strands_backend.tools.teach_command")
    from strands_backend.tools.teach_command import make_teach_command_tool

    bus = RecordingEventBus()
    bridge = MagicMock()
    ctx = _ctx(bus=bus, bridge=bridge, teach=True)
    with patch.object(module, "analyze", side_effect=RuntimeError("analysis failed")):
        teach = make_teach_command_tool(ctx)
        with pytest.raises(RuntimeError, match="analysis failed"):
            teach(command="printf safe")

    assert _statuses(bus) == ["started", "error"]
    call_ids = [event.get("tool_call_id") for event in bus.tool_calls]
    assert all(call_ids) and call_ids[0] == call_ids[1]
    bridge.ipc_invoke.assert_not_called()


def test_teach_command_pending_step_emits_one_card_per_call_without_execution() -> None:
    from strands_backend.tools.teach_command import make_teach_command_tool

    bus = RecordingEventBus()
    bridge = MagicMock()
    teach = make_teach_command_tool(_ctx(bus=bus, bridge=bridge, teach=True))

    first = teach(command="printf safe")
    second = teach(command="printf another")

    assert first["status"] == "teach_command"
    assert second["status"] == "teach_step_pending"
    assert _statuses(bus) == ["started", "completed", "started", "completed"]
    call_ids = [event["tool_call_id"] for event in bus.tool_calls]
    assert call_ids[0] == call_ids[1]
    assert call_ids[2] == call_ids[3]
    assert call_ids[0] != call_ids[2]
    bridge.ipc_invoke.assert_not_called()


# Supplemental cases below were added after the first red baseline; they were
# not run against the untouched-source baseline.
def test_read_error_envelope_closes_card_as_error() -> None:
    from strands_backend.tools.remote_file import make_remote_file_tool

    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {"status": "error", "error": "remote read failed"}
    bus = RecordingEventBus()
    result = make_remote_file_tool(
        _ctx(bus=bus, bridge=bridge, ssh_session_id="17")
    )(path="/tmp/input.txt")

    assert result["status"] == "error"
    assert _statuses(bus) == ["started", "error"]
    assert bus.tool_calls[-1]["result"]["status"] == "error"
    assert bus.tool_calls[0]["tool_call_id"] == bus.tool_calls[-1]["tool_call_id"]


def test_read_factory_exception_from_invalid_metadata_closes_card() -> None:
    from strands_backend.tools.remote_file import make_remote_file_tool

    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {"content": "text", "size": "not-a-size"}
    bus = RecordingEventBus()
    read = make_remote_file_tool(_ctx(bus=bus, bridge=bridge, ssh_session_id="17"))

    with pytest.raises(ValueError):
        read(path="/tmp/input.txt")

    assert _statuses(bus) == ["started", "error"]
    assert bus.tool_calls[0]["tool_call_id"] == bus.tool_calls[-1]["tool_call_id"]


def test_read_call_id_is_not_part_of_real_model_visible_schema() -> None:
    from strands.tools.registry import ToolRegistry
    from strands_backend.tools.remote_file import make_remote_file_tool

    registry = ToolRegistry()
    registry.process_tools([make_remote_file_tool(_ctx())])
    schema = registry.registry["read_remote_file"].tool_spec["inputSchema"]["json"]

    assert "tool_call_id" not in schema["properties"]
    assert "tool_call_id" not in schema["required"]


def test_missing_event_bus_does_not_change_tool_result_or_exception() -> None:
    from strands_backend.tools.remote_file import make_remote_file_tool
    from strands_backend.tools.teach_command import make_teach_command_tool

    bridge_with_bus = MagicMock()
    bridge_without_bus = MagicMock()
    bridge_with_bus.ipc_invoke.return_value = {"content": "same result", "size": 11}
    bridge_without_bus.ipc_invoke.return_value = {"content": "same result", "size": 11}
    bus = RecordingEventBus()
    with_bus = make_remote_file_tool(
        _ctx(bus=bus, bridge=bridge_with_bus, ssh_session_id="17")
    )(path="/tmp/result.txt")
    without_bus = make_remote_file_tool(
        _ctx(bridge=bridge_without_bus, ssh_session_id="17")
    )(path="/tmp/result.txt")
    assert without_bus == with_bus
    assert len(bus.tool_calls) == 2

    teach_bus = RecordingEventBus()
    teach_result = make_teach_command_tool(_ctx(bus=teach_bus, teach=True))(
        command="printf safe"
    )
    no_bus_result = make_teach_command_tool(_ctx(teach=True))(command="printf safe")
    assert no_bus_result == teach_result
    assert len(teach_bus.tool_calls) == 2

    failing_bridge = MagicMock()
    failing_bridge.ipc_invoke.side_effect = RuntimeError("same bridge error")
    bus_error = make_remote_file_tool(
        _ctx(bus=RecordingEventBus(), bridge=failing_bridge, ssh_session_id="17")
    )(path="/tmp/result.txt")
    no_bus_error = make_remote_file_tool(
        _ctx(bridge=failing_bridge, ssh_session_id="17")
    )(path="/tmp/result.txt")
    assert no_bus_error == bus_error
