"""#113③（2026-09-23）：远端没有 OSC 块时的兜底 —— 改道可以，但写命令绝不重放。

实测现场：可见终端执行靠远端 shell 的 OSC 133/633 块结算（Rust 注入
`BASH_INTEGRATION_SCRIPT`）。bash/zsh 以外的 shell（或 DEBUG trap 被 extdebug
占用、PROMPT_COMMAND 被用户接管）会导致**一个块都不来**，旧行为是白等到超时
→ `indeterminate`。#113② 之后这类结果全落在"状态未知"，覆盖面变大。

前端新增的兜底是回 `{"status":"reroute","channel":"background",
"reason":"no_shell_integration"}`。但"没收到块"**不等于**"没执行"：
命令可能已经在服务器上跑过一遍了。所以这一层必须按风险级决定能不能改道重跑：

- 只读 / 低风险（risk_l < 2）：最坏是同一只读命令跑两遍 → 允许改道，拿回真结果；
- 写操作（risk_l >= 2）：**绝不重放**（红线9 SSH 双重执行家族），保持状态未知；
- 老原因 `execution_channel_changed` 是"通道在派发前就没了、压根没执行" →
  任何风险级都照旧改道（不退化既有行为）。
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

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

_NO_INTEGRATION = {
    "status": "reroute",
    "channel": "background",
    "reason": "no_shell_integration",
}
_CHANNEL_CHANGED = {
    "status": "reroute",
    "channel": "background",
    "reason": "execution_channel_changed",
}
# #118 后半（2026-09-25 用户拍板）：界面没有可写的终端，但连接是活的。
# 前端担保"命令一个字都没写进终端"，所以改道不会造成二次执行 —— 代价是
# 界面上看不见这次执行，因此载荷必须明说换了通道，且写操作一寸不松。
_NO_VISIBLE_TERMINAL = {
    "status": "reroute",
    "channel": "background",
    "reason": "no_visible_terminal",
    "message": (
        "这台服务器已连接，但界面上没有打开的终端可以写（还停在欢迎页／当前标签页是本地壳），"
        "命令未执行。请先在顶栏打开这个工作区、切到它的终端标签页，再让我执行。"
    ),
}
_EXEC_OK = {"ok": True, "output": "Linux 6.6\n", "exit_code": 0, "duration": 0.2}


def _bridge(first: dict[str, Any], then: dict[str, Any]) -> tuple[MagicMock, list[str]]:
    """按方法名分派的假 RustBridge。

    `execute_via_ssh` 派发前会先调 `ssh_status` 查活会话；这里让它抛错走
    "查询失败 → 回退不校验"那条既有分支，以免测试替活会话检查负责。
    """
    calls: list[str] = []

    def invoke(method: str, params: Any = None, **kw: Any) -> dict[str, Any]:
        calls.append(method)
        if method == "ssh_status":
            raise RuntimeError("test: liveness query disabled")
        if method == "visible_terminal_execute":
            return first
        if method == "ssh_command":
            return then
        raise AssertionError(f"unexpected ipc method {method}")

    bridge = MagicMock()
    bridge.ipc_invoke = MagicMock(side_effect=invoke)
    return bridge, calls


def _run(first, then, risk, command="cat /etc/os-release"):
    bridge, calls = _bridge(first, then)
    ctx = ToolContext(
        event_bus=MagicMock(),
        rust_bridge=bridge,
        agent_name="main",
        session_id="t-113-3",
        ssh_session_id="1",
        execution_channel="visible-terminal",
    )
    with patch("strands_backend.tools.assess_command", return_value=risk), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = execute_via_ssh(
            ctx=ctx, command=command, ssh_session_id="1", tool_name="ssh_command"
        )
    return result, calls


def _dispatched(calls: list[str]) -> list[str]:
    """只看真正派发命令的那几次（活会话查询不参与断言）。"""
    return [c for c in calls if c != "ssh_status"]


def test_readonly_no_integration_falls_back_to_exec_and_returns_real_result():
    """只读命令拿不到 OSC 块 → 改道后台 exec，模型拿到真结果而不是"未知"。"""
    result, calls = _run(_NO_INTEGRATION, _EXEC_OK, _ALLOW_L0)
    assert result["status"] == "success"
    assert result["exit_code"] == 0
    assert result["output"] == "Linux 6.6\n"
    assert _dispatched(calls) == ["visible_terminal_execute", "ssh_command"]


def test_write_command_is_never_replayed_when_blocks_never_arrive():
    """写命令可能已经在服务器上跑过：绝不改道重放，如实报状态未知。"""
    result, calls = _run(
        _NO_INTEGRATION,
        _EXEC_OK,
        _ALLOW_L3,
        command="systemctl restart nginx",
    )
    assert _dispatched(calls) == ["visible_terminal_execute"], "写命令不得二次派发"
    assert result["status"] in ("indeterminate", "error")
    assert result["reason"] == "no_shell_integration"


def test_channel_changed_reroute_still_works_for_write_commands():
    """这条改道是"压根没执行"，与双重执行无关 —— 写命令也照旧改道，别退化。"""
    result, calls = _run(
        _CHANNEL_CHANGED,
        {"ok": True, "output": "", "exit_code": 0, "duration": 0.1},
        _ALLOW_L3,
        command="systemctl restart nginx",
    )
    assert _dispatched(calls) == ["visible_terminal_execute", "ssh_command"]
    assert result["status"] == "success"


def test_reroute_result_is_not_reported_as_a_command_failure():
    """改道成功不能因为中间那条 reroute 被判失败，否则又喂给"连续 3 次熔断"。"""
    result, _ = _run(_NO_INTEGRATION, _EXEC_OK, _ALLOW_L0)
    assert result.get("loop_progress") != "failed"
    assert "error" not in result


def test_unknown_reroute_reason_is_not_treated_as_safe():
    """认不出的 reroute 原因按最坏情况处理：不重放（新增原因默认不获得豁免）。"""
    result, calls = _run(
        {"status": "reroute", "channel": "background", "reason": "brand_new_thing"},
        _EXEC_OK,
        _ALLOW_L3,
        command="rm -rf /var/log/old",
    )
    assert _dispatched(calls) == ["visible_terminal_execute"]
    assert result["status"] in ("indeterminate", "error")


# ---------------------------------------------------------------------------
# #118 后半（2026-09-25 用户拍板）：没有可见终端时，只读命令改走后台并明说；
# 写操作仍不执行。真实现场是欢迎页 —— 连接活着、一块终端都没挂载，
# 旧行为是三条只读命令 1–6 毫秒全被拒，agent 连撞三次然后汇报失败。
# ---------------------------------------------------------------------------


def test_readonly_no_visible_terminal_reroutes_and_says_so_in_payload():
    """只读命令：改道后台拿真结果，并在载荷里写明换了通道（不许静默换）。"""
    result, calls = _run(_NO_VISIBLE_TERMINAL, _EXEC_OK, _ALLOW_L0, command="uptime")
    assert _dispatched(calls) == ["visible_terminal_execute", "ssh_command"]
    assert result["status"] == "success"
    assert result["execution_channel"] == "background"
    note = str(result.get("execution_channel_note") or "")
    assert "没有可见终端" in note, "换了通道却不告诉模型 = 教它撒谎"
    assert "后台" in note


def test_write_command_is_still_refused_when_no_visible_terminal():
    """写操作一寸不松：没有可见终端就是不执行，指路的话照旧带回去。"""
    result, calls = _run(
        _NO_VISIBLE_TERMINAL,
        _EXEC_OK,
        _ALLOW_L3,
        command="systemctl restart nginx",
    )
    assert _dispatched(calls) == ["visible_terminal_execute"], "写命令不得改道后台执行"
    assert result["status"] == "unavailable"
    assert result["reason"] == "no_visible_terminal"
    assert "终端标签页" in result["message"], "拒了却不给可照做的指引（#118 的原始缺陷）"


def test_no_integration_reroute_also_says_the_command_ran_in_background():
    """同一条原则的另一半：因缺 OSC 块而改道时，模型也要知道这次跑在后台。"""
    result, _ = _run(_NO_INTEGRATION, _EXEC_OK, _ALLOW_L0)
    note = str(result.get("execution_channel_note") or "")
    assert "后台" in note


def test_channel_changed_by_the_user_needs_no_apology_note():
    """用户自己把偏好切成后台的 —— 那不是"换通道"，不必额外解释（正向配对）。"""
    result, _ = _run(
        _CHANNEL_CHANGED,
        {"ok": True, "output": "", "exit_code": 0, "duration": 0.1},
        _ALLOW_L0,
    )
    assert result["status"] == "success"
    assert "execution_channel_note" not in result


def test_background_by_default_reports_no_channel_note():
    """偏好本来就是后台：不许凭空冒出一句"改走后台"（假事实）。"""
    bridge, _ = _bridge(_EXEC_OK, _EXEC_OK)
    ctx = ToolContext(
        event_bus=MagicMock(),
        rust_bridge=bridge,
        agent_name="main",
        session_id="t-118b",
        ssh_session_id="1",
        execution_channel="background",
    )
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW_L0), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="1", tool_name="ssh_command"
        )
    assert result["status"] == "success"
    assert "execution_channel_note" not in result
