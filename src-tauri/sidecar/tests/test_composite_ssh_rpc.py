"""Real sidecar/model RPC outcomes for config_diff and backup_restore."""
from __future__ import annotations

import json
import os
import queue
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from test_model_rpc_chain import DEADLINE, _Sidecar, _configure, _invoke_params
from test_reference_rpc_capabilities import _assert_schema, _isolated_environment
from test_tool_rpc_lifecycle import _ToolModelServer, _respond, _wait_for_tool_request


_CASES = (
    ("config_diff", "unknown", "auto", None, "indeterminate", "indeterminate", 1),
    ("config_diff", "exit2", "auto", None, "error", "succeeded", 1),
    ("backup_restore", "reject", "confirm", "reject", "rejected", "cancelled", 0),
    ("backup_restore", "cancel", "confirm", "cancel", "cancelled", "cancelled", 0),
    ("backup_restore", "exit2", "confirm", "approve", "error", "failed", 1),
    ("backup_restore", "restore-unknown", "auto", None, "indeterminate", "indeterminate", 1),
)


class _CompositeSidecar(_Sidecar):
    """Answer only synthetic SSH status/command requests; never opens SSH."""
    def __init__(self, *args, outcome: str, **kwargs):
        self.outcome = outcome
        self.reverse_requests: list[dict] = []
        self.command_requests: list[dict] = []
        super().__init__(*args, **kwargs)

    def _next(self, timeout: float = DEADLINE) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"timed out; sidecar stderr: {self.stderr_path}")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise AssertionError(f"timed out; sidecar stderr: {self.stderr_path}") from error
            if message is None or isinstance(message, BaseException):
                raise AssertionError(f"sidecar stdout failed; stderr: {self.stderr_path}")
            self.received.append(message)
            if "method" not in message or "id" not in message:
                return message
            method, params = message["method"], message.get("params", {})
            self.reverse_requests.append(message)
            if method == "ssh_status":
                assert params == {}, message
                result: object = [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                                   "user": "qa", "state": "connected"}]
            elif method == "ssh_command":
                assert params.get("sessionId") == 17, message
                assert params.get("toolName") in {"config_diff", "backup_restore"}, message
                assert params.get("operationId") and params.get("toolCallId"), message
                self.command_requests.append(message)
                if self.outcome == "unknown":
                    output, stderr, code = "", "", -1
                elif self.outcome == "exit2":
                    if params.get("toolName") == "config_diff":
                        output, stderr = "diff: /qa/missing: No such file\n", ""
                    else:
                        output, stderr = "", "cp: permission denied\n"
                    code = 2
                elif self.outcome in {"reject", "cancel"}:
                    raise AssertionError("approval denial/cancellation dispatched SSH")
                elif self.outcome == "restore-unknown":
                    if len(self.command_requests) == 1:
                        output, stderr, code = "/qa/config.conf.bak.1\n", "partial discovery\n", -1
                    else:  # Allows a buggy follow-up copy to finish instead of hanging the test.
                        output, stderr, code = "restore ok\n", "", 0
                else:
                    output, stderr, code = "", "cp: permission denied\n", 2
                result = {"ok": True, "exitCode": code, "operationId": params["operationId"],
                          "output": output, "stderr": stderr, "duration": 0.01}
            else:
                raise AssertionError(f"unexpected reverse RPC: {message}")
            self.send_response(message["id"], result)

    def send_response(self, request_id: int, result: object) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id,
                                             "result": result}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()


def _card(sidecar: _CompositeSidecar, session: str, invoke_id: int, stream: str,
          tool_name: str, status: str) -> dict:
    event = sidecar.wait_notification("tool_call", lambda params:
        params.get("session_id") == session and params.get("rpc_request_id") == invoke_id
        and params.get("rpc_stream_id") == stream
        and params.get("payload", {}).get("tool_name") == tool_name
        and params.get("payload", {}).get("status") == status)
    return event["params"]["payload"]


@pytest.mark.parametrize(
    "tool_name,outcome,mode,decision,expected,ledger_state,dispatches", _CASES,
    ids=["diff-unknown", "diff-exit2", "backup-rejected", "backup-cancelled",
         "backup-approved-nonzero", "restore-discovery-unknown"],
)
def test_composite_ssh_rpc_outcomes(tmp_path: Path, tool_name: str, outcome: str,
                                    mode: str, decision: str | None, expected: str,
                                    ledger_state: str, dispatches: int) -> None:
    tool_input = ({"file_a": "/qa/a.conf", "file_b": "/qa/missing"}
                  if tool_name == "config_diff" else
                  {"action": "restore", "file_path": "/qa/config.conf", "backup_path": ""}
                  if outcome == "restore-unknown" else
                  {"action": "backup", "file_path": "/qa/config.conf",
                   "backup_path": "/qa/config.conf.bak.1"})
    server = _ToolModelServer(tool_name, tool_input)
    sidecar = None
    session, stream, invoke_id = "qa-composite-" + uuid4().hex, str(uuid4()), 20
    safe_env = _isolated_environment(tmp_path / "profile")
    capture: dict = {
        "case": {"tool_name": tool_name, "outcome": outcome, "mode": mode, "decision": decision},
        "invoke_response": None,
        "reverse_requests": [],
        "command_requests": [],
        "notifications": [],
        "model_requests": [],
        "evidence": None,
        "trace": None,
        "business": None,
        "child_results": [],
    }
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _CompositeSidecar(tmp_path, outcome=outcome)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-composite-outcomes")["ok"] is True
            params = _invoke_params(session, "qa composite outcome", stream)
            params["state"]["mode"] = mode
            params["state"]["live"] = {"agentMode": mode, "permissionLevel": 3,
                                         "sshSessionId": 17, "sshConnection": "qa@qa.invalid"}
            sidecar.send("agent.invoke", params, invoke_id)
            approval = None
            if decision:
                started = _card(sidecar, session, invoke_id, stream, tool_name, "started")
                approval = _wait_for_tool_request(sidecar, "approval")
                assert sidecar.call(21, "ping")["alive"] is True
                assert len(server.snapshot()) == 1
                assert not sidecar.command_requests
                assert approval.get("extra", {}).get("tool_call_id") == started.get("tool_call_id")
                if decision == "cancel":
                    assert sidecar.call(22, "agent.cancel", {
                        "session_id": session, "reason": "qa stop",
                    })["cancelled"] is True
                    assert sidecar.call(23, "needs_you.get", {"req_id": approval["id"]})[
                        "status"] == "cancelled"
                else:
                    _respond(sidecar, approval, {"approved": decision == "approve"})

            response = sidecar.wait_rpc(invoke_id)
            capture["invoke_response"] = response
            assert "error" not in response, response
            _assert_schema(server, tool_name,
                           {"file_a", "file_b", "ssh_session_id"} if tool_name == "config_diff"
                           else {"action", "file_path", "backup_path", "ssh_session_id"})
            assert sum(request["method"] == "ssh_command" for request in sidecar.reverse_requests) == dispatches
            assert len(sidecar.command_requests) == dispatches

            cards = [started] if decision else [_card(sidecar, session, invoke_id, stream, tool_name, "started")]
            children = []
            for index in range(dispatches):
                start_card = cards[0] if index == 0 else _card(
                    sidecar, session, invoke_id, stream, tool_name, "started")
                child_status = "success" if outcome == "exit2" and tool_name == "config_diff" else expected
                terminal = "completed" if child_status == "success" else "error"
                end_card = _card(sidecar, session, invoke_id, stream, tool_name, terminal)
                children.append((start_card, end_card))
            if not dispatches:
                end_card = _card(sidecar, session, invoke_id, stream, tool_name, "error")
                children.append((cards[0], end_card))
            for start_card, end_card in children:
                assert start_card.get("tool_call_id")
                assert start_card["tool_call_id"] == end_card.get("tool_call_id")
                assert isinstance(end_card.get("result"), dict)
                capture["child_results"].append(end_card["result"])
                child_status = "success" if outcome == "exit2" and tool_name == "config_diff" else expected
                assert end_card["result"].get("status") == child_status
                if child_status == "error":
                    assert end_card["result"].get("exit_code") == 2
                    assert end_card["result"].get("stderr")
            if approval:
                assert approval.get("extra", {}).get("operation_id") == children[0][1]["result"].get("operation_id")

            evidence = sidecar.call(40, "evidence.list", {"session_id": session})
            capture["evidence"] = evidence
            matching = [row for row in evidence if row.get("tool_name") == tool_name]
            assert len(matching) == len(children)
            for start_card, end_card in children:
                result = end_card["result"]
                entry = next(row for row in matching if row.get("operation_id") == result.get("operation_id"))
                assert entry.get("tool_call_id") == start_card["tool_call_id"]
                assert entry.get("result_status") == result.get("status")
                with sqlite3.connect(f"file:{tmp_path / 'data' / 'tdsf.db'}?mode=ro", uri=True) as db:
                    row = db.execute("SELECT state, exit_code FROM operations WHERE id = ?",
                                     (result.get("operation_id"),)).fetchone()
                assert row and row[0] == ledger_state
                if outcome == "exit2":
                    assert row[1] == 2

            logs = sidecar.call(41, "debug.agent_log_tail", {"session_id": session, "lines": 100})
            trace = [item for item in logs["lines"] if item.get("meta", {}).get("tool_name") == tool_name
                     and item.get("type") in {"tool_call", "tool_result", "loop_progress"}]
            capture["trace"] = trace
            assert len(trace) == len(children) * 3
            assert all(item.get("meta", {}).get("rpc_request_id") == invoke_id for item in trace)
            assert all(item.get("meta", {}).get("rpc_stream_id") == stream for item in trace)

            if decision != "cancel":
                tool_messages = [message for body in server.snapshot()[1:]
                                 for message in body.get("messages", []) if message.get("role") == "tool"]
                assert tool_messages
                business = json.loads(tool_messages[-1]["content"])
                capture["business"] = business
                assert business.get("status") == expected
                if outcome == "exit2":
                    assert business.get("identical") is None and business.get("exit_code") == 2
                if outcome == "restore-unknown":
                    assert business.get("status") == "indeterminate"
            else:
                capture["business"] = capture["child_results"][-1] if capture["child_results"] else None
                assert not sidecar.command_requests
                progress = [item for item in trace if item.get("type") == "loop_progress"]
                assert progress and progress[-1].get("meta", {}).get("status") == "cancelled"

            if outcome == "restore-unknown":
                assert len(sidecar.command_requests) == 1
                assert sidecar.command_requests[0]["params"]["command"].startswith("ls -t ")
                assert not any("cp -p" in request["params"]["command"]
                               for request in sidecar.command_requests)
    finally:
        try:
            if sidecar is not None:
                capture["reverse_requests"] = sidecar.reverse_requests
                capture["command_requests"] = sidecar.command_requests
                capture["notifications"] = [message for message in sidecar.received
                                             if "method" in message and "id" not in message]
            capture["model_requests"] = server.snapshot()
            (tmp_path / "capture.json").write_text(
                json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8",
            )
        finally:
            try:
                if sidecar is not None:
                    try:
                        sidecar.call(990002, "agent.cancel", {"session_id": session, "reason": "qa cleanup"})
                    except (AssertionError, BrokenPipeError, OSError):
                        pass
                    sidecar.close()
            finally:
                server.close()
