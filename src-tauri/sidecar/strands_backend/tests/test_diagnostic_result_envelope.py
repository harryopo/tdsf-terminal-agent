"""Diagnostic tools keep the central execution envelope in their SDK result."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.tools.registry import ToolRegistry

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.log_analyzer import make_log_analyzer_tool
from strands_backend.tools.network_diagnostic import make_network_diagnostic_tool
from strands_backend.tools.process_inspector import make_process_inspector_tool


CASES = (
    ("analyze_logs", make_log_analyzer_tool,
     {"log_path": "/var/log/qa-missing.log", "mode": "tail", "lines": 7},
     {"log_path", "mode", "lines", "pattern", "ssh_session_id"},
     "tail -n 7 '/var/log/qa-missing.log'", "log"),
    ("inspect_processes", make_process_inspector_tool,
     {"mode": "detail", "pid": 424242},
     {"mode", "filter_user", "filter_name", "pid", "top_n", "ssh_session_id"},
     "ps -p 424242 -o pid,ppid,user,%cpu,%mem,stat,start,time,command", "process"),
    ("network_diagnose", make_network_diagnostic_tool,
     {"mode": "ping", "target": "qa.invalid", "count": 1},
     {"mode", "target", "count", "port", "ssh_session_id"},
     "ping -c 1 -W 2 'qa.invalid'", "network"),
)


class _Bus:
    def __init__(self) -> None:
        self.cards: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.cards.append(event)

    def emit_loop_progress(self, **_event: Any) -> None:
        pass


class _Rust:
    def __init__(self, outcome: dict[str, Any]) -> None:
        self.outcome = outcome
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any:
        self.calls.append((method, params))
        if method == "ssh_status":
            return [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                     "user": "qa", "state": "connected"}]
        assert method == "ssh_command"
        result = dict(self.outcome)
        if "operationId" in params:
            result["operationId"] = params["operationId"]
        return result


def _outcome(kind: str, code: int) -> dict[str, Any]:
    output = {
        "log": "2026-10-24T10:00:00Z qa synthetic log row\n",
        "process": "PID PPID USER %CPU %MEM STAT START TIME COMMAND\n424242 1 qa 0.0 0.1 S Oct24 00:01 qa-worker\n",
        "network": (
            "PING qa.invalid (192.0.2.1): 56 data bytes\n\n--- qa.invalid ping statistics ---\n"
            + ("1 packets transmitted, 1 received, 0% packet loss\n"
               if code == 0 else "1 packets transmitted, 0 received, 100% packet loss\n")
        ),
    }[kind]
    errors = {
        "log": "synthetic missing file: /var/log/qa-missing.log; password=qa_example_secret",
        "process": "synthetic process not found: 424242",
        "network": "synthetic ping output parse failure",
    }
    return {
        "ok": True,
        "exitCode": code,
        "output": output,
        "stderr": errors[kind] if code > 0 else "",
        "duration": 0.125,
        "truncated": code != 0,
    }


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


def _parsed_summary(kind: str, payload: dict[str, Any], expected_reachable: bool) -> None:
    if kind == "log":
        assert payload["summary"]["total_lines"] == 1
        assert payload["summary"]["sample"].startswith("2026-10-24")
    elif kind == "process":
        assert payload["count"] == 1
        assert payload["processes"][0]["pid"] == 424242
    else:
        assert payload["summary"]["transmitted"] == 1
        assert payload["summary"]["reachable"] is expected_reachable


@pytest.fixture(autouse=True)
def _isolated_sdk_environment(tmp_path: Path):
    safe_env = {name: os.environ[name] for name in
                ("PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT") if name in os.environ}
    for name in ("HOME", "USERPROFILE", "LOCALAPPDATA", "TEMP", "TMP"):
        directory = tmp_path / name.lower()
        directory.mkdir()
        safe_env[name] = str(directory)
    safe_env["TDSF_DATA_DIR"] = str(tmp_path / "data")
    reset_global_tracker()
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            yield
    finally:
        reset_global_tracker()


@pytest.mark.parametrize("name,factory,args,schema,command,kind", CASES, ids=[row[0] for row in CASES])
@pytest.mark.parametrize("exit_code", [0, 1, -1], ids=["exit-0", "readonly-exit-1", "unknown-exit"])
def test_diagnostic_sdk_result_retains_central_execution_envelope(
    name: str, factory: Any, args: dict[str, Any], schema: set[str], command: str,
    kind: str, exit_code: int,
) -> None:
    bus = _Bus()
    rust = _Rust(_outcome(kind, exit_code))
    ctx = ToolContext(event_bus=bus, rust_bridge=rust, session_id="qa-diagnostic-sdk",
                      ssh_session_id="17", mode="observe")
    tool_fn = factory(ctx)
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    tool_schema = registry.registry[name].tool_spec["inputSchema"]["json"]
    assert set(tool_schema["properties"]) == schema
    assert "sdk_tool_context" not in tool_schema["properties"]

    sdk_id = "qa-sdk-diagnostic-" + name
    tool_use = {"toolUseId": sdk_id, "name": name, "input": args}
    state: dict[str, Any] = {"agent": object()}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="qa-diagnostic-sdk")
    hook._before_tool_call(BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state,
    ))
    result = _stream(tool_fn, tool_use, state)
    hook._after_tool_call(AfterToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use,
        invocation_state=state, result=result,
    ))

    payload = _payload(result)
    cards = [card for card in bus.cards if card.get("tool_name") == name]
    terminal_status = "error" if exit_code < 0 else "completed"
    assert [card["status"] for card in cards] == ["started", terminal_status]
    completed = cards[1]["result"]
    assert cards[0]["params"]["command"] == command
    assert len([call for call in rust.calls if call[0] == "ssh_command"]) == 1
    assert hook.total_calls == 1
    assert hook.tool_log[-1]["sdk_tool_use_id"] == sdk_id
    evidence = [row for row in get_global_tracker().list("qa-diagnostic-sdk")
                if row.get("tool_name") == name]
    assert len(evidence) == 1
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert evidence[0]["tool_call_id"] == cards[0]["tool_call_id"]
    assert cards[0]["tool_call_id"] == cards[1]["tool_call_id"]

    if exit_code == -1:
        assert payload["status"] == completed["status"] == "indeterminate"
        assert payload.get("exit_code") is None
        assert completed.get("exit_code") is None
        assert payload.get("exit_code") == completed.get("exit_code")
    else:
        assert payload["status"] == completed["status"] == "success"
        assert payload["exit_code"] == completed["exit_code"] == exit_code
        assert payload["stderr"] == completed["stderr"]
        assert ("note" in payload) == ("note" in completed) == (exit_code != 0)
        if exit_code != 0:
            assert payload["note"] == completed["note"]
            assert payload["stderr"] and payload["note"]
            assert payload["truncated"] is completed["truncated"] is True
            assert "qa_example_secret" not in json.dumps(payload)
            assert "qa_example_secret" not in json.dumps(completed)
    for key in ("execution_channel", "truncated", "target_endpoint"):
        assert payload[key] == completed[key]
    assert cards[0]["source"] == cards[1]["source"]
    if exit_code >= 0:
        assert payload["duration"] == completed["duration"]
        _parsed_summary(kind, payload, expected_reachable=exit_code == 0)
