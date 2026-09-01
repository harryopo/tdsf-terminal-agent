"""
strands_backend/tools/ssh_sessions.py — SSH 会话枚举工具
========================================================

职责：
- 列出当前全部已连接的 SSH 会话（session_id + user@host + port + 状态），
  供 LLM 在多主机运维场景（教学常见：同时连多台服务器对比）确定目标
  ``ssh_session_id``，再交给 ssh_command / read_remote_file 等工具执行。
- 经 RustBridge 反向 JSON-RPC 调 Rust 侧 ``"ssh_status"`` 路由
  （sidecar.rs handle_reverse_request → ssh::sessions_detail），数据源是
  Rust SshState 的权威会话注册表——不依赖前端每轮下发的单一激活会话。

TDSF P2 #42 (2026-09-01, §37.90 检查报告)：
- 此前 agent 只能被动接收前端下发的"单一活跃会话"，LLM 无从得知其他
  会话 ID，多主机完全无法操作（只能用户手动切换激活终端）。
- 本工具为只读枚举（ToolPolicy readonly=True）：observe/L1 模式 schema 可见，
  无命令执行面、无审批交互。

设计：
- ``parse_live_sessions(resp)``：响应解析纯函数（不可识别结构返回 None，
  供 execute_via_ssh host 校验放宽复用——解析失败回退旧严格校验，fail-closed）。
- ``invoke_ssh_list_sessions_tool(ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_ssh_list_sessions_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool
  装饰函数，供 ``make_all_ops_tools`` 经 TOOL_REGISTRY 注册表驱动挂载。

返回结构：
    success:
        {status:"success", sessions:[{session_id, host, port, user, state}],
         active_session_id, count, hint}
    unavailable / error:
        {status:"unavailable"|"error", sessions:[], reason|error, message}
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.ssh_sessions")


# ============================================================================
# 响应解析纯函数（execute_via_ssh host 校验放宽复用）
# ============================================================================

def parse_live_sessions(resp: Any) -> list[dict[str, Any]] | None:
    """解析 ``"ssh_status"`` 反向路由响应为规范化会话列表

    Rust 侧返回 ``Vec<SshSessionDetail>``（serde camelCase）::
        [{"sessionId": 1, "host": "h", "port": 22, "user": "root",
          "state": "connected"}, ...]

    Args:
        resp: ipc_invoke("ssh_status", {}) 的原始返回值

    Returns:
        规范化列表 ``[{session_id, host, port, user, state}, ...]``；
        结构不可识别（非 list / 条目缺字段 / 字段类型错）时返回 None——
        调用方据此回退旧严格校验（fail-closed 方向，不放宽）。
    """
    if not isinstance(resp, list):
        return None
    sessions: list[dict[str, Any]] = []
    for item in resp:
        if not isinstance(item, dict):
            return None
        try:
            sessions.append({
                "session_id": int(item.get("sessionId")),
                "host": str(item.get("host", "")),
                "port": int(item.get("port", 22)),
                "user": str(item.get("user", "")),
                "state": str(item.get("state", "")),
            })
        except (TypeError, ValueError):
            return None
    return sessions


def session_endpoint(entry: dict[str, Any]) -> str:
    """格式化会话端点为 user@host:port（展示/审计用）"""
    return f"{entry['user']}@{entry['host']}:{entry['port']}"


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def invoke_ssh_list_sessions_tool(ctx: ToolContext) -> dict[str, Any]:
    """SSH 会话枚举工具核心实现

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）。
        只读枚举，不触发审批、不做命令风险检测。
    """
    if ctx.rust_bridge is None:
        logger.debug("ssh_list_sessions unavailable: rust_bridge not injected")
        return {
            "status": "unavailable",
            "reason": "rust_bridge_not_injected",
            "sessions": [],
            "message": "RustBridge 未注入，无法枚举 SSH 会话",
        }

    try:
        resp = ctx.rust_bridge.ipc_invoke("ssh_status", {})
    except Exception as e:  # noqa: BLE001 — 结构化降级不抛错阻塞 agent loop
        logger.exception(f"ssh_list_sessions ipc_invoke exception: {e}")
        return {
            "status": "error",
            "error": f"枚举 SSH 会话异常: {e}",
            "sessions": [],
        }

    sessions = parse_live_sessions(resp)
    if sessions is None:
        # 不可识别响应（旧 Rust 版本无此路由返回 error dict 等）→ 结构化降级
        logger.warning(
            f"ssh_list_sessions got unrecognized ssh_status response: "
            f"{type(resp).__name__}"
        )
        return {
            "status": "unavailable",
            "reason": "unrecognized_ssh_status_response",
            "sessions": [],
            "message": (
                "SSH 会话枚举不可用（Rust 侧返回了不可识别的结构，"
                "可能为旧版本后端）。请让用户手动确认目标主机。"
            ),
        }

    connected = [s for s in sessions if s["state"] == "connected"]
    active_id = str(ctx.ssh_session_id) if ctx.ssh_session_id else ""
    return {
        "status": "success",
        "sessions": sessions,
        "active_session_id": active_id,
        "count": len(sessions),
        "connected_count": len(connected),
        "hint": (
            "对指定主机执行命令时，把对应 session_id 传给 ssh_command 等"
            "工具的 ssh_session_id 参数；仅 state=connected 的会话可操作。"
        ),
    }


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_ssh_list_sessions_tool(ctx: ToolContext):
    """构建 SSH 会话枚举工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数（Strands 不可用时为 passthrough 装饰）
    """
    @tool
    def ssh_list_sessions() -> dict:
        """列出当前所有已连接的 SSH 会话。

        多主机运维场景（同时连接多台服务器）下，先用本工具获取各会话的
        session_id 与 user@host，再把目标 session_id 传给 ssh_command /
        read_remote_file 等工具的 ssh_session_id 参数。只读枚举，不执行
        任何命令；只有 state=connected 的会话可被操作。

        Returns:
            dict: 结构化结果，sessions 为会话列表（session_id/host/port/
                user/state），active_session_id 为当前激活终端会话，
                status 取值: success | unavailable | error
        """
        return invoke_ssh_list_sessions_tool(ctx)

    # Strands 从 __name__ 提取工具名，保持原名
    ssh_list_sessions.__name__ = "ssh_list_sessions"
    return ssh_list_sessions


__all__ = [
    "invoke_ssh_list_sessions_tool",
    "make_ssh_list_sessions_tool",
    "parse_live_sessions",
    "session_endpoint",
]
