"""Real RPC lifecycle coverage for remote file tools with a local SFTP boundary."""
from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from test_model_rpc_chain import DEADLINE, _Sidecar, _configure, _invoke_params
from test_reference_rpc_capabilities import _isolated_environment
from test_tool_rpc_lifecycle import (
    _ToolModelServer,
    _wait_for_tool_request,
    _respond,
)
from test_reference_rpc_capabilities import _assert_schema


class _SftpSidecar(_Sidecar):
    """Answer only sftp_read/sftp_write requests against temporary local bytes."""
    def __init__(self, *args, files: dict[str, Path], **kwargs):
        self.files = files
        self.sftp: list[tuple[str, str]] = []
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
            if "method" in message and "id" in message:
                method, params = message["method"], message.get("params", {})
                assert method in {"sftp_read", "sftp_write"}, message
                assert params.get("sessionId") == 17, message
                path = params.get("path")
                if path not in self.files:
                    base = next((key for key in self.files if path.startswith(key + ".tdsf-backup-")), None)
                    assert base is not None and re.fullmatch(re.escape(base) + r"\.tdsf-backup-[0-9a-f]{12}", path), message
                    local = self.files[base].with_name(self.files[base].name + path[len(base):])
                    self.files[path] = local
                else:
                    local = self.files[path]
                if method == "sftp_read":
                    assert set(params) in (
                        {"sessionId", "path"}, {"sessionId", "path", "max_size"},
                    ), message
                    result = list(local.read_bytes())
                else:
                    assert set(params) == {"sessionId", "path", "content"}, message
                    content = params["content"]
                    assert isinstance(content, list) and all(type(byte) is int and 0 <= byte <= 255 for byte in content)
                    local.write_bytes(bytes(content))
                    result = None
                self.sftp.append((method, path))
                self.send_response(message["id"], result)
                continue
            return message

    def send_response(self, request_id: int, result) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}) + "\n")
        self.process.stdin.flush()


@pytest.mark.parametrize("tool_name,decision", [
    ("read_remote_file", "plain"),
    ("read_remote_file", "approve"),
    ("read_remote_file", "reject"),
    ("read_remote_file", "cancel"),
    ("write_remote_file", "approve"),
    ("write_remote_file", "reject"),
    ("write_remote_file", "cancel"),
])
def test_remote_file_rpc_lifecycle(tmp_path: Path, tool_name: str, decision: str) -> None:
    initial = b"qa_setting=before\n"
    content = "qa_setting=新值\n"
    target_path = "/qa/settings.conf" if tool_name == "write_remote_file" else (
        "/qa/llm_config.json" if decision != "plain" else "/qa/readme.txt"
    )
    local = tmp_path / "remote-original"
    local.write_bytes(initial)
    files = {target_path: local}
    args = ({"path": target_path, "max_size": 4096} if tool_name == "read_remote_file" else {
        "path": target_path, "content": content,
        "expected_sha256": hashlib.sha256(initial).hexdigest(),
    })
    server = _ToolModelServer(tool_name, args)
    sidecar = None
    session, stream, invoke_id = "qa-remote-" + uuid4().hex, str(uuid4()), 20
    safe_env = _isolated_environment(tmp_path / "profile")
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar = _SftpSidecar(tmp_path, files=files)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-remote-file")["ok"] is True
            params = _invoke_params(session, "qa exercise remote file", stream)
            params["state"]["mode"] = "confirm"
            params["state"]["live"] = {"sshSessionId": "17", "workspaceRoot": str(tmp_path)}
            sidecar.send("agent.invoke", params, invoke_id)
            request = None
            if decision != "plain":
                request = _wait_for_tool_request(sidecar, "approval")
                assert sidecar.call(21, "ping")["alive"] is True
                assert len(server.snapshot()) == 1
                if tool_name == "read_remote_file":
                    assert sidecar.sftp == []
                else:
                    assert not any(method == "sftp_write" for method, _ in sidecar.sftp)
                if decision == "cancel":
                    assert sidecar.call(22, "agent.cancel", {"session_id": session, "reason": "qa stop"})["cancelled"] is True
                    assert sidecar.call(23, "needs_you.get", {"req_id": request["id"]})["status"] == "cancelled"
                else:
                    _respond(sidecar, request, {"approved": decision == "approve"})
            response = sidecar.wait_rpc(invoke_id)
            assert "error" not in response, response
            _assert_schema(server, tool_name, ({"path", "ssh_session_id", "max_size", "encoding"}
                                               if tool_name == "read_remote_file" else
                                               {"path", "content", "expected_sha256", "ssh_session_id"}))
            if decision == "cancel":
                expected = "cancelled"
            elif decision == "reject":
                expected = "rejected"
            else:
                expected = "success"
            if tool_name == "read_remote_file":
                if decision in {"plain", "approve"}:
                    assert sidecar.sftp == [("sftp_read", target_path)]
                else:
                    assert sidecar.sftp == []
            else:
                if decision == "approve":
                    assert local.read_bytes() == content.encode("utf-8")
                    backups = [path for name, path in files.items() if ".tdsf-backup-" in name]
                    assert len(backups) == 1 and backups[0].read_bytes() == initial
                    assert sum(method == "sftp_read" for method, _ in sidecar.sftp) >= 2
                    assert sum(method == "sftp_write" for method, _ in sidecar.sftp) == 2
                else:
                    assert local.read_bytes() == initial
                    assert not any(method == "sftp_write" for method, _ in sidecar.sftp)

            cards = []
            terminal = "error" if tool_name == "write_remote_file" and expected != "success" else "completed"
            for status in ("started", terminal):
                event = sidecar.wait_notification("tool_call", lambda p, s=status:
                    p.get("session_id") == session and p.get("rpc_request_id") == invoke_id
                    and p.get("rpc_stream_id") == stream and p.get("payload", {}).get("tool_name") == tool_name
                    and p.get("payload", {}).get("status") == s)
                cards.append(event["params"]["payload"])
            call_id = cards[0].get("tool_call_id")
            assert call_id and cards[1].get("tool_call_id") == call_id
            if request is not None:
                assert request["id"] != call_id
                assert request.get("extra", {}).get("tool_call_id") == call_id
            assert cards[1].get("result", {}).get("status") == expected
            if tool_name == "write_remote_file":
                operation_id = cards[1]["result"].get("operation_id")
                assert operation_id
                with sqlite3.connect(f"file:{tmp_path / 'data' / 'tdsf.db'}?mode=ro", uri=True) as db:
                    row = db.execute("SELECT state FROM operations WHERE id = ?", (operation_id,)).fetchone()
                assert row == (("succeeded" if expected == "success" else "cancelled"),)
            if tool_name == "read_remote_file":
                assert "content" not in cards[1]["result"]
            log = sidecar.call(40, "debug.agent_log_tail", {"session_id": session, "lines": 100})
            trace = [e for e in log["lines"] if e.get("meta", {}).get("tool_name") == tool_name
                     and e.get("type") in {"tool_call", "tool_result", "loop_progress"}]
            assert {e["type"] for e in trace} == {"tool_call", "tool_result", "loop_progress"}
            assert len(trace) == 3
            assert all(e.get("meta", {}).get("rpc_request_id") == invoke_id
                       and e.get("meta", {}).get("rpc_stream_id") == stream
                       and e.get("meta", {}).get("tool_call_id") == call_id for e in trace)
            progress = next(e for e in trace if e["type"] == "loop_progress")
            assert progress.get("meta", {}).get("sdk_tool_use_id") == "qa-sdk-call-" + tool_name
            evidence = sidecar.call(41, "evidence.list", {"session_id": session})
            matching = [row for row in evidence if row.get("tool_name") == tool_name]
            assert len(matching) == 1 and matching[0].get("tool_call_id") == call_id
            assert matching[0].get("sdk_tool_use_id") == "qa-sdk-call-" + tool_name
            if decision != "cancel":
                tool_msgs = [m for body in server.snapshot()[1:] for m in body.get("messages", []) if m.get("role") == "tool"]
                assert tool_msgs
                assert tool_msgs[-1].get("tool_call_id") == "qa-sdk-call-" + tool_name
                business_result = json.loads(tool_msgs[-1]["content"])
                assert isinstance(business_result, dict) and business_result.get("status") == expected
                if tool_name == "read_remote_file" and expected == "success":
                    assert business_result.get("content") == initial.decode("utf-8")
                if tool_name == "write_remote_file" and expected == "success":
                    assert business_result.get("sha256") == hashlib.sha256(content.encode("utf-8")).hexdigest()
                    assert business_result.get("operation_id") == cards[1]["result"].get("operation_id")
                assert "qa_finished" in response["result"]["observation"]
    finally:
        try:
            if sidecar is not None:
                sidecar.close()
        finally:
            server.close()
