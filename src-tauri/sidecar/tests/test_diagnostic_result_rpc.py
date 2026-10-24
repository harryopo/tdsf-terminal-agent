"""Non-zero read-only diagnostics retain the execution envelope over real RPC."""
from __future__ import annotations

import json
import os
import queue
import time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from test_model_rpc_chain import DEADLINE, _Sidecar, _configure, _invoke_params
from test_reference_rpc_capabilities import _assert_schema, _isolated_environment
from test_tool_rpc_lifecycle import _ToolModelServer


CASES = (
    ("analyze_logs", {"log_path": "/var/log/qa-missing.log", "mode": "tail", "lines": 7},
     {"log_path", "mode", "lines", "pattern", "ssh_session_id"},
     "tail -n 7 '/var/log/qa-missing.log'", "log", 1),
    ("inspect_processes", {"mode": "detail", "pid": 424242},
     {"mode", "filter_user", "filter_name", "pid", "top_n", "ssh_session_id"},
     "ps -p 424242 -o pid,ppid,user,%cpu,%mem,stat,start,time,command", "process", 1),
    ("network_diagnose", {"mode": "ping", "target": "qa.invalid", "count": 1},
     {"mode", "target", "count", "port", "ssh_session_id"},
     "ping -c 1 -W 2 'qa.invalid'", "network", 2),
)


class _DiagnosticSidecar(_Sidecar):
    """Answer only these three synthetic Rust reverse calls; no SSH is opened."""

    def __init__(self, *args, tool_name: str, command: str, kind: str, **kwargs):
        self.tool_name = tool_name
        self.command = command
        self.kind = kind
        self.reverse_requests: list[dict] = []
        super().__init__(*args, **kwargs)

    def _next(self, timeout: float = DEADLINE) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"sidecar message timeout; stderr: {self.stderr_path}")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise AssertionError(f"sidecar message timeout; stderr: {self.stderr_path}") from error
            if message is None or isinstance(message, BaseException):
                raise AssertionError(f"sidecar stdout failed; stderr: {self.stderr_path}")
            self.received.append(message)
            if "method" not in message or "id" not in message:
                return message
            method, params = message["method"], message.get("params", {})
            self.reverse_requests.append(message)
            if method == "ssh_status":
                assert params == {}
                result: object = [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                                   "user": "qa", "state": "connected"}]
            else:
                assert method == "ssh_command", message
                assert params["sessionId"] == 17
                assert params["toolName"] == self.tool_name
                assert params["command"] == self.command
                assert params["conversationSessionId"]
                assert params["operationId"] and params["toolCallId"]
                stderr = {
                    "log": "synthetic missing file: /var/log/qa-missing.log; password=qa_example_secret",
                    "process": "synthetic process not found: 424242",
                    "network": "synthetic ping output parse failure",
                }[self.kind]
                output = {
                    "log": "2026-10-24T10:00:00Z qa synthetic log row\n",
                    "process": "PID PPID USER %CPU %MEM STAT START TIME COMMAND\n424242 1 qa 0.0 0.1 S Oct24 00:01 qa-worker\n",
                    "network": "PING qa.invalid (192.0.2.1): 56 data bytes\n\n--- qa.invalid ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss\n",
                }[self.kind]
                result = {
                    "ok": True,
                    "exitCode": 1 if self.kind != "network" else 2,
                    "output": output,
                    "stderr": stderr,
                    "duration": 0.125,
                    "operationId": params["operationId"],
                    "truncated": True,
                }
            assert self.process.stdin is not None
            self.process.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": message["id"], "result": result,
            }, ensure_ascii=False) + "\n")
            self.process.stdin.flush()


def _actual_tool_result(server: _ToolModelServer) -> dict:
    histories = [
        [message for message in body.get("messages", []) if message.get("role") == "tool"]
        for body in server.snapshot()[1:]
    ]
    assert histories and all(len(history) == 1 for history in histories)
    messages = [history[0] for history in histories]
    assert all(message == messages[0] for message in messages)
    assert messages[0]["tool_call_id"] == "qa-sdk-call-" + server.tool_name
    return json.loads(messages[0]["content"])


@pytest.mark.parametrize("tool_name,arguments,schema,command,kind,exit_code", CASES,
                         ids=[row[0] for row in CASES])
def test_diagnostic_nonzero_result_matches_central_card_and_actual_model_request(
    tmp_path: Path, tool_name: str, arguments: dict, schema: set[str], command: str,
    kind: str, exit_code: int,
) -> None:
    server = _ToolModelServer(tool_name, arguments)
    sidecar = None
    session, stream, invoke_id = "qa-diagnostic-" + uuid4().hex, str(uuid4()), 20
    capture: dict = {"tool_name": tool_name, "cards": [], "business": None,
                     "evidence": None, "logs": None}
    try:
        with patch.dict(os.environ, _isolated_environment(tmp_path / "profile"), clear=True):
            sidecar = _DiagnosticSidecar(
                tmp_path, tool_name=tool_name, command=command, kind=kind,
            )
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-diagnostic-outcomes")["ok"] is True
            params = _invoke_params(session, "qa diagnostic " + tool_name, stream)
            params["state"]["mode"] = "auto"
            params["state"]["live"] = {
                "agentMode": "auto", "permissionLevel": 1,
                "sshSessionId": 17, "sshConnection": "qa@qa.invalid",
            }
            sidecar.send("agent.invoke", params, invoke_id)
            response = sidecar.wait_rpc(invoke_id)
            capture["response"] = response
            assert "error" not in response, response
            assert response["result"].get("observation")
            _assert_schema(server, tool_name, schema)

            cards = capture["cards"] = []
            sources = capture["card_sources"] = []
            for status in ("started", "completed"):
                event = sidecar.wait_notification(
                    "tool_call",
                    lambda event_params, expected=status: event_params.get("session_id") == session
                    and event_params.get("rpc_request_id") == invoke_id
                    and event_params.get("rpc_stream_id") == stream
                    and event_params.get("payload", {}).get("tool_name") == tool_name
                    and event_params.get("payload", {}).get("status") == expected,
                )
                cards.append(event["params"]["payload"])
                sources.append(event["params"]["source"])

            evidence = capture["evidence"] = sidecar.call(
                40, "evidence.list", {"session_id": session},
            )
            logs = capture["logs"] = sidecar.call(
                41, "debug.agent_log_tail", {"session_id": session, "lines": 100},
            )
            trace = [row for row in logs["lines"]
                     if row.get("meta", {}).get("tool_name") == tool_name
                     and row.get("type") in {"tool_call", "tool_result", "loop_progress"}]

            completed = cards[1]["result"]
            business = capture["business"] = _actual_tool_result(server)
            assert business["status"] == completed["status"] == "success"
            assert business["exit_code"] == completed["exit_code"] == exit_code
            assert business["stderr"] == completed["stderr"]
            assert business["note"] == completed["note"]
            assert business["stderr"] and business["note"]
            assert business["truncated"] is completed["truncated"] is True
            assert "qa_example_secret" not in json.dumps(business)
            assert "qa_example_secret" not in json.dumps(completed)
            for field in ("execution_channel", "duration", "truncated", "target_endpoint"):
                assert business[field] == completed[field]
            assert sources == ["main_agent.strands_tool." + tool_name] * 2
            assert cards[0]["params"]["command"] == command
            assert cards[0]["tool_call_id"] == cards[1]["tool_call_id"]

            commands = [message for message in sidecar.reverse_requests
                        if message["method"] == "ssh_command"]
            assert len(commands) == 1
            assert commands[0]["params"]["sessionId"] == 17
            assert commands[0]["params"]["command"] == command
            assert commands[0]["params"]["toolName"] == tool_name
            assert commands[0]["params"]["conversationSessionId"] == session
            assert commands[0]["params"]["operationId"]
            assert commands[0]["params"]["toolCallId"] == cards[0]["tool_call_id"]

            matching = [row for row in evidence if row.get("tool_name") == tool_name]
            assert len(matching) == 1
            assert matching[0]["tool_call_id"] == cards[0]["tool_call_id"]
            assert matching[0]["sdk_tool_use_id"] == "qa-sdk-call-" + tool_name
            assert [row["type"] for row in trace] == ["tool_call", "tool_result", "loop_progress"]
            assert all(row["meta"]["tool_call_id"] == cards[0]["tool_call_id"] for row in trace)
            assert trace[-1]["meta"]["sdk_tool_use_id"] == "qa-sdk-call-" + tool_name
    finally:
        try:
            capture["model_requests"] = server.snapshot()
            capture["reverse_requests"] = getattr(sidecar, "reverse_requests", [])
            capture["notifications"] = getattr(sidecar, "received", [])
            (tmp_path / "capture.json").write_text(
                json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8",
            )
        finally:
            try:
                if sidecar is not None:
                    sidecar.close()
            finally:
                server.close()
