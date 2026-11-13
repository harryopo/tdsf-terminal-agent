from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

import strands_backend.trust_store as trust_store_mod
from strands_backend.modes import AgentMode
from strands_backend.tools import ToolContext, assess_command
from strands_backend.tools.command_impact import classify_segment, split_compound
from strands_backend.tools.ssh_command import invoke_ssh_command_tool
from strands_backend.trust_store import (
    WhitelistStore,
    record_session_trust,
    reset_globals,
)


@pytest.fixture(autouse=True)
def stores(tmp_path, monkeypatch):
    reset_globals()
    whitelist = WhitelistStore(path=tmp_path / "agent_whitelist.json")
    monkeypatch.setattr(trust_store_mod, "_whitelist", whitelist)
    yield trust_store_mod
    reset_globals()


def _ctx(mode: AgentMode, session_id: str = "approval-policy") -> ToolContext:
    return ToolContext(agent_name="approval-policy-test", session_id=session_id, mode=mode)


@pytest.mark.parametrize("command", [
    "systemctl stop nginx status",
    "systemctl --host=status enable nginx",
    "systemctl -Hstatus enable nginx",
    "systemctl -H status stop nginx",
    "systemctl --root 'some status tree' enable nginx",
    "service status start",
    "service nginx stop status",
    "chkconfig list off",
    "chkconfig --list nginx off",
    "chkconfig --add nginx",
    "systemctl -- stop nginx status",
])
@pytest.mark.parametrize("mode", [AgentMode.CONFIRM, AgentMode.AUTO])
def test_mutating_service_actions_are_l3_or_higher(command, mode):
    assessment = classify_segment(command)
    assert assessment["risk_l"] >= 3
    assert assess_command(_ctx(mode), command)["decision"] == "confirm"


@pytest.mark.parametrize("command", [
    "systemctl status nginx --no-pager",
    "systemctl --user --no-pager status nginx",
    "systemctl --type service --state=failed status nginx",
    "systemctl -p 'ActiveState SubState' show nginx",
    "systemctl --property=MainPID show nginx",
    "systemctl -pMainPID show nginx",
    "systemctl -tservice list-units",
    "systemctl --property= show nginx",
    "systemctl -n 5 status nginx",
    "service nginx status",
    "service --status-all",
    "chkconfig --list",
    "chkconfig --list nginx",
    "chkconfig",
    "systemctl -- status nginx",
])
def test_readonly_service_queries_stay_l0_and_allowed(command):
    assessment = classify_segment(command)
    assert assessment["risk_l"] == 0
    result = assess_command(_ctx(AgentMode.CONFIRM), command)
    assert result["risk_l"] == 0
    assert result["decision"] == "allow"


@pytest.mark.parametrize("flags", ["-al", "-qal"])
def test_combined_short_flags_preserve_service_query(flags):
    command = f"systemctl {flags} status nginx"
    assert classify_segment(command)["risk_l"] == 0
    assert assess_command(_ctx(AgentMode.CONFIRM), command)["decision"] == "allow"


@pytest.mark.parametrize("command", [
    "systemctl --future-option status nginx",
    "systemctl -az status nginx",
    "systemctl --host",
    "systemctl --property",
    "systemctl --host='unterminated status",
])
def test_unknown_missing_or_unclosed_service_options_fail_closed(command):
    assessment = classify_segment(command)
    assert assessment["risk_l"] >= 3
    assert assess_command(_ctx(AgentMode.CONFIRM), command)["decision"] == "confirm"


@pytest.mark.parametrize("trust_kind,command", [
    ("readonly", "cat /etc/hostname"),
    ("prefix", "mv /tmp/source /tmp/target"),
])
@pytest.mark.parametrize("mode", [AgentMode.CONFIRM, AgentMode.AUTO])
def test_ask_rule_overrides_existing_session_trust(stores, trust_kind, command, mode):
    if trust_kind == "readonly":
        record_session_trust("approval-policy", "cat /etc/hostname", 0)
    else:
        stores.get_global_trust_store().add_prefix_allow("approval-policy", "mv")
    stores.get_global_whitelist().add_rule(command, "ask")

    result = assess_command(_ctx(mode), command)
    assert result["decision"] == "confirm"


def test_ask_added_after_readonly_trust_still_requires_confirmation(stores):
    command = "systemctl status nginx"
    record_session_trust("approval-policy", "cat /etc/hostname", 0)
    stores.get_global_whitelist().add_rule(command, "ask")
    result = assess_command(_ctx(AgentMode.CONFIRM), command)
    assert result["decision"] == "confirm"


def test_allow_without_ask_preserves_session_trust(stores):
    command = "systemctl status nginx"
    record_session_trust("approval-policy", "cat /etc/hostname", 0)
    result = assess_command(_ctx(AgentMode.CONFIRM), command)
    assert result["decision"] == "allow"
    assert result.get("trust_source") == "session_readonly"


@pytest.mark.parametrize("mode", [AgentMode.CONFIRM, AgentMode.AUTO])
def test_ask_does_not_weaken_deny_or_high_risk_rules(stores, mode):
    stores.get_global_whitelist().add_rule("systemctl stop nginx", "ask")
    assert assess_command(_ctx(mode), "systemctl stop nginx")["decision"] == "confirm"

    stores.get_global_whitelist().add_rule("rm -rf /", "ask")
    assert assess_command(_ctx(mode), "rm -rf /")["decision"] == "blocked"


def test_observe_still_denies_even_when_ask_matches(stores):
    stores.get_global_whitelist().add_rule("systemctl status nginx", "ask")
    result = assess_command(_ctx(AgentMode.OBSERVE), "systemctl status nginx")
    assert result["decision"] == "deny"


@pytest.mark.parametrize("command", [
    "git push origin main",
    "git -C repo push --force origin main",
    "git push origin +HEAD:refs/heads/main",
    "git push origin :refs/heads/main",
    "git reset --hard HEAD",
    "git clean -fd",
    "git checkout -- .",
    "git branch -D topic",
    "git tag -d release",
    "git stash drop",
    "git -c alias.publish=push publish origin",
    "git diff --output=report.txt",
    "git log --output=report.txt",
    "git clean -fd > report.txt",
    "> report.txt git reset --hard HEAD",
    "git.exe clean -fd > report.txt",
    "env GIT_DIR=repo git clean -fd",
    "/usr/bin/env git clean -fd",
    '"/path with space/git" "clean" -fd',
    r"g\it clean -fd",
    "git status && git reset --hard HEAD",
    "git status & git clean -fd",
    "echo ready & git clean -fd",
    "echo ready\ngit clean -fd",
    r"printf '%s' $'it\'s'; git clean -fd",
    "cat <(git clean -fd)",
    "tee >(git clean -fd)",
    "find . -maxdepth 0 '-exec' git clean -fd ';'",
    r"find . -maxdepth 0 -ex\ec git clean -fd \;",
])
def test_git_writes_require_confirmation_even_in_auto_with_allow(stores, command):
    stores.get_global_whitelist().add_rule("*", "allow")
    result = assess_command(_ctx(AgentMode.AUTO), command)
    assert result["decision"] == "confirm"
    assert result["risk_l"] >= 3
    assert "trust_source" not in result


@pytest.mark.parametrize("mode", [AgentMode.CONFIRM, AgentMode.AUTO])
def test_trusting_git_status_does_not_authorize_git_clean(stores, mode):
    ctx = _ctx(mode)
    risk_l = assess_command(ctx, "git status")["risk_l"]
    record_session_trust(ctx.session_id, "git status", risk_l)
    assert assess_command(ctx, "git status")["trust_source"] == "session_prefix"
    assert assess_command(ctx, "git clean -fd")["decision"] == "confirm"


@pytest.mark.parametrize("command", [
    "git --version", "git status", "git status --short",
    "git status --porcelain=v1", "git log --oneline -5", "git diff --stat",
    "git --no-pager diff --cached --name-only",
    "git branch --show-current", "git rev-parse --show-toplevel",
    "git status -sb", "git log -n 5", "git diff -- file.txt",
])
def test_common_git_queries_keep_existing_mode_behavior(command):
    confirm = assess_command(_ctx(AgentMode.CONFIRM), command)
    assert (confirm["decision"], confirm["risk_l"]) == ("confirm", 2)
    assert assess_command(_ctx(AgentMode.AUTO), command)["decision"] == "allow"


def test_git_hard_deny_survives_allow_and_observe_rejects_writes(stores):
    stores.get_global_whitelist().add_rule("*", "allow")
    assert assess_command(_ctx(AgentMode.AUTO), "git push --force origin main")["decision"] == "blocked"
    assert assess_command(_ctx(AgentMode.OBSERVE), "git clean -fd", readonly=True)["decision"] == "deny"


def test_compound_controls_preserve_quoted_text_and_redirects():
    command = 'echo "a&b\nc" 2>&1 & echo done &>/dev/null'
    assert split_compound(command) == ['echo "a&b\nc" 2>&1', "echo done &>/dev/null"]
    assert assess_command(_ctx(AgentMode.AUTO), r"echo \>& git clean -fd")["decision"] == "confirm"
    assert classify_segment("echo done > report.txt")["category"] == "file_write"
    assert classify_segment("docker ps > report.txt")["risk_l"] == 2
    assert classify_segment("find . -maxdepth 1 -name '*.md'")["risk_l"] == 0


@pytest.mark.parametrize("command", [
    "git reset --hard HEAD",
    r"printf '%s' $'it\'s'; git clean -fd",
    "cat <(git clean -fd)",
    "find . -maxdepth 0 '-exec' git clean -fd ';'",
])
def test_git_ssh_tool_stops_before_dispatch_without_approval(stores, monkeypatch, command):
    ctx = _ctx(AgentMode.AUTO)
    ctx.rust_bridge = Mock()
    ctx.ssh_session_id = "123"
    record_session_trust(ctx.session_id, "git status", 2)
    approval = Mock(return_value=None)
    monkeypatch.setattr("strands_backend.tools.request_approval_and_wait", approval)

    result = invoke_ssh_command_tool({"command": command}, ctx)

    approval.assert_called_once()
    ctx.rust_bridge.ipc_invoke.assert_not_called()
    assert result["status"] == "needs_approval"
