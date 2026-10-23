"""Exercise human-wait tool lifecycles through the real sidecar and Strands SDK."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import pytest

from test_model_rpc_chain import (
    DEADLINE,
    _Sidecar,
    _assert_reply,
    _configure,
    _invoke_params,
)


class _ToolModelServer:
    def __init__(self, tool_name: str, arguments: dict[str, Any], *,
                 follow_up: Callable[[dict], tuple[str, dict] | None] | None = None) -> None:
        self.tool_name = tool_name
        self.arguments = arguments
        self.follow_up = follow_up
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def do_POST(self) -> None:
                if self.path != "/v1/chat/completions":
                    self.send_response(404)
                    self.send_header("Connection", "close")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    self.close_connection = True
                    self.wfile.flush()
                    return
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length))
                with owner.lock:
                    owner.requests.append(body)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                if len(owner.snapshot()) == 1:
                    next_tool = (owner.tool_name, owner.arguments)
                else:
                    next_tool = owner.follow_up(body) if owner.follow_up else None
                if next_tool is not None:
                    name, arguments = next_tool
                    delta = {"tool_calls": [{
                        "index": 0,
                        "id": "qa-sdk-call-" + name,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": json.dumps(arguments, ensure_ascii=False),
                        },
                    }]}
                    finish = "tool_calls"
                else:
                    delta = {"content": "qa_finished"}
                    finish = "stop"
                chunk = {
                    "id": "chatcmpl-tool-qa",
                    "object": "chat.completion.chunk",
                    "created": 1700000001,
                    "model": body["model"],
                    "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
                final = {
                    "id": "chatcmpl-tool-qa",
                    "object": "chat.completion.chunk",
                    "created": 1700000001,
                    "model": body["model"],
                    "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                }
                self.wfile.write(f"data: {json.dumps(final)}\n\n".encode())
                usage = {
                    "id": "chatcmpl-tool-qa",
                    "object": "chat.completion.chunk",
                    "created": 1700000001,
                    "model": body["model"],
                    "choices": [],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3},
                }
                self.wfile.write(f"data: {json.dumps(usage)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return list(self.requests)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=DEADLINE)
        assert not self.thread.is_alive(), "tool model server thread did not stop"


@pytest.fixture
def tool_sidecar(tmp_path: Path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return workspace


def _start_tool_sidecar(tmp_path: Path, name: str, args: dict[str, Any]):
    server = _ToolModelServer(name, args)
    sidecar = None
    try:
        sidecar = _Sidecar(tmp_path)
        sidecar.start()
        assert _configure(sidecar, 10, server, "qa-tool-model")["ok"] is True
    except BaseException:
        try:
            if sidecar is not None:
                sidecar.close()
        finally:
            server.close()
        raise
    return sidecar, server


def _wait_for_tool_request(sidecar: _Sidecar, tool_type: str) -> dict[str, Any]:
    return sidecar.wait_notification(
        "needs_you",
        lambda params: params.get("payload", {}).get("event") == "created"
        and params.get("payload", {}).get("request", {}).get("type") == tool_type,
    )["params"]["payload"]["request"]


def _respond(sidecar: _Sidecar, request: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    return sidecar.call(30, "needs_you.respond", {
        "req_id": request["id"],
        "response": response,
    })


def _tool_identity(sidecar: _Sidecar, session: str, invoke_id: int, stream_id: str,
                   request: dict[str, Any], tool_name: str,
                   expected_status: str) -> dict[str, Any]:
    cards = []
    for status in ("started", "completed"):
        event = sidecar.wait_notification(
            "tool_call",
            lambda params, expected=status: params.get("session_id") == session
            and params.get("payload", {}).get("tool_name") == tool_name
            and params.get("payload", {}).get("status") == expected
            and params.get("rpc_request_id") == invoke_id
            and params.get("rpc_stream_id") == stream_id,
        )
        cards.append(event["params"]["payload"])
    assert [card["status"] for card in cards] == ["started", "completed"]
    result = cards[1].get("result")
    assert isinstance(result, dict)
    assert result["status"] == expected_status
    if expected_status == "cancelled":
        assert "超时" not in result.get("message", "")
    call_id = request.get("extra", {}).get("tool_call_id")
    if tool_name == "python_run":
        assert isinstance(call_id, str) and call_id
        assert call_id == cards[0].get("tool_call_id")
    else:
        call_id = cards[0].get("tool_call_id")
    assert isinstance(call_id, str) and call_id
    assert request["id"] != call_id
    assert {card.get("tool_call_id") for card in cards} == {call_id}

    log = sidecar.call(40, "debug.agent_log_tail", {"session_id": session, "lines": 100})
    entries = [
        entry for entry in log["lines"]
        if entry.get("meta", {}).get("tool_name") == tool_name
        and entry.get("type") in ("tool_call", "tool_result", "loop_progress")
    ]
    assert {entry["type"] for entry in entries} == {"tool_call", "tool_result", "loop_progress"}
    assert len(entries) == 3
    for entry in entries:
        meta = entry.get("meta", {})
        assert meta.get("tool_call_id") == call_id
        assert meta.get("rpc_request_id") == invoke_id
        assert meta.get("rpc_stream_id") == stream_id
        if entry["type"] == "loop_progress":
            assert meta.get("sdk_tool_use_id") == "qa-sdk-call-" + tool_name

    evidence = sidecar.call(41, "evidence.list", {"session_id": session})
    matching = [row for row in evidence if row.get("tool_name") == tool_name]
    assert len(matching) == 1
    assert matching[0].get("tool_call_id") == call_id
    assert matching[0].get("sdk_tool_use_id") == "qa-sdk-call-" + tool_name
    if tool_name == "python_run":
        assert matching[0]["sdk_tool_use_id"] != call_id
    else:
        assert matching[0]["sdk_tool_use_id"] == call_id
    return result


def _tool_result_from_request(server: _ToolModelServer, expected_status: str) -> dict[str, Any]:
    requests = server.snapshot()
    follow_up = next(
        body for body in requests[1:]
        if any(message.get("role") == "tool" for message in body.get("messages", []))
    )
    message = next(message for message in follow_up["messages"] if message.get("role") == "tool")
    assert message.get("tool_call_id") == "qa-sdk-call-" + server.tool_name
    result = json.loads(message["content"])
    assert result["status"] == expected_status
    return result


@pytest.mark.parametrize("decision", ["approve", "reject", "cancel"])
def test_python_run_approval_lifecycle_has_one_tool_identity(tool_sidecar, tmp_path: Path,
                                                               decision: str) -> None:
    workspace = tool_sidecar
    code = "open('qa-marker.txt', 'w', encoding='utf-8').write('qa_executed'); print('qa_executed')"
    sidecar, server = _start_tool_sidecar(tmp_path, "python_run", {"code": code})
    session = "qa-python-" + uuid4().hex
    stream = str(uuid4())
    invoke_id = 20
    try:
        params = _invoke_params(session, "qa_python_approval", stream)
        params["state"]["mode"] = "confirm"
        params["state"]["live"] = {"workspaceRoot": str(workspace)}
        sidecar.send("agent.invoke", params, invoke_id)
        request = _wait_for_tool_request(sidecar, "approval")
        assert not (workspace / "qa-marker.txt").exists()
        assert len(server.snapshot()) == 1
        assert sidecar.call(21, "ping")["alive"] is True
        assert not any(message.get("id") == invoke_id for message in sidecar.received + sidecar.pending)

        if decision == "cancel":
            cancelled = sidecar.call(22, "agent.cancel", {"session_id": session, "reason": "qa stop"})
            assert cancelled["cancelled"] is True
            terminal = sidecar.call(23, "needs_you.get", {"req_id": request["id"]})
            assert terminal["status"] == "cancelled"
        else:
            _respond(sidecar, request, {"approved": decision == "approve"})

        response = sidecar.wait_rpc(invoke_id)
        assert "error" not in response
        if decision == "approve":
            assert (workspace / "qa-marker.txt").read_text(encoding="utf-8") == "qa_executed"
        else:
            assert not (workspace / "qa-marker.txt").exists()
        expected_status = {"approve": "success", "reject": "rejected", "cancel": "cancelled"}[decision]
        result = _tool_identity(
            sidecar, session, invoke_id, stream, request, "python_run", expected_status,
        )
        if decision == "approve":
            assert result["exit_code"] == 0
            assert "qa_executed" in result["stdout"]
        if decision != "cancel":
            assert _tool_result_from_request(server, expected_status) == result
    finally:
        try:
            try:
                sidecar.call(90, "agent.cancel", {"session_id": session, "reason": "qa cleanup"})
            except (AssertionError, BrokenPipeError, OSError):
                pass
            sidecar.close()
        finally:
            server.close()


@pytest.mark.parametrize("decision", ["answer", "cancel"])
def test_ask_user_answer_or_cancel_is_reflected_by_real_tool_call(tool_sidecar,
                                                                  tmp_path: Path, decision: str) -> None:
    sidecar, server = _start_tool_sidecar(tmp_path, "ask_user", {"question": "请选择 qa 方案", "options": []})
    session = "qa-ask-" + uuid4().hex
    stream = str(uuid4())
    invoke_id = 50
    try:
        sidecar.send("agent.invoke", _invoke_params(session, "qa_ask_user", stream), invoke_id)
        request = _wait_for_tool_request(sidecar, "question")
        assert len(server.snapshot()) == 1
        assert sidecar.call(51, "ping")["alive"] is True
        assert not any(message.get("id") == invoke_id for message in sidecar.received + sidecar.pending)

        if decision == "answer":
            _respond(sidecar, request, {"answer": "采用方案甲"})
            response = sidecar.wait_rpc(invoke_id)
            _assert_reply(response, "qa_finished")
            result = _tool_result_from_request(server, "success")
            assert result["answer"] == "采用方案甲"
        else:
            cancelled = sidecar.call(52, "agent.cancel", {"session_id": session, "reason": "qa stop"})
            assert cancelled["cancelled"] is True
            response = sidecar.wait_rpc(invoke_id)
            assert "error" not in response

        tool_result = _tool_identity(
            sidecar, session, invoke_id, stream, request, "ask_user",
            "success" if decision == "answer" else "cancelled",
        )
        assert isinstance(tool_result, dict)
        assert tool_result["status"] == ("success" if decision == "answer" else "cancelled")
        if decision == "cancel":
            requests = server.snapshot()
            assert len(requests) <= 2
            if len(requests) == 2:
                calls = [
                    call
                    for message in requests[-1]["messages"]
                    for call in message.get("tool_calls", [])
                ]
                assert len(calls) == 1
    finally:
        try:
            try:
                sidecar.call(90, "agent.cancel", {"session_id": session, "reason": "qa cleanup"})
            except (AssertionError, BrokenPipeError, OSError):
                pass
            sidecar.close()
        finally:
            server.close()
