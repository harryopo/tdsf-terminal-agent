"""安全回归：同等危害必须同等审批（T1-REQ-01/04/08/09/10/11）。

来源：`.ai/test-runs/security-review-20261118-a1/probe_equivalent_harm.py` 的 10 例，
外加 home 等价写法、复合命令、引号字面文本与正常对照。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from strands_backend.modes import AgentMode
from strands_backend.tools import assess_command

MODES = [AgentMode.CONFIRM, AgentMode.AUTO]


def assess(cmd: str, mode: AgentMode) -> dict:
    ctx = SimpleNamespace(mode=mode, session_id="security-regression-equivalent")
    return assess_command(ctx, cmd)


# --- 同等危害：对 /etc/passwd 的破坏，不能只按动词定级 -----------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "cmd",
    [
        "rm /etc/passwd",
        "rm -f /etc/ssh/sshd_config",
        "> /etc/passwd",
        'echo "" > /etc/passwd',
        "chmod 000 /etc/passwd",
        "chown root /etc/passwd",
        "mv /etc/ssh/sshd_config /tmp/x",
        "cp /etc/passwd /tmp/p",
        "install -m 777 /etc/passwd /tmp/p",
        "shred /etc/passwd",
    ],
)
def test_equivalent_harm_requires_approval(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    assert a["risk_l"] >= 3, f"{cmd} 应不低于 L3，实际 {a['risk_l']}"
    assert a["decision"] == "confirm", f"{cmd} 在 {mode} 档不应免审批：{a['decision']}"


@pytest.mark.parametrize("mode", MODES)
def test_mv_and_rm_are_approval_equivalent(mode: AgentMode) -> None:
    """同一目标，mv 不得比 rm 更容易绕过审批（审批等价，而非强制同数值）。"""
    mv = assess("mv /etc/passwd /tmp/p", mode)
    rm = assess("rm /etc/passwd", mode)
    assert mv["decision"] == rm["decision"] == "confirm"
    assert mv["risk_l"] >= 3


# --- home 等价写法 ----------------------------------------------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "cmd",
    [
        "echo x >> ~/.bashrc",
        "echo x >> .bashrc",
        "echo x >> $HOME/.profile",
        'echo "ssh-rsa A" >> /home/alice/.ssh/authorized_keys',
        'echo "ssh-rsa A" >> /root/.ssh/authorized_keys',
    ],
)
def test_home_equivalent_paths(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    assert a["risk_l"] >= 3, f"{cmd} 的 home 等价写法应同样不低于 L3"
    assert a["decision"] == "confirm"


# --- 复合命令：取最高风险，不被首段只读覆盖 ---------------------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "cmd",
    [
        "cat /etc/passwd && history -c",
        "systemctl status nginx && sleep 999 &",
    ],
)
def test_compound_uses_highest_risk(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    assert a["decision"] == "confirm", f"{cmd} 不应被首段只读操作覆盖"


# --- 引号内的字面文本不得被当作真实操作符 -----------------------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize(
    "cmd",
    [
        "printf '&'",
        "printf 'history -c'",
        "printf 'nohup sleep 999 &'",
    ],
)
def test_quoted_literals_not_operators(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    flags = a.get("flags", [])
    assert "background" not in flags, f"{cmd} 不应被标记为后台常驻"
    assert "audit_evasion" not in flags, f"{cmd} 不应被标记为审计规避"


# --- 交互式与后台的正常目标：数值可不提级，但仍需审批 -----------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("cmd", ["top", "less /tmp/x", "vim /tmp/x"])
def test_interactive_plain_targets_still_confirm(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    assert a["decision"] == "confirm", f"{cmd} 交互式命令两档都应审批"
    assert "interactive" in a.get("flags", [])


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("cmd", ["setsid sleep 999", "disown", "sleep 999 &"])
def test_background_variants_require_approval(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    assert a["decision"] == "confirm"
    assert "background" in a.get("flags", [])


# --- 正常对照：只读历史与普通查询不受影响 -----------------------------------
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("cmd", ["history", "cat /etc/passwd", "systemctl status nginx"])
def test_normal_queries_unchanged(cmd: str, mode: AgentMode) -> None:
    a = assess(cmd, mode)
    assert a["decision"] == "allow", f"{cmd} 正常只读操作不应被误伤"

@pytest.mark.parametrize("mode", MODES)
def test_top_batch_mode_is_not_interactive(mode: AgentMode) -> None:
    """`top -bn1` 是批处理（合并短选项含 -b），不得被当作交互式命令。

    既有 `performance_analyze` 工具使用 `top -bn1 | head -12`，若被误标为
    interactive 会在 auto 档被强制审批，造成功能回退。
    """
    a = assess("top -bn1 | head -12", mode)
    assert "interactive" not in a.get("flags", [])
    assert a["decision"] == "allow"