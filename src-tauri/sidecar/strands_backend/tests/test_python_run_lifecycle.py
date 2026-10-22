"""Regression coverage for python_run approval, process, and SDK schema lifecycles."""
from __future__ import annotations

import subprocess
import sys
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from needs_you import NeedsYouStatus
from strands_backend.tools import ToolContext
from strands_backend.tools.python_run import invoke_python_run_tool, make_python_run_tool

python_run_module = import_module("strands_backend.tools.python_run")


@pytest.fixture
def isolated_audit_chain(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from strands_backend import audit_chain

    monkeypatch.setattr(
        audit_chain,
        "_global_chain",
        audit_chain.AuditChain(path=str(tmp_path / "audit.jsonl")),
    )


def _context(workspace: Path) -> ToolContext:
    return ToolContext(
        agent_name="python-run-lifecycle-test",
        session_id="python-run-lifecycle-session",
        mode="confirm",
        workspace=str(workspace),
    )


@pytest.mark.parametrize(
    ("request_status", "expected_status", "message_fragment"),
    [
        (NeedsYouStatus.CANCELLED, "cancelled", "审批已取消"),
        (NeedsYouStatus.TIMEOUT, "needs_approval", "审批超时"),
    ],
    ids=["business-cancel", "approval-timeout"],
)
def test_approval_terminal_status_is_preserved_without_execution(
    monkeypatch: pytest.MonkeyPatch,
    isolated_audit_chain: None,
    tmp_path: Path,
    request_status: NeedsYouStatus,
    expected_status: str,
    message_fragment: str,
) -> None:
    requests: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def wait_for_approval(*args: Any, **kwargs: Any) -> SimpleNamespace:
        requests.append((args, kwargs))
        return SimpleNamespace(status=request_status, response=None)

    monkeypatch.setattr(python_run_module, "request_approval_and_wait", wait_for_approval)
    monkeypatch.setattr(
        python_run_module,
        "_execute_python",
        lambda *_args, **_kwargs: pytest.fail("terminal approval result must not execute code"),
    )

    marker = tmp_path / "qa-marker.txt"
    result = invoke_python_run_tool(
        {
            "code": "open('qa-marker.txt', 'w', encoding='utf-8').write('not-executed')",
            "explanation": "qa approval lifecycle",
        },
        _context(tmp_path),
    )

    assert len(requests) == 1
    assert requests[0][0][0].workspace == str(tmp_path)
    assert requests[0][1]["risk_l"] >= 2
    assert result["status"] == expected_status
    assert message_fragment in result["message"]
    if request_status == NeedsYouStatus.CANCELLED:
        assert "超时" not in result["message"]
    assert not marker.exists()


def test_real_child_process_uses_devnull_stdin_and_fixed_workspace(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    real_run = subprocess.run
    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def run_spy(*args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append((args, kwargs.copy()))
        return real_run(*args, **kwargs)

    monkeypatch.setattr(python_run_module.subprocess, "run", run_spy)
    result = invoke_python_run_tool(
        {"code": "print('qa-child-output')"},
        _context(tmp_path),
    )

    assert result["status"] == "success"
    assert result["exit_code"] == 0
    assert "qa-child-output" in result["stdout"]
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert args[0][0] == sys.executable
    assert args[0][1:3] == ["-c", "print('qa-child-output')"]
    assert kwargs["stdin"] is subprocess.DEVNULL
    assert kwargs["cwd"] == str(tmp_path)
    assert kwargs["capture_output"] is True
    assert kwargs["text"] is True


def test_real_strands_registry_hides_internal_sdk_context_parameter(tmp_path: Path) -> None:
    from strands.tools.registry import ToolRegistry

    tool_fn = make_python_run_tool(_context(tmp_path))
    registry = ToolRegistry()
    registry.process_tools([tool_fn])

    assert "python_run" in registry.registry
    schema = registry.registry["python_run"].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]) == {"code"}
    assert schema["required"] == ["code"]
    assert "sdk_tool_context" not in schema["properties"]
    assert "sdk_tool_context" not in str(schema)
