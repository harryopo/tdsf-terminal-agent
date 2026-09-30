"""Ordinary API forms must obey the same production approval boundary."""
from __future__ import annotations

import hashlib
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from needs_you import NeedsYouStatus
from project_service import ProjectService
from strands_backend.modes import AgentMode
from strands_backend.tools import ToolContext
from strands_backend.tools.python_risk import analyze_python_code
from strands_backend.tools.python_run import invoke_python_run_tool
from strands_backend.tools.remote_file import invoke_write_remote_file_tool


@pytest.mark.parametrize("name", ["exec", "eval", "compile", "__import__", "breakpoint"])
@pytest.mark.parametrize("form", [
    "import builtins\nbuiltins.{name}('harmless')",
    "import builtins as b\nb.{name}('harmless')",
    "from builtins import {name} as f\nf('harmless')",
    "__builtins__.{name}('harmless')",
    "import builtins as b\ngetattr(b, '{name}')('harmless')",
])
def test_qualified_builtin_keeps_dynamic_execution_risk(name, form):
    assert analyze_python_code(form.format(name=name))["risk_l"] == 4


OPENERS = [
    "open",
    "builtins.open",
    "io.open",
    "codecs.open",
    "opener",
    "Path('marker.txt').open",
]
IMPORTS = "import builtins, io, codecs\nfrom io import open as opener\nfrom pathlib import Path\n"


def open_call(opener, mode):
    args = f"mode={mode!r}" if opener.startswith("Path(") else f"'marker.txt', mode={mode!r}"
    return f"{opener}({args})"


@pytest.mark.parametrize("opener", OPENERS)
@pytest.mark.parametrize("mode", ["w", "a", "x", "r+"])
def test_standard_file_openers_share_write_risk(opener, mode):
    assert analyze_python_code(IMPORTS + open_call(opener, mode))["risk_l"] == 2


@pytest.mark.parametrize("opener", OPENERS)
def test_standard_file_readers_remain_low_risk(opener):
    assert analyze_python_code(IMPORTS + open_call(opener, "r"))["risk_l"] == 0


@pytest.mark.parametrize("opener", [
    "Path('marker.txt').open({mode!r})",
    "p = Path('marker.txt'); p.open({mode!r})",
    "pathlib.Path('marker.txt').open({mode!r})",
    "Path.open(Path('marker.txt'), {mode!r})",
])
@pytest.mark.parametrize("mode", ["w", "a", "x", "r+", "r"])
def test_path_open_positional_mode_respects_bound_method(opener, mode):
    code = "import pathlib\nfrom pathlib import Path\n" + opener.format(mode=mode)
    assert analyze_python_code(code)["risk_l"] == (0 if mode == "r" else 2)


@pytest.mark.parametrize("code", [
    "from pathlib import Path\nPath('marker.txt').open('w')",
    "from pathlib import Path\np = Path('marker.txt'); p.open('w')",
])
def test_rejected_path_open_does_not_create_file(tmp_path, code):
    ctx = ToolContext(None, None, workspace=str(tmp_path), mode=AgentMode.CONFIRM)
    request = SimpleNamespace(id="reject-path", status=NeedsYouStatus.REJECTED, response={})
    with patch("strands_backend.tools.python_run.request_approval_and_wait", return_value=request) as approval:
        result = invoke_python_run_tool({"code": code}, ctx)
    approval.assert_called_once()
    assert result["status"] == "rejected"
    assert not (tmp_path / "marker.txt").exists()


@pytest.mark.parametrize("code", [
    "import builtins\nbuiltins.exec(\"open('marker.txt', 'w').write('done')\")",
    "from builtins import exec as run\nrun(\"open('marker.txt', 'w').write('done')\")",
    "import builtins as b\ngetattr(b, 'exec')(\"open('marker.txt', 'w').write('done')\")",
    IMPORTS + "io.open('marker.txt', 'w').write('done')",
    IMPORTS + "codecs.open('marker.txt', 'w').write('done')",
    IMPORTS + "builtins.open('marker.txt', 'w').write('done')",
])
def test_rejected_python_never_reaches_real_subprocess(tmp_path, code):
    ctx = ToolContext(None, None, workspace=str(tmp_path), mode=AgentMode.CONFIRM)
    request = SimpleNamespace(id="reject", status=NeedsYouStatus.REJECTED, response={})
    with patch("strands_backend.tools.python_run.request_approval_and_wait", return_value=request) as approval:
        result = invoke_python_run_tool({"code": code}, ctx)
    approval.assert_called_once()
    assert result["status"] == "rejected"
    assert not (tmp_path / "marker.txt").exists()


@pytest.mark.parametrize("mode,approved", [("confirm", False), ("confirm", True), ("auto", False)])
def test_python_file_write_controls(tmp_path, mode, approved):
    ctx = ToolContext(None, None, workspace=str(tmp_path), mode=AgentMode(mode))
    status = NeedsYouStatus.APPROVED if approved else NeedsYouStatus.REJECTED
    request = SimpleNamespace(id="control", status=status, response={})
    with patch("strands_backend.tools.python_run.request_approval_and_wait", return_value=request) as approval, patch(
        "strands_backend.tools.python_run.complete_approval_execution"
    ) as release:
        result = invoke_python_run_tool({"code": "import io\nio.open('marker.txt', 'w').write('done')"}, ctx)
    if approved or mode == "auto":
        assert result["status"] == "success"
        assert (tmp_path / "marker.txt").read_text() == "done"
    else:
        assert result["status"] == "rejected"
        assert not (tmp_path / "marker.txt").exists()
    assert approval.call_count == (mode == "confirm")
    assert release.call_count == approved


@pytest.mark.parametrize("mode", ["confirm", "auto"])
@pytest.mark.parametrize("status", [None, NeedsYouStatus.REJECTED, NeedsYouStatus.TIMEOUT, NeedsYouStatus.CANCELLED, NeedsYouStatus.APPROVED])
def test_remote_overwrite_approval_with_real_ledger(tmp_path, mode, status):
    before, after = b"old=value\n", b"new=value\n"
    bridge = MagicMock()
    bridge.ipc_invoke.side_effect = [list(before), None, None, list(after)]
    service = ProjectService(db_path=tmp_path / "ledger.db")
    service.init_db()
    ctx = ToolContext(None, bridge, session_id="approval-boundary", ssh_session_id="1", mode=AgentMode(mode))
    ctx.operation_service = service
    ctx.require_operation_ledger = True
    request = None if status is None else SimpleNamespace(id="approval", status=status)
    try:
        with patch("strands_backend.tools.remote_file.request_approval_and_wait", return_value=request) as approval, patch(
            "strands_backend.tools.remote_file.complete_approval_execution"
        ) as release:
            result = invoke_write_remote_file_tool({
                "path": "/etc/example.conf", "content": after.decode(),
                "expected_sha256": hashlib.sha256(before).hexdigest(),
            }, ctx)
        approval.assert_called_once()
        assert approval.call_args.kwargs["risk_l"] == 3
        operation = service.get_operation(result["operation_id"])
        if status == NeedsYouStatus.APPROVED:
            assert result["status"] == "success"
            assert operation["state"] == "succeeded"
            assert bridge.ipc_invoke.call_count == 4
            assert bridge.ipc_invoke.call_args_list[1].args[1]["content"] == list(before)
            assert bridge.ipc_invoke.call_args_list[2].args[1]["content"] == list(after)
            release.assert_called_once_with(request)
        else:
            assert result["status"] in {"rejected", "needs_approval"}
            assert operation["state"] == "cancelled"
            bridge.ipc_invoke.assert_not_called()
            release.assert_not_called()
    finally:
        service.close()


@pytest.mark.parametrize("mode", [AgentMode.OBSERVE, "invalid"])
def test_remote_overwrite_denied_or_unknown_mode_never_dispatches(mode):
    bridge = MagicMock()
    ctx = ToolContext(None, bridge, ssh_session_id="1", mode=AgentMode.CONFIRM)
    ctx.mode = mode
    result = invoke_write_remote_file_tool({
        "path": "/etc/example.conf", "content": "new", "expected_sha256": "0" * 64,
    }, ctx)
    assert result["status"] == "command_blocked"
    bridge.ipc_invoke.assert_not_called()
