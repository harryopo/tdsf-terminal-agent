"""get_terminal_output 工具 — 获取终端最近输出（Sidecar 路径）

TDSF 魔改 (2026-08-09): 方案书集成度补齐。
前端 Vercel SDK 路径已有 get_terminal_output（terminal.ts），
Python Sidecar 路径缺失。本工具让 Sidecar agent 也能读终端 scrollback。

数据来源：通过 rust_bridge 反向调用 Rust 获取 SSH 终端 scrollback。
Rust 端复用已有的 PTY scrollback 缓存（session.rs）。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.get_terminal_output")


def invoke_get_terminal_output(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """获取终端最近 N 行输出

    Args:
        params:
            - lines (int, 可选): 返回行数，默认 80，上限 2000
        ctx: ToolContext

    Returns:
        dict: {output: str, lines_returned: int, available: bool}
    """
    lines = int(params.get("lines", 80))
    lines = max(1, min(lines, 2000))

    # 通过 rust_bridge 获取终端 scrollback
    if ctx.rust_bridge is None:
        return {"output": "", "lines_returned": 0, "available": False}

    try:
        result = ctx.rust_bridge.ipc_invoke("get_terminal_scrollback", {
            "sessionId": ctx.ssh_session_id or "",
            "lines": lines,
        })
        output = str(result.get("output", "")) if result else ""
        # 截断到 24000 字符（与前端对齐）
        max_chars = 24000
        if len(output) > max_chars:
            output = output[-max_chars:]
        return {
            "output": output,
            "lines_returned": output.count("\n") + 1 if output else 0,
            "available": bool(output),
        }
    except Exception as e:
        logger.debug(f"get_terminal_output failed: {e}")
        return {"output": "", "lines_returned": 0, "available": False}


def make_get_terminal_output_tool(ctx: ToolContext):
    """构建 get_terminal_output 工具"""

    @tool
    def get_terminal_output(
        lines: int = 80,
    ) -> dict:
        """获取当前终端最近 N 行输出（scrollback）。

        用于查看用户最近在终端执行的命令和输出结果。
        SSH 连接时读取远端终端；未连接时返回空。

        Args:
            lines (int): 返回行数，默认 80，上限 2000。

        Returns:
            dict: {output: str, lines_returned: int, available: bool}
        """
        return invoke_get_terminal_output({"lines": lines}, ctx)

    get_terminal_output.__name__ = "get_terminal_output"
    return get_terminal_output
