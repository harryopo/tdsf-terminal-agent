from __future__ import annotations

import json
import threading
import ast
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path

import main
import pytest
from rpc_request_context import (
    agent_request_scope,
    current_agent_request_id,
    with_agent_request_id,
)
from strands_backend.agent_log import log_event, reset_for_test, tail


@pytest.fixture(autouse=True)
def _isolate_agent_log(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))

    reset_for_test()
    yield
    reset_for_test()


def _dispatch_fixture_agent(monkeypatch):
    messages: list[dict] = []
    monkeypatch.setattr(main, "write_message", messages.append)
    params = {
        "input": "fixture prompt",
        "state": {"source": "fixture", "rpc_request_id": 999},
    }

    dispatcher = main.MethodDispatcher()
    received = {}

    def handler(input, state):
        received.update(input=input, state=state)
        main.send_notification("agent.progress", {"phase": "tool_started"})
        assert log_event(
            "rpc-origin-fixture",
            "tool_call",
            "fixture event",
            meta={"status": "started"},
        )
        return {"ok": True}

    dispatcher.register("agent.invoke", handler)
    original_dispatch = dispatcher.dispatch

    def observe_dispatch(method, received_params):
        assert received_params is params
        return original_dispatch(method, received_params)

    monkeypatch.setattr(dispatcher, "dispatch", observe_dispatch)

    main._dispatch_in_executor(
        dispatcher, "agent.invoke", params, 41, is_notification=False
    )
    assert received == {
        "input": "fixture prompt",
        "state": {"source": "fixture", "rpc_request_id": 999},
    }
    assert received["state"] is params["state"]
    assert params == {
        "input": "fixture prompt",
        "state": {"source": "fixture", "rpc_request_id": 999},
    }
    return messages


def test_agent_rpc_id_reaches_notification(monkeypatch):
    messages = _dispatch_fixture_agent(monkeypatch)
    notification = next(message for message in messages if message.get("method"))
    assert notification["params"]["rpc_request_id"] == 41


def test_agent_rpc_id_reaches_session_log(monkeypatch):
    _dispatch_fixture_agent(monkeypatch)
    logged = tail("rpc-origin-fixture", event_type="tool_call")["lines"]
    assert len(logged) == 1
    assert logged[0]["meta"]["rpc_request_id"] == 41


def test_notification_metadata_is_copied_and_non_dict_params_are_preserved(monkeypatch):
    messages = []
    monkeypatch.setattr(main, "write_message", messages.append)
    nested = {"fixture": True}
    metadata = {"phase": "started", "nested": nested, "rpc_request_id": 999}
    with agent_request_scope(42):
        main.send_notification("agent.progress", metadata)
        assert main.send_notification("agent.raw", ["fixture"]) is None

    assert messages[0]["params"] == {
        "phase": "started",
        "nested": nested,
        "rpc_request_id": 42,
    }
    assert messages[0]["params"] is not metadata
    assert messages[0]["params"]["nested"] is nested
    assert metadata["rpc_request_id"] == 999
    assert messages[1]["params"] == ["fixture"]

    main.send_notification("agent.empty", None)
    assert "params" not in messages[2]


def test_notification_request_scope_masks_explicit_json_rpc_notification(monkeypatch):
    messages = []
    observed = []
    monkeypatch.setattr(main, "write_message", messages.append)
    dispatcher = main.MethodDispatcher()
    dispatcher.register(
        "agent.invoke",
        lambda: observed.append(current_agent_request_id()),
    )

    with agent_request_scope(51):
        main._dispatch_in_executor(
            dispatcher, "agent.invoke", {}, None, is_notification=True
        )
        assert current_agent_request_id() == 51

    assert observed == [None]
    assert messages == []


def test_log_metadata_rejects_forgery_and_keeps_id_when_truncated():
    with agent_request_scope(43):
        assert log_event(
            "rpc-meta-fixture",
            "tool_call",
            "fixture",
            meta={"status": "started", "rpc_request_id": 999},
        )
        assert log_event(
            "rpc-meta-large-fixture",
            "tool_call",
            "fixture",
            meta={"padding": "x" * 9000, "rpc_request_id": 999},
        )

    regular_meta = tail("rpc-meta-fixture")["lines"][0]["meta"]
    assert regular_meta == {"status": "started", "rpc_request_id": 43}
    large_meta = tail("rpc-meta-large-fixture")["lines"][0]["meta"]
    assert large_meta == {"truncated": True, "rpc_request_id": 43}

    assert log_event(
        "rpc-meta-unscoped-fixture",
        "tool_call",
        "fixture",
        meta={"rpc_request_id": 999},
    )
    unscoped_meta = tail("rpc-meta-unscoped-fixture")["lines"][0]["meta"]
    assert "rpc_request_id" not in unscoped_meta


def test_request_metadata_still_uses_existing_log_redaction():
    with agent_request_scope(44):
        assert log_event(
            "rpc-redaction-fixture",
            "tool_call",
            "fixture",
            meta={"password": "fixture-secret", "rpc_request_id": 999},
        )

    entry = tail("rpc-redaction-fixture")["lines"][0]
    assert entry["meta"]["rpc_request_id"] == 44
    assert "fixture-secret" not in str(entry["meta"])
    assert "REDACTED" in str(entry["meta"])


def test_export_snapshot_preserves_request_id_and_redacts_source_log():
    from strands_backend.diagnostics import export_snapshot

    session_id = "rpc-export-fixture"
    with agent_request_scope(45):
        assert log_event(
            session_id,
            "tool_call",
            "fixture",
            meta={"password": "export-fixture-secret", "rpc_request_id": 999},
        )

    source_log = tail(session_id)["lines"][0]
    output_path = Path(
        export_snapshot(
            session_id,
            {
                "schema_version": 1,
                "session_id": session_id,
                "sources": [source_log],
            },
        )["path"]
    )
    exported = json.loads(output_path.read_text(encoding="utf-8"))
    source_meta = exported["sources"][0]["meta"]

    assert source_meta["rpc_request_id"] == 45
    assert source_meta["password"] == "<REDACTED>"
    assert "export-fixture-secret" not in output_path.read_text(encoding="utf-8")


@pytest.mark.parametrize("request_id", [0, (1 << 63) - 1])
def test_scope_accepts_wire_integer_bounds(request_id):
    with agent_request_scope(request_id):
        assert current_agent_request_id() == request_id
    assert current_agent_request_id() is None


@pytest.mark.parametrize("request_id", [True, False, -1, 1 << 63, "41", 41.0, None])
def test_scope_masks_invalid_or_missing_request_ids(request_id):
    with agent_request_scope(request_id):
        assert current_agent_request_id() is None


def test_metadata_is_shallow_copied_and_reserved_id_cannot_be_forged():
    nested = {"kept": True}
    original = {"status": "started", "nested": nested, "rpc_request_id": 999}

    with agent_request_scope(41):
        copied = with_agent_request_id(original)

    assert copied == {"status": "started", "nested": nested, "rpc_request_id": 41}
    assert copied is not original
    assert copied["nested"] is nested
    assert original["rpc_request_id"] == 999

    without_scope = with_agent_request_id(original)
    assert "rpc_request_id" not in without_scope
    assert original["rpc_request_id"] == 999


def test_nested_and_exception_scopes_restore_the_outer_request():
    with agent_request_scope(12):
        with pytest.raises(RuntimeError, match="fixture"):
            with agent_request_scope(34):
                assert current_agent_request_id() == 34
                raise RuntimeError("fixture")
        assert current_agent_request_id() == 12
    assert current_agent_request_id() is None


def test_sync_dispatch_masks_non_agent_calls_and_restores_scope():
    dispatcher = main.MethodDispatcher()
    observed = []
    dispatcher.register("fixture.fast", lambda: observed.append(current_agent_request_id()))
    dispatcher.register("agent.invoke", lambda: observed.append(current_agent_request_id()))

    with agent_request_scope(7):
        main._dispatch_request(dispatcher, "fixture.fast", {}, 8)
        assert current_agent_request_id() == 7
        main._dispatch_request(dispatcher, "agent.invoke", {}, 9)
        assert current_agent_request_id() == 7

    assert observed == [None, 9]
    assert current_agent_request_id() is None


def test_sync_dispatch_exception_cleans_its_request_scope():
    dispatcher = main.MethodDispatcher()

    def fail():
        assert current_agent_request_id() == 21
        raise RuntimeError("fixture dispatch failure")

    dispatcher.register("agent.invoke", fail)
    with pytest.raises(RuntimeError, match="fixture dispatch failure"):
        main._dispatch_request(dispatcher, "agent.invoke", {}, 21)
    assert current_agent_request_id() is None


def test_slow_dispatch_exception_sends_error_and_cleans_its_scope(monkeypatch):
    messages = []
    monkeypatch.setattr(main, "write_message", messages.append)
    dispatcher = main.MethodDispatcher()

    def fail():
        assert current_agent_request_id() == 22
        raise RuntimeError("fixture async failure")

    dispatcher.register("agent.invoke", fail)
    main._dispatch_in_executor(
        dispatcher, "agent.invoke", {}, 22, is_notification=False
    )

    assert messages[0]["error"]["message"] == "fixture async failure"
    assert messages[0]["id"] == 22
    assert current_agent_request_id() is None


@pytest.mark.parametrize("request_id", ["41", True, -1])
def test_invalid_id_does_not_reject_handler_or_change_response_id(
    request_id, tmp_path, monkeypatch
):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    messages = []
    monkeypatch.setattr(main, "write_message", messages.append)
    params = {"input": "fixture", "state": {"rpc_request_id": 999}}
    received = []
    dispatcher = main.MethodDispatcher()

    def handler(input, state):
        received.append((input, state, current_agent_request_id()))
        main.send_notification("agent.progress", {"rpc_request_id": 888})
        assert log_event(
            "rpc-invalid-id-fixture",
            "tool_call",
            "fixture",
            meta={"rpc_request_id": 777},
        )
        return {"accepted": True}

    dispatcher.register("agent.invoke", handler)
    main._dispatch_in_executor(
        dispatcher, "agent.invoke", params, request_id, is_notification=False
    )

    assert received == [("fixture", params["state"], None)]
    assert params == {"input": "fixture", "state": {"rpc_request_id": 999}}
    assert messages[-1] == {
        "jsonrpc": main.JSONRPC_VERSION,
        "result": {"accepted": True},
        "id": request_id,
    }
    assert "rpc_request_id" not in messages[0]["params"]
    assert "rpc_request_id" not in tail("rpc-invalid-id-fixture")["lines"][0]["meta"]


def test_reused_worker_thread_gets_each_dispatch_id_without_leakage():
    dispatcher = main.MethodDispatcher()
    calls = []

    def invoke(session_id):
        request_id = current_agent_request_id()
        calls.append((session_id, request_id, threading.get_ident()))
        if request_id == 101:
            raise RuntimeError("fixture worker failure")
        return request_id

    dispatcher.register("agent.invoke", invoke)
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        first = executor.submit(main._dispatch_request, dispatcher, "agent.invoke", {"session_id": "same"}, 101)
        second = executor.submit(main._dispatch_request, dispatcher, "agent.invoke", {"session_id": "same"}, 202)
        with pytest.raises(RuntimeError, match="fixture worker failure"):
            first.result(timeout=2)
        assert second.result(timeout=2) == 202
    finally:
        executor.shutdown(wait=True, cancel_futures=True)

    assert [call[:2] for call in calls] == [("same", 101), ("same", 202)]
    assert calls[0][2] == calls[1][2]


def test_concurrent_same_session_dispatches_keep_distinct_request_ids(monkeypatch):
    barrier = threading.Barrier(2)
    dispatcher = main.MethodDispatcher()
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)

    def invoke(session_id):
        barrier.wait(timeout=2)
        main.send_notification("agent.progress", {"session_id": session_id})
        assert log_event(
            "rpc-concurrent-fixture",
            "tool_call",
            "fixture",
            meta={"session_id": session_id},
        )
        return session_id, current_agent_request_id()

    dispatcher.register("agent.invoke", invoke)
    executor = ThreadPoolExecutor(max_workers=2)
    futures = []
    try:
        futures = [
            executor.submit(main._dispatch_request, dispatcher, "agent.invoke", {"session_id": "same"}, request_id)
            for request_id in (301, 302)
        ]
        assert {future.result(timeout=3) for future in futures} == {
            ("same", 301),
            ("same", 302),
        }
    finally:
        barrier.abort()
        executor.shutdown(wait=True, cancel_futures=True)

    assert {message["params"]["rpc_request_id"] for message in notifications} == {
        301,
        302,
    }
    log_rows = tail("rpc-concurrent-fixture")["lines"]
    assert {row["meta"]["rpc_request_id"] for row in log_rows} == {301, 302}


def test_copied_worker_context_becomes_inactive_after_scope_exit():
    ready = threading.Event()
    release = threading.Event()
    observed = []
    worker_context = None

    def worker():
        ready.set()
        if not release.wait(timeout=3):
            raise AssertionError("fixture worker was not released")
        observed.append(current_agent_request_id())

    thread = None
    try:
        with agent_request_scope(401):
            worker_context = copy_context()
            thread = threading.Thread(target=worker_context.run, args=(worker,))
            thread.start()
            assert ready.wait(timeout=2)
            assert current_agent_request_id() == 401

        with agent_request_scope(402):
            assert current_agent_request_id() == 402
            release.set()
            thread.join(timeout=2)
            assert not thread.is_alive(), "fixture worker did not exit"
            assert observed == [None]
            assert current_agent_request_id() == 402
    finally:
        release.set()
        if thread is not None:
            thread.join(timeout=2)
            assert not thread.is_alive(), "fixture worker leaked"


def test_sync_and_slow_dispatch_paths_both_call_shared_request_wrapper():
    tree = ast.parse(Path(main.__file__).read_text(encoding="utf-8"))
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    def called_names(node):
        return {
            call.func.id
            for call in ast.walk(node)
            if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
        }

    def direct_dispatch_calls(node):
        return [
            call
            for call in ast.walk(node)
            if isinstance(call, ast.Call)
            and isinstance(call.func, ast.Attribute)
            and call.func.attr == "dispatch"
        ]

    assert "_dispatch_request" in called_names(functions["_dispatch_in_executor"])
    assert "_dispatch_request" in called_names(functions["main"])
    assert not direct_dispatch_calls(functions["main"])
