"""backup_restore 工具 — 配置文件备份与恢复（SSH 远端执行）

TDSF 魔改 (2026-08-09): 方案书集成度补齐。
在修改关键配置文件前先备份，出问题时恢复。
通过 ssh_command 工具在远端执行 cp 命令。
"""
from __future__ import annotations

import logging
import shlex
import time
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.backup_restore")


def _cp_ok(result: dict[str, Any]) -> bool:
    """判定 cp 命令真实成功

    execute_via_ssh 对 exit_code != 0 仍可能返回 status="success"
    （status 只表示命令通道正常），必须同时校验 exit_code == 0，
    否则 cp 失败（权限不足/文件不存在）会被误报为成功 → 用户以为
    有备份就放心改配置，恢复时才发现无备份（2026-08-28 审查修复）。
    """
    return result.get("status") == "success" and result.get("exit_code", 1) == 0


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
        # shlex.quote 转义路径: 单引号包裹不能防注入（路径含 ' 即可闭合
        # 引号注入任意命令，且 file_path 来自 LLM 参数），必须用 shlex.quote
        cmd = f"cp -p {shlex.quote(file_path)} {shlex.quote(backup_path)} && echo 'backup ok'"
        result = invoke_ssh_command_tool(
            params={
                "command": cmd,
                "ssh_session_id": params.get("ssh_session_id", ""),
                "explanation": f"备份 {file_path} → {backup_path}",
                "timeout": 10,
            },
            ctx=ctx,
        )
        ok = _cp_ok(result)
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
            # 找最新的 .bak.N 文件（glob 由 shell 展开, 引号只包前缀部分;
            # shlex.quote 防止 file_path 含引号注入）
            cmd_find = f"ls -t {shlex.quote(file_path)}.bak.* 2>/dev/null | head -1"
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
        cmd = f"cp -p {shlex.quote(backup_path)} {shlex.quote(file_path)} && echo 'restore ok'"
        result = invoke_ssh_command_tool(
            params={
                "command": cmd,
                "ssh_session_id": params.get("ssh_session_id", ""),
                "explanation": f"恢复 {backup_path} → {file_path}",
                "timeout": 10,
            },
            ctx=ctx,
        )
        ok = _cp_ok(result)
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
