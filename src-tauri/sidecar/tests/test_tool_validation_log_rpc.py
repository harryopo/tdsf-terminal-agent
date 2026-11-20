"""Parameter-validation failures survive the real sidecar/model RPC round trip."""
from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from strands_backend.diagnostics import export_snapshot
from test_model_rpc_chain import _Sidecar, _configure, _invoke_params
from test_reference_rpc_capabilities import _isolated_environment
from test_tool_rpc_lifecycle import _ToolModelServer


CASES = (
    ("service_manage", {"action": "status", "service": ""}, "service 参数缺失"),
    ("config_diff", {"file_a": "", "file_b": "/qa-b.conf"}, "file_a and file_b are required"),
    (
        "network_diagnose",
        {"mode": "invalid password=qa_synthetic_value"},
        "非法模式",
    ),
)


def _tool_result(server: _ToolModelServer) -> dict | str:
    results = [
        message
        for body in server.snapshot()[1:]
        for message in body.get("messages", [])
        if message.get("role") == "tool"
    ]
    assert len(results) == 1
    assert results[0].get("tool_call_id") == "qa-sdk-call-" + server.tool_name
    content = results[0]["content"]
    try:
        payload = json.loads(content)
    except (TypeError, json.JSONDecodeError):
        return content
    assert isinstance(payload, dict)
    return payload


@pytest.mark.parametrize("tool_name,arguments,expected_error", CASES,
                         ids=[row[0] for row in CASES])
def test_pre_execution_validation_failure_reaches_next_model_turn_and_retained_log(
    tmp_path: Path, tool_name: str, arguments: dict, expected_error: str,
) -> None:
    server = _ToolModelServer(tool_name, arguments)
    sidecar = None
    session = "qa-validation-rpc-" + uuid4().hex
    stream = str(uuid4())
    invoke_id = 20
    capture: dict = {
        "tool_name": tool_name,
        "response": None,
        "evidence": None,
        "result": None,
        "result_payload": None,
        "model_result_messages": [],
        "model_requests": [],
        "notifications": [],
        "reverse_requests": [],
        "logs": None,
    }
    try:
        safe_env = _isolated_environment(tmp_path / "profile")
        safe_env["TDSF_DATA_DIR"] = str(tmp_path / "data")
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _Sidecar(tmp_path)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-validation-model")["ok"] is True
            params = _invoke_params(session, "qa validation " + tool_name, stream)
            params["state"].update({
                "mode": "auto",
                "live": {"agentMode": "auto", "permissionLevel": 3},
            })
            sidecar.send("agent.invoke", params, invoke_id)
            response = sidecar.wait_rpc(invoke_id)
            capture["response"] = response
            capture["model_requests"] = server.snapshot()
            capture["model_result_messages"] = [
                message
                for body in capture["model_requests"][1:]
                for message in body.get("messages", [])
                if message.get("role") == "tool"
            ]
            capture["result"] = (
                capture["model_result_messages"][0]
                if len(capture["model_result_messages"]) == 1 else None
            )
            evidence = sidecar.call(40, "evidence.list", {"session_id": session})
            capture["evidence"] = evidence
            logs = sidecar.call(
                41, "debug.agent_log_tail", {"session_id": session, "lines": 100},
            )
            capture["logs"] = logs

            assert "error" not in response, response
            assert response["result"]["next_step"] == "done"
            assert any(
                item.get("function", {}).get("name") == tool_name
                for item in server.snapshot()[0]["tools"]
            )
            result = _tool_result(server)
            capture["result_payload"] = result
            assert expected_error in json.dumps(result, ensure_ascii=False)
            if isinstance(result, dict):
                assert result.get("status") == "error"
            assert evidence == []
            progress = [
                row for row in logs["lines"]
                if row.get("type") == "loop_progress"
                and row.get("meta", {}).get("sdk_tool_use_id") == "qa-sdk-call-" + tool_name
            ]
            assert len(progress) == 1
            row = progress[0]
            payload = json.loads(row["content"])
            assert row["meta"]["status"] == payload["status"] == "failed"
            assert row["meta"]["sdk_tool_use_id"] == payload["sdk_tool_use_id"]
            assert expected_error in payload["error"]
            assert payload["error"] == row["meta"]["error"]
            assert len(payload["error"]) <= 120
            assert "qa_synthetic_value" not in json.dumps(logs, ensure_ascii=False)
            if tool_name == "network_diagnose":
                assert "<REDACTED>" in json.dumps(logs, ensure_ascii=False)

            export = export_snapshot(session, {
                "schema_version": 1,
                "session_id": session,
                "sources": {
                    "journal": {"status": "ready", "data": logs},
                    "evidence": {"status": "ready", "data": evidence},
                },
            })
            exported = Path(export["path"]).read_text(encoding="utf-8")
            assert "qa_synthetic_value" not in exported
            assert expected_error in exported
            assert "qa-sdk-call-" + tool_name in exported

            cards = [
                message for message in sidecar.received
                if message.get("method") == "tool_call"
                and message.get("params", {}).get("session_id") == session
                and message.get("params", {}).get("rpc_request_id") == invoke_id
                and message.get("params", {}).get("rpc_stream_id") == stream
            ]
            assert cards == []
            reverse = [
                message for message in sidecar.received
                if message.get("method") in {"ssh_status", "ssh_command"}
            ]
            assert reverse == []
            needs_you = [
                message for message in sidecar.received + sidecar.pending
                if message.get("method") == "needs_you"
                and message.get("params", {}).get("session_id") == session
                and message.get("params", {}).get("rpc_request_id") == invoke_id
                and message.get("params", {}).get("rpc_stream_id") == stream
            ]
            assert needs_you == []

            model_results = [
                message
                for body in server.snapshot()[1:]
                for message in body.get("messages", [])
                if message.get("role") == "tool"
            ]
            assert len(model_results) == 1
            assert model_results[0]["tool_call_id"] == "qa-sdk-call-" + tool_name
    finally:
        try:
            capture["model_requests"] = server.snapshot()
            capture["notifications"] = getattr(sidecar, "received", [])
            capture["reverse_requests"] = [
                message for message in capture["notifications"]
                if message.get("method") in {"ssh_status", "ssh_command"}
            ]
            (tmp_path / "capture.json").write_text(
                json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8",
            )
        finally:
            try:
                if sidecar is not None:
                    sidecar.close()
            finally:
                server.close()
