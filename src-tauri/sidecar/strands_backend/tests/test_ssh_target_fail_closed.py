"""T2 回归：SSH 目标身份证据不足时必须 fail-closed（V4）。

修复前：live 会话查询失败且 `ctx.ssh_host` 为空时，旧逻辑"跳过校验"，
模型给出的 `ssh_session_id` 会被直接派发——多会话场景下可能打到非目标服务器。
本文件证明该路径已关闭，且证据充分的回退链路不被误阻断。

所有 Rust 桥均为 MagicMock，测试不发起任何真实 SSH 连接。
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from strands_backend.tools import ToolContext, execute_via_ssh

ALLOW = {
    "decision": "allow",
    "risk": {"level": "L0", "matched_rules": []},
    "impact": None,
    "risk_l": 0,
    "reason": "",
}


def make_ctx(host: str = "", active: str = "1") -> ToolContext:
    ctx = ToolContext(
        event_bus=MagicMock(),
        rust_bridge=MagicMock(),
        agent_name="t2-fail-closed",
        session_id="s-t2",
        ssh_session_id=active,
        permission_level=2,
        ssh_host=host,
    )

    def fake_ipc(method: str, params: dict) -> dict:
        # 只让实时会话查询失败；其它调用返回合成成功结果。
        if method == "ssh_status":
            raise RuntimeError("ssh_status unavailable")
        return {"exit_code": 0, "output": "ok", "duration": 0.01}

    ctx.rust_bridge.ipc_invoke.side_effect = fake_ipc
    return ctx


def run(ctx: ToolContext, command: str = "cat /etc/hostname", target: str = "1") -> dict:
    with patch("strands_backend.tools.assess_command", return_value=ALLOW):
        return execute_via_ssh(ctx, command, ssh_session_id=target)


def assert_no_dispatch(ctx: ToolContext) -> None:
    """只允许 ssh_status 状态查询，不得发生任何真实命令派发。"""
    for call in ctx.rust_bridge.ipc_invoke.call_args_list:
        assert call.args[0] == "ssh_status", f"发生了非状态查询的派发：{call.args[0]}"
    assert ctx.rust_bridge.visible_terminal_execute.call_count == 0


def test_missing_host_with_different_target_blocks() -> None:
    """host 缺失且目标会话 != 激活会话 → 阻断（不再因 host 缺失跳过比对）。"""
    ctx = make_ctx(host="", active="1")
    result = run(ctx, target="2")
    assert result["status"] == "command_blocked"
    assert_no_dispatch(ctx)


def test_missing_host_with_same_target_is_not_blocked() -> None:
    """host 缺失但目标 == 激活会话：身份已由会话 ID 确定，不应误阻断。

    这是初版实现的重要修正：若仅因缺少主机名字符串就阻断，会让大量
    "目标就是当前会话"的正常调用被误伤（曾导致 29 个既有测试回退）。
    """
    ctx = make_ctx(host="", active="1")
    result = run(ctx, target="1")
    assert result["status"] != "command_blocked"
    assert "无法验证目标会话身份" not in result.get("message", "")


def test_missing_active_session_blocks() -> None:
    """激活会话未知时无法比对目标身份，同样不得放行。"""
    ctx = make_ctx(host="root@192.0.2.10", active="")
    result = run(ctx)
    assert result["status"] == "command_blocked"
    assert_no_dispatch(ctx)


def test_host_mismatch_still_blocked() -> None:
    """目标会话不是当前激活会话 → 保持既有 host_mismatch 阻断。"""
    ctx = make_ctx(host="root@192.0.2.10", active="1")
    result = run(ctx, target="2")
    assert result["status"] == "command_blocked"
    assert_no_dispatch(ctx)


def test_verified_fallback_is_not_blocked() -> None:
    """live 查询失败但 host 与激活/目标会话证据一致 → 不得误阻断。"""
    ctx = make_ctx(host="root@192.0.2.10", active="1")
    result = run(ctx, target="1")
    assert result["status"] != "command_blocked"
    assert "无法验证目标会话身份" not in result.get("message", "")