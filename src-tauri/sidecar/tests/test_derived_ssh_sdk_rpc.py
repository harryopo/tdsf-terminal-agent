"""Real sidecar and SDK traces for derived SSH tool identities."""
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
from test_tool_rpc_lifecycle import _ToolModelServer, _respond, _wait_for_tool_request


READ_CASES = (
    ("service_manage", {"action": "status", "service": "nginx"},
     {"action", "service", "ssh_session_id", "timeout"}, "systemctl status nginx --no-pager -l"),
    ("package_manage", {"action": "search", "package": "nginx", "package_manager": "dnf"},
     {"action", "package", "package_manager", "ssh_session_id", "timeout"}, "dnf search nginx"),
    ("firewall_manage", {"action": "list"},
     {"action", "port", "service", "ssh_session_id", "timeout"}, "firewall-cmd --list-all"),
    ("security_audit", {"scope": "open_ports"}, {"scope", "ssh_session_id", "timeout"},
     "ss -tlnp | awk 'NR>1 {print $4, $6}'"),
    ("performance_analyze", {"metric": "load"}, {"metric", "ssh_session_id", "timeout"}, "uptime"),
    ("analyze_logs", {"log_path": "/var/log/qa.log", "mode": "tail", "lines": 7},
     {"log_path", "mode", "lines", "pattern", "ssh_session_id"}, "tail -n 7 '/var/log/qa.log'"),
    ("inspect_processes", {"mode": "list"},
     {"mode", "filter_user", "filter_name", "pid", "top_n", "ssh_session_id"}, "ps aux"),
    ("network_diagnose", {"mode": "ping", "target": "qa.invalid", "count": 1},
     {"mode", "target", "count", "port", "ssh_session_id"}, "ping -c 1 -W 2 'qa.invalid'"),
)


class _DerivedSidecar(_Sidecar):
    """Answer only synthetic Rust requests; never open SSH connections."""

    def __init__(self, *args, tool_name: str, command: str, **kwargs):
        self.tool_name, self.command = tool_name, command
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
            elif method == "ssh_command":
                assert set(params) == {"sessionId", "command", "timeout", "conversationSessionId",
                                       "toolName", "operationId", "toolCallId"}
                assert params["sessionId"] == 17 and params["toolName"] == self.tool_name
                assert params["command"] == self.command
                assert params["conversationSessionId"] and params["operationId"] and params["toolCallId"]
                result = {"ok": True, "exitCode": 0, "operationId": params["operationId"],
                          "output": "qa synthetic output\n", "stderr": "", "duration": 0.01}
            else:
                raise AssertionError(f"unexpected reverse RPC: {message}")
            assert self.process.stdin is not None
            self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                                 "result": result}, ensure_ascii=False) + "\n")
            self.process.stdin.flush()


def _trace(sidecar: _DerivedSidecar, server: _ToolModelServer, session: str,
           invoke_id: int, stream: str, tool_name: str, command: str,
           expected: str, capture: dict) -> None:
    cards = capture["cards"] = []
    for status in ("started", "completed" if expected == "success" else "error"):
        event = sidecar.wait_notification("tool_call", lambda params, wanted=status:
            params.get("session_id") == session and params.get("rpc_request_id") == invoke_id
            and params.get("rpc_stream_id") == stream
            and params.get("payload", {}).get("tool_name") == tool_name
            and params.get("payload", {}).get("status") == wanted)
        cards.append(event["params"]["payload"])
    evidence = sidecar.call(40, "evidence.list", {"session_id": session})
    capture["evidence"] = evidence
    logs = sidecar.call(41, "debug.agent_log_tail", {"session_id": session, "lines": 100})
    capture["logs"] = logs
    rows = [row for row in evidence if row.get("tool_name") == tool_name]
    trace = [row for row in logs["lines"] if row.get("meta", {}).get("tool_name") == tool_name
             and row.get("type") in {"tool_call", "tool_result", "loop_progress"}]
    capture["trace"] = trace
    # The immutable loopback server emits this ID in its actual SSE tool call.
    parent = "qa-sdk-call-" + tool_name
    if expected == "success":
        histories = [[message for message in body.get("messages", []) if message.get("role") == "tool"]
                     for body in server.snapshot()[1:]]
        assert histories and all(len(history) == 1 for history in histories)
        messages = [history[0] for history in histories]
        assert all(message == messages[0] for message in messages)
        assert {message["tool_call_id"] for message in messages} == {parent}
        business = capture["business"] = json.loads(messages[0]["content"])
        assert business["status"] == expected
    child = cards[0]["tool_call_id"]
    assert cards[1]["tool_call_id"] == child != parent
    assert cards[0]["params"]["command"] == command
    assert cards[1]["result"]["status"] == expected
    assert all("sdk_tool_context" not in card.get("params", {}) for card in cards)
    assert len(rows) == 1
    assert (rows[0].get("tool_call_id"), rows[0].get("sdk_tool_use_id")) == (child, parent)
    assert [row["type"] for row in trace] == ["tool_call", "tool_result", "loop_progress"]
    assert all(row["meta"]["tool_call_id"] == child for row in trace)
    assert trace[-1]["meta"]["sdk_tool_use_id"] == parent
    assert "tool_call_ids" not in trace[-1]["meta"]
    assert all(row["meta"]["rpc_request_id"] == invoke_id
               and row["meta"]["rpc_stream_id"] == stream for row in trace)


def _exercise(tmp_path: Path, tool_name: str, arguments: dict, schema: set[str],
              command: str, decision: str | None = None) -> None:
    server = _ToolModelServer(tool_name, arguments)
    sidecar = None
    session, stream, invoke_id = "qa-derived-" + uuid4().hex, str(uuid4()), 20
    expected = "success" if decision in (None, "approve") else "cancelled" if decision == "cancel" else "rejected"
    requires_approval = decision is not None or tool_name == "security_audit"
    capture: dict = {"tool_name": tool_name, "decision": decision, "response": None,
                     "approval": None, "cards": [], "evidence": None, "logs": None}
    safe_env = _isolated_environment(tmp_path / "profile")
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _DerivedSidecar(tmp_path, tool_name=tool_name, command=command)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-derived-tools")["ok"] is True
            params = _invoke_params(session, "qa derived ssh " + tool_name, stream)
            mode = "auto" if decision is None else "confirm"
            params["state"]["mode"] = mode
            params["state"]["live"] = {"agentMode": mode, "permissionLevel": 3,
                                         "sshSessionId": 17, "sshConnection": "qa@qa.invalid"}
            sidecar.send("agent.invoke", params, invoke_id)
            if requires_approval:
                approval = capture["approval"] = _wait_for_tool_request(sidecar, "approval")
                assert not any(request["method"] == "ssh_command" for request in sidecar.reverse_requests)
                assert len(server.snapshot()) == 1
                assert sidecar.call(21, "ping")["alive"] is True
                if decision == "cancel":
                    assert sidecar.call(22, "agent.cancel", {
                        "session_id": session, "reason": "qa stop",
                    })["cancelled"] is True
                    assert sidecar.call(23, "needs_you.get", {"req_id": approval["id"]})["status"] == "cancelled"
                else:
                    _respond(sidecar, approval, {"approved": decision != "reject"})
            response = capture["response"] = sidecar.wait_rpc(invoke_id)
            assert "error" not in response, response
            assert response["result"].get("observation")
            _assert_schema(server, tool_name, schema)
            commands = [request["params"] for request in sidecar.reverse_requests if request["method"] == "ssh_command"]
            assert len(commands) == (1 if expected == "success" else 0)
            if commands:
                assert commands[0]["conversationSessionId"] == session
            _trace(sidecar, server, session, invoke_id, stream, tool_name, command, expected, capture)
            if requires_approval:
                assert capture["approval"]["extra"]["tool_call_id"] == capture["cards"][0]["tool_call_id"]
    finally:
        try:
            capture["model_requests"] = server.snapshot()
            capture["reverse_requests"] = getattr(sidecar, "reverse_requests", [])
            capture["notifications"] = getattr(sidecar, "received", [])
            (tmp_path / "capture.json").write_text(json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8")
        finally:
            try:
                if sidecar is not None:
                    try:
                        sidecar.call(90, "agent.cancel", {"session_id": session, "reason": "qa cleanup"})
                    except (AssertionError, BrokenPipeError, OSError):
                        pass
                    sidecar.close()
            finally:
                server.close()


@pytest.mark.parametrize("tool_name,arguments,schema,command", READ_CASES, ids=[row[0] for row in READ_CASES])
def test_derived_read_tools_keep_rpc_sdk_parent_identity(
    tmp_path: Path, tool_name: str, arguments: dict, schema: set[str], command: str,
) -> None:
    _exercise(tmp_path, tool_name, arguments, schema, command)


@pytest.mark.parametrize("tool_name,arguments,schema,command,decision", [
    ("service_manage", {"action": "restart", "service": "nginx"},
     {"action", "service", "ssh_session_id", "timeout"}, "systemctl restart nginx", "approve"),
    ("package_manage", {"action": "install", "package": "nginx", "package_manager": "dnf"},
     {"action", "package", "package_manager", "ssh_session_id", "timeout"}, "dnf install -y nginx", "cancel"),
    ("firewall_manage", {"action": "add_port", "port": "8443"},
     {"action", "port", "service", "ssh_session_id", "timeout"},
     "firewall-cmd --permanent --add-port=8443/tcp && firewall-cmd --reload", "reject"),
], ids=["service-approve", "package-cancel", "firewall-reject"])
def test_derived_write_outcomes_keep_sdk_identity_and_gate_dispatch(
    tmp_path: Path, tool_name: str, arguments: dict, schema: set[str], command: str, decision: str,
) -> None:
    _exercise(tmp_path, tool_name, arguments, schema, command, decision)
