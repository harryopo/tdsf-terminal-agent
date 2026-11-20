"""Content-free model timing uses actual SDK rounds, not reasoning flush times."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from strands import Agent, tool
from strands.models.model import Model

from strands_backend import adapter, agent_log
from strands_backend.adapter import TdsfStrandsCallbackHandler, ToolCallLimitHook


class OfflineModel(Model):
    def __init__(self):
        self.calls = 0

    def get_config(self):
        return {"model": "offline-timing"}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        yield None

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.calls += 1
        first = self.calls == 1
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {"toolUse": {
            "toolUseId": "timing-fixture", "name": "timing_probe",
        }} if first else {}}}
        if first:
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
        else:
            yield {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "private reasoning fixture"}}}}
        yield {"contentBlockStop": {}}
        if not first:
            yield {"contentBlockStart": {"start": {}}}
            for text in ("private output ", "fixture"):
                yield {"contentBlockDelta": {"delta": {"text": text}}}
            yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "tool_use" if first else "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}}}


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    agent_log.reset_for_test()
    yield
    agent_log.reset_for_test()


def timings():
    return agent_log.tail(session_id="timing-session", lines=100, event_type="model_timing")["lines"]


def test_actual_sdk_records_two_model_rounds_and_first_content_only():
    @tool
    def timing_probe() -> str:
        """Return a constant fixture; perform no command or network call."""
        return "private tool fixture"

    bus = MagicMock()
    handler = TdsfStrandsCallbackHandler(bus, session_id="timing-session")
    model = OfflineModel()
    agent = Agent(model=model, tools=[timing_probe], callback_handler=handler, hooks=[ToolCallLimitHook()])
    agent("private user fixture")
    rows = timings()
    assert [(r["meta"]["round"], r["meta"]["phase"]) for r in rows] == [
        (1, "request"), (1, "first_response"), (2, "request"), (2, "first_response"),
    ]
    assert [r["meta"]["response_type"] for r in rows if r["meta"]["phase"] == "first_response"] == ["tool", "reasoning"]
    assert model.calls == 2
    assert all(r["content"] == "" for r in rows)
    assert "private" not in str(rows)
    for row in rows:
        meta = row["meta"]
        if meta["phase"] == "first_response":
            assert meta["elapsed_ms"] >= 0
            assert set(meta) == {"phase", "round", "response_type", "elapsed_ms"}
        else:
            assert set(meta) == {"phase", "round"}
    assert bus.emit_agent_message.call_count == 3


def test_first_text_uses_monotonic_time_without_recording_lifecycle_events(monkeypatch):
    clock = [10.0]
    monkeypatch.setattr(adapter, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    bus = MagicMock()
    handler = TdsfStrandsCallbackHandler(bus, session_id="timing-session")
    hook = ToolCallLimitHook()
    hook._before_model_call(SimpleNamespace(agent=SimpleNamespace(callback_handler=handler)))
    handler(start=True)
    handler(data="")
    assert len(timings()) == 1
    clock[0] = 12.5
    handler(data="first")
    clock[0] = 15.0
    handler(data="second", complete=True)
    assert len(timings()) == 2
    assert timings()[1]["meta"] == {"phase": "first_response", "round": 1, "response_type": "text", "elapsed_ms": 2500.0}
    handler.begin_turn(teach=False, allow_teach_output=False)
    handler(data="not a model call")
    assert len(timings()) == 2


def test_timing_write_failure_does_not_drop_or_duplicate_stream(monkeypatch):
    bus = MagicMock()
    handler = TdsfStrandsCallbackHandler(bus, session_id="timing-session")
    hook = ToolCallLimitHook()
    monkeypatch.setattr(agent_log, "log_event", MagicMock(side_effect=OSError("fixture")))
    hook._before_model_call(SimpleNamespace(agent=SimpleNamespace(callback_handler=handler)))
    handler(data="first")
    handler(data="second")
    assert bus.emit_agent_message.call_count == 2
    assert agent_log.log_event.call_count == 2
