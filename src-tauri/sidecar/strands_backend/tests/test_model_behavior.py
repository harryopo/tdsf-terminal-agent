"""No-network behavior tests through the real Strands Agent registration path."""
from __future__ import annotations

import copy
from unittest.mock import MagicMock

import pytest
from strands.models.model import Model

from strands_backend.adapter import StrandsAgentAdapter
from strands_backend.usage import get_global_usage_store, reset_global_usage_store


class BehaviorModel(Model):
    def __init__(self) -> None:
        self.seen = []

    def get_config(self):
        return {"model": "behavior-fixture"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        yield None

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.seen.append({
            "messages": copy.deepcopy(messages),
            "tool_specs": copy.deepcopy(tool_specs),
            "system_prompt": system_prompt,
        })
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "reply-Behavior"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {
            "inputTokens": 1, "outputTokens": 1, "totalTokens": 2,
        }}}


@pytest.fixture(autouse=True)
def _isolate_usage(tmp_path, monkeypatch):
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()
    reset_global_usage_store()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()
    reset_global_usage_store()


def test_real_strands_turn_binds_profile_snapshot_and_persistent_usage(tmp_path) -> None:
    model = BehaviorModel()
    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(), rust_bridge=MagicMock(), backend_enabled=True,
        strands_model=model,
    )
    snapshot = {
        "configSnapshotId": "snapshot-old",
        "configGeneration": 3,
        "provider": "openai",
        "requestedModel": "behavior-fixture",
        "resolvedModel": "behavior-fixture",
    }
    adapter.update_model(model, turn_snapshot=snapshot)

    result = adapter.invoke("main", "请重启 nginx 并验证状态", {
        "session_id": "behavior-session",
        "_rpc_stream_id": "00000000-0000-4000-8000-000000000101",
        "live": {"agentMode": "confirm"},
    })

    assert result["observation"] == "reply-Behavior\n"
    assert result["turn_policy"]["intent"] == "command"
    assert result["turn_policy"]["format_issues"]
    assert result["model_turn_snapshot"] == snapshot
    assert "【输出策略：command】" in str(model.seen[-1]["messages"])
    assert result["tokens"]["input_tokens"] == 1
    stored = get_global_usage_store().query(session_id="behavior-session")
    assert stored["summary"]["input_tokens"] == 1
    assert stored["summary"]["output_tokens"] == 1
    assert stored["events"][0]["config_snapshot_id"] == "snapshot-old"
    assert stored["events"][0]["granularity"] == "invocation_aggregate"
