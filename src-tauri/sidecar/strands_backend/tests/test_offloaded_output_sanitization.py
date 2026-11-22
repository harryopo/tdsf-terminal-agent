"""Ensure offloaded SFTP output is redacted before the model can retrieve it."""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any
from uuid import uuid4

import pytest
from strands import Agent
from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent

from strands_backend.adapter import ToolCallLimitHook, _context_management_kwargs
from strands_backend.evidence import reset_global_tracker
from strands_backend.tools import ToolContext
from strands_backend.tools.remote_file import make_remote_file_tool
from strands_backend.tests.test_strands_adapter_context import FakeContextModel


class _ReadBridge:
    def __init__(self, content: str) -> None:
        self.content = content

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> list[int]:
        assert method == "sftp_read"
        assert params == {"sessionId": 17, "path": "/etc/hosts", "max_size": 1048576}
        return list(self.content.encode("utf-8"))


def _payload(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    assert isinstance(blocks, list) and blocks
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
    pytest.fail(f"tool content did not contain a JSON business payload: {blocks!r}")


def _visible_text(blocks: list[dict[str, Any]]) -> str:
    return "\n".join(
        str(block.get("text", block.get("json", ""))) for block in blocks
    )


@pytest.mark.parametrize(("long_result", "repeats"), [(False, 2), (True, 2000)])
def test_remote_file_output_is_redacted_before_and_after_offload(
    long_result: bool, repeats: int,
) -> None:
    reset_global_tracker()
    secret = "qa-" + "fixture-secret-value"
    source = ("运维状态正常\n" * repeats) + "\nAPI_KEY=" + secret
    session_id = "offload-redaction-" + uuid4().hex
    ctx = ToolContext(
        rust_bridge=_ReadBridge(source), ssh_session_id="17", mode="confirm",
        agent_name="main", session_id=session_id,
    )
    tool_fn = make_remote_file_tool(ctx)
    hook = ToolCallLimitHook(agent_name="main", event_bus=None, session_id=session_id)
    agent = Agent(
        model=FakeContextModel(),
        tools=[tool_fn],
        hooks=[hook],
        **_context_management_kwargs(),
    )

    async def call_tool(tool: Any, name: str, tool_input: dict[str, Any], call_id: str):
        tool_use = {"toolUseId": call_id, "name": name, "input": tool_input}
        state = {"agent": agent}
        await agent.hooks.invoke_callbacks_async(BeforeToolCallEvent(
            agent=agent, selected_tool=tool, tool_use=tool_use,
            invocation_state=state,
        ))
        events = [event async for event in tool.stream(tool_use, state)]
        result = events[-1].tool_result
        after = AfterToolCallEvent(
            agent=agent, selected_tool=tool, tool_use=tool_use,
            invocation_state=state, result=result,
        )
        await agent.hooks.invoke_callbacks_async(after)
        return after.result

    try:
        initial = asyncio.run(call_tool(
            tool_fn, "read_remote_file", {"path": "/etc/hosts"}, "qa-read-1",
        ))
        assert initial["status"] == "success"
        assert initial["toolUseId"] == "qa-read-1"
        text = _visible_text(initial["content"])
        assert secret not in text

        if not long_result:
            business = _payload(initial["content"])
            assert business["status"] == "success"
            assert business["path"] == "/etc/hosts"
            assert "运维状态正常" in business["content"]
            assert "<REDACTED" in business["content"]
            return

        assert text.startswith("[Offloaded:")
        match = re.search(r"\[Stored references:\]\n\s+(\S+) \(", text)
        assert match, f"offloaded result omitted its storage reference: {text[:1000]}"
        registry_entry = agent.tool_registry.registry["retrieve_offloaded_content"]
        retrieved = asyncio.run(call_tool(
            registry_entry, "retrieve_offloaded_content",
            {"reference": match.group(1)}, "qa-readback-1",
        ))
        assert retrieved["status"] == "success"
        assert retrieved["toolUseId"] == "qa-readback-1"
        full = _payload(retrieved["content"])
        assert full["status"] == "success"
        assert full["path"] == "/etc/hosts"
        assert ("运维状态正常\n" * repeats) in full["content"]
        assert secret not in full["content"]
        assert "<REDACTED" in full["content"]
    finally:
        reset_global_tracker()
