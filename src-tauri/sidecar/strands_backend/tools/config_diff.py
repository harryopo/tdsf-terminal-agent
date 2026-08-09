"""config_diff 工具 — 配置文件差异对比（SSH 远端执行）

TDSF 魔改 (2026-08-09): 方案书集成度补齐。
对比当前配置文件与备份版本的差异，辅助用户理解配置变更。
通过 ssh_command 工具在远端执行 diff 命令。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.config_diff")


def invoke_config_diff(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """对比两个配置文件的差异

    Args:
        params:
            - file_a (str, 必填): 文件 A 路径（当前配置）
            - file_b (str, 必填): 文件 B 路径（备份或参考配置）
            - ssh_session_id (str, 可选): SSH 会话 ID
        ctx: ToolContext

    Returns:
        dict: {diff: str, identical: bool, exit_code: int}
    """
    file_a = str(params.get("file_a", "")).strip()
    file_b = str(params.get("file_b", "")).strip()
    if not file_a or not file_b:
        return {"diff": "", "identical": False, "exit_code": 1,
                "error": "file_a and file_b are required"}

    # 构建 diff 命令（安全：路径用单引号包裹防注入）
    cmd = f"diff -u '{file_a}' '{file_b}' 2>&1 || true"

    # 复用 ssh_command 执行
    from strands_backend.tools.ssh_command import invoke_ssh_command_tool
    result = invoke_ssh_command_tool(
        params={
            "command": cmd,
            "ssh_session_id": params.get("ssh_session_id", ""),
            "explanation": f"对比 {file_a} 与 {file_b} 的差异",
            "timeout": 10,
        },
        ctx=ctx,
    )

    output = result.get("output", "")
    exit_code = result.get("exit_code", 1)
    # diff 返回 0=相同，1=有差异，2=错误
    identical = exit_code == 0

    return {
        "diff": output,
        "identical": identical,
        "exit_code": exit_code,
        "file_a": file_a,
        "file_b": file_b,
    }


def make_config_diff_tool(ctx: ToolContext):
    """构建 config_diff 工具"""

    @tool
    def config_diff(
        file_a: str,
        file_b: str,
        ssh_session_id: str = "",
    ) -> dict:
        """对比两个配置文件的差异（在 SSH 远端执行 diff -u）。

        用于查看当前配置与备份/参考配置之间的变更。

        Args:
            file_a (str): 当前配置文件路径。
            file_b (str): 备份或参考配置文件路径。
            ssh_session_id (str): SSH 会话 ID（空则用默认会话）。

        Returns:
            dict: {diff: str, identical: bool, exit_code: int, file_a, file_b}
        """
        return invoke_config_diff(
            {"file_a": file_a, "file_b": file_b, "ssh_session_id": ssh_session_id},
            ctx,
        )

    config_diff.__name__ = "config_diff"
    return config_diff
