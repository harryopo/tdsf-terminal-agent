from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _isolated_logs(tmp_path, monkeypatch):
    from strands_backend.agent_log import reset_for_test

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    yield tmp_path
    reset_for_test()


def _dispatcher():
    class Dispatcher:
        def __init__(self):
            self.methods = {}

        def register(self, name, handler):
            self.methods[name] = handler

    return Dispatcher()


def test_log_events_have_stable_ids_and_truthful_truncation():
    from strands_backend.agent_log import log_event, tail

    log_event("s1", "assistant_msg", "short")
    log_event("s1", "assistant_msg", "x" * 5000)
    events = tail("s1", lines=10)["lines"]

    assert len({event["event_id"] for event in events}) == 2
    assert all(uuid.UUID(event["event_id"]) for event in events)
    assert [event["event_id"] for event in tail("s1", lines=10)["lines"]] == [
        event["event_id"] for event in events
    ]
    assert events[0]["content_truncated"] is False
    assert events[1]["content_truncated"] is True


def test_legacy_tail_does_not_invent_truncation_false(_isolated_logs):
    from strands_backend.agent_log import _log_file, tail

    path = _log_file("legacy")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"ts": 1, "type": "user_msg", "content": "old", "meta": {}}) + "\n", encoding="utf-8")

    event = tail("legacy")["lines"][0]
    assert "content_truncated" not in event


def test_credentials_are_recursively_redacted_from_meta_and_json_content():
    from strands_backend.agent_log import log_event, tail

    secrets = ["pw-secret", "key-secret", "token-secret", "auth-secret", "cookie-secret"]
    meta = {
        "nested": [
            {"password": secrets[0]},
            {"api_key": secrets[1]},
            {"token": secrets[2]},
            {"authorization": secrets[3]},
            {"cookie": secrets[4]},
        ]
    }
    content = json.dumps({"credentials": {"password": secrets[0], "api_key": secrets[1]}})
    log_event("s1", "tool_call", content, meta=meta)

    event = tail("s1")["lines"][0]
    serialized = json.dumps(event, ensure_ascii=False)
    for secret in secrets:
        assert secret not in serialized
    assert "REDACTED" in serialized


def test_tail_is_bounded_reports_window_and_ignores_leading_fragment(_isolated_logs):
    from strands_backend.agent_log import _log_file, tail

    path = _log_file("large")
    path.parent.mkdir(parents=True, exist_ok=True)
    complete = json.dumps({"ts": 1, "type": "user_msg", "content": "tail", "meta": {}})
    path.write_bytes(("{" + "x" * (2 * 1024 * 1024) + "}\n" + complete + "\n").encode("utf-8"))
    path.with_name(path.name + ".1").write_text("archived", encoding="utf-8")

    result = tail("large", lines=5000)
    assert result["window_limited"] is True
    assert result["archive_available"] is True
    assert result["total_in_file"] is None
    assert result["lines"] == [json.loads(complete)]
    assert result["returned"] <= 1000
    assert result["invalid_lines"] == 0


def test_tail_caps_requested_lines_at_one_thousand():
    from strands_backend.agent_log import log_event, tail

    for i in range(1005):
        log_event("many", "user_msg", str(i))
    result = tail("many", lines=5000)

    assert result["returned"] == 1000
    assert result["total_in_file"] == 1005
    assert result["window_limited"] is True
    assert result["invalid_lines"] == 0


def test_tail_counts_only_invalid_complete_lines(_isolated_logs):
    from strands_backend.agent_log import _log_file, tail

    path = _log_file("invalid")
    path.parent.mkdir(parents=True, exist_ok=True)
    valid = json.dumps({"ts": 1, "type": "user_msg", "content": "ok", "meta": {}})
    path.write_text(valid + "\nnot-json\n{" , encoding="utf-8")

    result = tail("invalid", lines=10)
    assert result["invalid_lines"] == 1
    assert result["total_in_file"] is None
    assert result["returned"] == 1


def test_tail_returns_not_ok_when_log_read_fails(_isolated_logs, monkeypatch):
    import builtins
    from strands_backend import agent_log

    path = agent_log._log_file("unreadable")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n", encoding="utf-8")

    def fail_read(file, *args, **kwargs):
        if Path(file) == path:
            raise OSError("read denied")
        return original_open(file, *args, **kwargs)

    original_open = builtins.open
    monkeypatch.setattr(builtins, "open", fail_read)
    result = agent_log.tail("unreadable")
    assert result["ok"] is False


def test_export_snapshot_validates_schema_size_and_session_and_uses_exclusive_file(_isolated_logs):
    from strands_backend.diagnostics import export_snapshot

    snapshot = {"schema_version": 1, "session_id": "s1", "sources": []}
    result = export_snapshot("s1", snapshot)
    output = Path(result["path"])
    assert result["ok"] is True
    assert output.parent == _isolated_logs / "diagnostics"
    assert output.name.startswith("diagnostics-") and output.suffix == ".json"
    assert json.loads(output.read_text(encoding="utf-8")) == snapshot
    second = Path(export_snapshot("s1", snapshot)["path"])
    assert second != output
    assert second.is_file()

    for session_id, invalid in (
        ("other", snapshot),
        ("s1", {**snapshot, "schema_version": 2}),
        ("s1", {**snapshot, "schema_version": True}),
        ("s1", {**snapshot, "sources": "x" * (2 * 1024 * 1024)}),
    ):
        with pytest.raises(ValueError):
            export_snapshot(session_id, invalid)
    with pytest.raises(ValueError):
        export_snapshot(1, {**snapshot, "session_id": 1})


def test_snapshot_sanitizer_recurses_without_mutating_input():
    from strands_backend.diagnostics import sanitize_diagnostic

    value = {"items": [{"password": "secret", "safe": "visible"}]}
    sanitized = sanitize_diagnostic(value)

    assert sanitized["items"][0]["password"] != "secret"
    assert sanitized["items"][0]["safe"] == "visible"
    assert value["items"][0]["password"] == "secret"


def test_diagnostic_text_redacts_quoted_api_key_cli_flag_and_url_credentials():
    from strands_backend.diagnostics import sanitize_diagnostic

    value = (
        'API_KEY="two word secret"; '
        "curl --api-key 'two word secret' "
        "https://alice:url-secret@example.test/path; "  # secret-scan: fixture-line
        'password: "first second"; token: "first second"; '
        'password: "first \\"second\\" third"; '
        "password: 'first''second'"
    )
    sanitized = sanitize_diagnostic(value)

    assert "two word secret" not in sanitized
    assert "url-secret" not in sanitized
    assert "alice:" not in sanitized
    assert "first second" not in sanitized
    assert 'first "second" third' not in sanitized
    assert "first''second" not in sanitized


def test_old_disk_meta_is_redacted_on_read_without_rewriting_source(_isolated_logs):
    from strands_backend.agent_log import _log_file, tail

    path = _log_file("old-meta")
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps({
        "ts": 1,
        "type": "tool_call",
        "content": "old command",
        "meta": {
            "nested": [
                {"api_key": "disk-key-secret"},
                {"command": 'API_KEY="two word secret" --api-key \'two word secret\' https://alice:url-secret@example.test'},  # secret-scan: fixture-line
            ]
        },
    }, ensure_ascii=False).encode("utf-8") + b"\n"
    path.write_bytes(raw)

    event = tail("old-meta")["lines"][0]
    observed = json.dumps(event, ensure_ascii=False)
    for secret in ("disk-key-secret", "two word secret", "url-secret", "alice:"):
        assert secret not in observed
    assert path.read_bytes() == raw


def test_exported_file_contains_no_sensitive_text(_isolated_logs):
    from strands_backend.diagnostics import export_snapshot

    snapshot = {
        "schema_version": 1,
        "session_id": "s1",
        "sources": [
            'API_KEY="two word secret"',
            "curl --api-key 'two word secret' https://alice:url-secret@example.test/path",  # secret-scan: fixture-line
            'password: "first second"; token: "first second"',
            'password: "first \\"second\\" third"',
            "password: 'first''second'",
        ],
    }
    output = Path(export_snapshot("s1", snapshot)["path"])
    written = output.read_text(encoding="utf-8")

    for secret in (
        "two word secret", "url-secret", "alice:", "first second",
        'first "second" third', "first''second",
    ):
        assert secret not in written
    assert "REDACTED" in written


def test_export_rpc_is_registered_and_maps_snapshot_to_export(_isolated_logs):
    from strands_backend.agent_log import register_methods

    dispatcher = _dispatcher()
    register_methods(dispatcher)
    assert "debug.export_session_diagnostics" in dispatcher.methods
    result = dispatcher.methods["debug.export_session_diagnostics"](
        session_id="s1", snapshot={"schema_version": 1, "session_id": "s1"}
    )
    assert result["ok"] is True
    assert Path(result["path"]).is_file()


def test_real_bus_logs_needs_you_safely_and_subscribes_once(_isolated_logs, monkeypatch):
    import event_bus as event_bus_module
    from event_bus import EventBus
    from strands_backend.agent_log import register_methods, tail

    bus = EventBus()
    monkeypatch.setattr(event_bus_module, "get_global_bus", lambda: bus)
    dispatcher = _dispatcher()
    register_methods(dispatcher)
    register_methods(dispatcher)
    assert len([s for s in bus._subscribers if s.name == "agent_log"]) == 1

    from event_bus import Event

    bus.publish(Event(
        event_type="needs_you",
        payload={
            "event": "created",
            "request": {
                "id": "request-17",
                "type": "approval",
                "status": "pending",
                "title": "Confirm deploy",
                "description": "Review deployment request",
                "response": {"token": "response-secret"},
            },
        },
        session_id="s1",
        source="needs_you_service",
    ))

    events = tail("s1", lines=10)["lines"]
    assert len(events) == 1
    assert events[0]["type"] == "needs_you"
    assert events[0]["meta"] == {
        "request_id": "request-17",
        "needs_type": "approval",
        "event": "created",
        "status": "pending",
    }
    assert "Confirm deploy" in events[0]["content"]
    assert "Review deployment request" in events[0]["content"]
    assert "response-secret" not in json.dumps(events[0])
