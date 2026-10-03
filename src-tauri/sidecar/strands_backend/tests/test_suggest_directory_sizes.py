"""Regression coverage for recursive directory-size suggestions."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from strands_backend.tools.suggest_command import invoke_suggest_command_tool


def _suggest(intent: str, target_os: str, path: str | None = None) -> dict:
    params = {"intent": intent, "target_os": target_os}
    if path is not None:
        params["path"] = path
    return invoke_suggest_command_tool(params, MagicMock(event_bus=None))


def test_windows_recursive_directory_size_uses_requested_path_and_sorts_bytes() -> None:
    result = _suggest(
        "递归统计每个子目录总大小并按大小降序输出",
        "windows",
        r"D:\ai",
    )

    assert result["status"] == "success", result
    command = result["command"]
    assert "Get-ChildItem -LiteralPath 'D:\\ai' -Directory" in command
    assert "Get-ChildItem" in command and "-Recurse" in command
    assert "Measure-Object" in command and "Length" in command and "Sum" in command
    assert "Sort-Object" in command and "Bytes" in command and "-Descending" in command
    assert "-Drive" not in command
    assert "不可读" in result["explanation"]
    assert "不等于" in result["explanation"] or "可能" in result["explanation"]


def test_windows_directory_size_escapes_single_quotes_in_path() -> None:
    result = _suggest("递归统计目录下每个子目录大小", "windows", "D:\\O'Brien")

    assert result["status"] == "success", result
    assert "-LiteralPath 'D:\\O''Brien'" in result["command"]


def test_windows_directory_size_extracts_path_from_user_intent() -> None:
    result = _suggest(
        "用 PowerShell 递归统计 D:\\ai 下每个子目录的总大小，并按大小降序输出 "
        "（Get-ChildItem 配合 Measure-Object Sum Length）",
        "windows",
    )

    assert result["status"] == "success", result
    assert "Get-ChildItem -LiteralPath 'D:\\ai' -Directory" in result["command"]


def test_windows_directory_size_defaults_to_current_directory() -> None:
    result = _suggest("递归统计每个子目录总大小", "windows")

    assert result["status"] == "success", result
    assert "Get-ChildItem -LiteralPath '.' -Directory" in result["command"]


def test_powershell_command_reports_temp_tree_sizes_in_descending_order() -> None:
    powershell = shutil.which("pwsh") or shutil.which("powershell")
    if powershell is None or os.name != "nt":
        pytest.skip("PowerShell execution is available only on Windows hosts with PowerShell")

    with tempfile.TemporaryDirectory(prefix="codex dir size ") as temp_root:
        root = Path(temp_root) / "root with ' quote"
        large = root / "big folder"
        small = root / "small's folder"
        empty = root / "empty folder"
        (large / "nested").mkdir(parents=True)
        small.mkdir(parents=True)
        empty.mkdir(parents=True)
        (large / "nested" / "payload.bin").write_bytes(b"x" * 19)
        (small / "payload.bin").write_bytes(b"y" * 5)

        suggested = _suggest("递归统计每个子目录总大小并按大小降序输出", "windows", str(root))
        assert suggested["status"] == "success", suggested
        command = suggested["command"]
        assert "-LiteralPath '" + str(root).replace("'", "''") + "'" in command
        completed = subprocess.run(
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", f"{command} | ConvertTo-Json -Compress"],
            capture_output=True,
            text=True,
            check=True,
        )

        rows = json.loads(completed.stdout)
        by_name = {Path(row["Directory"]).name: row["Bytes"] for row in rows}
        assert list(by_name) == ["big folder", "small's folder", "empty folder"]
        assert by_name == {"big folder": 19, "small's folder": 5, "empty folder": 0}


def test_linux_directory_size_remains_linux_and_unmatched_stays_empty() -> None:
    linux = _suggest("递归统计目录下每个子目录大小", "linux", ".")
    assert linux["status"] == "success", linux
    assert "du" in linux["command"]
    assert "Get-ChildItem" not in linux["command"]

    unmatched = _suggest("统计 D 盘物理容量", "windows")
    assert unmatched["status"] == "unmatched", unmatched
    assert unmatched["command"] is None
    assert "SELinux" not in unmatched["explanation"]
