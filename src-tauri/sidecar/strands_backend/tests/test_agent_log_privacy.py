# secret-scan: fixture — 所有凭据样本均为合成数据，验证日志脱敏边界。
from __future__ import annotations

import json
import logging

import pytest


@pytest.fixture(autouse=True)
def isolated_log(tmp_path, monkeypatch):
    from strands_backend.agent_log import reset_for_test

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    yield tmp_path
    reset_for_test()


def _raw_log(tmp_path, session="privacy"):
    return (tmp_path / "agent-logs" / f"{session}.jsonl").read_text(encoding="utf-8")


def test_nested_objects_and_json_strings_redact_values_preserving_content_contract(isolated_log):
    from strands_backend.agent_log import log_event, tail

    secrets = [
        "pw_nest_71", "key_array_82", "cs_json_93", "rt_meta_14",
        "pem_value_25", "auth_value_36", "cookie_value_47",
    ]
    content = {
        "nested": {"Password": secrets[0]},
        "items": [{"api-key": secrets[1]}, {"clientSecret": secrets[2]}],
        "json": json.dumps({"refresh_token": secrets[3], "private-key": secrets[4]}),
        "authorization": {"Authorization": secrets[5]},
        "Cookie": secrets[6],
        "token_count": 12,
        "max_tokens": 99,
        "tool_call_id": "call-8",
        "session_id": "session-9",
        "enabled": True,
        "empty": None,
        "ordinary": "中文与 192.168.1.20",
    }
    meta = {
        "context": [{"COOKIE": secrets[6], "count": 4, "ok": False, "none": None}],
        "session_id": "session-9",
    }
    original_content, original_meta = json.loads(json.dumps(content)), json.loads(json.dumps(meta))
    assert log_event("privacy", "tool_call", content, meta=meta)
    line = tail(session_id="privacy", lines=1)["lines"][0]
    raw = _raw_log(isolated_log)
    assert isinstance(line["content"], str)
    assert isinstance(line["meta"], dict)
    for secret in secrets:
        assert secret not in raw
    assert line["meta"]["context"][0]["count"] == 4
    assert line["meta"]["context"][0]["ok"] is False
    assert line["meta"]["context"][0]["none"] is None
    for value in (12, 99, "call-8", "session-9", "192.168.1.20", "中文"):
        assert str(value) in line["content"]
    assert content == original_content and meta == original_meta


@pytest.mark.parametrize("encoded", [False, True])
def test_started_bus_json_params_are_redacted_without_mutating_other_subscribers(
    isolated_log, monkeypatch, encoded,
):
    from event_bus import Event, EventBus
    from strands_backend import agent_log

    secret = "started_private_123"
    params = {"clientSecret": secret, "command": "pwd"}
    payload = {
        "tool_name": "ssh_command", "status": "started",
        "params": json.dumps(params) if encoded else params, "tool_call_id": "call-7",
    }
    event = Event("tool_call", payload, session_id="privacy", source="test")
    original_payload = json.loads(json.dumps(payload))
    observed, notifications = [], []
    bus = EventBus(rust_notifier=lambda kind, data: notifications.append((kind, data)))
    bus.subscribe(lambda item: observed.append(item.payload), event_type="tool_call")
    monkeypatch.setattr("event_bus.get_global_bus", lambda: bus)
    agent_log._subscribe_bus()
    bus.publish(event)
    assert observed == [original_payload]
    assert notifications[0][1]["payload"] is payload
    assert payload == original_payload
    assert secret not in _raw_log(isolated_log)
    logged = agent_log.tail(session_id="privacy", lines=1)["lines"][0]
    assert logged["meta"]["tool_call_id"] == "call-7"
    assert "pwd" in logged["content"]


def test_existing_text_redaction_and_clip_contract_remain(isolated_log):
    from strands_backend.agent_log import log_event, tail

    pem = "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
    assert log_event(
        "privacy", "user_msg", f"Authorization: Bearer {'x' * 24}; {pem}; 内网 10.0.0.4",
    )
    assert log_event("privacy", "assistant_msg", "x" * 5000)
    lines = tail(session_id="privacy", lines=2)["lines"]
    assert "x" * 24 not in lines[0]["content"]
    assert "abc123" not in lines[0]["content"]
    assert "10.0.0.4" in lines[0]["content"]
    assert len(lines[1]["content"]) == 2001 and lines[1]["content"].endswith("…")
    assert log_event("privacy", "user_msg", None)
    assert tail(session_id="privacy", lines=1)["lines"][0]["content"] == ""


def test_redaction_and_write_exceptions_never_leak_or_escape(
    isolated_log, monkeypatch, caplog,
):
    from strands_backend import agent_log
    from strands_backend.tools import _redact

    secret = "exception_secret_77"

    def fail_redact(_text):
        raise RuntimeError(secret)

    original_redactor = _redact.redact_sensitive_text
    monkeypatch.setattr(_redact, "redact_sensitive_text", fail_redact)
    with caplog.at_level(logging.DEBUG):
        assert agent_log.log_event("privacy", "user_msg", "ordinary") is True
    assert secret not in caplog.text
    assert secret not in _raw_log(isolated_log)

    monkeypatch.setattr(_redact, "redact_sensitive_text", original_redactor)
    real_open = open

    def fail_open(*args, **kwargs):
        if str(args[0]).endswith("privacy.jsonl"):
            raise OSError(secret)
        return real_open(*args, **kwargs)

    monkeypatch.setattr("builtins.open", fail_open)
    with caplog.at_level(logging.DEBUG):
        assert agent_log.log_event("privacy", "user_msg", "ordinary") is False
    assert secret not in caplog.text


@pytest.mark.parametrize("wrapper", ["command", "markdown", "jsonl"])
def test_embedded_json_credentials_are_redacted(isolated_log, wrapper):
    from strands_backend.agent_log import log_event, tail

    value = '{"p\\u0061ssword": "embedded-credential-17", "exit_code": 0}'
    content = {
        "command": {"command": f"curl -d '{value}' https://example.invalid"},
        "markdown": f"配置如下：\n```json\n{value}\n```\n正常说明",
        "jsonl": value + '\n{"round": 2}',
    }[wrapper]
    assert log_event("privacy", "tool_result", content)
    assert "embedded-credential-17" not in _raw_log(isolated_log)
    assert "exit_code" in tail("privacy")["lines"][0]["content"]


def test_recognized_tokens_in_keys_still_redact(isolated_log):
    from strands_backend.agent_log import log_event

    token = "sk-" + "A" * 24
    assert log_event("privacy", "tool_result", {token: "正常内容"}, meta={token: 1})
    assert token not in _raw_log(isolated_log)
    assert "正常内容" in _raw_log(isolated_log)


@pytest.mark.parametrize("key", ["SecretAccessKey", "aws_secret_access_key"])
def test_secret_access_key_aliases_redact(isolated_log, key):
    from strands_backend.agent_log import log_event

    assert log_event("privacy", "tool_result", {key: "access-credential-17"})
    assert "access-credential-17" not in _raw_log(isolated_log)


@pytest.mark.parametrize("value", ['"cut-off-credential', '{"nested": "cut-off-credential"'])
def test_incomplete_embedded_json_drops_sensitive_tail(isolated_log, value):
    from strands_backend.agent_log import log_event, tail

    assert log_event("privacy", "tool_result", f'诊断前缀 {{"password": {value}')
    content = tail("privacy")["lines"][0]["content"]
    assert "cut-off-credential" not in _raw_log(isolated_log)
    assert "诊断前缀" in content and "REDACTED" in content


def test_unserializable_or_recursive_inputs_fail_closed(isolated_log, caplog):
    from strands_backend import agent_log

    class Unserializable:
        def __str__(self):
            return "unsupported-secret-17"

    recursive = []
    recursive.append(recursive)
    with caplog.at_level(logging.DEBUG):
        assert agent_log.log_event("privacy", "tool_result", Unserializable())
        assert agent_log.log_event("privacy", "tool_result", recursive)
        assert agent_log.log_event("privacy", "tool_result", "普通正文", meta={"x": recursive}) is False
    assert "unsupported-secret-17" not in _raw_log(isolated_log) + caplog.text
    assert "REDACTION_UNAVAILABLE" in _raw_log(isolated_log)
