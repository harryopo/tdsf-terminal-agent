"""Actual SDK hooks/tool closures use the changed policy without replaying work."""
from __future__ import annotations

import threading
from unittest.mock import MagicMock

import pytest
from strands import tool
from strands.models.model import Model

from rpc_request_context import agent_request_scope
from strands_backend.adapter import StrandsAgentAdapter, _compose_system_prompt
from strands_backend.modes import AgentMode
from strands_backend.tools import assess_command

STREAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class BarrierModel(Model):
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.prompts = []

    def get_config(self):
        return {"model": "offline-mode-probe"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        yield None

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.prompts.append(system_prompt)
        first = len(self.prompts) == 1
        if first:
            assert "policy_probe" in {spec["name"] for spec in tool_specs}
            self.entered.set()
            assert self.release.wait(5), "mode-control test did not release model"
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {
            "toolUse": {"toolUseId": "policy-call", "name": "policy_probe"}
        } if first else {}}}
        yield {"contentBlockDelta": {"delta": {
            "toolUse": {"input": "{}"}
        } if first else {"text": "done"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use" if first else "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}}


@pytest.mark.parametrize(("initial", "changed", "expected"), [
    ("confirm", "auto", "allow"),
    ("auto", "confirm", "confirm"),
])
def test_live_mode_reaches_real_sdk_tool_closure_and_next_model_prompt(
    initial, changed, expected, tmp_path, monkeypatch,
):
    import needs_you
    from strands_backend.tools import python_run
    from strands_backend.trust_store import WhitelistStore

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    whitelist = WhitelistStore(tmp_path / "whitelist.json")
    monkeypatch.setattr("strands_backend.trust_store.get_global_whitelist", lambda: whitelist)
    needs_you.reset_for_test()
    ctxs = []
    decisions = []
    approvals = []
    model = BarrierModel()

    def reject_python_approval(ctx, command, risk_result, **kwargs):
        req = needs_you.get_global_service().request_approval(
            title="offline approval", description="offline test", session_id="mode-sdk",
        )
        needs_you.get_global_service().reject(req.id, "offline rejection")
        approvals.append(req)
        return req

    monkeypatch.setattr(python_run, "request_approval_and_wait", reject_python_approval)

    @tool
    def policy_probe() -> dict:
        """Assess a fixture without executing any command or Python code."""
        ctx = ctxs[0]
        shell = assess_command(ctx, "touch mode-fixture.txt")
        assert assess_command(ctx, "rm -rf /")["decision"] == "blocked"
        whitelist.add_rule("touch mode-ask.txt", "ask")
        assert assess_command(ctx, "touch mode-ask.txt")["decision"] == "confirm"
        py, _ = python_run._approval_gate(ctx, "open('mode-fixture.txt', 'w')", "offline")
        decisions.append((shell["decision"], py))
        return {"status": "success", "decision": shell["decision"]}

    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), rust_bridge=MagicMock(), backend_enabled=True,
        strands_model=model, extra_tools=[policy_probe],
    )
    original = adapter._build_tool_context

    def capture(*args, **kwargs):
        ctx = original(*args, **kwargs)
        ctxs.append(ctx)
        return ctx

    monkeypatch.setattr(adapter, "_build_tool_context", capture)
    results = []

    def run():
        with agent_request_scope(2001, STREAM):
            results.append(adapter.invoke("main", "offline policy probe", {
                "session_id": "mode-sdk", "live": {"agentMode": initial},
            }))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    try:
        assert model.entered.wait(5), "actual SDK model was never reached"
        assert decisions == []
        assert adapter.set_mode("mode-sdk", STREAM, changed, 1) == {
            "ok": True, "mode": changed, "revision": 1,
        }
        assert ctxs[0].mode == AgentMode(changed)
        model.release.set()
        worker.join(10)
        assert not worker.is_alive()
        assert results[0]["next_step"] == "done", results
        tool_results = [part["toolResult"] for message in next(iter(adapter._agent_cache.values())).messages
                        for part in message["content"] if "toolResult" in part]
        assert len(decisions) == 1, tool_results
        assert decisions[0][0] == expected
        if changed == "auto":
            assert decisions[0][1] is None
            assert approvals == []
        else:
            assert decisions[0][1]["status"] == "rejected"
            assert len(approvals) == 1
        assert len(model.prompts) == 2
        assert model.prompts[0] != model.prompts[1]
        agent = next(iter(adapter._agent_cache.values()))
        assert agent.system_prompt == _compose_system_prompt(
            AgentMode(changed), False, base=adapter.system_prompt,
        )
        assert "policy_probe" in agent.tool_names
        assert "retrieve_offloaded_content" in agent.tool_names
        assert adapter._invocation_modes == {}
        assert adapter._limit_hooks[("main", "mode-sdk")].refresh_mode is None
        assert adapter.set_mode("mode-sdk", STREAM, initial, 2)["reason"] == "not_active"
    finally:
        model.release.set()
        worker.join(10)
        needs_you.reset_for_test()
