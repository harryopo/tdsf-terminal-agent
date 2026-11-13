# secret-scan: fixture — Synthetic credentials exercise local log redaction.
import json
import uuid

import pytest

from rpc_request_context import agent_request_scope
from strands_backend import agent_log
from strands_backend.diagnostics import sanitize_diagnostic


@pytest.fixture(autouse=True)
def isolated_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    agent_log.reset_for_test()
    yield tmp_path
    agent_log.reset_for_test()


def test_rpc_identity_and_metadata_budget_survive_privacy_merge(isolated_logs):
    metadata = {"detail": "x" * 9000, "rpc_request_id": 999}
    with agent_request_scope(17):
        assert agent_log.log_event("integration", "tool_result", "x" * 2100, metadata)
    entry = json.loads((isolated_logs / "agent-logs/integration.jsonl").read_text("utf-8"))
    assert uuid.UUID(entry["event_id"])
    assert entry["meta"] == {"truncated": True, "rpc_request_id": 17}
    assert entry["content_truncated"] is True
    assert len(entry["content"]) == 2001
    assert metadata == {"detail": "x" * 9000, "rpc_request_id": 999}


def test_tuple_credentials_are_redacted_without_mutating_inputs(isolated_logs):
    content = ({"password": "tuple-content-synth-91"}, {"safe": "192.168.1.20"})
    meta = {"items": ({"token": "tuple-meta-synth-92"},)}
    assert agent_log.log_event("tuple-integration", "tool_result", content, meta)
    raw = (isolated_logs / "agent-logs/tuple-integration.jsonl").read_text("utf-8")
    assert "tuple-content-synth-91" not in raw
    assert "tuple-meta-synth-92" not in raw
    assert "192.168.1.20" in raw
    assert content == ({"password": "tuple-content-synth-91"}, {"safe": "192.168.1.20"})
    assert meta == {"items": ({"token": "tuple-meta-synth-92"},)}


@pytest.mark.parametrize("key", ["pwd", "idToken", "custom_token", "passphrase"])
def test_credential_key_union(key):
    assert sanitize_diagnostic({key: "synth-credential-73"}) == {key: "<REDACTED>"}
    assert sanitize_diagnostic(json.dumps(json.dumps({key: "synth-credential-73"}))).find("synth-credential-73") == -1


def test_existing_header_url_depth_and_observation_contracts():
    text = "Proxy-Authorization: synthetic header\nSet-Cookie: synthetic cookie\nsftp://alice:synthetic-pass@example.invalid/path\nordinary 192.168.1.20"
    safe = sanitize_diagnostic(text)
    for secret in ("synthetic header", "synthetic cookie", "synthetic-pass", "alice:"):
        assert secret not in safe
    assert "192.168.1.20" in safe
    nested = "end"
    for _ in range(25):
        nested = [nested]
    assert "depth-limit" in json.dumps(sanitize_diagnostic(nested))
    assert sanitize_diagnostic({"token_count": 12, "max_tokens": 99, "ok": True}) == {"token_count": 12, "max_tokens": 99, "ok": True}


@pytest.mark.parametrize("content", [
    json.dumps({"passphrase": "synthetic-legacy-credential-381", "peer": "192.168.1.20"}),
    "Proxy-Authorization: Basic synthetic-legacy-credential-381\npeer=192.168.1.20",
])
def test_legacy_content_is_redacted_on_read_without_rewriting_source(isolated_logs, content):
    directory = isolated_logs / "agent-logs"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "legacy-content.jsonl"
    original = (json.dumps({"ts": 1, "type": "tool_result", "content": content, "meta": {}}) + "\n").encode("utf-8")
    path.write_bytes(original)
    result = agent_log.tail("legacy-content", lines=10)
    assert result["returned"] == 1
    shown = json.dumps(result["lines"], ensure_ascii=False)
    assert "synthetic-legacy-credential-381" not in shown
    assert "192.168.1.20" in shown
    assert path.read_bytes() == original


def test_passphrase_is_redacted_from_content_and_metadata_on_disk(isolated_logs):
    content = {"passphrase": "synthetic-content-credential-382", "peer": "192.168.1.20"}
    metadata = {"passphrase": "synthetic-meta-credential-383", "count": 7}
    assert agent_log.log_event("passphrase-write", "tool_result", content, metadata)
    raw = (isolated_logs / "agent-logs/passphrase-write.jsonl").read_text("utf-8")
    assert "synthetic-content-credential-382" not in raw
    assert "synthetic-meta-credential-383" not in raw
    assert "192.168.1.20" in raw
    assert json.loads(raw)["meta"]["count"] == 7
    assert content["passphrase"] == "synthetic-content-credential-382"
    assert metadata["passphrase"] == "synthetic-meta-credential-383"
