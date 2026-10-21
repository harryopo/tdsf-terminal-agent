"""Exercise the real sidecar, Strands OpenAI model, and JSON-RPC stream chain."""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest


ROOT = Path(__file__).resolve().parents[3]
SIDECAR = ROOT / "src-tauri" / "sidecar"
MAIN = SIDECAR / "main.py"
DEADLINE = 30


class _ModelServer:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.a_prefix_sent = threading.Event()
        self.release_a = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length))
                with owner.lock:
                    owner.requests.append(body)

                if self.path != "/v1/chat/completions":
                    self.send_error(404)
                    return
                if body.get("model") == "qa-deny-model":
                    payload = json.dumps({
                        "error": {
                            "message": "qa denied",
                            "type": "invalid_request_error",
                            "param": None,
                            "code": "invalid_api_key",
                        }
                    }).encode()
                    self.close_connection = True
                    self.send_response(401)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Connection", "close")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    self.wfile.flush()
                    return

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                def send_chunk(content: str | None, finish: str | None = None) -> None:
                    event = {
                        "id": "chatcmpl-qa",
                        "object": "chat.completion.chunk",
                        "created": 1700000000,
                        "model": body["model"],
                        "choices": [{
                            "index": 0,
                            "delta": ({"content": content} if content is not None else {}),
                            "finish_reason": finish,
                        }],
                    }
                    self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
                    self.wfile.flush()

                if body.get("model") == "qa-model-A":
                    send_chunk("qa_answer_A_prefix")
                    owner.a_prefix_sent.set()
                    if not owner.release_a.wait(DEADLINE):
                        return
                    send_chunk("_suffix")
                    send_chunk(None, "stop")
                else:
                    send_chunk("qa_answer_B", "stop")

                usage = {
                    "id": "chatcmpl-qa",
                    "object": "chat.completion.chunk",
                    "created": 1700000000,
                    "model": body["model"],
                    "choices": [],
                    "usage": {
                        "prompt_tokens": 2,
                        "completion_tokens": 1,
                        "total_tokens": 3,
                    },
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
        self.release_a.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=DEADLINE)
        assert not self.thread.is_alive(), "model server thread did not stop"


class _Sidecar:
    def __init__(self, tmp_path: Path) -> None:
        data = tmp_path / "data"
        logs = tmp_path / "logs"
        home = tmp_path / "home"
        for path in (data, logs, home):
            path.mkdir()
        self.stderr_path = logs / "sidecar.stderr.log"
        self.stderr_file = self.stderr_path.open("w", encoding="utf-8")

        env = os.environ.copy()
        for name in list(env):
            if name.startswith("TDSF_"):
                env.pop(name, None)
        for name in (
            "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
            "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy",
            "https_proxy", "all_proxy", "LANGFUSE_PUBLIC_KEY",
            "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST", "PYTEST_CURRENT_TEST",
        ):
            env.pop(name, None)
        env.update({
            "TDSF_DATA_DIR": str(data),
            "TDSF_AGENT_BACKEND": "strands",
            "TDSF_KB_AUTO_INIT": "0",
            "TDSF_SIDECAR_LOG": "WARNING",
            "HF_HOME": str(home / "hf"),
            "HF_HUB_CACHE": str(home / "hf-cache"),
            "TRANSFORMERS_CACHE": str(home / "transformers"),
            "APPDATA": str(home / "appdata"),
            "XDG_DATA_HOME": str(home / "xdg"),
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "OTEL_SDK_DISABLED": "true",
            "NO_PROXY": "127.0.0.1,localhost",
            "no_proxy": "127.0.0.1,localhost",
            "PYTHONUTF8": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        try:
            self.process = subprocess.Popen(
                [sys.executable, "-u", "-B", str(MAIN)],
                cwd=SIDECAR,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self.stderr_file,
                text=True,
                encoding="utf-8",
                bufsize=1,
            )
        except BaseException:
            self.stderr_file.close()
            raise
        assert self.process.stdin is not None
        assert self.process.stdout is not None
        self.messages: queue.Queue[dict[str, Any] | BaseException | None] = queue.Queue()
        self.pending: list[dict[str, Any]] = []
        self.received: list[dict[str, Any]] = []
        self.reader = threading.Thread(target=self._read_stdout, daemon=True)
        self.reader.start()

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except BaseException as error:
            self.messages.put(error)
        finally:
            self.messages.put(None)

    def send(self, method: str, params: Any = None, request_id: int | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        if request_id is not None:
            message["id"] = request_id
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def _next(self, timeout: float = DEADLINE) -> dict[str, Any]:
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty as error:
            raise AssertionError(
                f"sidecar did not produce the expected JSON-RPC message; stderr: {self.stderr_path}"
            ) from error
        if message is None:
            raise AssertionError(
                f"sidecar stdout closed (exit={self.process.poll()}); stderr: {self.stderr_path}"
            )
        if isinstance(message, BaseException):
            raise AssertionError(f"sidecar stdout reader failed; stderr: {self.stderr_path}") from message
        self.received.append(message)
        if "method" in message and "id" in message:
            raise AssertionError(
                f"unexpected reverse RPC request: {message['method']}; stderr: {self.stderr_path}"
            )
        return message

    def wait_rpc(self, request_id: int) -> dict[str, Any]:
        for index, message in enumerate(self.pending):
            if message.get("id") == request_id:
                return self.pending.pop(index)
        deadline = time.monotonic() + DEADLINE
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"timed out waiting for RPC id {request_id}; stderr: {self.stderr_path}"
                )
            message = self._next(remaining)
            if message.get("id") == request_id:
                return message
            self.pending.append(message)

    def wait_notification(self, method: str, predicate=lambda _params: True) -> dict[str, Any]:
        for index, message in enumerate(self.pending):
            if message.get("method") == method and predicate(message.get("params", {})):
                return self.pending.pop(index)
        deadline = time.monotonic() + DEADLINE
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"timed out waiting for notification {method}; stderr: {self.stderr_path}"
                )
            message = self._next(remaining)
            if message.get("method") == method and predicate(message.get("params", {})):
                return message
            self.pending.append(message)

    def call(self, request_id: int, method: str, params: Any = None) -> dict[str, Any]:
        self.send(method, params, request_id)
        response = self.wait_rpc(request_id)
        assert "error" not in response, f"{method} RPC failed: {response.get('error')}"
        return response["result"]

    def start(self) -> None:
        ready = self.wait_notification("ready")
        status = self.call(1, "status")
        assert ready["params"]["version"] == status["version"]
        assert ready["params"]["methods"] == status["methods"]
        required_methods = {
            "agent.cancel", "agent.configure", "agent.invoke", "ping",
            "shutdown", "sidecar.health", "status",
        }
        assert required_methods.issubset(status["methods"])
        health = self.call(2, "sidecar.health")
        assert health["backend_type"] == "strands"
        assert "main" in health["agents_list"]
        assert health["strands_available"] is True
        assert health["backend_activated"] is True

    def _stop_own_process(self) -> None:
        if self.process.poll() is None:
            try:
                self.process.terminate()
            except OSError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    self.process.kill()
                except OSError:
                    pass
                self.process.wait(timeout=5)

    def close(self) -> None:
        try:
            code = self.process.poll()
            if code is None:
                self.call(990001, "shutdown")
                code = self.process.wait(timeout=DEADLINE)
            if code != 0:
                raise AssertionError(f"sidecar exit was {code}; stderr: {self.stderr_path}")
        finally:
            try:
                self._stop_own_process()
            finally:
                try:
                    if self.process.stdin is not None and not self.process.stdin.closed:
                        try:
                            self.process.stdin.close()
                        except OSError:
                            pass
                    self.reader.join(timeout=DEADLINE)
                    if self.reader.is_alive() and self.process.stdout is not None:
                        self.process.stdout.close()
                    self.reader.join(timeout=5)
                finally:
                    try:
                        if self.process.stdout is not None and not self.process.stdout.closed:
                            try:
                                self.process.stdout.close()
                            except OSError:
                                pass
                    finally:
                        self.stderr_file.close()
            assert not self.reader.is_alive(), f"sidecar stdout reader did not stop; stderr: {self.stderr_path}"


@pytest.fixture
def live_sidecar(tmp_path: Path):
    server = _ModelServer()
    sidecar = None
    try:
        sidecar = _Sidecar(tmp_path)
        sidecar.start()
        yield sidecar, server
    finally:
        server.release_a.set()
        try:
            if sidecar is not None:
                sidecar.close()
        finally:
            server.close()


def _configure(sidecar: _Sidecar, request_id: int, server: _ModelServer, model: str) -> dict[str, Any]:
    return sidecar.call(request_id, "agent.configure", {"config": {
        "provider": "openai",
        "api_key": "fake-" + "rpc-key",
        "base_url": server.base_url,
        "model": model,
        "temperature": 0,
        "max_tokens": 64,
    }})


def _invoke_params(session_id: str, text: str, stream_id: str) -> dict[str, Any]:
    return {"name": "main", "state": {
        "session_id": session_id,
        "input": text,
        "_rpc_stream_id": stream_id,
    }}


def _invoke(sidecar: _Sidecar, request_id: int, params: dict[str, Any]) -> None:
    sidecar.send("agent.invoke", params, request_id)


def _assert_reply(response: dict[str, Any], text: str) -> None:
    assert "error" not in response, response
    result = response["result"]
    assert text in result["observation"]
    assert result["next_step"] == "done"


def _assert_history_roles(messages: list[dict[str, Any]]) -> None:
    markers = (
        "qa_first_user_marker",
        "qa_answer_A_prefix_suffix",
        "qa_queued_user_marker",
    )
    found: list[tuple[int, str]] = []
    for marker in markers:
        matches = [
            (index, message.get("role"))
            for index, message in enumerate(messages)
            if marker in json.dumps(message, ensure_ascii=False)
        ]
        assert len(matches) == 1, f"expected one history message for {marker}: {matches}"
        found.append(matches[0])
    assert [role for _, role in found] == ["user", "assistant", "user"]
    assert [index for index, _ in found] == sorted(index for index, _ in found)


@pytest.mark.parametrize("cancel_queued", [False, True], ids=["preserve-queued-turn", "cancel-queued-turn"])
def test_real_rpc_model_stream_identity_and_queue_cancel(live_sidecar, cancel_queued: bool) -> None:
    sidecar, server = live_sidecar
    session = "qa-rpc-session-" + uuid4().hex
    first_stream = str(uuid4())
    queued_stream = str(uuid4())

    assert _configure(sidecar, 10, server, "qa-model-A")["ok"] is True
    _invoke(sidecar, 11, _invoke_params(session, "qa_first_user_marker", first_stream))
    first_chunk = sidecar.wait_notification(
        "agent_message",
        lambda params: "qa_answer_A_prefix" in params.get("payload", {}).get("content", ""),
    )
    first_meta = first_chunk["params"]
    assert first_meta["rpc_request_id"] == 11
    assert first_meta["rpc_stream_id"] == first_stream
    assert first_meta["session_id"] == session
    assert server.a_prefix_sent.wait(DEADLINE), "model A never emitted its first SSE chunk"

    assert _configure(sidecar, 12, server, "qa-model-B")["ok"] is True
    _invoke(sidecar, 13, _invoke_params(session, "qa_queued_user_marker", queued_stream))
    assert sidecar.call(14, "ping")["alive"] is True

    if cancel_queued:
        cancelled = sidecar.call(15, "agent.cancel", {
            "session_id": session,
            "reason": "qa cancel queued invocation",
        })
        assert cancelled["cancelled"] is True
    server.release_a.set()

    first_response = sidecar.wait_rpc(11)
    # agent.cancel stops the queued turn; the controlled in-flight HTTP stream completes.
    _assert_reply(first_response, "qa_answer_A_prefix_suffix")
    second_response = sidecar.wait_rpc(13)
    if cancel_queued:
        assert "error" not in second_response
        assert "已停止" in second_response["result"]["observation"]
        models = [request["model"] for request in server.snapshot()]
        assert models == ["qa-model-A"], "cancelled queued request reached the model"
        fresh_stream = str(uuid4())
        _invoke(sidecar, 16, _invoke_params(session, "qa_fresh_user_marker", fresh_stream))
        _assert_reply(sidecar.wait_rpc(16), "qa_answer_B")
        requests = server.snapshot()
        assert [request["model"] for request in requests] == ["qa-model-A", "qa-model-B"]
        assert "qa_fresh_user_marker" in json.dumps(requests[1]["messages"], ensure_ascii=False)
        assert "qa_queued_user_marker" not in json.dumps(requests[1]["messages"], ensure_ascii=False)
    else:
        _assert_reply(second_response, "qa_answer_B")
        requests = server.snapshot()
        assert [request["model"] for request in requests] == ["qa-model-A", "qa-model-B"]
        _assert_history_roles(requests[1]["messages"])

    second_chunk = sidecar.wait_notification(
        "agent_message",
        lambda params: "qa_answer_B" in params.get("payload", {}).get("content", ""),
    )
    assert second_chunk["params"]["rpc_request_id"] == (16 if cancel_queued else 13)
    assert second_chunk["params"]["rpc_stream_id"] == (fresh_stream if cancel_queued else queued_stream)
    assert second_chunk["params"]["session_id"] == session


def test_unconfigured_and_http_401_are_not_fabricated_success(live_sidecar) -> None:
    sidecar, server = live_sidecar
    session = "qa-error-session-" + uuid4().hex
    _invoke(sidecar, 21, _invoke_params(session, "你好", str(uuid4())))
    unconfigured = sidecar.wait_rpc(21)
    assert "error" not in unconfigured
    assert unconfigured["result"]["degraded"] is True
    assert unconfigured["result"]["degraded_reason"] == "strands_model_not_injected"
    assert unconfigured["result"]["next_step"] == "done"
    assert "当前没有可用的 AI 模型" in unconfigured["result"]["observation"]
    assert server.snapshot() == []

    denied_config = _configure(sidecar, 22, server, "qa-deny-model")
    assert denied_config["ok"] is True
    _invoke(sidecar, 23, _invoke_params(session, "qa_denied_user_marker", str(uuid4())))
    denied = sidecar.wait_rpc(23)
    assert "error" not in denied
    assert denied["result"]["degraded"] is True
    assert denied["result"]["degraded_reason"] == "invoke_error"
    assert denied["result"]["next_step"] == "error"
    assert "qa_answer_" not in denied["result"]["observation"]
    requests = server.snapshot()
    assert [request["model"] for request in requests] == ["qa-deny-model"]
    assert "qa_denied_user_marker" in json.dumps(requests[0]["messages"], ensure_ascii=False)

    assert _configure(sidecar, 24, server, "qa-model-B")["ok"] is True
    _invoke(sidecar, 25, _invoke_params(session + "-fresh", "qa_fresh_user_marker", str(uuid4())))
    _assert_reply(sidecar.wait_rpc(25), "qa_answer_B")
    requests = server.snapshot()
    assert [request["model"] for request in requests] == ["qa-deny-model", "qa-model-B"]
