"""ROADMAP #60 —— suggest_command 的 target_os 必须真正切换命令库。

回归的根因：`_SUGGESTION_RULES` 原来只有一张 Linux 表，`target_os` 参数只是被
原样回显，从不参与匹配。于是在本地 Windows 终端里，工具仍然吐 `uptime` /
`free -h` / `journalctl`，PowerShell 直接报"不是可识别的 cmdlet"，命令卡在
auto 模式下还会被自动追加回车执行。

这里钉住三件事：
1. 默认（不传 target_os）保持 Linux —— 本产品以 Linux 教学为主，不能反向破约；
2. `target_os="windows"` 必须返回 PowerShell 可跑的等价命令，且不得出现 Linux 专有二进制；
3. Windows 上没有对应概念的检查项（SELinux）必须走 unmatched，**不能伪造一条命令**。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

_SIDECAR_DIR = Path(__file__).resolve().parents[2]
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

import pytest

from strands_backend.tools import suggest_command as sc
from strands_backend.tools.suggest_command import invoke_suggest_command_tool

LINUX_ONLY_BINARIES = {
    "uptime", "free", "df", "du", "ps", "ss", "journalctl", "systemctl",
    "getenforce", "sestatus", "ip", "ls", "find", "grep", "awk", "top",
}


def _ctx() -> object:
    return MagicMock(
        event_bus=MagicMock(),
        rust_bridge=MagicMock(),
        session_id="test-session",
        ssh_session_id=None,
    )


def _suggest(intent: str, target_os: str | None = None) -> dict:
    params: dict = {"intent": intent}
    if target_os is not None:
        params["target_os"] = target_os
    return invoke_suggest_command_tool(params, _ctx())  # type: ignore[arg-type]


def _first_token(command: str) -> str:
    return command.strip().split()[0] if command.strip() else ""


# ---------------------------------------------------------------- 默认不变
def test_default_target_os_stays_linux() -> None:
    """不传 target_os 时必须是 Linux 命令 —— 教学产品的主场景，不能反向破约。"""
    assert _suggest("查看内存使用")["command"] == "free -h"


def test_explicit_linux_matches_previous_behaviour() -> None:
    result = _suggest("查看磁盘空间", "linux")
    assert result["status"] == "success"
    assert result["command"] == "df -h"
    assert result["target_os"] == "linux"


# ---------------------------------------------------------------- windows 生效
@pytest.mark.parametrize(
    ("intent", "must_contain"),
    [
        ("查看内存使用", "Get-CimInstance"),
        ("查看磁盘空间", "Get-PSDrive"),
        ("看下 cpu 使用排行", "Get-Process"),
        ("查看端口监听", "netstat"),
        ("查看系统日志", "Get-WinEvent"),
        ("查看服务状态", "Get-Service"),
    ],
)
def test_windows_intent_returns_powershell_command(
    intent: str,
    must_contain: str,
) -> None:
    result = _suggest(intent, "windows")
    assert result["status"] == "success", result
    assert must_contain in result["command"], result["command"]


def test_windows_ping_uses_dash_n_not_dash_c() -> None:
    """Windows 的 ping 参数是 -n，Linux 是 -c。给错就是直接报错。"""
    windows = _suggest("测试网络连通性", "windows")["command"]
    linux = _suggest("测试网络连通性", "linux")["command"]
    assert "-n" in windows and "-c" not in windows
    assert "-c" in linux


def test_windows_suggestions_never_emit_linux_only_binaries() -> None:
    """整表扫描：任何规则声明了 windows 变体，就不能用 Linux 专有命令打头，
    管道右侧也必须是 PowerShell cmdlet（动词-名词大写形式）。"""
    import re

    ps_verb = re.compile(r"^(Get|Select|Sort|Where|Format|Measure|New|Remove)-[A-Z]")
    checked = 0
    for keywords, variants in sc._SUGGESTION_RULES:  # noqa: SLF001
        if "windows" not in variants:
            continue
        checked += 1
        command = variants["windows"][0]
        assert _first_token(command) not in LINUX_ONLY_BINARIES, (keywords, command)
        for stage in command.split("|")[1:]:
            first = _first_token(stage)
            assert ps_verb.match(first), f"windows 管道右侧不是 PowerShell cmdlet: {keywords} -> {command}"
    assert checked >= 8, "windows 变体覆盖过少，#60 未真正修复"


def test_target_os_is_case_insensitive() -> None:
    assert "Get-" in _suggest("查看内存使用", "Windows")["command"]
    assert "Get-" in _suggest("查看内存使用", "WINDOWS")["command"]


def test_unknown_target_os_falls_back_to_linux_by_design() -> None:
    """只有 windows 走 PowerShell 表；其他值（含 macos）落回 Linux 表并被回显。"""
    result = _suggest("查看内存使用", "macos")
    assert result["target_os"] == "macos"
    assert result["command"] == "free -h"


# ---------------------------------------------------------------- 不伪造命令
def test_selinux_on_windows_is_unmatched_not_fabricated() -> None:
    """SELinux 在 Windows 无对应概念：必须 unmatched，不能编一条"看着像"的命令。"""
    assert _suggest("查看 selinux 状态", "linux")["status"] == "success"
    result = _suggest("查看 selinux 状态", "windows")
    assert result["status"] == "unmatched"
    assert result["command"] is None
    assert "windows" in result["explanation"].lower()


def test_windows_unmatched_still_lists_suggestions() -> None:
    result = _suggest("解释 topology 拓扑", "windows")
    assert result["status"] == "unmatched"
    assert result["command"] is None
    assert result["suggestions"]


# ---------------------------------------------------------------- 预测回显
def test_predict_output_covers_powershell_cmdlets() -> None:
    """预测回显不能对 PowerShell 命令一律退化成"执行 X 命令"。"""
    for cmd in (
        "Get-Process | Sort-Object CPU -Descending | Select-Object -First 20",
        "Get-PSDrive -PSProvider FileSystem",
        "netstat -ano | Select-String LISTENING",
    ):
        assert _first_token(cmd) in sc._PREDICTIONS  # noqa: SLF001
        assert sc._predict_output(cmd) != f"执行 {_first_token(cmd)} 命令（观察终端输出以确认结果）"  # noqa: SLF001


def test_windows_success_result_carries_predicted_output() -> None:
    result = _suggest("查看端口监听", "windows")
    predicted = result["predicted_output"]
    assert predicted
    assert predicted != sc._predict_output("definitely-not-a-real-command")  # noqa: SLF001
    assert "端口" in predicted or "连接" in predicted
