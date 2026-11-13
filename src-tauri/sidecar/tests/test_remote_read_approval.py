"""Regression coverage for approval-gated reads of remote credential files."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from needs_you import NeedsYouStatus  # noqa: E402
from strands_backend.modes import AgentMode  # noqa: E402
from strands_backend.tools import ToolContext  # noqa: E402
from strands_backend.tools import remote_file  # noqa: E402


class FakeBridge:
    def __init__(self, result: object = "fictional remote text", error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[tuple[str, dict]] = []

    def ipc_invoke(self, method: str, params: dict) -> object:
        self.calls.append((method, params))
        if self.error is not None:
            raise self.error
        return self.result


class FakeEventBus:
    def __init__(self):
        self.events: list[dict] = []

    def emit_tool_call(self, **event: object) -> None:
        self.events.append(event)


def _ctx(mode: AgentMode | str, *, bridge: FakeBridge | None = None, event_bus=None) -> ToolContext:
    return ToolContext(
        mode=mode,
        rust_bridge=bridge if bridge is not None else FakeBridge(),
        event_bus=event_bus,
        session_id="conversation-1",
        ssh_session_id="17",
    )


def _approval(monkeypatch, status=NeedsYouStatus.APPROVED, *, on_request=None, returns_none=False):
    calls: list[tuple[tuple, dict]] = []
    released: list[object] = []
    request = SimpleNamespace(status=status, id="approval-1")

    def wait(*args, **kwargs):
        calls.append((args, kwargs))
        if on_request is not None:
            on_request()
        return None if returns_none else request

    monkeypatch.setattr(remote_file, "request_approval_and_wait", wait)
    monkeypatch.setattr(remote_file, "complete_approval_execution", released.append)
    return calls, released, request


@pytest.mark.parametrize("mode", [AgentMode.OBSERVE, AgentMode.CONFIRM, AgentMode.AUTO])
def test_ordinary_remote_file_reads_do_not_request_approval(monkeypatch, mode):
    bridge = FakeBridge()
    ctx = _ctx(mode, bridge=bridge)
    calls, released, _ = _approval(monkeypatch)

    result = remote_file.invoke_remote_file_tool({"path": "/etc/hosts"}, ctx)

    assert result["status"] == "success"
    assert result["content"] == "fictional remote text"
    assert len(bridge.calls) == 1
    assert calls == []
    assert released == []


@pytest.mark.parametrize(
    "path",
    [
        "/home/user/.ssh/id_ed25519",
        "/etc/shadow",
        "/home/user/.aws/credentials",
        "/home/user/.tdsf-data/llm_config.json",
        "/etc/./shadow",
        "/etc//shadow",
        "/./etc/shadow",
    ],
)
def test_observe_blocks_credential_paths_without_io(monkeypatch, path):
    bridge = FakeBridge()
    calls, released, _ = _approval(monkeypatch)

    result = remote_file.invoke_remote_file_tool({"path": path}, _ctx(AgentMode.OBSERVE, bridge=bridge))

    assert result["status"] == "command_blocked"
    assert bridge.calls == []
    assert calls == []
    assert released == []


@pytest.mark.parametrize("mode", [AgentMode.CONFIRM, AgentMode.AUTO])
@pytest.mark.parametrize(
    "path",
    ["/home/user/.ssh/id_ed25519", "/etc/shadow", "/home/user/.aws/credentials", "/home/user/llm_config.json"],
)
def test_credential_reads_are_gated_by_approval_and_bind_the_read(monkeypatch, mode, path):
    bridge = FakeBridge()
    ctx = _ctx(mode, bridge=bridge)
    calls, released, request = _approval(monkeypatch)
    tool_call_id = "call-remote-read-1"

    result = remote_file.invoke_remote_file_tool(
        {"path": path, "ssh_session_id": "29"}, ctx, tool_call_id=tool_call_id
    )

    assert result["status"] == "success"
    assert result["content"] == "fictional remote text"
    assert bridge.calls == [("sftp_read", {"sessionId": 29, "path": path, "max_size": 1048576})]
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args[0] is ctx
    assert path in args[1]
    assert args[2]["write"] is False
    assert kwargs["tool_name"] == "read_remote_file"
    assert kwargs["risk_l"] == 3
    assert any(segment["category"] == "credential" for segment in kwargs["impact"]["segments"])
    assert kwargs["ssh_session_id"] == "29"
    assert kwargs["tool_call_id"] == tool_call_id
    assert released == [request]


@pytest.mark.parametrize(
    "status,expected",
    [
        (NeedsYouStatus.REJECTED, "rejected"),
        (NeedsYouStatus.TIMEOUT, "needs_approval"),
        (NeedsYouStatus.CANCELLED, "cancelled"),
        (NeedsYouStatus.PENDING, "needs_approval"),
        ("OTHER", "needs_approval"),
    ],
)
def test_non_approved_credential_read_never_reaches_bridge_or_releases(monkeypatch, status, expected):
    bridge = FakeBridge()
    calls, released, _ = _approval(monkeypatch, status)

    result = remote_file.invoke_remote_file_tool(
        {"path": "/etc/shadow"}, _ctx(AgentMode.CONFIRM, bridge=bridge)
    )

    assert result["status"] == expected
    assert "content" not in result
    assert bridge.calls == []
    assert len(calls) == 1
    assert released == []


def test_missing_approval_request_never_reaches_bridge_or_releases(monkeypatch):
    bridge = FakeBridge()
    calls, released, _ = _approval(monkeypatch, returns_none=True)

    result = remote_file.invoke_remote_file_tool(
        {"path": "/etc/shadow"}, _ctx(AgentMode.CONFIRM, bridge=bridge)
    )

    assert result["status"] == "needs_approval"
    assert "content" not in result
    assert bridge.calls == []
    assert len(calls) == 1
    assert released == []


def test_invalid_mode_fails_closed_before_remote_read(monkeypatch):
    bridge = FakeBridge()
    calls, released, _ = _approval(monkeypatch)

    result = remote_file.invoke_remote_file_tool(
        {"path": "/etc/shadow"}, _ctx("invalid-mode", bridge=bridge)
    )

    assert result["status"] == "command_blocked"
    assert bridge.calls == []
    assert calls == []
    assert released == []


@pytest.mark.parametrize(
    "result,error,expected",
    [
        ("fictional remote text", None, "success"),
        (None, RuntimeError("bridge failed"), "error"),
        ({"status": "error", "error": "unavailable"}, None, "error"),
        ({"status": "unavailable", "reason": "offline"}, None, "unavailable"),
        ({"size": 8}, None, "error"),
        ([999], None, "error"),
    ],
)
def test_approved_read_releases_once_after_every_bridge_outcome(monkeypatch, result, error, expected):
    bridge = FakeBridge(result=result, error=error)
    calls, released, request = _approval(monkeypatch)

    response = remote_file.invoke_remote_file_tool(
        {"path": "/etc/shadow"}, _ctx(AgentMode.AUTO, bridge=bridge)
    )

    assert response["status"] == expected
    assert len(calls) == 1
    assert released == [request]


@pytest.mark.parametrize(
    "bridge,session,expected",
    [(None, "17", "unavailable"), (FakeBridge(), "not-a-session", "error"), (FakeBridge(), "0", "unavailable"), (FakeBridge(), "", "unavailable")],
)
def test_missing_bridge_or_invalid_session_preserves_status_without_approval(monkeypatch, bridge, session, expected):
    calls, released, _ = _approval(monkeypatch)
    ctx = _ctx(AgentMode.CONFIRM, bridge=bridge)
    ctx.rust_bridge = bridge
    ctx.ssh_session_id = session

    result = remote_file.invoke_remote_file_tool({"path": "/etc/shadow"}, ctx)

    assert result["status"] == expected
    assert calls == []
    assert released == []
    assert bridge is None or bridge.calls == []


def test_approval_uses_original_path_and_session_if_context_changes_while_waiting(monkeypatch):
    bridge = FakeBridge()
    ctx = _ctx(AgentMode.CONFIRM, bridge=bridge)

    def mutate_context():
        ctx.ssh_session_id = "99"
        ctx.mode = AgentMode.OBSERVE

    calls, released, request = _approval(monkeypatch, on_request=mutate_context)
    result = remote_file.invoke_remote_file_tool(
        {"path": "/etc/shadow"}, ctx, tool_call_id="bound-call"
    )

    assert result["status"] == "success"
    assert bridge.calls == [("sftp_read", {"sessionId": 17, "path": "/etc/shadow", "max_size": 1048576})]
    assert calls[0][1]["ssh_session_id"] == "17"
    assert calls[0][1]["tool_call_id"] == "bound-call"
    assert released == [request]


def test_factory_events_share_call_id_and_never_include_file_content(monkeypatch):
    event_bus = FakeEventBus()
    ctx = _ctx(AgentMode.CONFIRM, event_bus=event_bus)
    calls, _, _ = _approval(monkeypatch)
    tool = remote_file.make_remote_file_tool(ctx)

    result = tool(path="/etc/shadow")

    assert result["content"] == "fictional remote text"
    assert [event["status"] for event in event_bus.events] == ["started", "completed"]
    assert len({event["tool_call_id"] for event in event_bus.events}) == 1
    assert calls[0][1]["tool_call_id"] == event_bus.events[0]["tool_call_id"]
    assert all("fictional remote text" not in repr(event) for event in event_bus.events)
