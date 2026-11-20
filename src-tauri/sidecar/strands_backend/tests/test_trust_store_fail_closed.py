"""T4 回归：白名单不可信时必须 fail-closed，且保存具备原子性（V3）。

修复前：`load` 把"文件损坏"静默降级为空规则表，用户配置的 deny 规则失效；
`save` 非原子写，崩溃可能留下半个 JSON。本文件覆盖：
- 首次无文件 ≠ 损坏；
- 损坏即降级，allow 自动放行失效；
- 运行中重载失败保留最后可信 deny；
- 原子保存产生完整 JSON；
- 保存失败不污染内存与旧文件。
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from strands_backend.modes import AgentMode
from strands_backend.tools import assess_command
from strands_backend.trust_store import DECISION_ALLOW, DECISION_DENY, WhitelistStore


def test_missing_file_is_not_degraded(tmp_path) -> None:
    store = WhitelistStore(tmp_path / "agent_whitelist.json")
    assert store.degraded is False
    assert store.list_rules() == []


def test_corrupted_file_disables_allow(tmp_path) -> None:
    path = tmp_path / "agent_whitelist.json"
    path.write_text('{"rules": [{"pattern": "cat *", "decision": "allow"}', encoding="utf-8")
    store = WhitelistStore(path)
    assert store.degraded is True
    assert store.match_command("cat /etc/hostname") is None


def test_reload_failure_keeps_last_known_deny(tmp_path) -> None:
    path = tmp_path / "agent_whitelist.json"
    store = WhitelistStore(path)
    store.add_rule("rm *", DECISION_DENY)
    assert store.match_command("rm -rf /tmp/x") == "deny"
    path.write_text('{"rules": [', encoding="utf-8")  # 外部截断
    store.load()
    assert store.degraded is True
    assert store.match_command("rm -rf /tmp/x") == "deny"


def test_atomic_save_produces_complete_json(tmp_path) -> None:
    path = tmp_path / "agent_whitelist.json"
    store = WhitelistStore(path)
    store.add_rule("cat *", DECISION_ALLOW)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["rules"][0]["pattern"] == "cat *"
    assert not (tmp_path / "agent_whitelist.json.tmp").exists()


def test_save_failure_keeps_old_file_and_memory(tmp_path, monkeypatch) -> None:
    path = tmp_path / "agent_whitelist.json"
    store = WhitelistStore(path)
    store.add_rule("cat *", DECISION_ALLOW)
    old_text = path.read_text(encoding="utf-8")

    def boom(*_args):
        raise OSError("disk full")

    monkeypatch.setattr("strands_backend.trust_store.os.replace", boom)
    with pytest.raises(OSError):
        store.add_rule("rm *", DECISION_DENY)
    assert path.read_text(encoding="utf-8") == old_text
    assert [r["pattern"] for r in store.list_rules()] == ["cat *"]
    assert store.degraded is True
    # 降级后 allow 自动放行必须停用，不能再按内存中的 allow 规则免审。
    assert store.match_command("cat /etc/hostname") is None


def test_degraded_whitelist_forces_write_approval(tmp_path) -> None:
    """白名单损坏时，auto 档的写操作也必须逐条审批。"""
    path = tmp_path / "agent_whitelist.json"
    path.write_text('{"rules": [', encoding="utf-8")
    store = WhitelistStore(path)
    assert store.degraded is True
    ctx = SimpleNamespace(mode=AgentMode.AUTO, session_id="t4-degraded")
    with patch("strands_backend.trust_store.get_global_whitelist", return_value=store):
        result = assess_command(ctx, "echo hello > /tmp/x")
    assert result["decision"] == "confirm"