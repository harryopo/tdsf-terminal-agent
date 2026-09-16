"""P1d regression gates for retained Strands capabilities."""

from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you

    reset_fix_loop()
    reset_needs_you()
    yield
    reset_fix_loop()
    reset_needs_you()


def _event(name="ssh_command", exception=None):
    event = MagicMock()
    event.tool_use = {"name": name}
    event.exception = exception
    event.cancel_tool = False
    return event


def _call(hook, failed):
    hook._before_tool_call(_event())
    error = RuntimeError("boom") if failed else None
    hook._after_tool_call(_event(exception=error))


def test_prompt_retains_diagnostic_history_and_rollback_guards():
    from strands_backend.adapter import _DEFAULT_SYSTEM_PROMPT

    assert "低侵入、只读取证" in _DEFAULT_SYSTEM_PROMPT
    assert "历史案例只作线索" in _DEFAULT_SYSTEM_PROMPT
    assert "当前主机" in _DEFAULT_SYSTEM_PROMPT
    assert "明确备份或回滚路径" in _DEFAULT_SYSTEM_PROMPT


def test_write_verification_uses_real_tool_log_shape():
    from strands_backend.adapter import _needs_verify_followup

    write = {
        "name": "write_remote_file",
        "input": {"path": "/tmp/x"},
        "success": True,
    }
    verify = {
        "name": "ssh_command",
        "input": {"command": "cat /tmp/x"},
        "success": True,
    }
    assert _needs_verify_followup([write, verify]) is False
    assert _needs_verify_followup([write]) is True
    assert _needs_verify_followup([write, {**verify, "success": False}]) is True


def test_three_failures_handoff_to_needs_you(monkeypatch):
    from strands_backend.adapter import ToolCallLimitHook

    service = MagicMock()
    monkeypatch.setattr("needs_you.get_global_service", lambda: service)
    hook = ToolCallLimitHook(
        agent_name="main", event_bus=MagicMock(), session_id="parity-s1"
    )
    for _ in range(3):
        _call(hook, True)
    hook._before_tool_call(_event())
    assert hook.cancelled is True
    service.notify_fix_loop_exhausted.assert_called_once()


def test_success_resets_failure_budget():
    from fix_loop import get_global_tracker
    from strands_backend.adapter import ToolCallLimitHook

    hook = ToolCallLimitHook(
        agent_name="main", event_bus=MagicMock(), session_id="parity-s2"
    )
    _call(hook, True)
    _call(hook, True)
    _call(hook, False)
    operation_key = hook._fix_loop_operation_key("ssh_command")
    assert get_global_tracker().get_retry_count("parity-s2", operation_key) == 0
