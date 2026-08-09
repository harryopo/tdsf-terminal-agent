"""backup_restore 工具 — 配置文件备份与恢复（SSH 远端执行）

TDSF 魔改 (2026-08-09): 方案书集成度补齐。
在修改关键配置文件前先备份，出问题时恢复。
通过 ssh_command 工具在远端执行 cp 命令。
"""
from __future__ import annotations

import logging
import time
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.backup_restore")


def invoke_backup_restore(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """备份或恢复配置文件

    Args:
        params:
            - action (str): "backup" | "restore"
            - file_path (str, 必填): 配置文件路径
            - backup_path (str, 可选): 备份路径（默认自动生成 .bak.N）
            - ssh_session_id (str, 可选): SSH 会话 ID
        ctx: ToolContext

    Returns:
        dict: {ok: bool, action: str, file_path: str, backup_path: str, message: str}
    """
    action = str(params.get("action", "backup")).strip().lower()
    file_path = str(params.get("file_path", "")).strip()
    if not file_path:
        return {"ok": False, "action": action, "message": "file_path is required"}

    if action not in ("backup", "restore"):
        return {"ok": False, "action": action, "message": "action must be 'backup' or 'restore'"}

    backup_path = str(params.get("backup_path", "")).strip()

    # 复用 ssh_command 执行
    from strands_backend.tools.ssh_command import invoke_ssh_command_tool

    if action == "backup":
        # 备份: cp file_path backup_path
        if not backup_path:
            ts = int(time.time())
            backup_path = f"{file_path}.bak.{ts}"
        cmd = f"cp -p '{file_path}' '{backup_path}' && echo 'backup ok: {backup_path}'"
        result = invoke_ssh_command_tool(
            params={
                "command": cmd,
                "ssh_session_id": params.get("ssh_session_id", ""),
                "explanation": f"备份 {file_path} → {backup_path}",
                "timeout": 10,
            },
            ctx=ctx,
        )
        ok = result.get("status") == "success"
        return {
            "ok": ok,
            "action": "backup",
            "file_path": file_path,
            "backup_path": backup_path,
            "message": result.get("output", ""),
        }
    else:
        # 恢复: cp backup_path file_path
        if not backup_path:
            # 找最新的 .bak.N 文件
            cmd_find = f"ls -t '{file_path}.bak.'* 2>/dev/null | head -1"
            result_find = invoke_ssh_command_tool(
                params={
                    "command": cmd_find,
                    "ssh_session_id": params.get("ssh_session_id", ""),
                    "explanation": f"查找 {file_path} 的最新备份",
                    "timeout": 5,
                },
                ctx=ctx,
            )
            backup_path = result_find.get("output", "").strip().split("\n")[0].strip()
            if not backup_path:
                return {
                    "ok": False,
                    "action": "restore",
                    "file_path": file_path,
                    "message": "未找到备份文件",
                }
        cmd = f"cp -p '{backup_path}' '{file_path}' && echo 'restore ok'"
        result = invoke_ssh_command_tool(
            params={
                "command": cmd,
                "ssh_session_id": params.get("ssh_session_id", ""),
                "explanation": f"恢复 {backup_path} → {file_path}",
                "timeout": 10,
            },
            ctx=ctx,
        )
        ok = result.get("status") == "success"
        return {
            "ok": ok,
            "action": "restore",
            "file_path": file_path,
            "backup_path": backup_path,
            "message": result.get("output", ""),
        }


def make_backup_restore_tool(ctx: ToolContext):
    """构建 backup_restore 工具"""

    @tool
    def backup_restore(
        action: str,
        file_path: str,
        backup_path: str = "",
        ssh_session_id: str = "",
    ) -> dict:
        """备份或恢复配置文件（在 SSH 远端执行 cp）。

        action="backup": 将 file_path 备份到 backup_path（空则自动 .bak.时间戳）。
        action="restore": 将 backup_path 恢复到 file_path（空则找最新 .bak.N）。

        建议在修改关键配置文件前先 backup，出问题时 restore。

        Args:
            action (str): "backup" 或 "restore"。
            file_path (str): 配置文件路径。
            backup_path (str): 备份路径（backup 可选，restore 空则找最新）。
            ssh_session_id (str): SSH 会话 ID（空则用默认会话）。

        Returns:
            dict: {ok, action, file_path, backup_path, message}
        """
        return invoke_backup_restore(
            {
                "action": action,
                "file_path": file_path,
                "backup_path": backup_path,
                "ssh_session_id": ssh_session_id,
            },
            ctx,
        )

    backup_restore.__name__ = "backup_restore"
    return backup_restore
