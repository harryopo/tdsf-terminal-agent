"""Regression tests for reference and planning tool call lifecycles."""
# secret-scan: fixture; all credential-shaped values below are synthetic.
from __future__ import annotations

from typing import Any

import pytest

from strands_backend.tools import ToolContext
from strands_backend.tools.knowledge_get_doc import make_knowledge_get_doc_tool
from strands_backend.tools.knowledge_search import make_knowledge_search_tool
from strands_backend.tools.skill_invoke import make_skill_invoke_tool
from strands_backend.tools.todo_write import make_todo_write_tool, reset_session_todos


class RecordingEventBus:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.events.append(event)


def _context(bus: RecordingEventBus, *, session_id: str = "session-original") -> ToolContext:
    return ToolContext(
        event_bus=bus,
        agent_name="main",
        session_id=session_id,
    )


def _install_builtin_registry(monkeypatch: pytest.MonkeyPatch):
    import skills.registry as registry_module
    from skills.registry import SkillRegistry

    registry = SkillRegistry()
    registry.load_builtin()
    monkeypatch.setattr(registry_module, "get_global_registry", lambda: registry)
    return registry


def _assert_lifecycle(bus: RecordingEventBus, name: str, terminal: str) -> str:
    assert [event["status"] for event in bus.events] == ["started", terminal]
    call_ids = [event.get("tool_call_id") for event in bus.events]
    assert call_ids[0] and call_ids == [call_ids[0], call_ids[0]]
    assert all(event["tool_name"] == name for event in bus.events)
    return call_ids[0]


@pytest.fixture(autouse=True)
def reset_todos_around_each_test():
    reset_session_todos()
    yield
    reset_session_todos()


def test_skill_factory_emits_correlated_events_and_only_returns_reference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import skills.registry as registry_module

    registry = _install_builtin_registry(monkeypatch)
    linux_ops = registry.get("linux-ops")
    assert linux_ops is not None and linux_ops.executor
    monkeypatch.setattr(
        registry_module,
        "_run_executor",
        lambda *_args, **_kwargs: pytest.fail("get_reference must not run an executor"),
    )

    bus = RecordingEventBus()
    returned = make_skill_invoke_tool(_context(bus))(skill_name="linux-ops", input="nginx")

    _assert_lifecycle(bus, "skill_invoke", "completed")
    assert returned["status"] == "success"
    assert returned["execution"] == "not_run"
    assert "content" in returned
    assert "stdout" not in returned


def test_knowledge_search_postprocessing_exception_closes_started_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class MalformedRag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            assert top_k == 5
            return [{"title": "missing content"}]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: MalformedRag())
    bus = RecordingEventBus()

    with pytest.raises(KeyError):
        make_knowledge_search_tool(_context(bus))(query="status")

    _assert_lifecycle(bus, "knowledge_search", "error")


def test_knowledge_get_doc_postprocessing_exception_closes_started_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class MalformedRag:
        def get_doc(self, _url: str) -> dict[str, Any]:
            return {"title": "bad chunks", "chunks": "not-an-integer"}

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: MalformedRag())
    bus = RecordingEventBus()

    with pytest.raises(ValueError):
        make_knowledge_get_doc_tool(_context(bus))(url="doc.md")

    _assert_lifecycle(bus, "knowledge_get_doc", "error")


def test_todo_exception_during_normalization_closes_started_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import strands_backend.tools.todo_write as todo_module

    reset_session_todos()
    monkeypatch.setattr(
        todo_module,
        "get_session_todos",
        lambda _session_id: (_ for _ in ()).throw(RuntimeError("todo store unavailable")),
    )
    bus = RecordingEventBus()

    with pytest.raises(RuntimeError, match="todo store unavailable"):
        make_todo_write_tool(_context(bus))(todos=[{"title": "inspect", "status": "pending"}])

    _assert_lifecycle(bus, "todo_write", "error")


def test_reference_tool_schemas_keep_the_existing_model_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from strands.tools.registry import ToolRegistry

    _install_builtin_registry(monkeypatch)

    event_bus = RecordingEventBus()
    ctx = _context(event_bus)
    tool_registry = ToolRegistry()
    tools = [
        make_skill_invoke_tool(ctx),
        make_knowledge_search_tool(ctx),
        make_knowledge_get_doc_tool(ctx),
        make_todo_write_tool(ctx),
    ]
    tool_registry.process_tools(tools)

    expected = {
        "skill_invoke": {"skill_name", "input"},
        "knowledge_search": {"query", "limit"},
        "knowledge_get_doc": {"url"},
        "todo_write": {"todos"},
    }
    for name, properties in expected.items():
        schema = tool_registry.registry[name].tool_spec["inputSchema"]["json"]
        assert set(schema["properties"]) == properties


def test_business_outcomes_keep_each_tools_existing_terminal_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class EmptyRag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return []

        def get_doc(self, _url: str) -> None:
            return None

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: EmptyRag())
    _install_builtin_registry(monkeypatch)
    reset_session_todos()

    skill_bus = RecordingEventBus()
    skill_result = make_skill_invoke_tool(_context(skill_bus))(skill_name="missing-skill")
    assert skill_result["status"] == "not_found"
    _assert_lifecycle(skill_bus, "skill_invoke", "error")

    search_bus = RecordingEventBus()
    search_result = make_knowledge_search_tool(_context(search_bus))(query="nothing")
    assert search_result["status"] == "empty"
    _assert_lifecycle(search_bus, "knowledge_search", "completed")

    class ErrorRag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            raise RuntimeError("offline retrieval failure")

        def get_doc(self, _url: str) -> dict[str, Any]:
            raise RuntimeError("offline document failure")

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: ErrorRag())
    search_error_bus = RecordingEventBus()
    search_error = make_knowledge_search_tool(_context(search_error_bus))(query="offline")
    assert search_error["status"] == "error"
    assert "offline retrieval failure" in search_error["message"]
    _assert_lifecycle(search_error_bus, "knowledge_search", "completed")

    doc_error_bus = RecordingEventBus()
    doc_error = make_knowledge_get_doc_tool(_context(doc_error_bus))(url="doc.md")
    assert doc_error["status"] == "error"
    assert "offline document failure" in doc_error["message"]
    _assert_lifecycle(doc_error_bus, "knowledge_get_doc", "completed")

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: EmptyRag())
    doc_missing_bus = RecordingEventBus()
    doc_missing = make_knowledge_get_doc_tool(_context(doc_missing_bus))(url="missing.md")
    assert doc_missing["status"] == "not_found"
    _assert_lifecycle(doc_missing_bus, "knowledge_get_doc", "completed")

    todo_bus = RecordingEventBus()
    todo_result = make_todo_write_tool(_context(todo_bus))(todos=[])
    assert todo_result == {"ok": False, "error": "todo list must contain at least one titled item"}
    _assert_lifecycle(todo_bus, "todo_write", "error")


def test_lifecycle_freezes_skill_session_and_source_at_call_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = _install_builtin_registry(monkeypatch)
    bus = RecordingEventBus()
    ctx = _context(bus)
    returned = {"name": "linux-ops", "source": "test", "content": "reference"}

    def get_reference(_name: str, _params: dict[str, Any]) -> dict[str, Any]:
        ctx.session_id = "session-mutated"
        ctx.agent_name = "debug"
        return returned

    monkeypatch.setattr(registry, "get_reference", get_reference)
    result = make_skill_invoke_tool(ctx)(skill_name="linux-ops")

    assert result["status"] == "success"
    assert result["content"] == returned["content"]
    _assert_lifecycle(bus, "skill_invoke", "completed")
    assert {event["session_id"] for event in bus.events} == {"session-original"}
    assert {event["source"] for event in bus.events} == {
        "main_agent.strands_tool.skill_invoke"
    }


def test_nested_same_tool_calls_keep_distinct_correlated_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    bus = RecordingEventBus()
    ctx = _context(bus)
    nested_tool = None

    class NestedRag:
        def hybrid_search(self, query: str, *, top_k: int) -> list[dict[str, Any]]:
            if query == "outer":
                assert nested_tool is not None
                nested_tool(query="inner")
            return [{"title": query, "content": f"result for {query}"}]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: NestedRag())
    nested_tool = make_knowledge_search_tool(ctx)
    outer_result = nested_tool(query="outer")

    assert outer_result["results"][0]["title"] == "outer"
    assert [event["status"] for event in bus.events] == [
        "started", "started", "completed", "completed"
    ]
    ids_by_query: dict[str, set[str]] = {}
    for event in bus.events:
        ids_by_query.setdefault(event["params"]["query"], set()).add(event["tool_call_id"])
    assert len(ids_by_query["outer"]) == 1
    assert len(ids_by_query["inner"]) == 1
    assert ids_by_query["outer"].isdisjoint(ids_by_query["inner"])


def test_skill_playbook_and_todo_events_keep_separate_card_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = _install_builtin_registry(monkeypatch)
    reset_session_todos()
    monkeypatch.setattr(
        registry,
        "get_reference",
        lambda *_args: {
            "name": "linux-ops",
            "source": "test",
            "content": "reference",
            "playbook": [{"description": "inspect service"}],
        },
    )
    bus = RecordingEventBus()

    returned = make_skill_invoke_tool(_context(bus))(skill_name="linux-ops")

    assert returned["status"] == "success"
    assert [event["tool_name"] for event in bus.events] == [
        "skill_invoke", "todo_write", "todo_write", "skill_invoke"
    ]
    skill_id = bus.events[0]["tool_call_id"]
    todo_id = bus.events[1]["tool_call_id"]
    assert skill_id and todo_id and skill_id != todo_id
    assert [event["tool_call_id"] for event in (bus.events[0], bus.events[3])] == [skill_id] * 2
    assert [event["tool_call_id"] for event in (bus.events[1], bus.events[2])] == [todo_id] * 2
    assert bus.events[1]["params"] == bus.events[2]["params"] == {"count": 1}


def test_todo_events_summarize_items_as_count_only() -> None:
    reset_session_todos()
    bus = RecordingEventBus()
    todos = [
        {"title": "inspect", "description": "safe"},
        {"title": "verify", "description": "also safe"},
    ]

    returned = make_todo_write_tool(_context(bus))(todos=todos)

    assert returned["ok"] is True and returned["count"] == 2
    _assert_lifecycle(bus, "todo_write", "completed")
    assert [event["params"] for event in bus.events] == [{"count": 2}, {"count": 2}]
    assert "todos" not in repr(bus.events)


def test_nested_event_payloads_are_redacted_without_mutating_business_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module
    from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

    token = "abcdefghijklmnopqrstuvwx"

    class CredentialRag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{
                "title": "credentials",
                "metadata": {"api_key": f"Bearer {token}"},
                "content": f"Authorization: Bearer {token}",
            }]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: CredentialRag())
    bus = RecordingEventBus()
    params = {"query": "credentials", "nested": [{"api_key": f"Bearer {token}"}]}

    returned = invoke_knowledge_search_tool(params, ctx=_context(bus))

    assert returned["results"][0]["content"] == f"Authorization: Bearer {token}"
    assert returned["results"][0]["metadata"]["api_key"] == f"Bearer {token}"
    terminal = bus.events[-1]
    assert "<REDACTED" in terminal["params"]["nested"][0]["api_key"]
    assert token not in repr(terminal["params"])
    assert "<REDACTED" in terminal["result"]["results"][0]["content"]
    assert "<REDACTED" in terminal["result"]["results"][0]["metadata"]["api_key"]
    assert token not in repr(bus.events)


def test_missing_or_failing_event_bus_never_changes_results_or_exceptions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import strands_backend.tools.todo_write as todo_module
    from strands_backend.tools.knowledge_get_doc import invoke_knowledge_get_doc_tool
    import knowledge.rag as rag_module

    class FailingBus:
        def __init__(self) -> None:
            self.statuses: list[str] = []
            self.events: list[dict[str, Any]] = []

        def emit_tool_call(self, **event: Any) -> None:
            self.statuses.append(event["status"])
            self.events.append(event)
            raise RuntimeError("event transport unavailable")

    class SimpleRag:
        def get_doc(self, _url: str) -> dict[str, Any]:
            return {"title": "doc", "chunks": 1, "content": "body"}

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: SimpleRag())
    result_without_bus = invoke_knowledge_get_doc_tool(
        {"url": "doc.md"}, ctx=ToolContext(session_id="no-bus")
    )
    assert result_without_bus["status"] == "success"

    failing_bus = FailingBus()
    result_with_failing_bus = invoke_knowledge_get_doc_tool(
        {"url": "doc.md"}, ctx=_context(failing_bus)
    )
    assert result_with_failing_bus == result_without_bus
    assert failing_bus.statuses == ["started", "completed"]

    reset_session_todos()
    token = "abcdefghijklmnopqrstuvwx"
    exception_message = f"Authorization: Bearer {token}"

    def fail_todo_read(_session_id: str) -> list[dict[str, Any]]:
        raise ValueError(exception_message)

    monkeypatch.setattr(todo_module, "get_session_todos", fail_todo_read)

    with pytest.raises(ValueError) as no_bus_error:
        make_todo_write_tool(ToolContext(session_id="no-bus-error"))(
            todos=[{"title": "inspect", "status": "pending"}]
        )
    assert str(no_bus_error.value) == exception_message

    exception_bus = FailingBus()
    with pytest.raises(ValueError) as raised:
        make_todo_write_tool(_context(exception_bus))(
            todos=[{"title": "inspect", "status": "pending"}]
        )
    assert str(raised.value) == exception_message
    assert exception_bus.statuses == ["started", "error"]
    assert "<REDACTED" in exception_bus.events[-1]["result"]["message"]
    assert token not in repr(exception_bus.events)


def test_real_strands_hook_does_not_duplicate_owned_tool_cards(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json
    import knowledge.rag as rag_module
    import skills.registry as registry_module
    from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
    from strands_backend.adapter import ToolCallLimitHook
    from strands_backend.tools.registry import TOOL_REGISTRY

    registry = _install_builtin_registry(monkeypatch)
    monkeypatch.setattr(registry_module, "get_global_registry", lambda: registry)

    class SimpleRag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return []

        def get_doc(self, _url: str) -> None:
            return None

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: SimpleRag())
    cases = [
        ("skill_invoke", make_skill_invoke_tool, {"skill_name": "linux-ops"}),
        ("knowledge_search", make_knowledge_search_tool, {"query": "empty"}),
        ("knowledge_get_doc", make_knowledge_get_doc_tool, {"url": "missing.md"}),
        ("todo_write", make_todo_write_tool, {"todos": [{"title": "one"}]}),
    ]

    for name, factory, arguments in cases:
        assert TOOL_REGISTRY[name].emits_tool_events
        bus = RecordingEventBus()
        ctx = _context(bus, session_id=f"hook-{name}")
        hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=ctx.session_id)
        call_id = f"sdk-{name}"
        tool_input = dict(arguments)
        hook._before_tool_call(BeforeToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use={"toolUseId": call_id, "name": name, "input": tool_input},
            invocation_state={},
        ))
        returned = factory(ctx)(**arguments)
        hook._after_tool_call(AfterToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use={"toolUseId": call_id, "name": name, "input": tool_input},
            invocation_state={},
            result={
                "toolUseId": call_id,
                "status": "success",
                "content": [{"text": json.dumps(returned, ensure_ascii=False)}],
            },
        ))

        assert len(bus.events) == 2
        _assert_lifecycle(bus, name, "completed")
