"""End-to-end coverage for reference-tool RPCs through the real sidecar."""
from __future__ import annotations

import json
import os
import queue
import re
import time
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import pytest

from test_model_rpc_chain import DEADLINE, _Sidecar, _configure, _invoke_params
from test_tool_rpc_lifecycle import _ToolModelServer


CASE_NAMES = (
    "knowledge-roundtrip",
    "knowledge-missing",
    "skill-reference",
    "skill-missing",
    "terminal-nonempty",
    "terminal-empty",
    "terminal-unavailable",
)

_SAFE_ENV_NAMES = (
    "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT",
)


class _TerminalSidecar(_Sidecar):
    """Allow only the expected reverse scrollback call and answer it locally."""

    def __init__(self, *args, terminal_payload: dict, **kwargs) -> None:
        self.terminal_payload = terminal_payload
        self.reverse_requests: list[dict] = []
        super().__init__(*args, **kwargs)

    def _next(self, timeout: float = DEADLINE) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(
                    f"sidecar did not produce the expected JSON-RPC message; stderr: {self.stderr_path}"
                )
            try:
                message = self.messages.get(timeout=remaining)
            except queue.Empty as error:
                raise AssertionError(
                    f"sidecar did not produce the expected JSON-RPC message; stderr: {self.stderr_path}"
                ) from error
            if message is None:
                raise AssertionError(
                    f"sidecar stdout closed (exit={self.process.poll()}); stderr: {self.stderr_path}"
                )
            if isinstance(message, BaseException):
                raise AssertionError(
                    f"sidecar stdout reader failed; stderr: {self.stderr_path}"
                ) from message
            self.received.append(message)
            if "method" in message and "id" in message:
                assert message["method"] == "get_terminal_scrollback", message
                self.reverse_requests.append(message)
                self.send_response(message["id"], self.terminal_payload)
                continue
            return message

    def send_response(self, request_id: int, result: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": request_id, "result": result,
        }, ensure_ascii=False) + "\n")
        self.process.stdin.flush()


def _isolated_environment(profile: Path) -> dict[str, str]:
    for name in ("home", "userprofile", "localappdata", "temp"):
        (profile / name).mkdir(parents=True, exist_ok=True)
    return {
        name: os.environ[name]
        for name in _SAFE_ENV_NAMES
        if name in os.environ
    } | {
        "USERPROFILE": str(profile / "userprofile"),
        "HOME": str(profile / "home"),
        "LOCALAPPDATA": str(profile / "localappdata"),
        "TEMP": str(profile / "temp"),
        "TMP": str(profile / "temp"),
    }


def _assert_schema(server: _ToolModelServer, tool_name: str, expected: set[str]) -> None:
    requests = server.snapshot()
    assert requests
    declarations = requests[0].get("tools", [])
    declaration = next(item for item in declarations if item.get("function", {}).get("name") == tool_name)
    properties = declaration["function"]["parameters"].get("properties", {})
    assert set(properties) == expected
    assert not any(name in properties for name in ("sdk_tool_context", "session_id", "sessionId"))


def _tool_cards(sidecar: _Sidecar, session: str, invoke_id: int, stream: str,
                tool_name: str, terminal_status: str = "completed") -> list[dict]:
    cards = []
    for expected in ("started", terminal_status):
        event = sidecar.wait_notification(
            "tool_call",
            lambda params, status=expected: params.get("session_id") == session
            and params.get("rpc_request_id") == invoke_id
            and params.get("rpc_stream_id") == stream
            and params.get("payload", {}).get("tool_name") == tool_name
            and params.get("payload", {}).get("status") == status,
        )
        cards.append(event["params"]["payload"])
    assert [card["status"] for card in cards] == ["started", terminal_status]
    assert cards[0].get("tool_call_id")
    assert cards[1].get("tool_call_id") == cards[0]["tool_call_id"]
    return cards


def _assert_trace(sidecar: _Sidecar, session: str, invoke_id: int, stream: str,
                  sdk_id: str, tool_name: str, result: dict,
                  terminal_status: str = "completed") -> None:
    cards = _tool_cards(sidecar, session, invoke_id, stream, tool_name, terminal_status)
    assert cards[1].get("result") == result
    ui_id = cards[0]["tool_call_id"]
    log = sidecar.call(40, "debug.agent_log_tail", {"session_id": session, "lines": 100})
    entries = [
        entry for entry in log["lines"]
        if entry.get("meta", {}).get("tool_name") == tool_name
        and entry.get("type") in {"tool_call", "tool_result", "loop_progress"}
    ]
    assert {entry["type"] for entry in entries} == {"tool_call", "tool_result", "loop_progress"}
    assert len(entries) == 3
    for entry in entries:
        meta = entry.get("meta", {})
        assert meta.get("rpc_request_id") == invoke_id
        assert meta.get("rpc_stream_id") == stream
        if entry["type"] == "loop_progress":
            assert meta.get("sdk_tool_use_id") == sdk_id
        else:
            assert "sdk_tool_use_id" not in meta
        assert meta.get("tool_call_id") == ui_id
    evidence = sidecar.call(41, "evidence.list", {"session_id": session})
    matching = [row for row in evidence if row.get("tool_name") == tool_name]
    assert len(matching) == 1
    assert matching[0].get("tool_call_id") == ui_id
    assert matching[0].get("sdk_tool_use_id") == sdk_id
    if isinstance(result.get("status"), str):
        assert matching[0].get("result_status") == result["status"]
    if isinstance(result.get("available"), bool):
        assert matching[0].get("result_available") is result["available"]


_OFFLOAD_REFERENCE = re.compile(r"\[Stored references:\]\n\s+(\S+) \(")
_RETRIEVAL_ID = "qa-sdk-call-retrieve_offloaded_content"


def _retrieve_offloaded_result(body: dict) -> tuple[str, dict] | None:
    messages = body.get("messages", [])
    if any(message.get("tool_call_id") == _RETRIEVAL_ID for message in messages):
        return None
    for message in messages:
        if message.get("role") == "tool" and message.get("content", "").startswith("[Offloaded:"):
            match = _OFFLOAD_REFERENCE.search(message["content"])
            if match:
                return "retrieve_offloaded_content", {"reference": match[1]}
    return None


def _follow_up_tool_result(server: _ToolModelServer) -> dict:
    requests = server.snapshot()
    follow_up = next(
        body for body in requests[1:]
        if any(message.get("role") == "tool" for message in body.get("messages", []))
    )
    message = next(message for message in follow_up["messages"] if message.get("role") == "tool")
    assert message.get("tool_call_id") == "qa-sdk-call-" + server.tool_name
    assert message["content"], "successful reference-tool content was lost before reaching the model"
    if message["content"].startswith("[Offloaded:"):
        match = _OFFLOAD_REFERENCE.search(message["content"])
        assert match, "offloaded result must provide a retrievable reference"
        assert any(item.get("function", {}).get("name") == "retrieve_offloaded_content"
                   for item in requests[0]["tools"])
        retrieval = next(
            call for body in requests[2:] for row in body.get("messages", [])
            for call in row.get("tool_calls", []) if call.get("id") == _RETRIEVAL_ID
        )
        assert retrieval["function"]["name"] == "retrieve_offloaded_content"
        assert json.loads(retrieval["function"]["arguments"]) == {"reference": match[1]}
        message = next(
            row for body in requests[2:] for row in body.get("messages", [])
            if row.get("role") == "tool" and row.get("tool_call_id") == _RETRIEVAL_ID
        )
    result = json.loads(message["content"])
    assert isinstance(result, dict)
    return result


def _run_sdk_call(tmp_path: Path, case: str, tool_name: str, arguments: dict,
                  validate_result, *, command: list[str] | None = None,
                  terminal_payload: dict | None = None,
                  expected_schema: set[str] | None = None,
                  rpc_check=None) -> tuple[dict, list[dict], object]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    server = _ToolModelServer(tool_name, arguments, follow_up=_retrieve_offloaded_result)
    sidecar = None
    session = "qa-reference-" + uuid4().hex
    stream = str(uuid4())
    invoke_id = 20
    safe_env = _isolated_environment(tmp_path / "profile")
    result = None
    try:
        with patch.dict(os.environ, safe_env, clear=True):
            sidecar_type = _TerminalSidecar if terminal_payload is not None else _Sidecar
            extra = {"terminal_payload": terminal_payload} if terminal_payload is not None else {}
            sidecar = sidecar_type(tmp_path, command=command, **extra)
            sidecar.start()
            assert _configure(sidecar, 10, server, "qa-tool-model")["ok"] is True
        rpc_result = rpc_check(sidecar) if rpc_check is not None else None
        params = _invoke_params(session, "qa " + case, stream)
        params["state"].update({
            "mode": "confirm",
            "live": {"workspaceRoot": str(tmp_path)},
        })
        sidecar.send("agent.invoke", params, invoke_id)
        response = sidecar.wait_rpc(invoke_id)
        assert "error" not in response, response
        assert "qa_finished" in response["result"]["observation"]
        assert not any(
            message.get("method") == "needs_you"
            and message.get("params", {}).get("payload", {}).get("event") == "created"
            for message in sidecar.received + sidecar.pending
        )
        result = _follow_up_tool_result(server)
        validate_result(result)
        if expected_schema is not None:
            _assert_schema(server, tool_name, expected_schema)
        assert sidecar.call(30, "ping")["alive"] is True
        sdk_id = "qa-sdk-call-" + tool_name
        terminal_status = "error" if result.get("status") == "not_found" and tool_name == "skill_invoke" else "completed"
        _assert_trace(sidecar, session, invoke_id, stream, sdk_id, tool_name, result, terminal_status)
        if terminal_payload is not None:
            assert len(sidecar.reverse_requests) == 1
            reverse = sidecar.reverse_requests[0]
            assert reverse["method"] == "get_terminal_scrollback"
            assert reverse["params"] == {
                "sessionId": "", "lines": max(1, min(arguments["lines"], 2000)),
            }
        return result, server.snapshot(), rpc_result
    finally:
        try:
            capture = {
                "case": case,
                "result": result,
                "messages": sidecar.received if sidecar is not None else [],
                "model_requests": server.snapshot(),
                "reverse_requests": getattr(sidecar, "reverse_requests", []),
            }
            (tmp_path / f"{case}-rpc-capture.json").write_text(
                json.dumps(capture, ensure_ascii=False, indent=2), encoding="utf-8",
            )
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


def exercise_reference_case(tmp_path: Path, case: str,
                            command: list[str] | None = None) -> None:
    if case == "knowledge-roundtrip":
        def check_search_rpc(sidecar: _Sidecar) -> dict:
            rpc_search = sidecar.call(50, "knowledge.search_slim", {
                "query": "systemctl", "limit": 2,
            })
            assert rpc_search.get("results"), rpc_search
            return rpc_search

        search_result, _, rpc_search = _run_sdk_call(
            tmp_path / "knowledge-search", case, "knowledge_search", {"query": "systemctl", "limit": 2},
            lambda result: (
                result.get("status") == "success"
                and len(result.get("results", [])) > 0
                and all(row.get("url") for row in result["results"])
            ) or pytest.fail(f"knowledge_search returned no usable result: {result}"),
            command=command, expected_schema={"query", "limit"}, rpc_check=check_search_rpc,
        )
        first = search_result["results"][0]
        url = first["url"]
        assert any(row.get("url") == url for row in rpc_search["results"]), (
            "SDK knowledge_search URL was absent from the same slim library RPC results"
        )

        def check_doc_rpc(sidecar: _Sidecar) -> dict:
            rpc_doc = sidecar.call(50, "knowledge.get_doc", {"url": url, "library": "slim"})
            assert rpc_doc.get("ok") is True, rpc_doc
            return rpc_doc

        doc_result, _, rpc_doc = _run_sdk_call(
            tmp_path / "knowledge-doc", case, "knowledge_get_doc", {"url": url},
            lambda result: (
                result.get("status") == "success"
                and result.get("url") == url
                and bool(result.get("content"))
            ) or pytest.fail(f"knowledge_get_doc returned no document: {result}"),
            command=command, expected_schema={"url"}, rpc_check=check_doc_rpc,
        )
        # The underlying RPC and SDK read the same bundled slim library. SDK
        # truncation is a public contract, so compare exact body only in range.
        assert doc_result["url"] == rpc_doc["url"] == url
        rpc_content = str(rpc_doc.get("content") or "")
        if len(rpc_content) <= 30000:
            assert doc_result["content"] == rpc_content
            assert doc_result["truncated"] is False
        else:
            assert doc_result["truncated"] is True
            assert doc_result["content"].startswith(rpc_content[:30000])
        return

    if case == "knowledge-missing":
        def check_missing_doc_rpc(sidecar: _Sidecar) -> None:
            rpc_doc = sidecar.call(50, "knowledge.get_doc", {
                "url": "qa-no-such-document.md", "library": "slim",
            })
            assert rpc_doc.get("ok") is False
            assert "not found" in rpc_doc.get("error", "")

        _run_sdk_call(
            tmp_path, case, "knowledge_get_doc", {"url": "qa-no-such-document.md"},
            lambda result: (
                result.get("status") == "not_found"
                and result.get("url") == "qa-no-such-document.md"
                and "不存在" in result.get("message", "")
            ) or pytest.fail(f"missing document was not preserved as not_found: {result}"),
            command=command, expected_schema={"url"}, rpc_check=check_missing_doc_rpc,
        )
        return

    if case == "skill-reference":
        def check_skill_rpc(sidecar: _Sidecar) -> None:
            catalog = sidecar.call(50, "skill.list", {})
            assert any(item.get("name") == "linux-ops" for item in catalog["skills"])

        _run_sdk_call(
            tmp_path, case, "skill_invoke", {"skill_name": "linux-ops", "input": "systemctl"},
            lambda result: (
                result.get("status") == "success"
                and result.get("execution") == "not_run"
                and bool(result.get("content"))
                and not any(key in result for key in ("stdout", "stderr", "exit_code"))
            ) or pytest.fail(f"skill reference was not returned: {result}"),
            command=command, expected_schema={"skill_name", "input"}, rpc_check=check_skill_rpc,
        )
        return
    if case == "skill-missing":
        rpc_names: set[str] = set()

        def check_catalog(sidecar: _Sidecar) -> None:
            catalog = sidecar.call(50, "skill.list", {})
            names = {item.get("name") for item in catalog["skills"]}
            assert "linux-ops" in names
            rpc_names.update(names)

        _run_sdk_call(
            tmp_path, case, "skill_invoke",
            {"skill_name": "qa-no-such-skill", "input": "read-only capability probe"},
            lambda result: (
                result.get("status") == "not_found"
                and "qa-no-such-skill" == result.get("skill_name")
                and set(result.get("available_skills", [])) == rpc_names
            ) or pytest.fail(f"missing skill result omitted not_found/catalog: {result}"),
            command=command, expected_schema={"skill_name", "input"}, rpc_check=check_catalog,
        )
        return

    if case.startswith("terminal-"):
        if case == "terminal-nonempty":
            fixture_secret = "qa-fixture-value"
            output = "服务状态：正常\nAPI_KEY=" + fixture_secret
            available = True
        elif case == "terminal-empty":
            output, available = "", True
        else:
            output, available = "", False
        lines = 3000
        clamped_lines = 2000
        expected = {
            "output": ("服务状态：正常\nAPI_KEY=<REDACTED>" if output else ""),
            "lines_requested": clamped_lines,
            "lines_returned": 2 if output else 0,
            "available": available,
            "truncated": False,
            "has_more": False,
        }
        _run_sdk_call(
            tmp_path, case, "get_terminal_output", {"lines": lines},
            lambda result: result == expected or pytest.fail(f"terminal result mismatch: {result}"),
            command=command,
            terminal_payload={"output": output, "available": available},
            expected_schema={"lines"},
        )
        return

    raise AssertionError(f"unknown reference RPC case: {case}")


@pytest.mark.parametrize("case", CASE_NAMES, ids=CASE_NAMES)
def test_reference_tools_round_trip_through_real_sidecar(tmp_path: Path, case: str) -> None:
    exercise_reference_case(tmp_path, case)
