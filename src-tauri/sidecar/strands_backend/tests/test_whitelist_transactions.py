"""CR02/CR03: temporary policies; no user data or network."""
import json
import threading
from unittest.mock import patch

import pytest

from strands_backend.trust_store import WhitelistStore


@pytest.mark.parametrize("data", [
    {"rules": [{"pattern": "safe", "decision": "allow"}, {"pattern": "blocked", "decision": "denyy"}]},
    {"rules": [{"pattern": "safe", "decision": "allow"}, None]},
    {"rules": [{"pattern": 123, "decision": "deny"}]},
    {"rules": [{"pattern": "blocked", "decision": 123}]},
    {"not_rules": []}, {"rules": None},
])
def test_invalid_policy_preserves_last_trusted_rules(tmp_path, data):
    p = tmp_path / "policy.json"
    store = WhitelistStore(path=p)
    store.add_rule("blocked", "deny")
    p.write_text(json.dumps(data), encoding="utf-8")
    store.load()
    assert store.degraded
    assert store.match_command("blocked") == "deny"
    assert store.match_command("safe") is None

@pytest.mark.parametrize("data", [{"rules": []}, []])
def test_explicit_empty_policy_is_valid(tmp_path, data):
    p = tmp_path / "policy.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    store = WhitelistStore(path=p)
    assert not store.degraded
    assert store.list_rules() == []

@pytest.mark.parametrize("failed_operation", ["mkdir", "replace"])
def test_save_failure_preserves_memory_and_file(tmp_path, failed_operation):
    p = tmp_path / "policy.json"
    store = WhitelistStore(path=p)
    store.add_rule("blocked", "deny")
    before = p.read_bytes()
    target = ("pathlib.Path.mkdir" if failed_operation == "mkdir"
              else "strands_backend.trust_store.os.replace")
    with patch(target, side_effect=OSError("synthetic failure")):
        with pytest.raises(OSError):
            store.add_rule("safe", "allow")
    assert store.degraded
    assert store.match_command("blocked") == "deny"
    assert store.match_command("safe") is None
    assert p.read_bytes() == before

def test_concurrent_updates_commit_as_one_transaction(tmp_path):
    p = tmp_path / "policy.json"
    store = WhitelistStore(path=p)
    original = store._persist
    persisted = threading.Event()
    release = threading.Event()
    second_started = threading.Event()
    second_done = threading.Event()
    errors = []
    def persist(rules):
        original(rules)
        if threading.current_thread().name == "first-writer":
            persisted.set()
            if not release.wait(5):
                raise RuntimeError("barrier timeout")
    store._persist = persist
    def first():
        try:
            store.add_rule("blocked", "deny")
        except Exception as exc:
            errors.append(exc)
    def second():
        second_started.set()
        try:
            store.add_rule("safe", "allow")
        except Exception as exc:
            errors.append(exc)
        finally:
            second_done.set()
    a = threading.Thread(target=first, name="first-writer")
    b = threading.Thread(target=second, name="second-writer")
    a.start()
    assert persisted.wait(5)
    b.start()
    try:
        assert second_started.wait(5)
        # The competing operation must not complete while the first commit is paused.
        assert not second_done.wait(0.2)
    finally:
        release.set()
        a.join(5)
        b.join(5)
    assert not a.is_alive() and not b.is_alive() and not errors
    expected = {"blocked", "safe"}
    assert {r["pattern"] for r in store.list_rules()} == expected
    assert {r["pattern"] for r in json.loads(p.read_text(encoding="utf-8"))["rules"]} == expected
    assert WhitelistStore(path=p).match_command("blocked") == "deny"
