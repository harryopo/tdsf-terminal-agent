from __future__ import annotations

from contextvars import copy_context
from importlib.metadata import version
from unittest.mock import MagicMock

import main
import pytest
from strands._async import run_async
from strands_backend.adapter import StrandsAgentAdapter
from strands_backend.tools import tool


@pytest.fixture(autouse=True)
def _isolate_identity_side_effects(tmp_path, monkeypatch):
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()


class _Handler:
    def __init__(self) -> None:
        self._stats = {"events_received": 0}

    def begin_turn(self, **_kwargs) -> None:
        pass


class _SdkToolAgent:
    """Fake only the model boundary; execute the real Strands tool stream."""

    def __init__(self, sdk_tool) -> None:
        self.callback_handler = _Handler()
        self.messages: list = []
        self.sdk_tool = sdk_tool

    def __call__(self, _prompt: str) -> str:
        async def run_tool():
            return [
                event
                async for event in self.sdk_tool.stream(
                    {"toolUseId": "stream-identity-tool", "name": "stream_identity_probe", "input": {}},
                    {},
                )
            ]

        assert run_async(run_tool)
        return "fixture tool completed"


def _dispatcher(handler, method="agent.invoke"):
    dispatcher = main.MethodDispatcher()
    dispatcher.register(method, handler)
    return dispatcher


def test_agent_invoke_copies_and_strips_stream_tag_but_notifies_with_real_rpc_identity(monkeypatch):
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    stream_id = "a12bcdef-1234-4abc-8abc-1234567890ab"
    nested = {"retained": True}
    params = {
        "input": "fixture",
        "state": {"session_id": "chat-a", "_rpc_stream_id": stream_id, "nested": nested},
    }
    received = {}

    def handler(input, state):
        received.update(input=input, state=state)
        main.send_notification("agent.progress", {"phase": "working", "rpc_stream_id": "forged"})
        return {"observation": "done"}

    result = main._dispatch_request(_dispatcher(handler), "agent.invoke", params, 41)

    assert result == {"observation": "done"}
    assert received["input"] == "fixture"
    assert received["state"] == {"session_id": "chat-a", "nested": nested}
    assert received["state"] is not params["state"]
    assert received["state"]["nested"] is nested
    assert params["state"]["_rpc_stream_id"] == stream_id
    assert notifications == [
        {
            "jsonrpc": main.JSONRPC_VERSION,
            "method": "agent.progress",
            "params": {
                "phase": "working",
                "rpc_request_id": 41,
                "rpc_stream_id": stream_id,
            },
        }
    ]


def test_agent_invoke_without_stream_tag_preserves_original_params_and_state_identity(monkeypatch):
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    params = {"input": "fixture", "state": {"session_id": "chat-no-tag"}}
    received = []

    def handler(input, state):
        received.append((input, state))
        main.send_notification("agent.progress", {"phase": "working"})

    dispatcher = _dispatcher(handler)
    dispatched_params = []
    original_dispatch = dispatcher.dispatch

    def observe_dispatch(method, received_params):
        dispatched_params.append(received_params)
        return original_dispatch(method, received_params)

    monkeypatch.setattr(dispatcher, "dispatch", observe_dispatch)
    main._dispatch_request(dispatcher, "agent.invoke", params, 52)

    assert received == [("fixture", params["state"])]
    assert received[0][1] is params["state"]
    assert dispatched_params == [params]
    assert dispatched_params[0] is params
    assert notifications[0]["params"] == {
        "phase": "working", "rpc_request_id": 52,
    }
    assert params == {"input": "fixture", "state": {"session_id": "chat-no-tag"}}


@pytest.mark.parametrize(
    ("request_id", "state_tag"),
    [
        (61, "not-a-uuid"),
        (61, "A12BCDEF-1234-4ABC-8ABC-1234567890AB"),
        (61, "{a12bcdef-1234-4abc-8abc-1234567890ab}"),
        (61, 42),
        (True, "a12bcdef-1234-4abc-8abc-1234567890ab"),
        ("61", "a12bcdef-1234-4abc-8abc-1234567890ab"),
        (61.0, "a12bcdef-1234-4abc-8abc-1234567890ab"),
        (-1, "a12bcdef-1234-4abc-8abc-1234567890ab"),
        (None, "a12bcdef-1234-4abc-8abc-1234567890ab"),
    ],
)
def test_invalid_or_unrelated_stream_provenance_is_not_forwarded(
    monkeypatch, request_id, state_tag
):
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    params = {"input": "fixture", "state": {"_rpc_stream_id": state_tag}}
    received = []

    def handler(input, state):
        received.append((input, state))
        main.send_notification(
            "agent.progress",
            {"rpc_request_id": 999, "rpc_stream_id": "forged", "phase": "working"},
        )

    main._dispatch_request(_dispatcher(handler), "agent.invoke", params, request_id)

    sent_params = notifications[0]["params"]
    assert "rpc_stream_id" not in sent_params
    if type(request_id) is not int or request_id < 0:
        assert "rpc_request_id" not in sent_params
    else:
        assert sent_params["rpc_request_id"] == request_id
    assert len(received) == 1
    assert "_rpc_stream_id" not in received[0][1]
    assert params["state"]["_rpc_stream_id"] == state_tag


def test_non_agent_dispatch_masks_forged_tag_and_restores_enclosing_agent_scope(monkeypatch):
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    outer_tag = "a12bcdef-1234-4abc-8abc-1234567890ab"
    fast_params = {"state": {"_rpc_stream_id": "must-not-be-extracted"}}
    seen_fast_params = []
    dispatcher = main.MethodDispatcher()

    def fast(state):
        seen_fast_params.append(state)
        main.send_notification(
            "fixture.fast.progress",
            {"rpc_request_id": 900, "rpc_stream_id": "forged"},
        )

    def agent(input, state):
        main._dispatch_request(dispatcher, "fixture.fast", fast_params, None)
        main.send_notification("agent.progress", {"phase": "after nested call"})

    dispatcher.register("fixture.fast", fast)
    dispatcher.register("agent.invoke", agent)
    params = {"input": "fixture", "state": {"_rpc_stream_id": outer_tag}}

    main._dispatch_request(dispatcher, "agent.invoke", params, 63)

    assert seen_fast_params == [fast_params["state"]]
    assert seen_fast_params[0] is fast_params["state"]
    assert "rpc_request_id" not in notifications[0]["params"]
    assert "rpc_stream_id" not in notifications[0]["params"]
    assert notifications[1]["params"] == {
        "phase": "after nested call",
        "rpc_request_id": 63,
        "rpc_stream_id": outer_tag,
    }


def test_exception_and_copied_context_do_not_keep_stream_identity_active(monkeypatch):
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    copied = None

    def fail(input, state):
        nonlocal copied
        copied = copy_context()
        raise RuntimeError("fixture dispatch failure")

    params = {
        "input": "fixture",
        "state": {"_rpc_stream_id": "a12bcdef-1234-4abc-8abc-1234567890ab"},
    }
    with pytest.raises(RuntimeError, match="fixture dispatch failure"):
        main._dispatch_request(_dispatcher(fail), "agent.invoke", params, 71)

    assert copied is not None
    copied.run(
        main.send_notification,
        "agent.progress",
        {"rpc_request_id": 999, "rpc_stream_id": "forged"},
    )
    assert "rpc_request_id" not in notifications[0]["params"]
    assert "rpc_stream_id" not in notifications[0]["params"]


def test_copied_context_has_identity_during_dispatch_then_becomes_inactive(monkeypatch):
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    copied = None
    stream_id = "b23bcdef-1234-4abc-8abc-1234567890ab"

    def handler(input, state):
        nonlocal copied
        copied = copy_context()
        copied.run(
            main.send_notification,
            "agent.progress",
            {"rpc_stream_id": "forged", "phase": "inside"},
        )

    main._dispatch_request(
        _dispatcher(handler),
        "agent.invoke",
        {"input": "fixture", "state": {"_rpc_stream_id": stream_id}},
        72,
    )
    assert copied is not None
    copied.run(
        main.send_notification,
        "agent.progress",
        {"rpc_stream_id": "forged", "phase": "after"},
    )

    assert notifications[0]["params"] == {
        "phase": "inside", "rpc_request_id": 72, "rpc_stream_id": stream_id,
    }
    assert notifications[1]["params"] == {"phase": "after"}


def test_stream_identity_reaches_real_strands_tool_worker(monkeypatch):
    assert version("strands-agents") == "1.53.0"
    notifications = []
    monkeypatch.setattr(main, "write_message", notifications.append)
    @tool
    def stream_identity_probe() -> int:
        """Emit one local notification from a real Strands tool worker."""
        main.send_notification(
            "agent.progress",
            {"rpc_request_id": 999, "rpc_stream_id": "forged", "phase": "tool"},
        )
        return 1

    agent = _SdkToolAgent(stream_identity_probe)
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), backend_enabled=True, strands_model=MagicMock()
    )
    adapter._get_or_create_agent = lambda *_args, **_kwargs: agent
    dispatcher = _dispatcher(
        lambda input, state: adapter.invoke("main", input, state)
    )
    stream_id = "c34bcdef-1234-4abc-8abc-1234567890ab"
    params = {
        "input": "run local fixture tool",
        "state": {
            "session_id": "chat-worker",
            "_rpc_stream_id": stream_id,
            "mode": "observe",
            "live": {"agentMode": "observe", "teach": False},
        },
    }

    result = main._dispatch_request(dispatcher, "agent.invoke", params, 81)

    assert result["observation"] == "fixture tool completed"
    assert notifications == [
        {
            "jsonrpc": main.JSONRPC_VERSION,
            "method": "agent.progress",
            "params": {
                "rpc_request_id": 81,
                "rpc_stream_id": stream_id,
                "phase": "tool",
            },
        }
    ]
