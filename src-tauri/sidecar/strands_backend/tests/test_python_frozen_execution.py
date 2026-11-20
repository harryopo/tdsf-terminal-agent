"""Frozen Python worker selection and its existing risk boundary."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from strands_backend.modes import AgentMode
from strands_backend.tools import ToolContext, assess_command
from strands_backend.tools import python_run as python_run_module
from strands_backend.trust_store import SessionTrustStore, WhitelistStore


def _ctx(workspace: Path, mode: AgentMode = AgentMode.CONFIRM, wsl_distro: str = ""):
    return ToolContext(workspace=str(workspace), mode=mode, wsl_distro=wsl_distro)


@pytest.fixture
def isolated_trust(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import strands_backend.trust_store as trust_store

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(trust_store, "_trust_store", SessionTrustStore())
    monkeypatch.setattr(
        trust_store,
        "_whitelist",
        WhitelistStore(tmp_path / "data" / "agent_whitelist.json"),
    )


def test_frozen_execution_uses_worker_argv_and_keeps_process_limits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
):
    calls = []
    monkeypatch.setattr(python_run_module.sys, "frozen", True, raising=False)

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, "frozen-ok", "")

    monkeypatch.setattr(python_run_module.subprocess, "run", fake_run)
    result = python_run_module.invoke_python_run_tool(
        {"code": "print('frozen-ok')", "timeout": 12}, _ctx(tmp_path),
    )

    assert result["status"] == "success"
    assert calls[0][0] == [sys.executable, "--python-worker", "print('frozen-ok')"]
    assert calls[0][1]["stdin"] is subprocess.DEVNULL
    assert calls[0][1]["timeout"] == 12
    assert calls[0][1]["cwd"] == str(tmp_path)
    assert calls[0][1]["capture_output"] is True
    assert calls[0][1]["text"] is True


def test_non_frozen_execution_forces_utf8_child_io(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
):
    monkeypatch.delattr(python_run_module.sys, "frozen", raising=False)
    monkeypatch.setenv("PYTHONIOENCODING", "ascii")

    result = python_run_module.invoke_python_run_tool(
        {"code": "print('中文结果')", "timeout": 12}, _ctx(tmp_path),
    )

    assert result["status"] == "success"
    assert result["stdout"].strip() == "中文结果"
    assert os.environ["PYTHONIOENCODING"] == "ascii"


def test_wsl_selection_remains_a_separate_nonexecuted_route(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
):
    calls = []
    monkeypatch.setattr(python_run_module.sys, "frozen", True, raising=False)

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, "wsl-route", "")

    monkeypatch.setattr(python_run_module.subprocess, "run", fake_run)
    result = python_run_module._execute_python("print('x')", "/workspace/project", "Ubuntu", 9)

    assert result["status"] == "success"
    assert calls[0][0] == [
        "wsl.exe", "-d", "Ubuntu", "--cd", "/workspace/project",
        "--exec", "python3", "-c", "print('x')",
    ]
    assert calls[0][1]["cwd"] is None
    assert calls[0][1]["stdin"] is subprocess.DEVNULL


@pytest.mark.parametrize("mode", [AgentMode.AUTO, AgentMode.CONFIRM, AgentMode.OBSERVE])
@pytest.mark.parametrize(
    "command",
    [
        "tdsf-sidecar.exe --python-worker print('x')",
        '"C:\\Program Files\\TDSF\\tdsf-sidecar.exe" --python-worker print(\'x\')',
    ],
)
def test_worker_cli_is_never_silently_allowed(
    mode: AgentMode,
    command: str,
    tmp_path: Path,
    isolated_trust,
):
    assessment = assess_command(_ctx(tmp_path, mode), command)

    assert assessment["risk_l"] >= 3
    assert assessment["decision"] != "allow"
