"""Dedicated one-step command card for teaching mode.

This tool never executes a command.  It exists as a stable teaching schema
entry when a lesson needs a command that does not correspond to an operations
tool's parameter schema (for example, a deployment step).
"""
from __future__ import annotations

from typing import Any

from strands_backend.tools import ToolContext, tool
from strands_backend.tools.command_impact import analyze


def invoke_teach_command_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Create exactly one visible teaching card without touching a terminal."""
    command = str(params.get("command") or "").strip()
    if not command:
        raise ValueError("teach_command 工具必填参数缺失: command")
    if not ctx.teach:
        return {
            "status": "teach_command_unavailable",
            "message": "教学命令卡只能在教学模式使用。",
        }

    impact = analyze(command)
    if impact.get("denied"):
        return {
            "status": "teach_command_unavailable",
            "message": "该命令命中安全硬底线，不能生成教学命令卡。",
        }
    if ctx.teach_step_emitted:
        return {
            "status": "teach_step_pending",
            "message": "上一张教学命令卡仍在等待终端回显；请先完成后再继续。",
        }

    ctx.teach_step_emitted = True
    explanation = str(params.get("explanation") or "").strip()
    predicted_output = str(params.get("predicted_output") or "").strip()
    return {
        "status": "teach_command",
        "command": command,
        "impact": impact,
        "tool_name": "teach_command",
        "predicted_output": predicted_output
        or "将显示该命令的原生终端输出和退出状态；具体内容以当前主机为准。",
        "explanation": explanation or "请先执行这一条命令，再根据终端回显继续下一步。",
    }


def make_teach_command_tool(ctx: ToolContext):
    """Build the schema-only teaching command-card tool."""

    @tool
    def teach_command(
        command: str,
        explanation: str = "",
        predicted_output: str = "",
    ) -> dict:
        """生成一张教学命令卡，不在后端执行命令。

        仅教学模式可用。每轮只调用一次；学生点击卡片后，命令才会以打字机
        方式输入当前可见终端。调用后必须停止，等待教学回显证据。

        Args:
            command: 本步唯一要让学生执行的 Linux shell 命令。
            explanation: 让学生观察什么的简短说明。
            predicted_output: 预期能看到的现象，不能编造具体主机数据。
        """
        return invoke_teach_command_tool(
            {
                "command": command,
                "explanation": explanation,
                "predicted_output": predicted_output,
            },
            ctx,
        )

    teach_command.__name__ = "teach_command"
    return teach_command


__all__ = ["invoke_teach_command_tool", "make_teach_command_tool"]
