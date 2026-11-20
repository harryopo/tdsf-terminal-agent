"""Real sidecar/Strands/OpenAI RPC traces for composite tool identity."""
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
from test_tool_rpc_lifecycle import _ToolModelServer, _wait_for_tool_request


class _SdkCompositeSidecar(_Sidecar):
    """Answer synthetic reverse Rust calls only; no SSH connection is opened."""

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
                command = params.get("command", "")
                if self.outcome == "diff-success":
                    assert command == "diff -u /qa/a.conf /qa/b.conf 2>&1"
                    output, stderr, code = "--- a.conf\n+++ b.conf\n", "", 1
                elif self.outcome in {"restore-success", "restore-cancel-second"}:
                    if command.startswith("ls -t "):
                        output, stderr, code = "/qa/config.conf.bak.1\n", "", 0
                    else:
                        assert self.outcome == "restore-success", command
                        assert command.startswith("cp -p "), command
                        output, stderr, code = "restore ok\n", "", 0
                else:
                    raise AssertionError(f"unexpected fake Rust outcome {self.outcome}: {message}")
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


def _card(sidecar: _SdkCompositeSidecar, session: str, invoke_id: int, stream_id: str,
          tool_name: str, status: str) -> dict:
    event = sidecar.wait_notification("tool_call", lambda params:
        params.get("session_id") == session
        and params.get("rpc_request_id") == invoke_id
        and params.get("rpc_stream_id") == stream_id
        and params.get("payload", {}).get("tool_name") == tool_name
        and params.get("payload", {}).get("status") == status)
    return event["params"]["payload"]


def _model_parent_id(server: _ToolModelServer) -> str:
    requests = server.snapshot()
    followup = next(body for body in requests[1:]
                    if any(message.get("role") == "tool" for message in body.get("messages", [])))
    assistant = next(message for message in followup["messages"]
                     if message.get("role") == "assistant" and message.get("tool_calls"))
    calls = assistant["tool_calls"]
    assert len(calls) == 1
    return calls[0]["id"]


def _capture(sidecar: _SdkCompositeSidecar | None, server: _ToolModelServer,
             tmp_path: Path, capture: dict) -> None:
    try:
        if sidecar is not None:
            capture["reverse_requests"] = sidecar.reverse_requests
            capture["command_requests"] = sidecar.command_requests
            capture["notifications"] = [message for message in sidecar.received
                                         if "method" in message and "id" not in message]
        capture["model_requests"] = server.snapshot()
    finally:
        (tmp_path / "capture.json").write_text(
            json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8",
        )


def test_config_diff_rpc_has_one_child_and_actual_sdk_parent(tmp_path: Path) -> None:
    tool_input = {"file_a": "/qa/a.conf", "file_b": "/qa/b.conf"}
    server = _ToolModelServer("config_diff", tool_input)
    sidecar = None
    session, stream_id, invoke_id = "qa-diff-" + uuid4().hex, str(uuid4()), 20
    capture: dict = {"case": "config_diff_single", "response": None, "cards": [],
                     "evidence": None, "trace": None, "business": None}
    safe_env = _isolated_environment(tmp_path / "profile")
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _SdkCompositeSidecar(tmp_path, outcome="diff-success")
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-composite-sdk-trace")["ok"] is True
            params = _invoke_params(session, "qa config diff", stream_id)
            params["state"]["mode"] = "auto"
            params["state"]["live"] = {"agentMode": "auto", "permissionLevel": 3,
                                         "sshSessionId": 17, "sshConnection": "qa@qa.invalid"}
            sidecar.send("agent.invoke", params, invoke_id)
            response = sidecar.wait_rpc(invoke_id)
            capture["response"] = response
            assert "error" not in response, response
            _assert_schema(server, "config_diff", {"file_a", "file_b", "ssh_session_id"})
            start = _card(sidecar, session, invoke_id, stream_id, "config_diff", "started")
            end = _card(sidecar, session, invoke_id, stream_id, "config_diff", "completed")
            capture["cards"] = [start, end]
            child_id = start["tool_call_id"]
            assert child_id != _model_parent_id(server)
            assert end["tool_call_id"] == child_id
            assert "sdk_tool_context" not in start.get("params", {})
            assert end["result"]["status"] == "success"
            evidence = sidecar.call(40, "evidence.list", {"session_id": session})
            capture["evidence"] = evidence
            matching = [row for row in evidence if row.get("tool_name") == "config_diff"]
            assert len(matching) == 1
            assert matching[0]["tool_call_id"] == child_id
            assert matching[0]["sdk_tool_use_id"] == _model_parent_id(server)
            logs = sidecar.call(41, "debug.agent_log_tail", {"session_id": session, "lines": 100})
            trace = [row for row in logs["lines"] if row.get("meta", {}).get("tool_name") == "config_diff"
                     and row.get("type") in {"tool_call", "tool_result", "loop_progress"}]
            capture["trace"] = trace
            assert [row["type"] for row in trace] == ["tool_call", "tool_result", "loop_progress"]
            for row in trace[:2]:
                assert row["meta"]["tool_call_id"] == child_id
            progress = trace[-1]["meta"]
            assert progress["tool_call_id"] == child_id
            assert progress["sdk_tool_use_id"] == _model_parent_id(server)
            assert "tool_call_ids" not in progress
            messages = [message for body in server.snapshot()[1:]
                        for message in body.get("messages", []) if message.get("role") == "tool"]
            assert len(messages) == 1
            capture["business"] = json.loads(messages[0]["content"])
            assert capture["business"]["status"] == "success"
            assert len(sidecar.command_requests) == 1
    finally:
        try:
            _capture(sidecar, server, tmp_path, capture)
        finally:
            try:
                if sidecar is not None:
                    sidecar.close()
            finally:
                server.close()


@pytest.mark.parametrize("outcome", ["restore-success", "restore-cancel-second"])
def test_restore_rpc_keeps_two_child_ids_and_parent_progress(tmp_path: Path, outcome: str) -> None:
    tool_input = {"action": "restore", "file_path": "/qa/config.conf", "backup_path": ""}
    server = _ToolModelServer("backup_restore", tool_input)
    sidecar = None
    session, stream_id, invoke_id = "qa-restore-" + uuid4().hex, str(uuid4()), 20
    capture: dict = {"case": outcome, "response": None, "cards": [], "approval": None,
                     "evidence": None, "trace": None, "business": None}
    safe_env = _isolated_environment(tmp_path / "profile")
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _SdkCompositeSidecar(tmp_path, outcome=outcome)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-composite-sdk-trace")["ok"] is True
            params = _invoke_params(session, "qa restore", stream_id)
            params["state"]["mode"] = "confirm"
            params["state"]["live"] = {"agentMode": "confirm", "permissionLevel": 3,
                                         "sshSessionId": 17, "sshConnection": "qa@qa.invalid"}
            sidecar.send("agent.invoke", params, invoke_id)
            first_start = _card(sidecar, session, invoke_id, stream_id, "backup_restore", "started")
            first_done = _card(sidecar, session, invoke_id, stream_id, "backup_restore", "completed")
            second_start = _card(sidecar, session, invoke_id, stream_id, "backup_restore", "started")
            child_ids = [first_start["tool_call_id"], second_start["tool_call_id"]]
            assert child_ids[0] != child_ids[1]
            assert first_done["tool_call_id"] == child_ids[0]
            assert "sdk_tool_context" not in first_start.get("params", {})
            if outcome == "restore-success":
                approval = _wait_for_tool_request(sidecar, "approval")
                capture["approval"] = approval
                assert approval.get("extra", {}).get("tool_call_id") == child_ids[1]
                assert len(sidecar.command_requests) == 1
                sidecar.call(30, "needs_you.respond", {
                    "req_id": approval["id"], "response": {"approved": True},
                })
                second_done = _card(sidecar, session, invoke_id, stream_id, "backup_restore", "completed")
                assert second_done["tool_call_id"] == child_ids[1]
                response = sidecar.wait_rpc(invoke_id)
                capture["response"] = response
                assert "error" not in response, response
                terminal_cards = [first_start, first_done, second_start, second_done]
                expected_status = "success"
            else:
                approval = _wait_for_tool_request(sidecar, "approval")
                capture["approval"] = approval
                assert approval.get("extra", {}).get("tool_call_id") == child_ids[1]
                assert len(sidecar.command_requests) == 1
                assert sidecar.call(31, "agent.cancel", {
                    "session_id": session, "reason": "qa stop second child",
                })["cancelled"] is True
                assert sidecar.call(32, "needs_you.get", {"req_id": approval["id"]})["status"] == "cancelled"
                second_end = _card(sidecar, session, invoke_id, stream_id, "backup_restore", "error")
                assert second_end["tool_call_id"] == child_ids[1]
                response = sidecar.wait_rpc(invoke_id)
                capture["response"] = response
                assert "error" not in response, response
                terminal_cards = [first_start, first_done, second_start, second_end]
                expected_status = "cancelled"
                assert [request["params"]["command"].split()[0]
                        for request in sidecar.command_requests] == ["ls"]

            capture["cards"] = terminal_cards
            _assert_schema(server, "backup_restore",
                           {"action", "file_path", "backup_path", "ssh_session_id"})
            if outcome == "restore-success":
                assert [request["params"]["command"].split()[0]
                        for request in sidecar.command_requests] == ["ls", "cp"]
            evidence = sidecar.call(40, "evidence.list", {"session_id": session})
            capture["evidence"] = evidence
            rows = [row for row in evidence if row.get("tool_name") == "backup_restore"]
            assert [row["tool_call_id"] for row in rows] == child_ids
            parent_id = _model_parent_id(server) if outcome == "restore-success" else "qa-sdk-call-backup_restore"
            assert [row["sdk_tool_use_id"] for row in rows] == [parent_id, parent_id]
            logs = sidecar.call(41, "debug.agent_log_tail", {"session_id": session, "lines": 100})
            trace = [row for row in logs["lines"] if row.get("meta", {}).get("tool_name") == "backup_restore"
                     and row.get("type") in {"tool_call", "tool_result", "loop_progress"}]
            capture["trace"] = trace
            per_child = [row for row in trace if row["type"] in {"tool_call", "tool_result"}]
            assert [row["meta"]["tool_call_id"] for row in per_child] == [
                child_ids[0], child_ids[0], child_ids[1], child_ids[1],
            ]
            assert len(trace) == 5
            progress = next(row["meta"] for row in trace if row["type"] == "loop_progress")
            assert progress["sdk_tool_use_id"] == parent_id
            assert progress["tool_call_ids"] == child_ids
            assert "tool_call_id" not in progress
            assert all("tool_call_ids" not in card for card in terminal_cards)
            if outcome == "restore-success":
                histories = [[message for message in body.get("messages", [])
                              if message.get("role") == "tool"]
                             for body in server.snapshot()[1:]]
                assert histories and all(len(history) == 1 for history in histories)
                messages = [history[0] for history in histories]
                assert {message["tool_call_id"] for message in messages} == {parent_id}
                assert all(message == messages[0] for message in messages)
                capture["business"] = json.loads(messages[0]["content"])
                assert capture["business"]["status"] == expected_status
            else:
                assert not any(message.get("method") == "ssh_command" for message in sidecar.reverse_requests
                               if message.get("params", {}).get("command", "").startswith("cp -p"))
                assert [card.get("result", {}).get("status") for card in terminal_cards[1::2]] == [
                    "success", "cancelled",
                ]
    finally:
        try:
            _capture(sidecar, server, tmp_path, capture)
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
