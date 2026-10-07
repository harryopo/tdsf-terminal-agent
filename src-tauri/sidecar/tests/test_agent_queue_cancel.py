"""JSON-RPC cancellation must cover agent.invoke while it waits in the pool."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_agent_state(tmp_path, monkeypatch):
    import fix_loop
    import needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log
    from agent_facade import reset_for_test as reset_facade

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    fix_loop.reset_for_test()
    reset_facade()
    needs_you.reset_for_test()
    reset_agent_log()
    yield
    reset_facade()
    needs_you.reset_for_test()
    reset_agent_log()
    fix_loop.reset_for_test()


class _FakeAgent:
    """No-network model boundary that still exercises the adapter's real hook."""

    callback_handler = None

    def __init__(self, adapter, session_id, model_calls, tool_calls):
        self.adapter = adapter
        self.session_id = session_id
        self.model_calls = model_calls
        self.tool_calls = tool_calls
        self.messages = []

    def __call__(self, prompt):
        self.model_calls.append((self.session_id, prompt))
        from rpc_request_context import current_agent_request_id

        request_ids = getattr(self.adapter, "_test_rpc_ids", None)
        if request_ids is not None:
            request_ids.append((self.session_id, current_agent_request_id()))
        hook = self.adapter._limit_hooks[("main", self.session_id)]
        event = SimpleNamespace(tool_use={"name": "probe_tool"}, cancel_tool=False)
        hook._before_tool_call(event)
        if not event.cancel_tool:
            self.tool_calls.append(self.session_id)
        return "完成"


def _shutdown_executor(executor, *futures):
    """Always shut down the pool, even if a worker Future reports an error."""
    try:
        for future in futures:
            if future is not None and not future.cancelled():
                future.result(timeout=5)
    finally:
        executor.shutdown(wait=True, cancel_futures=True)


@pytest.mark.parametrize("use_list_params", [False, True], ids=["dict", "list"])
def test_cancel_agent_invoke_while_queued_in_main_executor(monkeypatch, use_list_params):
    """A queued invoke is cancellable before it can reach its model or tool."""
    import agent_facade
    import main

    from strands_backend.adapter import StrandsAgentAdapter

    strands_adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=object()
    )
    model_calls = []
    tool_calls = []

    def get_or_create(_agent_id, ctx, **_kwargs):
        strands_adapter._get_limit_hook("main", ctx.session_id)
        return _FakeAgent(strands_adapter, ctx.session_id, model_calls, tool_calls)

    monkeypatch.setattr(strands_adapter, "_get_or_create_agent", get_or_create)
    agent_facade.set_strands_adapter(strands_adapter)
    agent_facade.set_backend(strands_adapter.invoke)

    dispatcher = main.MethodDispatcher()
    agent_facade.register_methods(dispatcher)
    executor = ThreadPoolExecutor(max_workers=2)
    release_workers = threading.Event()
    workers_started = [threading.Event(), threading.Event()]
    response_sent = threading.Event()
    responses = []

    def occupy_worker(started):
        started.set()
        assert release_workers.wait(5), "test did not release executor barrier"

    def capture_response(result, req_id):
        responses.append((result, req_id))
        response_sent.set()

    monkeypatch.setattr(main, "send_response", capture_response)
    monkeypatch.setattr(main, "_main_executor", executor)

    blockers = [
        executor.submit(occupy_worker, started) for started in workers_started
    ]
    future = None
    try:
        assert all(event.wait(3) for event in workers_started), (
            "both executor workers must be occupied before submitting agent.invoke"
        )

        state = {"session_id": "queue-s1", "input": "首轮"}
        invoke_params = ["main", state] if use_list_params else {"name": "main", "state": state}
        cancel_params = ["queue-s1", "用户点击停止"] if use_list_params else {
            "session_id": "queue-s1", "reason": "用户点击停止",
        }
        future = main._submit_slow_request(
            dispatcher,
            "agent.invoke",
            invoke_params,
            701,
            False,
        )
        assert not future.running(), "agent.invoke started despite both workers being occupied"
        assert not future.done(), "agent.invoke completed despite both workers being occupied"
        cancelled = dispatcher.dispatch("agent.cancel", cancel_params)

        assert cancelled["cancelled"] is True, (
            "agent.cancel did not see the agent.invoke request queued in the real pool"
        )
        assert model_calls == [], "queued invoke reached the model before workers were released"
        assert tool_calls == [], "queued invoke executed a tool before workers were released"

        release_workers.set()
        assert response_sent.wait(5), "queued invoke did not send its original RPC response"
        future.result(timeout=5)
        assert "queue-s1" not in strands_adapter._invocations
        assert responses[0][1] == 701, "queued invoke response lost its original RPC id"
        result = responses[0][0]
        assert "已停止" in result["observation"], (
            "cancelled queued invoke did not return the adapter's stopped response"
        )
        assert model_calls == [], "cancelled queued invoke still called the model"
        assert tool_calls == [], "cancelled queued invoke still executed a tool"

        other = dispatcher.dispatch(
            "agent.invoke", {"name": "main", "state": {"session_id": "queue-s2", "input": "正常"}}
        )
        assert other["next_step"] == "done"
        assert [sid for sid, _ in model_calls] == ["queue-s2"]
        assert tool_calls == ["queue-s2"]

        resumed = dispatcher.dispatch(
            "agent.invoke", {"name": "main", "state": {"session_id": "queue-s1", "input": "新一轮"}}
        )
        assert resumed["next_step"] == "done"
        assert [sid for sid, _ in model_calls] == ["queue-s2", "queue-s1"]
        assert tool_calls == ["queue-s2", "queue-s1"]
    finally:
        release_workers.set()
        _shutdown_executor(executor, *blockers, future)


def _configured_runtime(monkeypatch):
    import agent_facade
    import main
    from strands_backend.adapter import StrandsAgentAdapter

    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=object()
    )
    model_calls = []
    tool_calls = []

    def get_or_create(_agent_id, ctx, **_kwargs):
        adapter._get_limit_hook("main", ctx.session_id)
        return _FakeAgent(adapter, ctx.session_id, model_calls, tool_calls)

    adapter._test_rpc_ids = []
    monkeypatch.setattr(adapter, "_get_or_create_agent", get_or_create)
    agent_facade.set_strands_adapter(adapter)
    agent_facade.set_backend(adapter.invoke)
    dispatcher = main.MethodDispatcher()
    agent_facade.register_methods(dispatcher)
    return main, adapter, dispatcher, model_calls, tool_calls


def test_cancel_two_queued_calls_preserves_other_session_and_new_queued_turn(monkeypatch):
    main, adapter, dispatcher, model_calls, tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=2)
    monkeypatch.setattr(main, "_main_executor", executor)
    release = threading.Event()
    started = [threading.Event(), threading.Event()]
    responses = []
    monkeypatch.setattr(main, "send_response", lambda result, req_id: responses.append((result, req_id)))
    blockers = [
        executor.submit(lambda event=event: (event.set(), release.wait(5)))
        for event in started
    ]
    queued = []
    resumed = None
    try:
        assert all(event.wait(3) for event in started), "pool workers did not enter barriers"
        requests = [
            ("queue-multi-s1", "first", 721),
            ("queue-multi-s1", "second", 722),
            ("queue-multi-s2", "other", 723),
        ]
        for session_id, prompt, req_id in requests:
            queued.append(main._submit_slow_request(
                dispatcher, "agent.invoke",
                {"name": "main", "state": {"session_id": session_id, "input": prompt}},
                req_id, False,
            ))
        assert len(adapter._invocations["queue-multi-s1"]) == 2
        assert dispatcher.dispatch(
            "agent.cancel", {"session_id": "queue-multi-s1", "reason": "停止两轮"}
        )["cancelled"] is True
        assert model_calls == [] and tool_calls == []
        release.set()
        for future in queued:
            future.result(timeout=5)
        by_id = {req_id: result for result, req_id in responses}
        assert set(by_id) == {721, 722, 723}
        assert all("已停止" in by_id[req_id]["observation"] for req_id in (721, 722))
        assert by_id[723]["next_step"] == "done"
        assert [sid for sid, _ in model_calls] == ["queue-multi-s2"]
        assert tool_calls == ["queue-multi-s2"]
        assert adapter._test_rpc_ids == [("queue-multi-s2", 723)]
        assert "queue-multi-s1" not in adapter._invocations

        release.clear()
        new_started = [threading.Event(), threading.Event()]
        new_blockers = [
            executor.submit(lambda event=event: (event.set(), release.wait(5)))
            for event in new_started
        ]
        blockers.extend(new_blockers)
        assert all(event.wait(3) for event in new_started), "pool did not re-enter barriers"
        resumed = main._submit_slow_request(
            dispatcher, "agent.invoke",
            {"name": "main", "state": {"session_id": "queue-multi-s1", "input": "新回合"}},
            724, False,
        )
        assert not resumed.running() and not resumed.done()
        release.set()
        resumed.result(timeout=5)
        assert any(req_id == 724 for _result, req_id in responses)
        assert [sid for sid, _ in model_calls] == ["queue-multi-s2", "queue-multi-s1"]
        assert tool_calls == ["queue-multi-s2", "queue-multi-s1"]
        assert adapter._test_rpc_ids == [
            ("queue-multi-s2", 723), ("queue-multi-s1", 724),
        ]
        from rpc_request_context import current_agent_request_id

        assert current_agent_request_id() is None, "worker RPC scope leaked into the test thread"
        assert "queue-multi-s1" not in adapter._invocations
    finally:
        release.set()
        _shutdown_executor(executor, *blockers, *queued, resumed)


def test_cancel_after_future_starts_before_dispatch_still_stops_model(monkeypatch):
    main, adapter, dispatcher, model_calls, tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main, "_main_executor", executor)
    entered = threading.Event()
    release = threading.Event()
    responses = []
    response_sent = threading.Event()
    original = main._dispatch_in_executor

    def wait_before_dispatch(*args):
        entered.set()
        assert release.wait(5), "test did not release dispatch barrier"
        return original(*args)

    monkeypatch.setattr(main, "_dispatch_in_executor", wait_before_dispatch)
    monkeypatch.setattr(main, "send_response", lambda result, req_id: (responses.append((result, req_id)), response_sent.set()))
    future = None
    try:
        future = main._submit_slow_request(
            dispatcher, "agent.invoke",
            {"name": "main", "state": {"session_id": "running-s1", "input": "检查"}},
            725, False,
        )
        assert entered.wait(3), "worker did not enter the before-dispatch barrier"
        assert future.running(), "the test barrier was reached without a running Future"
        assert dispatcher.dispatch(
            "agent.cancel", {"session_id": "running-s1", "reason": "停止"}
        )["cancelled"] is True
        release.set()
        assert response_sent.wait(5), "cancelled running call did not respond"
        future.result(timeout=5)
        assert responses[0][1] == 725
        assert "已停止" in responses[0][0]["observation"]
        assert model_calls == [] and tool_calls == []
        assert "running-s1" not in adapter._invocations
    finally:
        release.set()
        _shutdown_executor(executor, future)


@pytest.mark.parametrize("cancel_by_shutdown", [False, True], ids=["future-cancel", "shutdown"])
def test_cancelled_future_cleanup_releases_registration(monkeypatch, cancel_by_shutdown):
    main, adapter, dispatcher, _model_calls, _tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main, "_main_executor", executor)
    entered = threading.Event()
    release = threading.Event()
    blocker = executor.submit(lambda: (entered.set(), release.wait(5)))
    future = None
    try:
        assert entered.wait(3), "executor worker did not reach the blocker"
        future = main._submit_slow_request(
            dispatcher, "agent.invoke",
            {"name": "main", "state": {"session_id": "cleanup-s1", "input": "排队"}},
            731, False,
        )
        assert adapter._invocations.get("cleanup-s1"), "queued invocation was not registered"
        if cancel_by_shutdown:
            executor.shutdown(wait=False, cancel_futures=True)
            assert future.cancelled(), "shutdown did not cancel the queued Future"
        else:
            assert future.cancel(), "Future.cancel() failed for a genuinely queued request"
        assert "cleanup-s1" not in adapter._invocations
    finally:
        release.set()
        _shutdown_executor(executor, blocker, future)


def test_submit_failure_releases_registration(monkeypatch):
    main, adapter, dispatcher, _model_calls, _tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=1)
    executor.shutdown(wait=True)
    monkeypatch.setattr(main, "_main_executor", executor)
    with pytest.raises(RuntimeError, match="shutdown"):
        main._submit_slow_request(
            dispatcher, "agent.invoke",
            {"name": "main", "state": {"session_id": "submit-fail-s1", "input": "提交失败"}},
            732, False,
        )
    assert "submit-fail-s1" not in adapter._invocations


def test_dispatch_exception_keeps_rpc_error_and_releases_registration(monkeypatch):
    main, adapter, dispatcher, _model_calls, _tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main, "_main_executor", executor)
    errors = []
    sent = threading.Event()
    monkeypatch.setattr(
        main, "send_error",
        lambda code, message, req_id, data=None: (errors.append((code, message, req_id, data)), sent.set()),
    )
    dispatcher.register(
        "agent.invoke",
        lambda **_kwargs: (_ for _ in ()).throw(ValueError("dispatcher boom")),
    )
    future = None
    try:
        future = main._submit_slow_request(
            dispatcher, "agent.invoke",
            {"name": "main", "state": {"session_id": "dispatch-error-s1", "input": "错误"}},
            733, False,
        )
        assert sent.wait(5), "dispatcher exception did not reach JSON-RPC error handler"
        future.result(timeout=5)
        assert errors[0][:3] == (main.ERR_INTERNAL_ERROR, "dispatcher boom", 733)
        assert "dispatch-error-s1" not in adapter._invocations
    finally:
        _shutdown_executor(executor, future)


def test_notification_cancel_has_no_response_and_releases_registration(monkeypatch):
    main, adapter, dispatcher, model_calls, tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main, "_main_executor", executor)
    entered = threading.Event()
    release = threading.Event()
    blocker = executor.submit(lambda: (entered.set(), release.wait(5)))
    responses = []
    monkeypatch.setattr(main, "send_response", lambda result, req_id: responses.append((result, req_id)))
    future = None
    try:
        assert entered.wait(3), "executor worker did not reach the blocker"
        future = main._submit_slow_request(
            dispatcher, "agent.invoke",
            {"name": "main", "state": {"session_id": "notification-s1", "input": "通知"}},
            None, True,
        )
        assert adapter._invocations.get("notification-s1")
        assert dispatcher.dispatch(
            "agent.cancel", {"session_id": "notification-s1", "reason": "停止"}
        )["cancelled"] is True
        release.set()
        future.result(timeout=5)
        assert responses == [], "JSON-RPC notification unexpectedly received a response"
        assert model_calls == [] and tool_calls == []
        assert "notification-s1" not in adapter._invocations
    finally:
        release.set()
        _shutdown_executor(executor, blocker, future)


@pytest.mark.parametrize(
    "params,expected_error",
    [
        ({"name": "main", "state": {"session_id": "invalid-extra-s1", "input": "x"}, "extra": 1}, True),
        ({"name": "unknown", "state": {"session_id": "invalid-name-s1", "input": "x"}}, True),
        ({"name": "main", "state": "not-a-dict"}, True),
        ({"name": "main", "state": {"input": "no session"}}, False),
    ],
    ids=["extra-param", "unknown-agent", "bad-state", "missing-session"],
)
def test_invalid_or_unscoped_agent_params_do_not_register_cancel_state(
    monkeypatch, params, expected_error
):
    main, adapter, dispatcher, _model_calls, _tool_calls = _configured_runtime(monkeypatch)
    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main, "_main_executor", executor)
    entered = threading.Event()
    release = threading.Event()
    blocker = executor.submit(lambda: (entered.set(), release.wait(5)))
    errors = []
    sent = threading.Event()
    responses = []
    model_calls = []
    tool_calls = []
    monkeypatch.setattr(
        adapter, "_get_or_create_agent",
        lambda _agent_id, ctx, **_kwargs: (
            adapter._get_limit_hook("main", ctx.session_id),
            _FakeAgent(adapter, ctx.session_id, model_calls, tool_calls),
        )[1],
    )
    monkeypatch.setattr(
        main, "send_error",
        lambda code, message, req_id, data=None: (errors.append((code, message, req_id)), sent.set()),
    )
    monkeypatch.setattr(main, "send_response", lambda result, req_id: responses.append((result, req_id)))
    future = None
    try:
        assert entered.wait(3), "executor worker did not reach the blocker"
        future = main._submit_slow_request(dispatcher, "agent.invoke", params, 734, False)
        assert adapter._invocations == {}, "malformed/unscoped params created a cancel registration"
        release.set()
        if expected_error:
            assert sent.wait(5), "malformed request did not preserve dispatcher error handling"
        future.result(timeout=5)
        if expected_error:
            assert errors and errors[0] == (main.ERR_INTERNAL_ERROR, errors[0][1], 734)
            assert responses == []
            assert model_calls == [] and tool_calls == []
        else:
            assert errors == []
            assert responses and responses[0][1] == 734
            assert responses[0][0]["next_step"] == "done"
            assert [sid for sid, _ in model_calls] == [""]
            assert tool_calls == [""]
        assert adapter._invocations == {}
    finally:
        release.set()
        _shutdown_executor(executor, blocker, future)


def test_main_routes_only_slow_methods_to_pool_and_ping_stays_fast(monkeypatch):
    import ast
    import inspect

    main, _adapter, dispatcher, _model_calls, _tool_calls = _configured_runtime(monkeypatch)
    source = inspect.getsource(main.main)
    tree = ast.parse(source)
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_submit_slow_request"
    ]
    assert len(calls) == 1, "main loop no longer has one slow-method submission point"
    assert "ping" not in main._slow_methods
    assert any(
        isinstance(node, ast.If)
        and any(isinstance(child, ast.Call) and child in calls for child in ast.walk(node))
        and {"_main_executor", "_slow_methods", "method"}.issubset(
            {item.id for item in ast.walk(node.test) if isinstance(item, ast.Name)}
        )
        for node in ast.walk(tree)
    ), "slow executor submission is no longer guarded by the slow-method branch"

    executor = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(main, "_main_executor", executor)
    entered = threading.Event()
    release = threading.Event()
    blocker = executor.submit(lambda: (entered.set(), release.wait(5)))
    try:
        assert entered.wait(3), "executor worker did not reach the blocker"
        ping = main._dispatch_request(dispatcher, "ping", None, 736)
        assert ping["alive"] is True, "fast ping waited for a saturated slow-method executor"
    finally:
        release.set()
        _shutdown_executor(executor, blocker)
