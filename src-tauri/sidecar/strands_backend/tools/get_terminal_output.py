"""get_terminal_output 工具 — 获取终端最近输出（Sidecar 路径）

TDSF (2026-08-09): 方案书集成度补齐。
前端 Vercel SDK 路径已有 get_terminal_output（terminal.ts），
Python Sidecar 路径缺失。本工具让 Sidecar agent 也能读终端 scrollback。

数据来源：通过 rust_bridge 反向调用 Rust 获取 SSH 终端 scrollback。
Rust 端复用已有的 PTY scrollback 缓存（session.rs）。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool
# TDSF 2026-08-28 (B1-G1): 终端文本进 LLM 前必须脱敏（对齐前端 redact.ts）
from strands_backend.tools._redact import redact_sensitive_text

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
        dict: {output: str, lines_requested: int, lines_returned: int,
               available: bool, truncated: bool}. ``available`` describes
               the terminal channel, so an active terminal with no output is
               available=True and output="".
    """
    lines = int(params.get("lines", 80))
    lines = max(1, min(lines, 2000))

    # 通过 rust_bridge 获取终端 scrollback
    if ctx.rust_bridge is None:
        return {
            "output": "",
            "lines_requested": lines,
            "lines_returned": 0,
            "available": False,
            "truncated": False,
            "note": "当前没有可读取的活动终端。",
        }

    try:
        result = ctx.rust_bridge.ipc_invoke("get_terminal_scrollback", {
            "sessionId": ctx.ssh_session_id or "",
            "lines": lines,
        })
        output = str(result.get("output", "")) if result else ""
        # Rust 端返回 available=false 时不能把空字符串误报为“命令没有输出”。
        bridge_available = bool(result and result.get("available", True))
        original_length = len(output)
        # 截断到 24000 字符（与前端对齐）
        max_chars = 24000
        char_truncated = len(output) > max_chars
        if char_truncated:
            output = output[-max_chars:]
        # TDSF 2026-08-28 (B1-G1): 送 LLM 前脱敏（前端路径 3 处已覆盖，
        # 本工具是 Sidecar 独立路径，此前裸奔）
        output = redact_sensitive_text(output)
        lines_returned = output.count("\n") + 1 if output else 0
        # Rust/PTY bridge intentionally returns the tail only.  Equality means
        # older lines may exist, not that the returned text was lost.
        has_more = lines_returned >= lines
        truncated = char_truncated
        return {
            "output": output,
            "lines_requested": lines,
            "lines_returned": lines_returned,
            "available": bridge_available,
            "truncated": truncated,
            "has_more": has_more,
            **({
                "note": (
                    "输出已按字符上限截断；请改用更聚焦的命令读取。"
                    if truncated
                    else "仅返回当前终端尾部；如需更早内容，请增大 lines 再次读取。"
                    if has_more
                    else ""
                ),
                "output_chars": original_length,
            } if truncated or has_more else {}),
        }
    except Exception as e:
        logger.debug(f"get_terminal_output failed: {e}")
        return {
            "output": "",
            "lines_requested": lines,
            "lines_returned": 0,
            "available": False,
            "truncated": False,
            "note": "终端回读暂不可用；未写入外部存储。",
        }


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
            dict: {output: str, lines_requested: int, lines_returned: int,
                   available: bool, truncated: bool}
        """
        return invoke_get_terminal_output({"lines": lines}, ctx)

    get_terminal_output.__name__ = "get_terminal_output"
    return get_terminal_output
