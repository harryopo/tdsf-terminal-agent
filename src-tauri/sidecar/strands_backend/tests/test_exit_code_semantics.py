"""#113②（2026-09-23）：退出码非 0 ≠ 命令失败。

用户实测（openEuler 192.168.45.200）跑 agent 体检时，`journalctl … | grep -c 'avc:  denied'`
这类命令**没有匹配时按 shell 规矩返回 1**，而 `execute_via_ssh` 早期版本把"非 0"一律判成
`status:"error"` → ① 聊天卡红、② 证据记 error、③ **连续 3 次就把整个会话熔断**
（`adapter._before_tool_call` 的 `failure_count >= max_failures`），④ 模型收到的信号比它自己的
判断还差（日志里它推理写对了"grep 无匹配不是错误"，却还是重跑了同一条）。

口径（用户 2026-09-23 选定）：
- **只读 / 低风险命令（risk L0-L1）非 0 → 算跑完了**，退出码原样带回，判断权交还模型；
- **写操作（risk ≥ L2）非 0 → 仍然算失败**，熔断照旧（安全底线不动）；
- **拿不到退出码（缺失 / Rust 的 -1 哨兵）→ 状态未知（indeterminate）**，不再谎报"以退出码 -1 结束"；
- 非 0 时 **stderr 必须一起带回去** —— 放宽之后如果只说"成功"又不给原因，模型会凭空认为一切正常。
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from strands_backend.tools import ToolContext, execute_via_ssh

_ALLOW_L0 = {
    "decision": "allow",
    "risk": {"level": "L0", "high_risk": False},
    "impact": {"segments": [], "max_risk_l": 0},
    "risk_l": 0,
}
_ALLOW_L3 = {
    "decision": "allow",
    "risk": {"level": "L3", "high_risk": True},
    "impact": {"segments": [], "max_risk_l": 3},
    "risk_l": 3,
}


def _ctx(bridge_result: dict[str, Any]) -> ToolContext:
    bridge = MagicMock()
    bridge.ipc_invoke = MagicMock(return_value=bridge_result)
    return ToolContext(
        event_bus=MagicMock(),
        rust_bridge=bridge,
        agent_name="main",
        session_id="t-113-2",
        ssh_session_id="1",
    )


def _run(bridge_result, risk=_ALLOW_L0, command="journalctl -b | grep -c 'avc:  denied'"):
    ctx = _ctx(bridge_result)
    with patch("strands_backend.tools.assess_command", return_value=risk), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = execute_via_ssh(
            ctx=ctx, command=command, ssh_session_id="1", tool_name="ssh_command"
        )
    return result, ctx


# ---------------------------------------------------------------- 只读放宽
def test_readonly_nonzero_exit_is_not_an_error():
    """grep 无匹配（exit 1）+ 输出完整 → 不再被判 error，退出码原样带回。"""
    result, _ = _run({"ok": True, "output": "0", "exit_code": 1, "duration": 0.1})
    assert result["status"] == "success"
    assert result["exit_code"] == 1
    assert "error" not in result
    assert result["output"] == "0"


def test_readonly_nonzero_still_carries_stderr_so_model_sees_why():
    """放宽的前提是把原因交回去：诊断信息常在 stderr，只说 success 会让模型凭空认为正常。"""
    result, _ = _run(
        {
            "ok": True,
            "output": "",
            "stderr": "cat: /missing: No such file or directory",
            "exit_code": 1,
            "duration": 0.1,
        },
        command="cat /missing",
    )
    assert result["status"] == "success"
    assert result["exit_code"] == 1
    assert "No such file" in result["stderr"]


def test_readonly_nonzero_hints_the_model_instead_of_verdict():
    """给一句口径说明，而不是替它下'失败'结论。"""
    result, _ = _run({"ok": True, "output": "0", "exit_code": 1, "duration": 0.1})
    note = result.get("note", "")
    assert "退出码" in note and "不一定是失败" in note


def test_readonly_nonzero_closes_the_card_as_completed():
    """卡片主人（#114）跟着新口径走：不再红着报 error。"""
    _, ctx = _run({"ok": True, "output": "0", "exit_code": 1, "duration": 0.1})
    statuses = [c.kwargs["status"] for c in ctx.event_bus.emit_tool_call.call_args_list]
    assert statuses == ["started", "completed"]


def test_readonly_nonzero_records_completed_evidence():
    """证据面板不再把一次正常体检记成 error。"""
    ctx = _ctx({"ok": True, "output": "0", "exit_code": 1, "duration": 0.1})
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW_L0), patch(
        "strands_backend.tools._track_evidence"
    ) as evidence:
        execute_via_ssh(
            ctx=ctx, command="ps -ef | grep -c nginx", ssh_session_id="1",
            tool_name="ssh_command",
        )
    assert evidence.call_args.kwargs["status"] == "completed"


# ---------------------------------------------------------------- 写操作仍算失败
def test_write_command_nonzero_still_errors_and_keeps_breaker():
    """`systemctl restart` 返回 1 是真失败：状态、证据、卡片都照旧报错。"""
    result, ctx = _run(
        {"ok": True, "output": "", "stderr": "Job for nginx failed.", "exit_code": 1},
        risk=_ALLOW_L3,
        command="systemctl restart nginx",
    )
    assert result["status"] == "error"
    assert result["exit_code"] == 1
    assert "Job for nginx failed" in result["stderr"]
    statuses = [c.kwargs["status"] for c in ctx.event_bus.emit_tool_call.call_args_list]
    assert statuses == ["started", "error"]


# ---------------------------------------------------------------- 拿不到退出码
def test_rust_minus_one_sentinel_is_unknown_not_fake_exit_code():
    """-1 是 Rust '没收到退出状态' 的哨兵，不能当成'命令以退出码 -1 结束'。"""
    result, _ = _run({"ok": True, "output": "partial", "exit_code": -1, "duration": 0.1})
    assert result["status"] == "indeterminate"
    assert result["reason"] == "exit_code_unavailable"
    assert "-1 结束" not in str(result)


def test_missing_exit_code_is_unknown():
    """完全没有退出码：状态未知（诚实），不伪装成功也不谎报具体码。"""
    result, _ = _run({"ok": True, "output": "partial", "duration": 0.1})
    assert result["status"] == "indeterminate"
    assert result["reason"] == "missing_or_invalid_exit_code"


# ---------------------------------------------------------------- 零退出码不变
def test_zero_exit_still_plain_success():
    result, _ = _run({"ok": True, "output": "hello", "exit_code": 0, "duration": 0.1},
                     command="echo hello")
    assert result["status"] == "success"
    assert result["exit_code"] == 0
    assert "note" not in result
