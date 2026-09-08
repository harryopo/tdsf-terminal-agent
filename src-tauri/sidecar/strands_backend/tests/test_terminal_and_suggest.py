"""终端回读与命令建议契约测试。

这些测试只覆盖工具边界，不依赖真实 SSH/PTY：回读必须返回事实性元数据，
命令建议未命中时必须明确要求补充意图，不能伪造一条可执行命令。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

_SIDECAR_DIR = Path(__file__).resolve().parents[2]
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

from strands_backend.tools import ToolContext
from strands_backend.tools.get_terminal_output import invoke_get_terminal_output
from strands_backend.tools.suggest_command import invoke_suggest_command_tool


def _ctx(bridge: object | None = None) -> ToolContext:
    return ToolContext(
        event_bus=MagicMock(),
        rust_bridge=bridge,
        session_id="test-session",
        ssh_session_id="1",
    )


def test_suggest_prefers_specific_phrase_over_generic_keyword() -> None:
    result = invoke_suggest_command_tool(
        {"intent": "查看 nginx 状态"},
        _ctx(MagicMock()),
    )
    assert result["status"] == "success"
    assert result["command"] == "systemctl status nginx --no-pager"


def test_suggest_does_not_match_ascii_substrings() -> None:
    result = invoke_suggest_command_tool(
        {"intent": "解释 topology 拓扑"},
        _ctx(MagicMock()),
    )
    assert result["status"] == "unmatched"
    assert result["command"] is None
    assert result["suggestions"]


def test_suggest_does_not_treat_server_connection_as_service_status() -> None:
    result = invoke_suggest_command_tool(
        {"intent": "连接远程服务器 192.168.45.200"},
        _ctx(MagicMock()),
    )
    assert result["status"] == "unmatched"
    assert result["command"] is None


def test_suggest_does_not_treat_network_namespace_as_disk_space() -> None:
    result = invoke_suggest_command_tool(
        {"intent": "查看当前网络命名空间"},
        _ctx(MagicMock()),
    )
    assert result["status"] == "unmatched"
    assert result["command"] is None


def test_terminal_output_passes_requested_lines_and_metadata() -> None:
    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {
        "output": "line-1\nline-2",
        "available": True,
    }
    result = invoke_get_terminal_output({"lines": 2}, _ctx(bridge))
    bridge.ipc_invoke.assert_called_once_with(
        "get_terminal_scrollback",
        {"sessionId": "1", "lines": 2},
    )
    assert result["available"] is True
    assert result["lines_requested"] == 2
    assert result["lines_returned"] == 2
    assert result["has_more"] is True
    assert result["truncated"] is False


def test_terminal_output_marks_character_truncation_without_external_storage() -> None:
    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {
        "output": "x" * 24_500,
        "available": True,
    }
    result = invoke_get_terminal_output({"lines": 80}, _ctx(bridge))
    assert result["available"] is True
    assert result["truncated"] is True
    assert result["output_chars"] == 24_500
    assert "外部存储" not in result["note"]


def test_terminal_output_without_bridge_is_explicitly_unavailable() -> None:
    result = invoke_get_terminal_output({"lines": 10}, _ctx(None))
    assert result["available"] is False
    assert result["lines_requested"] == 10
    assert result["truncated"] is False


def test_terminal_output_keeps_channel_available_when_output_is_empty() -> None:
    bridge = MagicMock()
    bridge.ipc_invoke.return_value = {"output": "", "available": True}
    result = invoke_get_terminal_output({"lines": 10}, _ctx(bridge))
    assert result["available"] is True
    assert result["lines_returned"] == 0
    assert result["output"] == ""


def test_security_audit_has_teaching_shell_mapping() -> None:
    from strands_backend.tools.ops_extended import security_audit_to_shell_command
    from strands_backend.tools.shell_mapping import has_shell_mapping

    assert has_shell_mapping("security_audit") is True
    assert security_audit_to_shell_command({"scope": "open_ports"}) == (
        "ss -tlnp | awk 'NR>1 {print $4, $6}'"
    )
