"""Trace SSH command outcomes through the real sidecar and SDK with a fake Rust edge."""
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
    ("pwd", "exit0", "allow", "success", "succeeded"),
    ("ls /qa/missing", "exit2", "allow", "success", "succeeded"),
    ("pwd", "timeout", "allow", "indeterminate", "indeterminate"),
    ("pwd", "operation-mismatch", "allow", "indeterminate", "indeterminate"),
    ("touch /qa/marker", "exit0", "approve", "success", "succeeded"),
    ("touch /qa/marker", "exit2", "approve", "error", "failed"),
    ("touch /qa/marker", "exit0", "reject", "rejected", "cancelled"),
    ("touch /qa/marker", "exit0", "cancel", "cancelled", "cancelled"),
)


class _SshSidecar(_Sidecar):
    """Return synthetic connected-session and command results; never runs SSH."""
    def __init__(self, *args, outcome: str, **kwargs):
        self.outcome = outcome
        self.reverse_requests: list[dict] = []
        super().__init__(*args, **kwargs)

    def _next(self, timeout: float = DEADLINE) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f"timed out waiting for sidecar output; stderr: {self.stderr_path}")
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise AssertionError(f"timed out waiting for sidecar output; stderr: {self.stderr_path}") from error
            if message is None or isinstance(message, BaseException):
                raise AssertionError(f"sidecar stdout failed; stderr: {self.stderr_path}")
            self.received.append(message)
            if "method" not in message or "id" not in message:
                return message

            method, params = message["method"], message.get("params", {})
            self.reverse_requests.append(message)
            if method == "ssh_status":
                assert params == {}, message
                result = [{"sessionId": 17, "host": "qa.invalid", "port": 22,
                           "user": "qa", "state": "connected"}]
            elif method == "ssh_command":
                expected = {"sessionId", "command", "timeout", "conversationSessionId",
                            "toolName", "operationId", "toolCallId"}
                assert set(params) == expected, message
                assert params["sessionId"] == 17 and params["toolName"] == "ssh_command", message
                assert params["conversationSessionId"] and params["toolCallId"] and params["operationId"], message
                self.command_request = message
                code, output, stderr = {
                    "exit0": (0, "/qa\n", ""),
                    "exit2": (2, "", "ls: cannot access '/qa/missing': No such file or directory\n"),
                    "timeout": (-1, "partial output\n", "connection timed out\n"),
                    "operation-mismatch": (0, "/qa\n", ""),
                }[self.outcome]
                if self.outcome == "exit2" and params["command"].startswith("touch "):
                    stderr = "touch: cannot touch '/qa/marker': No such file or directory\n"
                result = {
                    "ok": True,
                    "exitCode": code,
                    "operationId": "qa-operation-mismatch" if self.outcome == "operation-mismatch"
                    else params["operationId"],
                    "output": output,
                    "stderr": stderr,
                    "duration": 0.01,
                }
            else:
                raise AssertionError(f"unexpected reverse RPC: {message}")
            self.send_response(message["id"], result)

    def send_response(self, request_id: int, result: object) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id,
                                             "result": result}, ensure_ascii=False) + "\n")
        self.process.stdin.flush()


def _tool_cards(sidecar: _SshSidecar, session: str, invoke_id: int, stream: str,
                terminal_status: str) -> list[dict]:
    cards = []
    for status in ("started", terminal_status):
        event = sidecar.wait_notification("tool_call", lambda params, current=status:
            params.get("session_id") == session
            and params.get("rpc_request_id") == invoke_id
            and params.get("rpc_stream_id") == stream
            and params.get("payload", {}).get("tool_name") == "ssh_command"
            and params.get("payload", {}).get("status") == current)
        cards.append(event["params"]["payload"])
    assert cards[0].get("tool_call_id")
    assert cards[1].get("tool_call_id") == cards[0]["tool_call_id"]
    return cards


@pytest.mark.parametrize(
    "command,outcome,decision,expected,ledger_state", _CASES,
    ids=["pwd-exit0", "readonly-nonzero", "timeout-no-exit", "operation-id-mismatch",
         "approved-write-success", "approved-write-nonzero", "write-rejected", "write-cancelled"],
)
def test_ssh_command_rpc_outcomes(tmp_path: Path, command: str, outcome: str,
                                  decision: str, expected: str, ledger_state: str) -> None:
    server = _ToolModelServer("ssh_command", {
        "command": command, "ssh_session_id": "17", "explanation": "检查 qa 状态", "timeout": 30,
    })
    sidecar = None
    session, stream, invoke_id = "qa-ssh-" + uuid4().hex, str(uuid4()), 20
    profile = tmp_path / "profile"
    safe_env = _isolated_environment(profile)
    captured: dict = {"case": {"command": command, "outcome": outcome, "decision": decision}}
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _SshSidecar(tmp_path, outcome=outcome)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-ssh-outcomes")["ok"] is True
            params = _invoke_params(session, "qa inspect command outcome", stream)
            params["state"]["mode"] = "confirm"
            params["state"]["live"] = {
                "agentMode": "confirm", "permissionLevel": 3,
                "sshSessionId": 17, "sshConnection": "qa@qa.invalid",
            }
            sidecar.send("agent.invoke", params, invoke_id)
            approval = None
            if decision in {"approve", "reject", "cancel"}:
                approval = _wait_for_tool_request(sidecar, "approval")
                assert sidecar.call(21, "ping")["alive"] is True
                assert not hasattr(sidecar, "command_request"), "SSH command dispatched before approval"
                assert len(server.snapshot()) == 1, "model was called again while approval was pending"
                if decision == "cancel":
                    assert sidecar.call(22, "agent.cancel", {
                        "session_id": session, "reason": "qa stop",
                    })["cancelled"] is True
                    assert sidecar.call(23, "needs_you.get", {"req_id": approval["id"]})["status"] == "cancelled"
                else:
                    _respond(sidecar, approval, {"approved": decision == "approve"})

            response = sidecar.wait_rpc(invoke_id)
            assert "error" not in response, response
            assert response["result"].get("observation")
            _assert_schema(server, "ssh_command", {"command", "ssh_session_id", "explanation", "timeout"})
            if decision in {"reject", "cancel"}:
                assert not hasattr(sidecar, "command_request"), "rejected/cancelled SSH command was dispatched"
                assert not any(item["method"] == "ssh_command" for item in sidecar.reverse_requests)
            else:
                assert hasattr(sidecar, "command_request")
                command_rpc = sidecar.command_request
                rpc_params = command_rpc["params"]
                assert command_rpc["method"] == "ssh_command"
                assert rpc_params["sessionId"] == 17
                assert rpc_params["command"] == command
                assert rpc_params["conversationSessionId"] == session
                assert rpc_params["toolName"] == "ssh_command"
                assert rpc_params["toolCallId"]
                assert len([item for item in sidecar.reverse_requests if item["method"] == "ssh_command"]) == 1

            terminal = "completed" if expected == "success" else "error"
            cards = _tool_cards(sidecar, session, invoke_id, stream, terminal)
            ui_id = cards[0]["tool_call_id"]
            business = cards[1].get("result")
            assert isinstance(business, dict)
            assert business.get("ssh_session_id") == "17"
            if approval is not None:
                assert approval["id"] != ui_id
                assert approval.get("extra", {}).get("tool_call_id") == ui_id
                assert approval.get("extra", {}).get("operation_id") == business.get("operation_id")
            if hasattr(sidecar, "command_request"):
                assert sidecar.command_request["params"]["toolCallId"] == ui_id
                assert sidecar.command_request["params"]["operationId"] == business.get("operation_id")
                assert business.get("target_endpoint") == "qa@qa.invalid:22"
            if expected == "success" and command == "pwd":
                assert business.get("exit_code") == 0 and business.get("output") == "/qa\n"
            if outcome == "exit2":
                assert business.get("exit_code") == 2
                assert "No such file" in business.get("stderr", "")
            if outcome == "timeout":
                assert "exit_code" not in business or business.get("exit_code") is None
                assert business.get("reason") == "exit_code_unavailable"
                assert "timed out" in business.get("stderr", "")
            if outcome == "operation-mismatch":
                assert business.get("reason") == "operation_id_mismatch"
                assert "exit_code" not in business

            operation_id = business.get("operation_id")
            assert operation_id
            with sqlite3.connect(f"file:{tmp_path / 'data' / 'tdsf.db'}?mode=ro", uri=True) as db:
                row = db.execute("SELECT state, exit_code, ssh_session_id, target_endpoint FROM operations WHERE id = ?",
                                 (operation_id,)).fetchone()
            assert row and row[0] == ledger_state
            assert row[2] == "17"
            if hasattr(sidecar, "command_request"):
                assert row[3] == "qa@qa.invalid:22"
            if outcome == "exit2":
                assert row[1] == 2

            evidence = sidecar.call(40, "evidence.list", {"session_id": session})
            matching = [item for item in evidence if item.get("tool_name") == "ssh_command"]
            assert len(matching) == 1
            assert matching[0].get("tool_call_id") == ui_id
            assert matching[0].get("operation_id") == operation_id
            assert matching[0].get("result_status") == business.get("status")
            assert matching[0].get("status") == ("completed" if business["status"] == "success"
                                                   else business["status"])
            assert matching[0].get("ssh_session_id") == "17"

            log = sidecar.call(41, "debug.agent_log_tail", {"session_id": session, "lines": 100})
            trace = [entry for entry in log["lines"] if entry.get("meta", {}).get("tool_name") == "ssh_command"
                     and entry.get("type") in {"tool_call", "tool_result", "loop_progress"}]
            assert {entry.get("type") for entry in trace} == {"tool_call", "tool_result", "loop_progress"}
            assert len(trace) == 3
            for entry in trace:
                meta = entry.get("meta", {})
                assert meta.get("rpc_request_id") == invoke_id
                assert meta.get("rpc_stream_id") == stream
                if entry.get("type") == "loop_progress":
                    assert meta.get("sdk_tool_use_id") == "qa-sdk-call-ssh_command"
            captured.update({"response": response, "reverse_requests": sidecar.reverse_requests,
                             "cards": cards, "evidence": matching, "trace": trace,
                             "model_requests": server.snapshot()})

            if decision != "cancel":
                assert "qa_finished" in response["result"]["observation"]
                tool_messages = [message for body in server.snapshot()[1:]
                                 for message in body.get("messages", []) if message.get("role") == "tool"]
                assert tool_messages and tool_messages[-1].get("content")
                model_result = json.loads(tool_messages[-1]["content"])
                assert isinstance(model_result, dict) and model_result.get("status") == expected
                if outcome == "exit2":
                    assert model_result.get("exit_code") == 2 and model_result.get("stderr")
                if outcome == "timeout":
                    assert model_result.get("reason") == "exit_code_unavailable"
                    assert "exit_code" not in model_result or model_result.get("exit_code") is None
                captured["model_tool_messages"] = tool_messages
            (tmp_path / "capture.json").write_text(
                json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8",
            )
            assert business.get("status") == expected
            assert matching[0].get("result_status") == expected
            progress = next(entry for entry in trace if entry["type"] == "loop_progress")
            assert progress["meta"].get("status") == (
                expected if expected in {"cancelled", "indeterminate", "success"} else "failed"
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
