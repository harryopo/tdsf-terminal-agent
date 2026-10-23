"""Remote file SDK calls must preserve the identity of their UI card."""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from needs_you import NeedsYouStatus
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.tools.registry import ToolRegistry

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.remote_file import (
    make_remote_file_tool,
    make_write_remote_file_tool,
)


class RecordingEventBus:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.events.append(event)

    def emit_loop_progress(self, **_event: Any) -> None:
        pass


class MemoryRustBridge:
    def __init__(self, initial: bytes, *, changed_before_write: bytes | None = None) -> None:
        self.files = {"/tmp/remote.txt": initial}
        self.changed_before_write = changed_before_write
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any:
        self.calls.append((method, params))
        path = params["path"]
        if method == "sftp_read":
            if self.changed_before_write is not None:
                self.files[path] = self.changed_before_write
                self.changed_before_write = None
            return list(self.files[path])
        if method == "sftp_write":
            self.files[path] = bytes(params["content"])
            return None
        raise AssertionError(f"unexpected RustBridge method: {method}")


def _sdk_result(tool_fn: Any, tool_use: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    async def run_stream():
        return [event async for event in tool_fn.stream(tool_use, state)]

    return asyncio.run(run_stream())[-1].tool_result


def _business_payload(result: dict[str, Any]) -> dict[str, Any]:
    for block in result["content"]:
        if isinstance(block.get("json"), dict):
            return block["json"]
        if isinstance(block.get("text"), str):
            payload = json.loads(block["text"])
            assert isinstance(payload, dict)
            return payload
    pytest.fail("SDK result has no business payload")


def _ctx(bus: RecordingEventBus, bridge: Any, *, mode: str = "confirm") -> ToolContext:
    return ToolContext(
        event_bus=bus,
        rust_bridge=bridge,
        agent_name="main",
        session_id="remote-file-sdk-link",
        ssh_session_id="17",
        mode=mode,
    )


def _run_sdk_call(tool_fn: Any, tool_name: str, tool_input: dict[str, Any], bus: RecordingEventBus):
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry[tool_name].tool_spec["inputSchema"]["json"]
    expected_fields = (
        {"path", "ssh_session_id", "max_size", "encoding"}
        if tool_name == "read_remote_file"
        else {"path", "content", "expected_sha256", "ssh_session_id"}
    )
    assert set(schema["properties"]) == expected_fields

    sdk_id = f"sdk-{tool_name}-call-31"
    tool_use = {
        "toolUseId": sdk_id,
        "name": tool_name,
        "input": dict(tool_input),
    }
    state: dict[str, Any] = {"agent": object()}
    hook = ToolCallLimitHook(
        agent_name="main", event_bus=bus, session_id="remote-file-sdk-link"
    )
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state
    ))
    sdk_result = _sdk_result(tool_fn, tool_use, state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None,
        selected_tool=None,
        tool_use=tool_use,
        invocation_state=state,
        result=sdk_result,
    ))

    card_events = [event for event in bus.events if event["tool_name"] == tool_name]
    evidence = [
        item for item in get_global_tracker().list("remote-file-sdk-link")
        if item["tool_name"] == tool_name
    ]
    assert len(card_events) == 2
    business = _business_payload(sdk_result)
    terminal = (
        "error" if business["status"] == "error"
        or (tool_name == "write_remote_file" and business["status"] != "success")
        else "completed"
    )
    assert [event["status"] for event in card_events] == ["started", terminal]
    assert len(evidence) == 1
    assert hook.tool_log[-1]["name"] == tool_name
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in schema["required"]
    assert "sdk_tool_context" not in card_events[0]["params"]
    return sdk_id, card_events, evidence[0], hook.tool_log[-1], sdk_result


@pytest.fixture(autouse=True)
def _reset_evidence():
    reset_global_tracker()
    yield
    reset_global_tracker()


def test_read_sdk_success_links_card_log_and_evidence_without_changing_schema() -> None:
    body = b"remote file body"
    bridge = MemoryRustBridge(body)
    bus = RecordingEventBus()
    tool_fn = make_remote_file_tool(_ctx(bus, bridge))

    sdk_id, cards, evidence, log, sdk_result = _run_sdk_call(
        tool_fn, "read_remote_file", {"path": "/tmp/remote.txt"}, bus
    )

    card_id = cards[0]["tool_call_id"]
    assert card_id == cards[1]["tool_call_id"]
    assert evidence["tool_call_id"] == log["tool_call_id"] == card_id
    assert evidence["sdk_tool_use_id"] == log["sdk_tool_use_id"] == sdk_id
    assert card_id != sdk_id
    assert _business_payload(sdk_result)["content"] == body.decode()
    assert bridge.calls == [("sftp_read", {
        "sessionId": 17, "path": "/tmp/remote.txt", "max_size": 1048576,
    })]


def test_direct_read_call_does_not_require_sdk_context() -> None:
    body = "direct file body"
    bridge = MemoryRustBridge(body.encode())
    bus = RecordingEventBus()
    result = make_remote_file_tool(_ctx(bus, bridge))(path="/tmp/remote.txt")

    assert result["status"] == "success"
    assert result["content"] == body
    assert [event["status"] for event in bus.events] == ["started", "completed"]


@pytest.mark.parametrize(
    ("reply", "expected_status"),
    [
        (b"\x00\x01", "binary"),
        ({"status": "unavailable", "reason": "fixture"}, "unavailable"),
        (RuntimeError("bridge failed"), "error"),
    ],
)
def test_read_sdk_non_success_outcomes_keep_the_same_call_identity(
    reply: Any, expected_status: str
) -> None:
    bridge = MagicMock()
    if isinstance(reply, Exception):
        bridge.ipc_invoke.side_effect = reply
    else:
        bridge.ipc_invoke.return_value = reply
    bus = RecordingEventBus()

    sdk_id, cards, evidence, log, sdk_result = _run_sdk_call(
        make_remote_file_tool(_ctx(bus, bridge)),
        "read_remote_file",
        {"path": "/tmp/remote.txt"},
        bus,
    )

    card_id = cards[0]["tool_call_id"]
    assert card_id == cards[1]["tool_call_id"]
    assert evidence["tool_call_id"] == log["tool_call_id"] == card_id
    assert evidence["sdk_tool_use_id"] == log["sdk_tool_use_id"] == sdk_id
    assert _business_payload(sdk_result)["status"] == expected_status


def test_write_sdk_success_links_card_log_and_evidence() -> None:
    original = b"before=value\n"
    updated = "after=value\n"
    bridge = MemoryRustBridge(original)
    bus = RecordingEventBus()
    approved = MagicMock(status=NeedsYouStatus.APPROVED)
    tool_fn = make_write_remote_file_tool(_ctx(bus, bridge))

    with patch(
        "strands_backend.tools.remote_file.request_approval_and_wait",
        return_value=approved,
    ):
        sdk_id, cards, evidence, log, sdk_result = _run_sdk_call(
            tool_fn,
            "write_remote_file",
            {
                "path": "/tmp/remote.txt",
                "content": updated,
                "expected_sha256": hashlib.sha256(original).hexdigest(),
            },
            bus,
        )

    card_id = cards[0]["tool_call_id"]
    assert card_id == cards[1]["tool_call_id"]
    assert evidence["tool_call_id"] == log["tool_call_id"] == card_id
    assert evidence["sdk_tool_use_id"] == log["sdk_tool_use_id"] == sdk_id
    assert card_id != sdk_id
    assert _business_payload(sdk_result)["status"] == "success"
    assert bridge.files["/tmp/remote.txt"] == updated.encode()
    backups = [value for path, value in bridge.files.items() if ".tdsf-backup-" in path]
    assert backups == [original]
    assert [method for method, _ in bridge.calls] == [
        "sftp_read", "sftp_write", "sftp_write", "sftp_read"
    ]


@pytest.mark.parametrize(
    ("approval_status", "changed_before_write", "expected_status", "expected_writes"),
    [
        (NeedsYouStatus.REJECTED, None, "rejected", 0),
        (NeedsYouStatus.APPROVED, b"newer=value\n", "stale_source", 0),
    ],
)
def test_write_sdk_rejection_and_version_conflict_keep_identity_and_do_not_write(
    approval_status: NeedsYouStatus,
    changed_before_write: bytes | None,
    expected_status: str,
    expected_writes: int,
) -> None:
    original = b"before=value\n"
    bridge = MemoryRustBridge(original, changed_before_write=changed_before_write)
    bus = RecordingEventBus()
    approved = MagicMock(status=approval_status)

    with patch(
        "strands_backend.tools.remote_file.request_approval_and_wait",
        return_value=approved,
    ):
        sdk_id, cards, evidence, log, sdk_result = _run_sdk_call(
            make_write_remote_file_tool(_ctx(bus, bridge)),
            "write_remote_file",
            {
                "path": "/tmp/remote.txt",
                "content": "after=value\n",
                "expected_sha256": hashlib.sha256(original).hexdigest(),
            },
            bus,
        )

    card_id = cards[0]["tool_call_id"]
    assert card_id == cards[1]["tool_call_id"]
    assert evidence["tool_call_id"] == log["tool_call_id"] == card_id
    assert evidence["sdk_tool_use_id"] == log["sdk_tool_use_id"] == sdk_id
    assert _business_payload(sdk_result)["status"] == expected_status
    assert sum(method == "sftp_write" for method, _ in bridge.calls) == expected_writes
