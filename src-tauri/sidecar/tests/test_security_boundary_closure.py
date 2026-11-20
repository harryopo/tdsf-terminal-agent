"""CR01/CR04: command strings only; never execute the commands."""
import pytest

from strands_backend.tools.command_impact import analyze


@pytest.mark.parametrize("target", [
    "/root/.profile", "/root/./.profile", "//root/.profile",
    "/etc/passwd", "/etc/./passwd", "/etc//passwd",
    "./.profile", "././.profile", "$HOME/./.profile",
    '/ro""ot/.profile', '"/root/."/.profile', '/etc/""passwd',
])
def test_sensitive_path_equivalence(target):
    assert analyze("cp /tmp/sample " + target)["max_risk_l"] >= 3

@pytest.mark.parametrize("command", [
    "echo hello", "echo hello HISTSIZE=0", 'echo "HISTSIZE=0"',
    "printf '%s' HISTSIZE=0", 'printf "export HISTSIZE=0"',
])
def test_history_assignment_text_is_readonly(command):
    assert analyze(command)["max_risk_l"] == 0

@pytest.mark.parametrize("command", [
    "HISTSIZE=0", "export HISTSIZE=0", 'export HISTSIZE="0"',
    "export OTHER=x HISTSIZE=0", "OTHER=x HISTSIZE=0",
])
def test_real_history_assignments_remain_gated(command):
    result = analyze(command)
    assert result["max_risk_l"] >= 3
    assert any("audit_evasion" in s.get("flags", []) for s in result["segments"])

def test_ordinary_file_write_keeps_existing_level():
    assert analyze("cp /tmp/sample /tmp/destination")["max_risk_l"] == 2
