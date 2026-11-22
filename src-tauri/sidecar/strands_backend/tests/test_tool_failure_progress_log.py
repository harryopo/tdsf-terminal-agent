"""Retained progress logs preserve SDK tool failures without changing execution ownership."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.agent_log import reset_for_test, tail
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.modes import AgentMode
from strands_backend.tools import DefaultRustBridge, ToolContext
from strands_backend.tools.config_diff import make_config_diff_tool
from strands_backend.tools.network_diagnostic import make_network_diagnostic_tool
from strands_backend.tools.ops_extended import make_service_manage_tool
from strands_backend.tests.test_cancelled_diagnostics_consistency import (
    RecordingEventBus,
    _execute,
    _make_agent,
)


FAILURES = (
    ("service_manage", {"action": "status", "service": ""}, "service 参数缺失"),
    ("config_diff", {"file_a": "", "file_b": "/qa-b.conf"}, "file_a and file_b are required"),
    (
        "network_diagnose",
        {"mode": "invalid password=qa_synthetic_value"},
        "非法模式",
    ),
)


class _RejectingRustBridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def ipc_invoke(self, method: str, params: dict, **_kwargs):
        self.calls.append((method, params))
        raise AssertionError(f"pre-execution validation unexpectedly dispatched {method}")


def _tool(name: str, ctx: ToolContext):
    return {
        "service_manage": make_service_manage_tool,
        "config_diff": make_config_diff_tool,
        "network_diagnose": make_network_diagnostic_tool,
    }[name](ctx)


def _safe_environment(tmp_path: Path) -> dict[str, str]:
    safe = {
        name: os.environ[name]
        for name in ("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT")
        if name in os.environ
    }
    for name in ("HOME", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"):
        directory = tmp_path / name.lower()
        directory.mkdir()
        safe[name] = str(directory)
    safe["TDSF_DATA_DIR"] = str(tmp_path / "data")
    return safe


@pytest.fixture(autouse=True)
def _isolated_diagnostics(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))
    reset_for_test()
    reset_global_tracker()
    yield
    reset_for_test()
    reset_global_tracker()


@pytest.mark.parametrize("tool_name,arguments,expected_error", FAILURES)
def test_sdk_pre_execution_failure_is_retained_with_sdk_identity_and_no_execution_record(
    tmp_path: Path, tool_name: str, arguments: dict, expected_error: str,
) -> None:
    session_id = "qa-validation-" + tool_name
    sdk_id = "qa-sdk-validation-" + tool_name
    bus = RecordingEventBus()
    rust_bridge = _RejectingRustBridge()
    ctx = ToolContext(
        event_bus=bus, rust_bridge=rust_bridge, session_id=session_id, agent_name="main",
    )
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    tool_fn = _tool(tool_name, ctx)
    agent = _make_agent(hook, tool_fn)

    with patch.dict(os.environ, _safe_environment(tmp_path), clear=True):
        sdk_result = _execute(agent, tool_name, arguments, sdk_id)
        payload = hook._tool_payload(sdk_result)
        if tool_name == "network_diagnose":
            assert sdk_result["status"] == "error"
            sdk_error = " ".join(
                block.get("text", "")
                for block in sdk_result["content"]
                if isinstance(block, dict)
            )
            assert expected_error in sdk_error
        else:
            assert sdk_result["status"] == "success"
            assert payload.get("status") == "error"
            assert expected_error in str(payload)
        assert hook.failures_by_tool[tool_name] == 1
        assert hook.tool_log[-1]["status"] == "error"
        assert expected_error in hook.tool_log[-1]["error"]

        entries = tail(session_id=session_id, lines=30)["lines"]
        progress = [entry for entry in entries if entry["type"] == "loop_progress"]
        assert len(progress) == 1
        retained = progress[0]
        retained_payload = json.loads(retained["content"])
        assert retained["meta"]["sdk_tool_use_id"] == sdk_id
        assert retained_payload["sdk_tool_use_id"] == sdk_id
        assert retained["meta"]["status"] == retained_payload["status"] == "failed"
        assert expected_error in retained["meta"]["error"]
        assert retained_payload["error"] == retained["meta"]["error"]
        assert len(retained_payload["error"]) <= 120
        serialized_log = json.dumps(entries, ensure_ascii=False)
        assert "qa_synthetic_value" not in serialized_log
        if tool_name == "network_diagnose":
            assert "非法模式" in retained_payload["error"]
            assert "<REDACTED>" in serialized_log

        # These parameter failures return before execute_via_ssh owns a card or evidence row.
        assert rust_bridge.calls == []
        assert bus.tool_calls == []
        assert get_global_tracker().list(session_id) == []


def test_success_after_same_hook_failure_clears_error_and_keeps_one_execution_owner(
    tmp_path: Path,
) -> None:
    session_id = "qa-validation-failure-then-success"
    bus = RecordingEventBus()
    commands: list[tuple[str, dict]] = []

    def send_request(method: str, params: dict, *_args):
        commands.append((method, params))
        if method == "ssh_status":
            return [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                     "user": "qa", "state": "connected"}]
        assert method == "ssh_command"
        return {
            "ok": True,
            "output": "qa service active",
            "stderr": "",
            "exitCode": 0,
            "duration": 0.01,
        }

    ctx = ToolContext(
        event_bus=bus,
        rust_bridge=DefaultRustBridge(send_request=send_request),
        session_id=session_id,
        ssh_session_id="17",
        agent_name="main",
        permission_level=1,
        mode=AgentMode.AUTO,
    )
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
    service_tool = make_service_manage_tool(ctx)
    agent = _make_agent(hook, service_tool)

    with patch.dict(os.environ, _safe_environment(tmp_path), clear=True):
        failed = _execute(
            agent, "service_manage", {"action": "status", "service": ""}, "qa-sdk-failed",
        )
        assert hook._tool_payload(failed)["status"] == "error"
        assert hook.failures_by_tool["service_manage"] == 1

        succeeded = _execute(
            agent, "service_manage", {"action": "status", "service": "sshd"}, "qa-sdk-success",
        )
        assert hook._tool_payload(succeeded)["status"] == "success"
        assert hook.failures_by_tool["service_manage"] == 0
        assert hook.tool_log[-1]["status"] == "success"

        entries = tail(session_id=session_id, lines=30)["lines"]
        progress = [entry for entry in entries if entry["type"] == "loop_progress"]
        assert len(progress) == 2
        first, second = (json.loads(entry["content"]) for entry in progress)
        assert first["status"] == "failed" and "error" in first
        assert first["sdk_tool_use_id"] == "qa-sdk-failed"
        assert second["status"] == "success"
        assert second["sdk_tool_use_id"] == "qa-sdk-success"
        assert "error" not in second
        assert "service 参数缺失" not in json.dumps(second, ensure_ascii=False)

        assert [method for method, _ in commands].count("ssh_command") == 1
        assert [event["status"] for event in bus.tool_calls] == ["started", "completed"]
        evidence = get_global_tracker().list(session_id)
        assert len(evidence) == 1
        assert evidence[0]["sdk_tool_use_id"] == "qa-sdk-success"
        assert evidence[0]["status"] == "completed"
