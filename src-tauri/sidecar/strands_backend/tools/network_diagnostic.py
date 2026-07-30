"""
strands_backend/tools/network_diagnostic.py — 网络诊断工具
==========================================================

职责：
- 在 SSH 会话上执行网络诊断命令，支持 5 种模式：
  * ping:    ping 目标主机（ping -c <count> -W 2 <target>）
  * ss:      查看活动连接/监听端口（ss -tulnp），可按端口过滤
  * netstat: 兼容老系统（netstat -tulnp），可按端口过滤
  * ip:      查看网卡/路由信息（ip addr / ip route）
  * dns:     DNS 查询（nslookup <target> 或 dig <target>）
- 不直接 ssh，复用 ``execute_via_ssh`` 调 Rust 后端 ``ssh_command``。
- 高危命令通过 ``RiskChecker`` 检测（虽然诊断命令是只读，仍过一道保险）。
- 返回结构化 dict：原始输出 + 解析后的端口/连接列表 + 摘要统计。

设计：
- ``invoke_network_diagnostic_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_network_diagnostic_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 装饰函数。

工具签名：
    network_diagnose(mode="ping", target="", count=4, port=0, ssh_session_id="") -> dict

返回结构：
    success:
        {status:"success", mode, target, raw_output, parsed, summary}
    unavailable:
        {status:"unavailable", mode, reason, message}
    error:
        {status:"error", mode, error}
"""
from __future__ import annotations

import logging
import re
from typing import Any

from strands_backend.tools import ToolContext, execute_via_ssh, tool

logger = logging.getLogger("sidecar.strands_backend.tools.network_diagnostic")

# 合法模式
_VALID_MODES = {"ping", "ss", "netstat", "ip", "dns"}
# ping 默认包数
_DEFAULT_COUNT = 4
_MAX_COUNT = 20


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def _shell_escape(s: str) -> str:
    """shell 单引号转义（防注入）"""
    return "'" + s.replace("'", "'\"'\"'") + "'"


def _build_command(mode: str, target: str, count: int, port: int) -> str:
    """根据模式构建 shell 命令

    Args:
        mode: 模式（ping / ss / netstat / ip / dns）
        target: 目标主机/IP（ping / dns 模式必填）
        count: ping 包数（ping 模式）
        port: 端口过滤（ss / netstat 模式可选）

    Returns:
        shell 命令字符串

    Raises:
        ValueError: 模式非法 / ping+dns 模式 target 为空
    """
    if mode not in _VALID_MODES:
        raise ValueError(f"非法模式: {mode}，必须为 {sorted(_VALID_MODES)}")

    if mode == "ping":
        if not target:
            raise ValueError("ping 模式必填参数缺失: target")
        n = max(1, min(int(count), _MAX_COUNT))
        # -W 2 每包超时 2 秒，避免长阻塞
        return f"ping -c {n} -W 2 {_shell_escape(target)}"

    if mode == "ss":
        # ss -tulnp 显示 tcp/udp 监听 + 进程
        cmd = "ss -tulnp"
        if port and port > 0:
            cmd += f" | grep ':{int(port)}\\b'"
        return cmd

    if mode == "netstat":
        # 老系统兼容（netstat 已被 ss 取代，但教学场景仍常见）
        cmd = "netstat -tulnp 2>/dev/null"
        if port and port > 0:
            cmd += f" | grep ':{int(port)}\\b'"
        return cmd

    if mode == "ip":
        # ip addr + ip route 综合输出
        return "ip addr && echo '---ROUTE---' && ip route"

    if mode == "dns":
        if not target:
            raise ValueError("dns 模式必填参数缺失: target")
        # 优先 nslookup（兼容性好），失败时降级到 dig
        return (
            f"nslookup {_shell_escape(target)} 2>/dev/null || "
            f"dig {_shell_escape(target)} +short 2>/dev/null || "
            f"getent hosts {_shell_escape(target)}"
        )

    raise ValueError(f"未实现的模式: {mode}")


def _parse_listening_ports(raw_output: str) -> list[dict[str, Any]]:
    """解析 ss/netstat 输出为监听端口列表

    兼容两种格式：
    - ss:     ``tcp LISTEN 0.0.0.0:22 0.0.0.0:*``（state 在 local:port 之前）
    - netstat: ``tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN``（state 在最后）

    匹配策略：扫描每行中的 ``地址:端口`` 模式（IPv4 / IPv6 / *），
    提取端口 + 推断协议 + 推断状态。表头无数字端口自动跳过。

    Args:
        raw_output: ss/netstat 命令原始输出

    Returns:
        端口 dict 列表，每个 dict 含 proto/local_address/port/state/raw
        （解析失败时返回空列表，不抛错）
    """
    if not raw_output:
        return []

    # 匹配 IPv4:port / [IPv6]:port / *:port / [::]:port
    port_pattern = re.compile(
        r"(?P<local>(?:\*|0\.0\.0\.0|\d+\.\d+\.\d+\.\d+|\[?[0-9a-fA-F:]+\]?))"
        r":(?P<port>\d+)\b",
        re.IGNORECASE,
    )

    ports: list[dict[str, Any]] = []
    for line in raw_output.splitlines():
        m = port_pattern.search(line)
        if not m:
            continue
        try:
            port = int(m.group("port"))
        except ValueError:
            continue
        # 跳过非法端口（表头 / 噪声）
        if port <= 0 or port > 65535:
            continue

        # 推断协议（行首是 tcp/udp/tcp6/udp6）
        first_token = line.split()[0].lower() if line.split() else ""
        proto = first_token if first_token in ("tcp", "udp", "tcp6", "udp6") else "tcp"

        # 推断状态
        line_upper = line.upper()
        if "LISTEN" in line_upper:
            state = "LISTEN"
        elif "ESTABLISHED" in line_upper:
            state = "ESTABLISHED"
        elif "TIME_WAIT" in line_upper:
            state = "TIME_WAIT"
        else:
            state = "UNKNOWN"

        ports.append({
            "proto": proto,
            "local_address": m.group("local"),
            "port": port,
            "state": state,
            "raw": line.strip(),
        })

    return ports


def _parse_ping_summary(raw_output: str) -> dict[str, Any]:
    """解析 ping 输出的统计摘要

    Args:
        raw_output: ping 命令原始输出

    Returns:
        dict: transmitted / received / loss / rtt_min / rtt_avg / rtt_max
              （解析失败时返回空 dict）
    """
    if not raw_output:
        return {}

    summary: dict[str, Any] = {}

    # packets transmitted / received / packet loss
    m = re.search(
        r"(\d+)\s+packets transmitted,\s+(\d+)\s+received,\s+(\d+)%\s+packet loss",
        raw_output,
    )
    if m:
        summary["transmitted"] = int(m.group(1))
        summary["received"] = int(m.group(2))
        summary["loss_percent"] = int(m.group(3))

    # rtt min/avg/max/mdev
    m = re.search(
        r"rtt\s+\S+\s*=\s*(\d+\.?\d*)/(\d+\.?\d*)/(\d+\.?\d*)/(\d+\.?\d*)\s*(ms)?",
        raw_output,
    )
    if m:
        summary["rtt_min_ms"] = float(m.group(1))
        summary["rtt_avg_ms"] = float(m.group(2))
        summary["rtt_max_ms"] = float(m.group(3))
        summary["rtt_mdev_ms"] = float(m.group(4))

    return summary


def invoke_network_diagnostic_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """网络诊断工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - mode (str, 可选): ping / ss / netstat / ip / dns，默认 ping
            - target (str, 可选): 目标主机/IP（ping / dns 模式必填）
            - count (int, 可选): ping 包数，默认 4，上限 20
            - port (int, 可选): 端口过滤（ss / netstat 模式）
            - ssh_session_id (str, 可选): SSH 会话 ID，空则用 ctx.ssh_session_id
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: 模式非法 / ping+dns 模式 target 为空
    """
    mode = params.get("mode", "ping") or "ping"
    target = params.get("target", "") or ""
    count = int(params.get("count", _DEFAULT_COUNT))
    port = int(params.get("port", 0) or 0)
    ssh_session_id = params.get("ssh_session_id", "") or ""

    # 构建命令（可能抛 ValueError）
    command = _build_command(mode, target, count, port)

    # 推送 tool_call 开始事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="network_diagnose",
                params={"mode": mode, "target": target, "count": count, "port": port},
                status="started",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.network_diagnostic",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call started failed: {e}")

    # 通过 execute_via_ssh 执行
    exec_result = execute_via_ssh(
        ctx=ctx,
        command=command,
        ssh_session_id=ssh_session_id,
        timeout=30,
        tool_name="network_diagnose",
    )

    if exec_result.get("status") != "success":
        return {
            **exec_result,
            "mode": mode,
            "target": target,
        }

    # 成功 → 模式化解析
    raw_output = exec_result.get("output", "")
    parsed: Any = None
    summary: dict[str, Any] = {"mode": mode, "target": target}

    if mode == "ping":
        ping_summary = _parse_ping_summary(raw_output)
        parsed = ping_summary
        summary.update(ping_summary)
        summary["reachable"] = ping_summary.get("received", 0) > 0
    elif mode in ("ss", "netstat"):
        ports = _parse_listening_ports(raw_output)
        parsed = ports
        summary["port_count"] = len(ports)
        summary["listening_ports"] = sorted({p["port"] for p in ports})
    elif mode == "ip":
        # 原始输出分块（addr / route）
        parsed = {"raw_sections": raw_output.split("---ROUTE---")}
        summary["sections"] = 2
    elif mode == "dns":
        parsed = {"resolved_lines": raw_output.splitlines()}
        summary["resolved"] = bool(raw_output.strip())

    # 推送 tool_call 完成事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="network_diagnose",
                params={"mode": mode, "target": target, "count": count, "port": port},
                result={"status": "success", "summary": summary},
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.network_diagnostic",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return {
        "status": "success",
        "mode": mode,
        "target": target,
        "command": command,
        "ssh_session_id": exec_result.get("ssh_session_id", ""),
        "raw_output": raw_output,
        "parsed": parsed,
        "summary": summary,
        "message": f"网络诊断完成（模式={mode}" + (
            f"，目标={target}" if target else "") + "）",
    }


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_network_diagnostic_tool(ctx: ToolContext):
    """构建网络诊断工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数
    """
    @tool
    def network_diagnose(
        mode: str = "ping",
        target: str = "",
        count: int = _DEFAULT_COUNT,
        port: int = 0,
        ssh_session_id: str = "",
    ) -> dict:
        """在 SSH 会话上执行网络诊断命令。

        支持 5 种模式：
        - ping:    ping 目标主机（ping -c <count> -W 2 <target>，target 必填）
        - ss:      查看活动连接/监听端口（ss -tulnp），可按 port 过滤
        - netstat: 兼容老系统（netstat -tulnp），可按 port 过滤
        - ip:      查看网卡/路由信息（ip addr + ip route）
        - dns:     DNS 查询（nslookup / dig / getent hosts，target 必填）

        Args:
            mode (str): 模式 ping / ss / netstat / ip / dns，默认 ping。
            target (str): 目标主机/IP（ping / dns 模式必填）。
            count (int): ping 包数，默认 4，上限 20。
            port (int): 端口过滤（ss / netstat 模式可选）。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认会话。

        Returns:
            dict: 结构化结果，含 status / mode / raw_output / parsed / summary 等字段。
                status 取值: success | needs_approval | unavailable | error
        """
        return invoke_network_diagnostic_tool(
            params={
                "mode": mode,
                "target": target,
                "count": count,
                "port": port,
                "ssh_session_id": ssh_session_id,
            },
            ctx=ctx,
        )

    network_diagnose.__name__ = "network_diagnose"
    return network_diagnose


__all__ = [
    "invoke_network_diagnostic_tool",
    "make_network_diagnostic_tool",
]
