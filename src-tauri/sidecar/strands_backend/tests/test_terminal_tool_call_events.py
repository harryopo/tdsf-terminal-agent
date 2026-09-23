"""#114（2026-09-23）：往终端写命令，必须留下一张能追溯到"是哪一步"的工具调用卡。

判据不是"某个工具记得发事件"，而是 **凡经 execute_via_ssh 落进终端的命令都恰好有一对
started → 终态事件，且卡上写的是真正跑的那个工具名**。

历史病：emit_tool_call 由每个工具手写一遍 ——
- ops_extended 五个工具（service_manage 等）一个都不发 → 命令进了终端，聊天里查不到来源；
- backup_restore / config_diff 借 ssh_command 执行 → 卡有，但名字一律显示成 ssh_command。
现在收口成 execute_via_ssh 一个主人，所以本文件同时钉住"不许重复发"（中心 + 手写 = 双卡）。
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from strands_backend.tools import ToolContext, execute_via_ssh
from strands_backend.tools.backup_restore import invoke_backup_restore
from strands_backend.tools.ops_extended import invoke_service_manage_tool
from strands_backend.tools.ssh_command import invoke_ssh_command_tool

_ALLOW = {
    "decision": "allow",
    "risk": {"level": "L0", "high_risk": False},
    "impact": {"segments": [], "max_risk_l": 0},
    "risk_l": 0,
}
_BLOCKED = {
    **_ALLOW,
    "decision": "blocked",
    "reason": "命中硬底线黑名单",
}


def _ctx() -> ToolContext:
    """带 mock event_bus / rust_bridge 的最小上下文（不碰真数据目录）。"""
    bus = MagicMock()
    bus.emit_tool_call = MagicMock(return_value=1)
    bridge = MagicMock()
    bridge.ipc_invoke = MagicMock(
        return_value={"ok": True, "output": "mock output", "exit_code": 0, "duration": 0.1}
    )
    return ToolContext(
        event_bus=bus,
        rust_bridge=bridge,
        agent_name="main",
        session_id="test-session",
        ssh_session_id="1",
    )


def _events(ctx: ToolContext) -> list[dict[str, Any]]:
    return [c.kwargs for c in ctx.event_bus.emit_tool_call.call_args_list]


def _statuses(ctx: ToolContext) -> list[str]:
    return [e["status"] for e in _events(ctx)]


def test_ops_tool_emits_paired_card_under_its_own_name():
    """service_manage 重启/查看服务也要有卡，且卡上写 service_manage。

    这是用户报的"有时候不显示 ssh 工具调用"那一半：命令确实进了终端。
    """
    ctx = _ctx()
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = invoke_service_manage_tool(
            {"action": "status", "service": "nginx"}, ctx
        )

    assert result["status"] == "success"
    events = _events(ctx)
    assert [e["status"] for e in events] == ["started", "completed"]
    assert {e["tool_name"] for e in events} == {"service_manage"}
    # 卡上必须看得见真正敲进终端的那行命令，而不是工具入参（action/service）
    assert events[0]["params"]["command"] == "systemctl status nginx --no-pager -l"


def test_ssh_command_emits_exactly_one_pair():
    """中心发一次 + 工具自己再发一次 = 双卡；手写那遍必须删干净。"""
    ctx = _ctx()
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = invoke_ssh_command_tool({"command": "df -h"}, ctx)

    assert result["status"] == "success"
    assert _statuses(ctx) == ["started", "completed"]
    assert {e["tool_name"] for e in _events(ctx)} == {"ssh_command"}


def test_blocked_command_still_closes_the_card():
    """被拦截也必须闭合：started 不发终态会在前端留一张永远转圈的卡。

    前端对孤儿 completed 是直接丢弃的（sidecar-adapter.ts:880-950），所以反过来
    "只有 started 没有终态"更糟——卡片停在输入态无人收尾。
    """
    ctx = _ctx()
    with patch("strands_backend.tools.assess_command", return_value=_BLOCKED), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = invoke_ssh_command_tool({"command": "rm -rf /"}, ctx)

    assert result["status"] == "command_blocked"
    assert _statuses(ctx) == ["started", "error"]
    assert _events(ctx)[1]["result"]["status"] == "command_blocked"


def test_backend_exception_still_closes_the_card():
    """执行体抛异常时同样要闭合，别让聊天里留一张没有下文的卡。"""
    ctx = _ctx()
    with patch(
        "strands_backend.tools._execute_via_ssh_impl",
        side_effect=RuntimeError("boom"),
    ):
        with pytest.raises(RuntimeError):
            execute_via_ssh(ctx, "df -h")

    assert _statuses(ctx) == ["started", "error"]


def test_borrowed_execution_is_labelled_with_the_calling_tool():
    """backup_restore 借 ssh_command 干活，卡上写的必须是 backup_restore。

    这是用户报的"命令建议和 ssh 调用混用"：一次备份只该出现一张 backup_restore 卡。
    """
    ctx = _ctx()
    with patch("strands_backend.tools.assess_command", return_value=_ALLOW), patch(
        "strands_backend.tools._track_evidence"
    ):
        result = invoke_backup_restore(
            {"action": "backup", "file_path": "/etc/nginx/nginx.conf"}, ctx
        )

    assert result["ok"] is True
    events = _events(ctx)
    assert [e["status"] for e in events] == ["started", "completed"]
    assert {e["tool_name"] for e in events} == {"backup_restore"}
    assert events[0]["params"]["command"].startswith("cp -p /etc/nginx/nginx.conf")
