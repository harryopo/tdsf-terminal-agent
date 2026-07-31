"""
strands_backend/tools/suggest_command.py — 命令建议工具
==========================================================

职责：
- 根据用户意图生成可执行的 Linux 命令。
- 返回结构化结果 {command, explanation}，前端 ``tool.tsx`` 据此渲染
  ``SuggestCommandCard``（含 Insert 按钮，一键写入活动终端）。
- 推送 ``tool_call`` 事件到 event_bus，让工具调用过程实时展示。

设计：
- ``invoke_suggest_command_tool(params, ctx)``：核心实现，无 Strands 依赖。
- ``make_suggest_command_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 函数。
- 命令生成采用"规则映射 + 关键词匹配"，避免在 Strands 工具内部再次调用 LLM。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.suggest_command")


# ============================================================================
# 规则映射表：常见运维意图 -> 命令 + 解释
# ============================================================================

_SUGGESTION_RULES: list[tuple[list[str], str, str]] = [
    # 系统负载
    (
        ["负载", "load", "系统负载", "cpu", "平均负载"],
        "uptime",
        "显示系统运行时间、当前用户数和 1/5/15 分钟平均负载（load average）。",
    ),
    (
        ["cpu 使用", "cpu usage", "cpu 排行"],
        "top -bn1 | head -20",
        "一次性输出 CPU/内存占用最高的进程快照（非交互式）。",
    ),
    # 内存
    (
        ["内存", "memory", "mem", "ram", "swap"],
        "free -h",
        "以人类可读格式显示总内存、已用、可用和 swap 使用情况。",
    ),
    # 磁盘
    (
        ["磁盘", "disk", "df", "空间", "容量"],
        "df -h",
        "以人类可读格式显示所有挂载点的磁盘使用情况。",
    ),
    (
        ["目录大小", "文件夹大小", "du"],
        "du -sh * | sort -h",
        "列出当前目录下所有文件/目录的大小，并按从小到大排序。",
    ),
    # 进程
    (
        ["进程", "process", "ps"],
        "ps aux --sort=-%cpu | head -20",
        "按 CPU 占用降序列出前 20 个进程。",
    ),
    (
        ["端口", "port", "监听", "listen"],
        "ss -tuln",
        "显示所有 TCP/UDP 监听端口（不解析服务名，速度快）。",
    ),
    # 日志
    (
        ["日志", "log", "journalctl", "systemd 日志"],
        "journalctl -xe --no-pager -n 50",
        "显示最近 50 条 systemd 日志（含错误级别和解释）。",
    ),
    # 服务
    (
        ["nginx 状态", "nginx status", "nginx"],
        "systemctl status nginx --no-pager",
        "查看 nginx 服务运行状态、最近日志和进程信息。",
    ),
    (
        ["服务状态", "systemctl status", "服务"],
        "systemctl --failed --no-pager",
        "列出当前处于 failed 状态的服务单元。",
    ),
    # 网络
    (
        ["网络", "network", "ping", "连通性"],
        "ping -c 4 8.8.8.8",
        "向 Google DNS 发送 4 个 ICMP 包，测试外网连通性。",
    ),
    (
        ["路由", "route", "网关"],
        "ip route",
        "显示当前路由表和默认网关。",
    ),
    # 文件/权限
    (
        ["文件权限", "permission", "chmod", "chown"],
        "ls -la",
        "列出当前目录文件及详细权限、所有者、组。",
    ),
    (
        ["大文件", "大文件查找"],
        "find . -type f -size +100M -exec ls -lh {} \\;",
        "查找当前目录下大于 100MB 的文件并显示大小。",
    ),
    # SELinux
    (
        ["selinux", "getenforce", "sestatus"],
        "getenforce && sestatus",
        "查看 SELinux 当前模式（Enforcing/Permissive/Disabled）和全局状态。",
    ),
]


def _match_suggestion(intent: str) -> tuple[str, str] | None:
    """根据意图关键词匹配最佳命令建议"""
    intent_lower = intent.lower()
    for keywords, command, explanation in _SUGGESTION_RULES:
        if any(kw in intent_lower for kw in keywords):
            return command, explanation
    return None


def _build_fallback(intent: str) -> tuple[str, str]:
    """无规则命中时返回通用解释命令"""
    return (
        f'echo "未找到与 \"{intent}\" 直接匹配的内置命令，请补充更多关键词（如 cpu/内存/磁盘/端口/日志）"',
        "未匹配到内置规则，这是一条提示命令，请用户补充具体场景。",
    )


# ============================================================================
# 核心实现
# ============================================================================

def invoke_suggest_command_tool(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """命令建议工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - intent (str, 必填): 用户想做的事情/目标
            - target_os (str, 可选): 目标系统，默认 "linux"
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict：{status, command, explanation}
    """
    intent = (params.get("intent") or params.get("description") or "").strip()
    if not intent:
        raise ValueError("suggest_command 工具必填参数缺失: intent")

    target_os = (params.get("target_os") or "linux").lower()

    matched = _match_suggestion(intent)
    if matched:
        command, explanation = matched
    else:
        command, explanation = _build_fallback(intent)

    result: dict[str, Any] = {
        "status": "success",
        "command": command,
        "explanation": explanation,
        "target_os": target_os,
        "intent": intent,
    }

    # 推送 tool_call 完成事件（started 在 make_suggest_command_tool 中已推，
    # 这里为了核心实现可被单独调用，再补一次 completed）
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="suggest_command",
                params={"intent": intent, "target_os": target_os},
                result=result,
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.suggest_command",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return result


# ============================================================================
# Strands @tool 工厂
# ============================================================================

def make_suggest_command_tool(ctx: ToolContext):
    """构建命令建议工具（带 ctx 闭包）"""

    @tool
    def suggest_command(
        intent: str,
        target_os: str = "linux",
    ) -> dict:
        """根据用户意图生成一条可执行的 Linux 命令，并解释每个字段含义。

        使用场景：
        - 用户说"帮我构造一条命令查看系统负载"
        - 用户说"查看磁盘空间的命令是什么"
        - 用户说"如何查看 nginx 状态"

        返回结果会被前端渲染成命令卡片，附带"Insert"按钮，用户可一键
        将命令写入当前活动终端。

        Args:
            intent (str): 用户想做的事情，如"查看系统负载"、"查看端口占用"。
            target_os (str): 目标操作系统，默认 "linux"。

        Returns:
            dict: 结构化结果，含 status / command / explanation / target_os。
        """
        # 推送 tool_call 开始事件，让前端实时显示工具调用卡片
        if ctx.event_bus is not None:
            try:
                ctx.event_bus.emit_tool_call(
                    tool_name="suggest_command",
                    params={"intent": intent, "target_os": target_os},
                    status="started",
                    session_id=ctx.session_id or None,
                    source=f"{ctx.agent_name}_agent.strands_tool.suggest_command",
                )
            except Exception as e:
                logger.debug(f"emit_tool_call started failed: {e}")

        return invoke_suggest_command_tool(
            params={"intent": intent, "target_os": target_os},
            ctx=ctx,
        )

    suggest_command.__name__ = "suggest_command"
    return suggest_command


__all__ = [
    "invoke_suggest_command_tool",
    "make_suggest_command_tool",
]
