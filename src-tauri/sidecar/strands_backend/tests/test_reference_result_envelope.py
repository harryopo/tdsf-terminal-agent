"""Reference tools keep their business result inside the real Strands envelope."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from strands.tools.registry import ToolRegistry

from strands_backend.tools import ToolContext
from strands_backend.tools.knowledge_get_doc import make_knowledge_get_doc_tool
from strands_backend.tools.remote_file import make_remote_file_tool
from strands_backend.tools.skill_invoke import make_skill_invoke_tool


CASES = [
    ("knowledge_get_doc", "success"),
    ("knowledge_get_doc", "not_found"),
    ("knowledge_get_doc", "error"),
    ("skill_invoke", "success"),
    ("skill_invoke", "not_found"),
    ("skill_invoke", "error"),
]


def _business_payload(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    assert isinstance(blocks, list) and blocks
    assert all(isinstance(block, dict) for block in blocks)
    for block in blocks:
        if isinstance(block.get("json"), dict):
            return block["json"]
        text = block.get("text")
        if isinstance(text, str):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                return value
    pytest.fail(f"SDK content blocks did not contain a JSON business result: {blocks!r}")


@pytest.mark.parametrize(("tool_name", "outcome"), CASES, ids=[f"{n}-{o}" for n, o in CASES])
def test_reference_result_stays_inside_real_sdk_content_envelope(
    monkeypatch: pytest.MonkeyPatch, tool_name: str, outcome: str,
) -> None:
    url = "qa://服务文档"
    tool_input = (
        {"url": url}
        if tool_name == "knowledge_get_doc"
        else {"skill_name": "linux-ops", "input": "systemctl 状态"}
    )

    if tool_name == "knowledge_get_doc":
        import knowledge.rag as rag_module

        class Rag:
            def get_doc(self, requested_url: str) -> dict[str, Any] | None:
                assert requested_url == url
                if outcome == "not_found":
                    return None
                if outcome == "error":
                    raise RuntimeError("qa fixture failure")
                return {
                    "title_zh": "Linux 服务管理",
                    "category": "系统管理",
                    "content": "使用 systemctl 查看服务状态。",
                    "chunks": 1,
                }

        monkeypatch.setattr(rag_module, "get_slim_rag", lambda: Rag())
        factory = make_knowledge_get_doc_tool
        schema_fields = {"url"}
    else:
        import skills.registry as registry_module

        class Registry:
            def list(self) -> list[Any]:
                return [SimpleNamespace(name="linux-ops", description="Linux 运维参考")]

            def get_reference(self, name: str, _params: dict[str, Any]) -> dict[str, Any]:
                assert name == "linux-ops"
                if outcome == "not_found":
                    raise KeyError(name)
                if outcome == "error":
                    raise RuntimeError("qa fixture failure")
                return {
                    "name": "linux-ops",
                    "source": "fixture",
                    "content": "systemctl 用于查询 Linux 服务状态。",
                }

        monkeypatch.setattr(registry_module, "get_global_registry", Registry)
        factory = make_skill_invoke_tool
        schema_fields = {"skill_name", "input"}

    tool_fn = factory(ToolContext(agent_name="main", session_id=f"qa-{tool_name}-{outcome}"))
    direct = tool_fn(**tool_input)
    assert isinstance(direct, dict)
    assert direct.get("status") == outcome
    assert "toolUseId" not in direct
    if outcome == "success":
        assert isinstance(direct["content"], str) and direct["content"]
    if tool_name == "skill_invoke" and outcome == "success":
        assert direct["execution"] == "not_run"
        assert direct["content"] == "systemctl 用于查询 Linux 服务状态。"

    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry[tool_name].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]) == schema_fields
    assert "sdk_tool_context" not in schema["properties"]

    sdk_id = f"qa-sdk-{tool_name}-{outcome}"
    tool_use = {"toolUseId": sdk_id, "name": tool_name, "input": tool_input}
    invocation_state = {"agent": object()}

    async def run_stream():
        return [event async for event in tool_fn.stream(tool_use, invocation_state)]

    events = asyncio.run(run_stream())
    envelope = events[-1].tool_result
    assert envelope["status"] == "success"
    assert envelope["toolUseId"] == sdk_id
    assert isinstance(envelope["content"], list)
    assert all(isinstance(block, dict) for block in envelope["content"])
    assert _business_payload(envelope["content"]) == direct


@pytest.mark.parametrize("outcome", ["success", "binary", "unavailable", "error"])
def test_remote_file_result_stays_inside_real_sdk_content_envelope(outcome: str) -> None:
    class Bridge:
        calls = 0

        def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any:
            self.calls += 1
            assert method == "sftp_read"
            assert params == {
                "sessionId": 17, "path": "/etc/hosts", "max_size": 1048576,
            }
            if outcome == "success":
                return list("远程主机".encode("utf-8"))
            if outcome == "binary":
                return [0, 1]
            if outcome == "unavailable":
                return {"status": "unavailable", "reason": "qa_unavailable"}
            return {"status": "error", "error": "qa_failure"}

    ctx = ToolContext(
        rust_bridge=Bridge(), ssh_session_id="17", mode="confirm",
        agent_name="main", session_id=f"qa-remote-file-{outcome}",
    )
    tool_fn = make_remote_file_tool(ctx)
    tool_input = {"path": "/etc/hosts"}
    direct = tool_fn(**tool_input)
    assert direct["status"] == outcome
    assert "toolUseId" not in direct
    if outcome == "success":
        assert isinstance(direct["content"], str) and direct["content"]

    registry = ToolRegistry()
    registry.process_tools([tool_fn])
    schema = registry.registry["read_remote_file"].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]) == {"path", "ssh_session_id", "max_size", "encoding"}
    assert "sdk_tool_context" not in schema["properties"]

    sdk_id = f"qa-sdk-read-remote-file-{outcome}"
    tool_use = {"toolUseId": sdk_id, "name": "read_remote_file", "input": tool_input}
    invocation_state = {"agent": object()}

    async def run_stream():
        return [event async for event in tool_fn.stream(tool_use, invocation_state)]

    events = asyncio.run(run_stream())
    envelope = events[-1].tool_result
    assert envelope["status"] == "success"
    assert envelope["toolUseId"] == sdk_id
    assert isinstance(envelope["content"], list)
    assert all(isinstance(block, dict) for block in envelope["content"])
    assert _business_payload(envelope["content"]) == direct
    assert ctx.rust_bridge.calls == 2
