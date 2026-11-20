"""SDK call identity must link lifecycle cards and retained evidence."""
from __future__ import annotations

import asyncio
import ast
from pathlib import Path
from typing import Any

import pytest
from strands import tool
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from strands.tools.registry import ToolRegistry

from strands_backend.adapter import ToolCallLimitHook
from strands_backend.evidence import get_global_tracker, reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.knowledge_get_doc import make_knowledge_get_doc_tool
from strands_backend.tools.knowledge_search import make_knowledge_search_tool
from strands_backend.tools.skill_invoke import make_skill_invoke_tool
from strands_backend.tools.todo_write import make_todo_write_tool, reset_session_todos
from strands_backend.tools.tool_lifecycle import take_reference_tool_call_id


class RecordingEventBus:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit_tool_call(self, **event: Any) -> None:
        self.events.append(event)

    def emit_loop_progress(self, **_event: Any) -> None:
        pass


def _sdk_result(tool_fn: Any, tool_use: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    async def run_stream():
        return [event async for event in tool_fn.stream(tool_use, state)]

    return asyncio.run(run_stream())[-1].tool_result


@pytest.fixture(autouse=True)
def _reset_evidence():
    reset_global_tracker()
    reset_session_todos()
    yield
    reset_global_tracker()
    reset_session_todos()


@pytest.mark.parametrize(
    ("name", "factory", "tool_input", "schema_fields"),
    [
        ("knowledge_search", make_knowledge_search_tool, {"query": "nginx"}, {"query", "limit"}),
        ("knowledge_get_doc", make_knowledge_get_doc_tool, {"url": "kb://nginx"}, {"url"}),
        ("skill_invoke", make_skill_invoke_tool, {"skill_name": "linux-ops", "input": "nginx"}, {"skill_name", "input"}),
        ("todo_write", make_todo_write_tool, {"todos": [{"title": "inspect", "status": "pending"}]}, {"todos"}),
    ],
)
def test_real_sdk_tool_execution_links_ui_card_and_evidence(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    factory: Any,
    tool_input: dict[str, Any],
    schema_fields: set[str],
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture", "source": "test", "tags": [], "url": "kb://nginx"}][:top_k]

        def get_doc(self, _url: str) -> dict[str, Any]:
            return {"title": "nginx", "content": "fixture", "chunks": 1}

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    if name == "skill_invoke":
        import skills.registry as registry_module
        from skills.registry import SkillRegistry

        registry_for_skill = SkillRegistry()
        registry_for_skill.load_builtin()
        monkeypatch.setattr(
            registry_module, "get_global_registry", lambda: registry_for_skill
        )
        monkeypatch.setattr(
            registry_for_skill,
            "get_reference",
            lambda *_args: {"name": "linux-ops", "source": "test", "content": "fixture"},
        )
    bus = RecordingEventBus()
    tool_fn = factory(ToolContext(event_bus=bus, agent_name="main", session_id="sdk-link"))
    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry[name].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]) == schema_fields

    sdk_id = f"sdk-{name}-call-17"
    invocation_state = {"agent": object(), "marker": object()}
    tool_use = {
        "toolUseId": sdk_id,
        "name": name,
        "input": {**tool_input, "sdk_tool_context": {"toolUseId": "forged"}},
    }
    hook = ToolCallLimitHook(
        agent_name="main", event_bus=bus, session_id="sdk-link"
    )
    hook._before_tool_call(
        BeforeToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state=invocation_state,
        )
    )

    sdk_result = _sdk_result(tool_fn, tool_use, invocation_state)
    hook._after_tool_call(
        AfterToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state=invocation_state,
            result=sdk_result,
        )
    )

    evidence = [
        item for item in get_global_tracker().list("sdk-link")
        if item["tool_name"] == name
    ]
    cards = [event for event in bus.events if event["tool_name"] == name]
    assert len(evidence) == 1
    assert [event["status"] for event in cards] == ["started", "completed"]
    assert evidence[0]["tool_call_id"] == cards[0]["tool_call_id"]
    assert cards[0]["tool_call_id"] == cards[1]["tool_call_id"]
    assert evidence[0]["sdk_tool_use_id"] == sdk_id
    assert evidence[0]["tool_call_id"] != sdk_id
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in cards[0]["params"]


def test_sdk_context_is_hidden_and_injected_from_the_real_stream() -> None:
    seen: list[Any] = []

    @tool(context="sdk_tool_context")
    def probe(query: str, sdk_tool_context: Any = None) -> dict[str, str]:
        seen.append(sdk_tool_context)
        return {"query": query}

    assert probe("direct") == {"query": "direct"}
    registry = ToolRegistry()
    registry.process_tools([probe])
    schema = registry.registry["probe"].tool_spec["inputSchema"]["json"]
    assert schema == {
        "properties": {"query": {"description": "Parameter query", "type": "string"}},
        "required": ["query"],
        "type": "object",
    }

    state = {"agent": object(), "marker": object()}
    tool_use = {
        "toolUseId": "sdk-prototype-9",
        "name": "probe",
        "input": {"query": "stream", "sdk_tool_context": {"toolUseId": "forged"}},
    }

    async def run_stream():
        return [event async for event in probe.stream(tool_use, state)]

    events = asyncio.run(run_stream())
    assert events[-1].tool_result["toolUseId"] == "sdk-prototype-9"
    assert seen[-1].tool_use["toolUseId"] == "sdk-prototype-9"
    assert seen[-1].invocation_state is state


@pytest.mark.parametrize(
    ("mismatched_session", "mismatched_agent"),
    [("other-session", "main"), ("sdk-link", "other-agent")],
)
def test_wrong_owner_after_hook_does_not_consume_reference_call(
    monkeypatch: pytest.MonkeyPatch,
    mismatched_session: str,
    mismatched_agent: str,
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingEventBus()
    tool_fn = make_knowledge_search_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id="sdk-link")
    )
    tool_use = {
        "toolUseId": "sdk-shared-id",
        "name": "knowledge_search",
        "input": {"query": "nginx"},
    }
    state = {"agent": object()}
    owner_hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="sdk-link")
    owner_hook._before_tool_call(
        BeforeToolCallEvent(agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state)
    )

    result = _sdk_result(tool_fn, tool_use, state)
    wrong_hook = ToolCallLimitHook(
        agent_name=mismatched_agent,
        event_bus=bus,
        session_id=mismatched_session,
    )
    wrong_hook._after_tool_call(
        AfterToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state=state,
            result=result,
        )
    )

    owner_hook._after_tool_call(
        AfterToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state=state,
            result=result,
        )
    )
    card_id = next(event["tool_call_id"] for event in bus.events if event["status"] == "started")
    owner_evidence = get_global_tracker().list("sdk-link")
    assert owner_evidence[-1]["tool_call_id"] == card_id
    assert owner_evidence[-1]["sdk_tool_use_id"] == "sdk-shared-id"
    wrong_evidence = get_global_tracker().list(mismatched_session)
    if mismatched_session != "sdk-link":
        assert len(wrong_evidence) == 1
        assert "tool_call_id" not in wrong_evidence[0]
    else:
        assert len(wrong_evidence) == 2
        other_agent_evidence = next(item for item in wrong_evidence if item["agent"] == "other-agent")
        assert "tool_call_id" not in other_agent_evidence


def test_same_input_in_two_sessions_keeps_distinct_sdk_and_card_ids(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingEventBus()
    calls = []
    for session_id, sdk_id in (("session-a", "sdk-a"), ("session-b", "sdk-b")):
        tool_fn = make_knowledge_search_tool(
            ToolContext(event_bus=bus, agent_name="main", session_id=session_id)
        )
        hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id=session_id)
        tool_use = {"toolUseId": sdk_id, "name": "knowledge_search", "input": {"query": "same"}}
        state = {"agent": object()}
        hook._before_tool_call(
            BeforeToolCallEvent(agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state)
        )

        result = _sdk_result(tool_fn, tool_use, state)
        hook._after_tool_call(
            AfterToolCallEvent(
                agent=None, selected_tool=None, tool_use=tool_use,
                invocation_state=state, result=result,
            )
        )
        calls.append((session_id, sdk_id))

    evidence_a = get_global_tracker().list("session-a")[0]
    evidence_b = get_global_tracker().list("session-b")[0]
    card_ids = {
        event["session_id"]: event["tool_call_id"]
        for event in bus.events
        if event["status"] == "started"
    }
    assert evidence_a["sdk_tool_use_id"] == calls[0][1]
    assert evidence_b["sdk_tool_use_id"] == calls[1][1]
    assert evidence_a["tool_call_id"] == card_ids["session-a"]
    assert evidence_b["tool_call_id"] == card_ids["session-b"]
    assert evidence_a["tool_call_id"] != evidence_b["tool_call_id"]


def test_skill_nested_todo_uses_its_own_call_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import skills.registry as registry_module
    from skills.registry import SkillRegistry

    registry = SkillRegistry()
    registry.load_builtin()
    monkeypatch.setattr(registry_module, "get_global_registry", lambda: registry)
    monkeypatch.setattr(
        registry,
        "get_reference",
        lambda *_args: {
            "name": "linux-ops",
            "source": "test",
            "content": "fixture",
            "playbook": [{"description": "inspect service"}],
        },
    )
    bus = RecordingEventBus()
    tool_fn = make_skill_invoke_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id="nested-session")
    )
    tool_use = {
        "toolUseId": "sdk-skill-parent",
        "name": "skill_invoke",
        "input": {"skill_name": "linux-ops"},
    }
    state = {"agent": object()}
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="nested-session")
    hook._before_tool_call(
        BeforeToolCallEvent(agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state)
    )

    result = _sdk_result(tool_fn, tool_use, state)
    hook._after_tool_call(
        AfterToolCallEvent(
            agent=None, selected_tool=None, tool_use=tool_use,
            invocation_state=state, result=result,
        )
    )

    skill_evidence = [item for item in get_global_tracker().list("nested-session") if item["tool_name"] == "skill_invoke"]
    todo_evidence = [item for item in get_global_tracker().list("nested-session") if item["tool_name"] == "todo_write"]
    skill_cards = [event for event in bus.events if event["tool_name"] == "skill_invoke"]
    todo_cards = [event for event in bus.events if event["tool_name"] == "todo_write"]
    assert len(skill_evidence) == 1
    assert todo_evidence == []
    assert len(skill_cards) == len(todo_cards) == 2
    skill_id = skill_cards[0]["tool_call_id"]
    todo_id = todo_cards[0]["tool_call_id"]
    assert skill_cards[1]["tool_call_id"] == skill_id
    assert todo_cards[1]["tool_call_id"] == todo_id
    assert skill_id != todo_id
    assert skill_id != "sdk-skill-parent"
    assert skill_evidence[0]["tool_call_id"] == skill_id
    assert skill_evidence[0]["sdk_tool_use_id"] == "sdk-skill-parent"
    assert todo_id not in {item.get("tool_call_id") for item in skill_evidence}
    assert todo_id not in {item.get("sdk_tool_use_id") for item in skill_evidence}


def test_direct_call_without_sdk_context_has_no_sdk_call_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingEventBus()
    make_knowledge_search_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id="direct-session")
    )(query="nginx")
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="direct-session")
    tool_use = {
        "toolUseId": "sdk-without-context",
        "name": "knowledge_search",
        "input": {"query": "nginx"},
    }
    hook._after_tool_call(
        AfterToolCallEvent(
            agent=None, selected_tool=None, tool_use=tool_use,
            invocation_state={}, result={"status": "success", "content": []},
        )
    )
    evidence = get_global_tracker().list("direct-session")
    assert len(evidence) == 1
    assert "tool_call_id" not in evidence[0]
    assert evidence[0]["sdk_tool_use_id"] == "sdk-without-context"


def test_cancelled_before_execution_uses_its_sdk_card_not_reference_uuid() -> None:
    bus = RecordingEventBus()
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="cancelled-session")
    hook.cancelled = True
    tool_use = {
        "toolUseId": "sdk-cancelled-before-run",
        "name": "knowledge_search",
        "input": {"query": "nginx"},
    }
    state = {"agent": object()}
    before = BeforeToolCallEvent(
        agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state
    )
    hook._before_tool_call(before)
    assert before.cancel_tool
    cancelled_result = {
        "toolUseId": tool_use["toolUseId"], "status": "cancelled", "content": []
    }
    hook._after_tool_call(
        AfterToolCallEvent(
            agent=None,
            selected_tool=None,
            tool_use=tool_use,
            invocation_state=state,
            result=cancelled_result,
            cancel_message="cancelled by user",
        )
    )

    evidence = get_global_tracker().list("cancelled-session")
    assert len(evidence) == 1
    assert evidence[0]["status"] == "cancelled"
    assert evidence[0]["tool_call_id"] == tool_use["toolUseId"]
    assert evidence[0]["sdk_tool_use_id"] == tool_use["toolUseId"]
    assert [event["status"] for event in bus.events] == ["started", "completed"]
    assert {event["tool_call_id"] for event in bus.events} == {tool_use["toolUseId"]}
    assert bus.events[-1]["result"]["status"] == "cancelled"
    assert take_reference_tool_call_id(
        tool_use, state, session_id="cancelled-session", agent_name="main"
    ) is None


def test_sdk_retry_consumes_old_link_and_emits_a_fresh_card_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingEventBus()
    tool_fn = make_knowledge_search_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id="retry-session")
    )
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="retry-session")
    state = {"agent": object()}
    original_agent = state["agent"]
    tool_use = {
        "toolUseId": "sdk-retried-call",
        "name": "knowledge_search",
        "input": {"query": "nginx"},
    }
    for _ in range(2):
        hook._before_tool_call(
            BeforeToolCallEvent(agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state)
        )
        result = _sdk_result(tool_fn, tool_use, state)
        hook._after_tool_call(
            AfterToolCallEvent(
                agent=None, selected_tool=None, tool_use=tool_use,
                invocation_state=state, result=result,
            )
        )
        assert take_reference_tool_call_id(
            tool_use, state, session_id="retry-session", agent_name="main"
        ) is None
        assert state["agent"] is original_agent

    evidence = get_global_tracker().list("retry-session")
    cards = [event for event in bus.events if event["tool_name"] == "knowledge_search"]
    ids = [event["tool_call_id"] for event in cards if event["status"] == "started"]
    assert len(evidence) == 2
    assert len(cards) == 4
    assert len(set(ids)) == 2
    assert [item["tool_call_id"] for item in evidence] == ids
    assert [item["sdk_tool_use_id"] for item in evidence] == ["sdk-retried-call"] * 2


@pytest.mark.parametrize("bad_sdk_id", [None, "", []])
def test_invalid_sdk_id_does_not_consume_a_real_reference_link(
    monkeypatch: pytest.MonkeyPatch,
    bad_sdk_id: Any,
) -> None:
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture"}][:top_k]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    bus = RecordingEventBus()
    tool_fn = make_knowledge_search_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id="bad-id-session")
    )
    real_use = {
        "toolUseId": "sdk-valid-id",
        "name": "knowledge_search",
        "input": {"query": "nginx"},
    }
    state = {"agent": object()}
    _sdk_result(tool_fn, real_use, state)
    owner_id = next(event["tool_call_id"] for event in bus.events if event["status"] == "started")

    assert take_reference_tool_call_id(
        {"toolUseId": bad_sdk_id, "name": "knowledge_search"},
        state,
        session_id="bad-id-session",
        agent_name="main",
    ) is None
    assert take_reference_tool_call_id(
        real_use,
        state,
        session_id="bad-id-session",
        agent_name="main",
    ) == owner_id


def test_sdk_tool_exception_keeps_the_real_error_card_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import knowledge.rag as rag_module

    class MalformedRag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "missing content"}]

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: MalformedRag())
    bus = RecordingEventBus()
    tool_fn = make_knowledge_search_tool(
        ToolContext(event_bus=bus, agent_name="main", session_id="exception-session")
    )
    hook = ToolCallLimitHook(agent_name="main", event_bus=bus, session_id="exception-session")
    tool_use = {
        "toolUseId": "sdk-exception-1",
        "name": "knowledge_search",
        "input": {"query": "nginx"},
    }
    state = {"agent": object()}
    hook._before_tool_call(
        BeforeToolCallEvent(agent=None, selected_tool=None, tool_use=tool_use, invocation_state=state)
    )
    result = _sdk_result(tool_fn, tool_use, state)
    hook._after_tool_call(
        AfterToolCallEvent(
            agent=None, selected_tool=None, tool_use=tool_use,
            invocation_state=state, result=result,
        )
    )

    evidence = get_global_tracker().list("exception-session")
    cards = [event for event in bus.events if event["tool_name"] == "knowledge_search"]
    assert result["status"] == "error"
    assert [event["status"] for event in cards] == ["started", "error"]
    assert len(evidence) == 1
    assert evidence[0]["tool_call_id"] == cards[0]["tool_call_id"]
    assert evidence[0]["sdk_tool_use_id"] == tool_use["toolUseId"]
    assert evidence[0]["status"] == "error"
    assert take_reference_tool_call_id(
        tool_use, state, session_id="exception-session", agent_name="main"
    ) is None


@pytest.mark.parametrize(
    ("name", "factory", "tool_input"),
    [
        ("knowledge_search", make_knowledge_search_tool, {"query": "nginx"}),
        ("knowledge_get_doc", make_knowledge_get_doc_tool, {"url": "kb://nginx"}),
        ("skill_invoke", make_skill_invoke_tool, {"skill_name": "linux-ops"}),
        ("todo_write", make_todo_write_tool, {"todos": [{"title": "inspect", "status": "pending"}]}),
    ],
)
def test_reference_factories_remain_directly_callable_without_sdk(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    factory: Any,
    tool_input: dict[str, Any],
) -> None:
    import importlib
    import knowledge.rag as rag_module

    class Rag:
        def hybrid_search(self, _query: str, *, top_k: int) -> list[dict[str, Any]]:
            return [{"title": "nginx", "content": "fixture"}][:top_k]

        def get_doc(self, _url: str) -> dict[str, Any]:
            return {"title": "nginx", "content": "fixture", "chunks": 1}

    monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
    module = importlib.import_module(factory.__module__)
    source_path = Path(__file__).parents[1] / "tools" / "__init__.py"
    source = ast.parse(source_path.read_text(encoding="utf-8"))
    fallback_node = next(
        node for node in ast.walk(source)
        if isinstance(node, ast.FunctionDef) and node.name == "_strands_tool"
    )
    namespace: dict[str, Any] = {}
    exec(compile(ast.Module(body=[fallback_node], type_ignores=[]), str(source_path), "exec"), namespace)
    fallback = namespace["_strands_tool"]
    namespace["_strands_tool"] = fallback

    monkeypatch.setattr(module, "tool", fallback)
    if name == "skill_invoke":
        import skills.registry as registry_module
        from skills.registry import SkillRegistry

        registry = SkillRegistry()
        registry.load_builtin()
        monkeypatch.setattr(registry_module, "get_global_registry", lambda: registry)
        monkeypatch.setattr(
            registry,
            "get_reference",
            lambda *_args: {"name": "linux-ops", "source": "test", "content": "fixture"},
        )

    bus = RecordingEventBus()
    tool_fn = factory(ToolContext(event_bus=bus, session_id="fallback"))
    assert not getattr(tool_fn, "_is_strands_tool", True)
    result = tool_fn(**tool_input)
    if name == "todo_write":
        assert result["ok"] is True
    else:
        assert result["status"] == "success"
    cards = [event for event in bus.events if event["tool_name"] == name]
    assert [event["status"] for event in cards] == ["started", "completed"]
    assert cards[0]["tool_call_id"] == cards[1]["tool_call_id"]
