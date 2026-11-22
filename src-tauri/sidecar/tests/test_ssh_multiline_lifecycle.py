"""Trace multiline SSH approval through the real sidecar with a fake Rust edge."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from test_model_rpc_chain import MAIN, _configure, _invoke_params
from test_reference_rpc_capabilities import _assert_schema, _isolated_environment
from test_ssh_tool_rpc_lifecycle import _SshSidecar
from test_tool_rpc_lifecycle import _ToolModelServer, _respond, _wait_for_tool_request


_CASES = (
    ("approve", "pwd\ntouch /qa/marker", "confirm", None, "approve", "success", "succeeded"),
    ("reject", "pwd\ntouch /qa/marker", "confirm", None, "reject", "rejected", "cancelled"),
    ("cancel", "pwd\ntouch /qa/marker", "confirm", None, "cancel", "cancelled", "cancelled"),
    ("timeout", "pwd\ntouch /qa/marker", "confirm", None, "timeout", "needs_approval", "cancelled"),
    ("service-error", "pwd\ntouch /qa/marker", "confirm", None, "none", "needs_approval", "cancelled"),
    ("hard-block", "pwd\nrm -rf /", "confirm", None, "none", "command_blocked", None),
    ("whitelist-ask", "pwd\nprintf qa_marker", "confirm", "ask", "approve", "success", "succeeded"),
    ("whitelist-deny", "pwd\nprintf qa_marker", "confirm", "deny", "none", "command_blocked", None),
)


def _patched_command(kind: str) -> list[str] | None:
    if kind not in {"timeout", "service-error"}:
        return None
    program = "\n".join((
        "import runpy, sys",
        "from needs_you import NeedsYouService",
        "kind = sys.argv[1]",
        "if kind == 'timeout':",
        "    original_init = NeedsYouService.__init__",
        "    def fast_init(self, *args, **kwargs):",
        "        kwargs['approval_timeout'] = 0.05",
        "        kwargs['timeout_check_interval'] = 0.01",
        "        original_init(self, *args, **kwargs)",
        "    NeedsYouService.__init__ = fast_init",
        "else:",
        "    def fail_request(self, *args, **kwargs):",
        "        raise RuntimeError('synthetic approval service failure')",
        "    NeedsYouService.request_approval = fail_request",
        "runpy.run_path(sys.argv[2], run_name='__main__')",
    ))
    return [sys.executable, "-c", program, kind, str(MAIN)]


def _tool_events(sidecar: _SshSidecar, session: str, invoke_id: int, stream: str) -> list[dict]:
    return [
        message["params"]["payload"]
        for message in sidecar.received
        if message.get("method") == "tool_call"
        and message.get("params", {}).get("session_id") == session
        and message.get("params", {}).get("rpc_request_id") == invoke_id
        and message.get("params", {}).get("rpc_stream_id") == stream
        and message.get("params", {}).get("payload", {}).get("tool_name") == "ssh_command"
    ]


def _operation_rows(db_path: Path, session: str) -> list[tuple]:
    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as db:
        return db.execute(
            "SELECT id, state, command_hash, ssh_session_id, conversation_session_id "
            "FROM operations WHERE conversation_session_id = ?",
            (session,),
        ).fetchall()


@pytest.mark.parametrize(
    "case,command,mode,whitelist,decision,expected_status,ledger_state", _CASES,
    ids=[case[0] for case in _CASES],
)
def test_multiline_ssh_rpc_outcomes(
    tmp_path: Path,
    case: str,
    command: str,
    mode: str,
    whitelist: str | None,
    decision: str,
    expected_status: str,
    ledger_state: str | None,
) -> None:
    server = _ToolModelServer("ssh_command", {
        "command": command,
        "ssh_session_id": "17",
        "explanation": "检查 qa 状态并按需更新标记",
        "timeout": 30,
    })
    session, stream, invoke_id = "qa-multiline-" + uuid4().hex, str(uuid4()), 20
    profile = tmp_path / "profile"
    sidecar = None
    approval = None
    captured: dict = {"case": case, "command": command, "mode": mode}
    try:
        with patch.dict(os.environ, _isolated_environment(profile), clear=True):
            sidecar = _SshSidecar(
                tmp_path,
                outcome="exit0",
                command=_patched_command(case),
            )
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-ssh-multiline")["ok"] is True
            if whitelist is not None:
                rule = sidecar.call(11, "memory.whitelist.add", {
                    "pattern": "printf qa_marker", "decision": whitelist,
                })
                assert rule["ok"] is True and rule["rule"]["decision"] == whitelist

            params = _invoke_params(session, "qa multiline lifecycle", stream)
            params["state"]["mode"] = mode
            params["state"]["live"] = {
                "agentMode": mode,
                "permissionLevel": 3,
                "sshSessionId": 17,
                "sshConnection": "qa@qa.invalid",
            }
            sidecar.send("agent.invoke", params, invoke_id)

            if decision in {"approve", "reject", "cancel", "timeout"}:
                approval = _wait_for_tool_request(sidecar, "approval")
                preapproval_cards = _tool_events(sidecar, session, invoke_id, stream)
                no_ssh_before_approval = not any(
                    message["method"] == "ssh_command" for message in sidecar.reverse_requests
                )
                if decision != "timeout":
                    ping_alive = sidecar.call(21, "ping")["alive"] is True
                    model_waited = len(server.snapshot()) == 1
                preapproval_rows = _operation_rows(tmp_path / "data" / "tdsf.db", session)

                if decision == "approve":
                    _respond(sidecar, approval, {"approved": True})
                elif decision == "reject":
                    _respond(sidecar, approval, {"approved": False})
                elif decision == "cancel":
                    assert sidecar.call(22, "agent.cancel", {
                        "session_id": session, "reason": "qa stop",
                    })["cancelled"] is True
                    assert sidecar.call(23, "needs_you.get", {"req_id": approval["id"]})["status"] == "cancelled"

            response = sidecar.wait_rpc(invoke_id)
            assert "error" not in response, response
            _assert_schema(server, "ssh_command", {"command", "ssh_session_id", "explanation", "timeout"})
            cards = _tool_events(sidecar, session, invoke_id, stream)
            captured.update({
                "response": response,
                "approval": approval,
                "preapproval_cards": preapproval_cards if approval else [],
                "cards": cards,
                "reverse_requests": sidecar.reverse_requests,
                "model_requests": server.snapshot(),
            })
            (tmp_path / "capture.json").write_text(
                json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8",
            )

            assert len(cards) == 2, f"expected one started/terminal card pair, got {cards}"
            started, terminal = cards
            assert started["status"] == "started"
            assert terminal["status"] == ("completed" if expected_status == "success" else "error")
            assert started.get("tool_call_id") and terminal.get("tool_call_id") == started["tool_call_id"]
            business = terminal.get("result")
            assert isinstance(business, dict) and business.get("status") == expected_status
            assert started.get("params", {}).get("command") == command

            if approval is not None:
                assert len(preapproval_cards) == 1
                assert preapproval_cards[0].get("status") == "started"
                assert preapproval_cards[0].get("tool_call_id") == started["tool_call_id"]
                extra = approval.get("extra", {})
                assert extra.get("tool_call_id") == started["tool_call_id"]
                assert extra.get("operation_id") == business.get("operation_id")
                assert extra.get("ssh_session_id") == "17"
                assert no_ssh_before_approval
                if decision != "timeout":
                    assert ping_alive and model_waited
                    assert len(preapproval_rows) == 1 and preapproval_rows[0][1] == "awaiting_approval"

            command_rpcs = [item for item in sidecar.reverse_requests if item["method"] == "ssh_command"]
            if decision in {"approve"}:
                assert len(command_rpcs) == 1
                assert command_rpcs[0]["params"]["command"] == command
                assert command_rpcs[0]["params"]["sessionId"] == 17
                assert command_rpcs[0]["params"]["toolCallId"] == started["tool_call_id"]
                assert command_rpcs[0]["params"]["operationId"] == business.get("operation_id")
            else:
                assert command_rpcs == []

            if decision == "timeout":
                assert sidecar.call(24, "needs_you.get", {"req_id": approval["id"]})["status"] == "timeout"
            if case in {"service-error", "hard-block", "whitelist-deny"}:
                assert not any(
                    message.get("method") == "needs_you"
                    and message.get("params", {}).get("payload", {}).get("event") == "created"
                    for message in sidecar.received
                )

            evidence = sidecar.call(40, "evidence.list", {"session_id": session})
            matching = [item for item in evidence if item.get("tool_name") == "ssh_command"]
            assert len(matching) == 1
            assert matching[0].get("tool_call_id") == started["tool_call_id"]
            assert matching[0].get("result_status") == expected_status
            expected_evidence_state = {
                "success": "completed", "command_blocked": "blocked",
            }.get(expected_status, expected_status)
            assert matching[0].get("status") == expected_evidence_state
            if business.get("operation_id"):
                assert matching[0].get("operation_id") == business["operation_id"]

            rows = _operation_rows(tmp_path / "data" / "tdsf.db", session)
            if ledger_state is None:
                assert rows == []
            else:
                assert len(rows) == 1
                operation_id, state, command_hash, ssh_session_id, conversation_session_id = rows[0]
                assert state == ledger_state
                assert command_hash == "sha256:" + hashlib.sha256(command.encode("utf-8")).hexdigest()
                assert ssh_session_id == "17" and conversation_session_id == session
                assert business.get("operation_id") == operation_id

            if decision != "cancel":
                tool_messages = [
                    message for body in server.snapshot()[1:]
                    for message in body.get("messages", []) if message.get("role") == "tool"
                ]
                assert tool_messages
                model_result = json.loads(tool_messages[-1]["content"])
                assert model_result.get("status") == expected_status
                assert model_result.get("command") == command
    finally:
        try:
            if sidecar is not None:
                try:
                    sidecar.call(90, "agent.cancel", {"session_id": session, "reason": "qa cleanup"})
                except (AssertionError, BrokenPipeError, OSError):
                    pass
                sidecar.close()
        finally:
            (tmp_path / "capture.json").write_text(
                json.dumps({**captured, "final_received": sidecar.received if sidecar else []},
                           ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            server.close()


@pytest.mark.parametrize("mode,exit_code,expected,sensitive_preview", [
    ("observe", 0, "command_blocked", False),
    ("auto", 2, "error", False),
    ("observe", 0, "command_blocked", True),
])
def test_multiline_direct_modes_keep_line_risk(tmp_path, monkeypatch, mode, exit_code, expected, sensitive_preview):
    from strands_backend.audit_chain import reset_global_chain
    from strands_backend.evidence import get_global_tracker, reset_global_tracker
    from strands_backend.tests.test_executor_evidence_returns import FakeBridge, RecordingEventBus, _context
    from strands_backend.tools.ssh_command import invoke_ssh_command_tool
    from strands_backend.trust_store import reset_globals

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))
    reset_globals()
    reset_global_tracker()
    reset_global_chain(str(tmp_path / "audit.jsonl"))
    bus = RecordingEventBus()
    bridge = FakeBridge(result={"ok": True, "exitCode": exit_code, "output": "", "stderr": "synthetic write error"})
    ctx = _context(bus, bridge, mode=mode)
    command = "pwd\ntouch /qa/marker"
    if sensitive_preview:
        command = "pwd\nrm -rf /" + " " * 32 + "ghp_" + "A" * 36
    try:
        result = invoke_ssh_command_tool({"command": command}, ctx)
        assert result["status"] == expected
        assert [event["status"] for event in bus.tool_calls] == ["started", "error"]
        assert bus.tool_calls[0]["tool_call_id"] == bus.tool_calls[1]["tool_call_id"]
        evidence = get_global_tracker().list(ctx.session_id)
        assert len(evidence) == 1
        assert evidence[0]["tool_call_id"] == bus.tool_calls[0]["tool_call_id"]
        if mode == "observe":
            assert bridge.calls == []
            if sensitive_preview:
                assert "ghp_" not in result["message"]
                assert "<REDACTED:" in result["message"]
        else:
            assert result["exit_code"] == 2
            assert bridge.calls.count("ssh_command") == 1
            audit = [json.loads(line)["entry"] for line in (tmp_path / "audit.jsonl").read_text(encoding="utf-8").splitlines()]
            failed = [entry for entry in audit if entry.get("event") == "command_failed"]
            assert len(failed) == 1 and failed[0]["risk_l"] >= 2
    finally:
        reset_globals()
        reset_global_tracker()
        reset_global_chain()
