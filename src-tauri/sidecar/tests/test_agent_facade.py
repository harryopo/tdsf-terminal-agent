"""Contract tests for the Strands-only agent RPC facade."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parents[1]))

import agent_facade as facade


class FakeDispatcher:
    def __init__(self) -> None:
        self.methods: dict[str, object] = {}

    def register(self, name: str, handler: object) -> None:
        self.methods[name] = handler

    def dispatch(self, name: str, params: dict | None = None) -> object:
        handler = self.methods[name]
        assert callable(handler)
        if params is None:
            return handler()
        return handler(**params)


@pytest.fixture(autouse=True)
def clean_backend() -> None:
    facade.reset_for_test()
    yield
    facade.reset_for_test()


def test_metadata_exposes_only_main() -> None:
    assert facade.list_agents() == ["main"]


def test_invoke_without_backend_is_fail_closed() -> None:
    with pytest.raises(RuntimeError):
        facade.invoke_agent("main", {"input": "hello"})


def test_unknown_agent_is_rejected() -> None:
    with pytest.raises(KeyError):
        facade.invoke_agent("coding", {"input": "hello"})


def test_set_backend_requires_callable_and_forwards_arguments() -> None:
    with pytest.raises(TypeError):
        facade.set_backend(None)  # type: ignore[arg-type]

    calls: list[tuple[str, str, dict]] = []

    def backend(agent_id: str, input: str, state: dict) -> dict:
        calls.append((agent_id, input, state))
        return {"ok": True}

    facade.set_backend(backend)
    state = {"input": "ls", "session_id": "s1"}
    assert facade.invoke_agent("main", state) == {"ok": True}
    assert calls == [("main", "ls", state)]


def test_set_backend_unavailable_is_fail_closed() -> None:
    facade.set_backend_unavailable("backend missing")
    with pytest.raises(RuntimeError, match="backend missing"):
        facade.invoke_agent("main", {"input": "hello"})


def test_registers_five_rpcs_and_dispatches_list_info_invoke() -> None:
    dispatcher = FakeDispatcher()
    facade.set_backend(lambda agent_id, input, state: {"agent": agent_id, "input": input})
    facade.register_methods(dispatcher)

    assert set(dispatcher.methods) == {
        "agent.invoke",
        "agent.cancel",
        "agent.list",
        "agent.info",
        "agent.configure",
    }
    listed = dispatcher.dispatch("agent.list")
    assert listed["agents"] == [{"name": "main", "class": "StrandsAgentAdapter"}]
    info = dispatcher.dispatch("agent.info", {"name": "main"})
    assert info["name"] == "main"
    invoked = dispatcher.dispatch("agent.invoke", {"name": "main", "state": {"input": "pwd"}})
    assert invoked == {"agent": "main", "input": "pwd"}
    # #69: 停止 RPC 在 set_backend 注入的裸 callable（非真 adapter）下 fail-soft，
    # 不能抛错——否则前端点停止会看到 IPC 失败而不是"没东西可停"。
    cancelled = dispatcher.dispatch("agent.cancel", {"session_id": "s1", "reason": "用户点击停止"})
    assert cancelled == {
        "session_id": "s1",
        "cancelled": False,
        "reason": "Strands backend unavailable",
    }


def test_configure_query_does_not_rebuild_model(monkeypatch: pytest.MonkeyPatch) -> None:
    save = MagicMock()
    create = MagicMock()
    monkeypatch.setattr("core.llm_config.save_config", save)
    monkeypatch.setattr("strands_backend.model_adapter.create_strands_model", create)

    result = facade.configure()
    assert result["ok"] is True
    assert isinstance(result["llm_call_set"], bool)
    save.assert_not_called()
    create.assert_not_called()


def test_configure_rejects_empty_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    save = MagicMock()
    create = MagicMock()
    monkeypatch.setattr("core.llm_config.save_config", save)
    monkeypatch.setattr("strands_backend.model_adapter.create_strands_model", create)

    result = facade.configure({"provider": "openai", "api_key": ""})
    assert result["ok"] is False
    save.assert_not_called()
    create.assert_not_called()


def test_configure_saves_creates_and_updates_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[object] = []
    model = object()
    adapter = MagicMock()
    facade.set_strands_adapter(adapter)

    def save(config: object) -> None:
        events.append(("save", config))

    def create(config: object) -> object:
        events.append(("create", config))
        return model

    monkeypatch.setattr("core.llm_config.save_config", save)
    monkeypatch.setattr("strands_backend.model_adapter.create_strands_model", create)
    adapter.update_model.side_effect = lambda value: events.append(("update", value))

    result = facade.configure(
        {"provider": "openai", "api_key": "sk-test", "model": "gpt-test"}
    )
    assert result["ok"] is True
    assert result["llm_call_set"] is True
    assert [entry[0] for entry in events] == ["save", "create", "update"]
    assert events[0][1] is events[1][1]
    assert events[2][1] is model
    adapter.update_model.assert_called_once_with(model)


def test_configure_fails_when_adapter_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("core.llm_config.save_config", MagicMock())
    monkeypatch.setattr("strands_backend.model_adapter.create_strands_model", lambda _: object())
    facade.set_strands_adapter(None)
    result = facade.configure({"provider": "openai", "api_key": "sk-test"})
    assert result["ok"] is False


def test_configure_fails_when_model_factory_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    adapter = MagicMock()
    facade.set_strands_adapter(adapter)
    monkeypatch.setattr("core.llm_config.save_config", MagicMock())
    monkeypatch.setattr("strands_backend.model_adapter.create_strands_model", lambda _: None)
    result = facade.configure({"provider": "openai", "api_key": "sk-test"})
    assert result["ok"] is False
    adapter.update_model.assert_not_called()
