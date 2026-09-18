"""只读白名单的 flag 否决 + denylist 只在命令位命中（2026-09-18 深度体检 A1/A2）。

A1（P0）：修复前 confirm 模式下 `find / -delete` / `awk BEGIN{system("id")}` /
`sort -o /etc/shadow /dev/null` 的 assess_command 决策都是 **allow**（零审批直接执行），
因为只读判定只看 basename。
A2（P1）：同时 `journalctl -k | grep reboot` 这类只读日志检索被 denylist 的
`\breboot\b` 在**任意位置**命中而硬封死 —— 安全模型是反的。

本文件两个方向都钉：破坏形态必须不再 allow，日常只读探测必须仍然 allow（防过度收紧）。
"""

from strands_backend.modes import AgentMode
from strands_backend.tools import ToolContext, assess_command
from strands_backend.tools.command_impact import (
    CATEGORY_READONLY,
    classify_segment,
    match_denylist,
)


def _decision(cmd: str) -> str:
    return assess_command(ToolContext(mode=AgentMode.CONFIRM, session_id="s"), cmd)[
        "decision"
    ]


# --- A1：带写/执行型 flag 的"只读名"命令不得再算只读 --------------------------

DESTRUCTIVE_SHAPES = [
    "find / -delete",
    "find /var -name core -exec rm -f {} ;",
    'awk BEGIN{system("id")}',
    "sort -o /etc/shadow /dev/null",
    "tar czf /tmp/etc.tgz /etc",
    "tar -xzf /tmp/x.tgz -C /",
    "gzip /var/log/syslog",
    "cat /etc/passwd > /tmp/pwn",
]


def test_destructive_shapes_never_auto_allow_in_confirm_mode():
    for cmd in DESTRUCTIVE_SHAPES:
        assert _decision(cmd) != "allow", f"{cmd!r} 在 confirm 档被零审批放行"


def test_readonly_names_with_write_flags_are_not_classified_readonly():
    for cmd in DESTRUCTIVE_SHAPES:
        seg = classify_segment(cmd)
        assert seg["category"] != CATEGORY_READONLY, f"{cmd!r} 仍被判只读 L0"


# --- A1 反向：日常只读探测不得被误伤（C3 放宽的初衷必须保住） -----------------

ORDINARY_PROBES = [
    "ls -la /var/log",
    "df -h",
    "free -m",
    "nproc",
    "uname -a",
    "journalctl -u ssh --since today",
    "systemctl status nginx",
    "cat /etc/os-release",
    "ps aux | grep nginx",
    "dmesg | tail -20",
    'find /var/log -name "*.log" | head',
    "awk '{print $1}' /etc/passwd | sort | uniq -c",
    "tar -tzf /tmp/backup.tgz",
    "gzip -k /var/log/syslog",
    "ls > /dev/null",
]


def test_ordinary_readonly_probes_still_auto_allow():
    for cmd in ORDINARY_PROBES:
        assert _decision(cmd) == "allow", f"{cmd!r} 被误收紧"


# --- A2：电源词只在命令位命中 -------------------------------------------------

LOG_SEARCHES = [
    "journalctl -k | grep reboot",
    "grep -i shutdown /var/log/syslog",
    "dmesg | grep halt",
]


def test_power_words_in_argument_position_are_not_hard_blocked():
    for cmd in LOG_SEARCHES:
        assert match_denylist(cmd) is None, f"{cmd!r} 仍被 denylist 硬封"
        assert _decision(cmd) != "blocked", f"{cmd!r} 在 confirm 档被 command_blocked"


def test_real_power_commands_still_hard_blocked():
    for cmd in ["reboot", "sudo reboot", "shutdown -h now", "poweroff", "init 6"]:
        assert _decision(cmd) == "blocked", f"{cmd!r} 竟然没被拦"


def test_last_reboot_history_query_still_exempt():
    # 既有豁免（is_last_reboot_history_query）不能被收紧掉
    assert _decision("last reboot") != "blocked"
