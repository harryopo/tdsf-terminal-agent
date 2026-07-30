"""
strands_backend/tools/remote_file.py — 远程文件读取工具
========================================================

职责：
- 通过 RustBridge 调用 Rust 后端 ``sftp_read`` Tauri command，
  读取 SSH 会话上的远程文件内容，返回结构化结果。
- 不直接 sftp（不引入 paramiko/asyncssh 等依赖），复用现有 Tauri invoke 机制
  + Rust russh-sftp 2.1 客户端，与 ``SshExplorer.tsx`` 共享会话。
- 大文件自动截断（默认 max_size=1MB），避免响应过大撑爆 agent 上下文。
- 二进制文件检测（含 NUL 字节）返回 binary 状态，不返回内容。
- 返回结构化 dict（不返回裸字符串）。

TDSF 魔改 2026-07-30 P0-C4 修复：
- 原 ipc_invoke 调用的 method 名为 "sftp_read_file"，但 Rust 侧实际命令为
  "sftp_read"（src-tauri/src/modules/ssh/mod.rs:416 + lib.rs:384），现已对齐。
- 调用结构：{session_id, path, max_size}（注：Rust sftp_read 当前签名是
  (app, state, session_id, path) -> Vec<u8>，max_size 字段 Rust 侧未支持，
  Python 端在拿到结果后自行截断；后续 Rust 扩展时再启用 max_size 透传）。

设计：
- ``invoke_remote_file_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_remote_file_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 装饰函数。

工具签名：
    read_remote_file(path, ssh_session_id="", max_size=1048576, encoding="utf-8") -> dict

返回结构：
    success:
        {status:"success", path, ssh_session_id, content, size, encoding, truncated}
    binary:
        {status:"binary", path, ssh_session_id, size, message}
    unavailable:
        {status:"unavailable", path, ssh_session_id, reason, message}
    error:
        {status:"error", path, ssh_session_id, error}
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.remote_file")

# 默认最大读取字节数（1MB，避免响应过大）
_DEFAULT_MAX_SIZE = 1024 * 1024


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def invoke_remote_file_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """远程文件读取工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - path (str, 必填): 远程文件绝对路径
            - ssh_session_id (str, 可选): SSH 会话 ID，空则用 ctx.ssh_session_id
            - max_size (int, 可选): 最大读取字节数，默认 1048576（1MB）
            - encoding (str, 可选): 文件编码，默认 utf-8
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: path 参数缺失或为空
    """
    path = params.get("path", "").strip()
    if not path:
        raise ValueError("remote_file 工具必填参数缺失: path")

    ssh_session_id = params.get("ssh_session_id", "") or ""
    max_size = int(params.get("max_size", _DEFAULT_MAX_SIZE))
    encoding = params.get("encoding", "utf-8") or "utf-8"

    session_id = ssh_session_id or ctx.ssh_session_id

    # 推送 tool_call 开始事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="read_remote_file",
                params={"path": path, "ssh_session_id": session_id, "max_size": max_size},
                status="started",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.remote_file",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call started failed: {e}")

    # 检查 RustBridge 配置
    if ctx.rust_bridge is None:
        logger.warning(
            f"remote_file unavailable (no rust_bridge): path={path}"
        )
        return {
            "status": "unavailable",
            "path": path,
            "ssh_session_id": session_id,
            "reason": "rust_bridge_not_injected",
            "message": "RustBridge 未注入，工具无法调用 Rust 后端",
        }

    # 通过 RustBridge 调 Rust 后端 sftp_read
    # TDSF 魔改 2026-07-30 P0-C4 修复:
    #   原 method 名 "sftp_read_file" 与 Rust 侧不匹配，
    #   Rust 实际命令为 "sftp_read"（mod.rs:416）。
    try:
        result = ctx.rust_bridge.ipc_invoke("sftp_read", {
            "session_id": session_id,
            "path": path,
            # 注：Rust sftp_read 当前签名未支持 max_size，传了也会被忽略；
            # 截断在 Python 侧 content 处理时做（见下方 truncated 逻辑）。
            "max_size": max_size,
        })
    except Exception as e:
        logger.exception(f"remote_file ipc_invoke exception: path={path}, error={e}")
        return {
            "status": "error",
            "path": path,
            "ssh_session_id": session_id,
            "error": f"ipc_invoke 异常: {e}",
        }

    # RustBridge 未配置返回 unavailable
    if isinstance(result, dict) and result.get("status") in ("unavailable", "error"):
        return {
            "status": result.get("status", "error"),
            "path": path,
            "ssh_session_id": session_id,
            "reason": result.get("reason", ""),
            "error": result.get("error", result.get("message", "")),
        }

    # TDSF 魔改 2026-07-30 P0-C4: 适配 Rust sftp_read 实际返回值
    # Rust sftp_read 签名: (app, state, session_id, path) -> Result<Vec<u8>, String>
    # 序列化到 Python 即 list[int]（字节列表），而非 dict。
    # 旧代码假设 result 是 dict 并取 result.get("content")，导致 content 丢失。
    # 这里统一适配三种返回形态：
    #   1. list[int] / bytes / bytearray：直接当二进制内容
    #   2. dict 含 content 字段：旧路径（假设 Rust 未来扩展返回 dict）
    #   3. 其他：str(result) 兜底
    truncated = False
    if isinstance(result, list) and all(isinstance(b, int) for b in result if result):
        # Rust sftp_read 实际返回路径：list[int] → bytes
        content_raw = bytes(result)
        size = len(content_raw)
    elif isinstance(result, (bytes, bytearray)):
        content_raw = bytes(result)
        size = len(content_raw)
    elif isinstance(result, dict):
        # 旧路径：假设 dict 含 content / size / truncated 字段
        content_raw = result.get("content", "")
        size = int(result.get("size", 0))
        truncated = bool(result.get("truncated", False))
    else:
        # 兜底：转字符串
        content_raw = str(result)
        size = len(content_raw)

    # Python 侧 max_size 截断（Rust sftp_read 不支持 max_size 字段，
    # 全量返回，Python 这里按 max_size 截断避免响应过大）
    if max_size > 0 and isinstance(content_raw, (bytes, bytearray)) and size > max_size:
        content_raw = content_raw[:max_size]
        size = max_size
        truncated = True
        logger.info(
            f"remote_file truncated by max_size: path={path}, "
            f"max_size={max_size}"
        )

    # 二进制文件检测（含 NUL 字节）
    is_binary = False
    if isinstance(content_raw, (bytes, bytearray)):
        is_binary = b"\x00" in content_raw
    elif isinstance(content_raw, str) and "\x00" in content_raw:
        is_binary = True

    if is_binary:
        logger.info(f"remote_file binary detected: path={path}, size={size}")
        return {
            "status": "binary",
            "path": path,
            "ssh_session_id": session_id,
            "size": size,
            "message": "文件为二进制格式，不返回内容（如需查看请用 ssh_command + xxd/head）",
        }

    # 文本文件
    try:
        content = content_raw.decode(encoding) if isinstance(content_raw, (bytes, bytearray)) else content_raw
    except (UnicodeDecodeError, LookupError) as e:
        logger.warning(f"remote_file decode failed: path={path}, encoding={encoding}, error={e}")
        # 解码失败降级为 latin-1（保证不抛错）
        try:
            content = content_raw.decode("latin-1") if isinstance(content_raw, (bytes, bytearray)) else content_raw
        except Exception:
            content = str(content_raw)

    # 推送 tool_call 完成事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="read_remote_file",
                params={"path": path, "ssh_session_id": session_id, "max_size": max_size},
                result={"status": "success", "size": size, "truncated": truncated},
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.remote_file",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return {
        "status": "success",
        "path": path,
        "ssh_session_id": session_id,
        "content": content,
        "size": size,
        "encoding": encoding,
        "truncated": truncated,
        "message": (
            f"文件已读取（{size} 字节" + ("，已截断" if truncated else "") + "）"
        ),
    }


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_remote_file_tool(ctx: ToolContext):
    """构建远程文件读取工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数
    """
    @tool
    def read_remote_file(
        path: str,
        ssh_session_id: str = "",
        max_size: int = _DEFAULT_MAX_SIZE,
        encoding: str = "utf-8",
    ) -> dict:
        """读取 SSH 会话上的远程文件内容。

        通过 SFTP 读取远程文件，自动检测二进制文件（含 NUL 字节）并返回
        binary 状态。大文件自动截断（默认 1MB），避免响应过大。

        Args:
            path (str): 远程文件绝对路径。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认会话。
            max_size (int): 最大读取字节数，默认 1048576（1MB）。
            encoding (str): 文件编码，默认 utf-8。

        Returns:
            dict: 结构化结果，含 status / path / content / size / truncated 等字段。
                status 取值: success | binary | unavailable | error
        """
        return invoke_remote_file_tool(
            params={
                "path": path,
                "ssh_session_id": ssh_session_id,
                "max_size": max_size,
                "encoding": encoding,
            },
            ctx=ctx,
        )

    read_remote_file.__name__ = "read_remote_file"
    return read_remote_file


__all__ = [
    "invoke_remote_file_tool",
    "make_remote_file_tool",
]
