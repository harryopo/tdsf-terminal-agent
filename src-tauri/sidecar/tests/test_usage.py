from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from strands_backend.usage import (
    UsageEvent,
    UsageStore,
    event_from_mapping,
    extract_usage,
    get_global_usage_store,
    normalize_usage,
    record_response_usage,
    register_methods,
    reset_global_usage_store,
    response_usage_event,
)


def test_unknown_fields_stay_null_while_real_zero_stays_zero() -> None:
    result = normalize_usage({"input_tokens": 0, "output_tokens": None})

    assert result["input_tokens"] == 0
    assert result["output_tokens"] is None
    assert result["total_tokens"] is None
    assert result["cached_input_tokens"] is None
    assert result["reasoning_tokens"] is None


def test_aliases_and_nested_cache_are_normalized_without_blind_addition() -> None:
    result = normalize_usage({
        "prompt_tokens": 20,
        "completion_tokens": 8,
        "prompt_tokens_details": {"cached_tokens": 5},
        "completion_tokens_details": {"reasoning_tokens": 3},
    })

    assert result["input_tokens"] == 20
    assert result["output_tokens"] == 8
    assert result["cached_input_tokens"] == 5
    assert result["reasoning_tokens"] == 3
    assert result["total_tokens"] is None


def test_extract_marks_strands_aggregate_and_latest_cycle_separately() -> None:
    latest = SimpleNamespace(usage={"input_tokens": 7, "output_tokens": 2})
    invocation = SimpleNamespace(
        usage={"input_tokens": 15, "output_tokens": 5, "total_tokens": 20},
        cycles=[latest],
    )
    response = SimpleNamespace(metrics=SimpleNamespace(latest_agent_invocation=invocation))

    result = extract_usage(response)

    assert result["input_tokens"] == 15
    assert result["last_input_tokens"] == 7
    assert result["_granularity"] == "invocation_aggregate"


def make_event(event_id: str = "event-1", **overrides: object) -> UsageEvent:
    values: dict[str, object] = {
        "event_id": event_id,
        "call_id": "call-1",
        "attempt_id": "attempt-1",
        "revision": 1,
        "update_mode": "cumulative",
        "granularity": "model_call",
        "session_id": "session-1",
        "turn_id": "turn-1",
        "provider": "openai",
        "requested_model": "gpt-test",
        "resolved_model": "gpt-test",
        "status": "completed",
        "completed_at": "2026-11-20T00:00:00+00:00",
        "input_tokens": 10,
        "output_tokens": 4,
        "total_tokens": 14,
    }
    values.update(overrides)
    return UsageEvent(**values)  # type: ignore[arg-type]


def test_duplicate_and_stale_replay_do_not_change_summary(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    event = make_event()

    assert store.record(event) == "recorded"
    assert store.record(event) == "duplicate"
    assert store.record(make_event("old", revision=0, input_tokens=999)) == "stale"
    summary = store.query()["summary"]
    assert summary["event_count"] == 1
    assert summary["input_tokens"] == 10


def test_delta_revisions_arriving_out_of_order_are_each_counted_once(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    later = make_event("second", revision=2, update_mode="delta", input_tokens=5)
    earlier = make_event("first", revision=1, update_mode="delta", input_tokens=2)
    assert store.record(later) == "recorded"
    assert store.record(earlier) == "recorded"
    assert store.record(earlier) == "duplicate"
    assert store.query(days=0)["summary"]["input_tokens"] == 7


def test_one_shared_strands_metrics_object_does_not_double_count_calls(tmp_path: Path) -> None:
    from strands.telemetry.metrics import EventLoopMetrics

    store = UsageStore(tmp_path / "usage.db")
    metrics = EventLoopMetrics()
    response = SimpleNamespace(metrics=metrics)
    for index, token_count in enumerate((10, 4)):
        metrics.reset_usage_metrics()
        metrics.update_usage({"inputTokens": token_count, "outputTokens": 0, "totalTokens": token_count})
        event = response_usage_event(
            response, session_id="session-1", turn_id="turn-1",
            call_id=f"call-{index}", status="completed",
        )
        assert event is not None
        assert store.record(event) == "recorded"
    assert store.query(days=0)["summary"]["input_tokens"] == 14


def test_cumulative_replaces_stream_snapshot_but_delta_accumulates(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    store.record(make_event("stream-1", input_tokens=3, output_tokens=1, total_tokens=4))
    store.record(make_event("final", revision=2, input_tokens=10, output_tokens=4, total_tokens=14))
    store.record(make_event(
        "delta-1", call_id="delta-call", update_mode="delta", revision=1,
        input_tokens=2, output_tokens=1, total_tokens=None,
    ))
    store.record(make_event(
        "delta-2", call_id="delta-call", update_mode="delta", revision=2,
        input_tokens=5, output_tokens=2, total_tokens=None,
    ))

    summary = store.query()["summary"]
    assert summary["input_tokens"] == 17
    assert summary["output_tokens"] == 7
    assert summary["total_tokens"] == 14


def test_aggregate_coverage_is_order_independent(tmp_path: Path) -> None:
    for aggregate_first in (False, True):
        store = UsageStore(tmp_path / f"usage-{aggregate_first}.db")
        child = make_event("child", call_id="child-call", input_tokens=10)
        aggregate = make_event(
            "aggregate", call_id="aggregate-call", granularity="invocation_aggregate",
            covers_call_ids=("child-call",), input_tokens=10,
        )
        events = (aggregate, child) if aggregate_first else (child, aggregate)
        results = [store.record(event) for event in events]

        assert store.query()["summary"]["input_tokens"] == 10
        assert store.query()["summary"]["event_count"] == 1
        if aggregate_first:
            assert results[-1] == "covered"


def test_retry_attempts_and_terminal_states_are_counted_separately(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    store.record(make_event("failed", attempt_id="attempt-1", status="failed", output_tokens=None))
    store.record(make_event("cancelled", attempt_id="attempt-2", status="cancelled", input_tokens=0))

    events = store.query()["events"]
    assert [event["status"] for event in events] == ["cancelled", "failed"]
    assert store.query()["summary"]["event_count"] == 2
    assert store.query()["summary"]["input_tokens"] == 10


def test_restart_replay_is_idempotent_and_session_query_uses_same_facts(tmp_path: Path) -> None:
    path = tmp_path / "usage.db"
    event = make_event()
    UsageStore(path).record(event)

    reopened = UsageStore(path)
    assert reopened.record(event) == "duplicate"
    assert reopened.query(session_id="session-1")["summary"] == reopened.query()["summary"]
    with sqlite3.connect(path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM session_usage_summary").fetchone()[0] == 1


def test_filtering_and_empty_results_distinguish_zero_from_unknown(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    store.record(make_event())
    store.record(make_event(
        "unknown", call_id="other", session_id="other", provider="anthropic",
        input_tokens=None, output_tokens=None, total_tokens=None,
    ))

    assert store.query(provider="anthropic")["summary"]["input_tokens"] is None
    assert store.query(session_id="missing")["summary"]["event_count"] == 0
    assert store.query(session_id="missing")["summary"]["input_tokens"] is None
    assert store.query(days=0)["summary"]["event_count"] == 2


def test_event_mapping_rejects_sensitive_payload_and_invalid_revision() -> None:
    with pytest.raises(ValueError, match="^usage 事件包含禁止字段: prompt$"):
        event_from_mapping({"event_id": "x", "prompt": "secret"})
    with pytest.raises(ValueError, match="^revision 必须是非负整数$"):
        make_event(revision=-1)


def test_query_returns_serializable_trend_without_sensitive_text(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    store.record(make_event())

    result = store.query()
    encoded = json.dumps(result)
    assert len(result["trend"]) == 1
    point = result["trend"][0]
    assert {key: point[key] for key in ("date", "event_count", "input_tokens", "output_tokens", "total_tokens")} == {
        "date": "2026-11-20", "event_count": 1, "input_tokens": 10,
        "output_tokens": 4, "total_tokens": 14,
    }
    assert point["cached_input_tokens"] is None
    assert point["reasoning_tokens"] is None
    assert "prompt" not in encoded
    assert "command" not in encoded
    assert "response" not in encoded

def test_normalize_accepts_object_usage_and_ignores_invalid_token_shapes() -> None:
    result = normalize_usage(SimpleNamespace(
        inputTokens=3,
        outputTokens=True,
        totalTokens=-1,
        cacheReadInputTokens=1,
        cacheCreationInputTokens=2,
        reasoningTokens=1,
    ))
    assert result["input_tokens"] == 3
    assert result["output_tokens"] is None
    assert result["total_tokens"] is None
    assert result["cached_input_tokens"] == 1
    assert result["cache_creation_input_tokens"] == 2
    assert normalize_usage("not-a-usage")["input_tokens"] is None


def test_extract_handles_none_dict_metrics_direct_usage_and_empty_aggregate() -> None:
    assert extract_usage(None) == {}
    assert extract_usage(SimpleNamespace(metrics={"inputTokens": 2})) == {
        "input_tokens": 2,
        "output_tokens": None,
        "total_tokens": None,
        "cached_input_tokens": None,
        "cache_creation_input_tokens": None,
        "reasoning_tokens": None,
        "_granularity": "invocation_aggregate",
    }
    direct = extract_usage(SimpleNamespace(usage=SimpleNamespace(inputTokens=4)))
    assert direct["input_tokens"] == 4
    assert direct["last_input_tokens"] == 4
    assert direct["_granularity"] == "model_call"
    empty = SimpleNamespace(metrics=SimpleNamespace(
        latest_agent_invocation=SimpleNamespace(usage={}, cycles=[]),
    ))
    assert extract_usage(empty) == {}


@pytest.mark.parametrize("field_name", ["event_id", "call_id", "attempt_id", "session_id", "turn_id"])
def test_event_rejects_empty_stable_identity(field_name: str) -> None:
    with pytest.raises(ValueError, match=f"^{field_name} 不能为空$"):
        make_event(**{field_name: ""})


def test_event_rejects_invalid_modes_tokens_and_unknown_mapping_fields() -> None:
    with pytest.raises(ValueError, match="^update_mode 必须是 cumulative/delta$"):
        make_event(update_mode="snapshot")
    with pytest.raises(ValueError, match="^granularity 必须是 model_call/invocation_aggregate$"):
        make_event(granularity="unknown")
    with pytest.raises(ValueError, match="^input_tokens 必须是非负整数或 null$"):
        make_event(input_tokens=True)
    with pytest.raises(ValueError, match="^usage 事件包含未知字段: bogus$"):
        event_from_mapping({"bogus": 1})


def test_event_mapping_converts_coverage_and_public_dict_has_no_sensitive_text() -> None:
    payload = make_event().to_dict()
    payload["covers_call_ids"] = ["child"]
    event = event_from_mapping(payload)
    assert event.covers_call_ids == ("child",)
    assert event.to_dict()["covers_call_ids"] == ["child"]


def test_record_rejects_conflicting_replay_mode_and_revision(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    store.record(make_event())
    with pytest.raises(ValueError, match="^event_id 重放内容不一致$"):
        store.record(make_event(input_tokens=999))
    with pytest.raises(ValueError, match="^同一 call/attempt 不能混用 cumulative 与 delta$"):
        store.record(make_event("other", revision=2, update_mode="delta"))
    with pytest.raises(ValueError, match="^同一 call/attempt/revision 的事件身份不一致$"):
        store.record(make_event("other", revision=1))


def test_model_filter_matches_requested_or_resolved_model(tmp_path: Path) -> None:
    store = UsageStore(tmp_path / "usage.db")
    store.record(make_event())
    assert store.query(model="gpt-test")["summary"]["event_count"] == 1
    assert store.query(model="missing")["summary"]["event_count"] == 0


def test_response_event_uses_stable_identity_and_no_usage_is_explicit() -> None:
    response = SimpleNamespace(
        id="physical-call", attempt_id=2, revision=3,
        usage={"input_tokens": 5, "output_tokens": 0},
    )
    first = response_usage_event(
        response, session_id="s", turn_id="t", status="cancelled",
    )
    second = response_usage_event(
        response, session_id="s", turn_id="t", status="cancelled",
    )
    assert first is not None and second is not None
    assert first.event_id == second.event_id
    assert first.call_id == "physical-call"
    assert first.attempt_id == "2"
    assert first.revision == 3
    assert first.provider == "unknown"
    assert first.output_tokens == 0
    assert response_usage_event(None, session_id="s", turn_id="t", status="failed") is None


def test_global_store_reopens_on_path_change_and_records_response(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "one"))
    reset_global_usage_store()
    first = get_global_usage_store()
    assert get_global_usage_store() is first
    assert record_response_usage(None, session_id="s", turn_id="t", status="completed") == "no_usage"
    response = SimpleNamespace(usage={"input_tokens": 1})
    assert record_response_usage(response, session_id="s", turn_id="t", status="completed") == "recorded"
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "two"))
    second = get_global_usage_store()
    assert second is not first
    reset_global_usage_store()


def test_rpc_registration_supports_camel_case_session_filter(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_global_usage_store()
    get_global_usage_store().record(make_event())

    class Dispatcher:
        def __init__(self) -> None:
            self.methods = {}

        def register(self, name, handler) -> None:
            self.methods[name] = handler

    dispatcher = Dispatcher()
    register_methods(dispatcher)
    assert set(dispatcher.methods) == {"usage.summary", "usage.events"}
    result = dispatcher.methods["usage.summary"](sessionId="session-1", model="gpt-test")
    assert result["summary"]["event_count"] == 1
    assert dispatcher.methods["usage.events"](sessionId="missing")["summary"]["event_count"] == 0
    reset_global_usage_store()
