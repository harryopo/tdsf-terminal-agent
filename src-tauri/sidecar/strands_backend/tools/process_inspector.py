"""
strands_backend/tools/process_inspector.py — 进程检查工具
==========================================================

职责：
- 在 SSH 会话上检查远程服务器进程状态，支持 3 种模式：
  * list:   列出所有进程（ps aux），可按用户/名称过滤
  * top:    按 CPU 占用排序展示前 N 进程（top -bn1 或 ps aux --sort=-%cpu）
  * detail: 查询指定进程的详细信息（ps -p <pid> -o ...），需 pid 或 name
- 不直接 ssh，复用 ``execute_via_ssh`` 调 Rust 后端 ``ssh_command``。
- 高危命令通过 ``RiskChecker`` 检测（虽然 ps/top 是只读，仍过一道保险）。
- 返回结构化 dict：原始输出 + 解析后的进程列表 + 摘要统计。

设计：
- ``invoke_process_inspector_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_process_inspector_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 装饰函数。

工具签名：
    inspect_processes(mode="list", filter_user="", filter_name="", pid=0,
                      top_n=20, ssh_session_id="") -> dict

返回结构：
    success:
        {status:"success", mode, raw_output, processes, count, summary}
    unavailable:
        {status:"unavailable", mode, reason, message}
    error:
        {status:"error", mode, error}
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, execute_via_ssh, tool

logger = logging.getLogger("sidecar.strands_backend.tools.process_inspector")

# 合法模式
_VALID_MODES = {"list", "top", "detail"}
# top 模式默认展示前 N 进程
_DEFAULT_TOP_N = 20
_MAX_TOP_N = 200


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def _shell_escape(s: str) -> str:
    """shell 单引号转义（防注入）"""
    return "'" + s.replace("'", "'\"'\"'") + "'"


def _build_command(
    mode: str,
    filter_user: str,
    filter_name: str,
    pid: int,
    top_n: int,
) -> str:
    """根据模式构建 shell 命令

    Args:
        mode: 模式（list / top / detail）
        filter_user: 用户过滤（list 模式可选）
        filter_name: 进程名过滤（list / detail 模式可选）
        pid: 进程 ID（detail 模式优先用）
        top_n: top 模式展示前 N 进程

    Returns:
        shell 命令字符串

    Raises:
        ValueError: 模式非法 / detail 模式 pid 和 filter_name 都为空
    """
    if mode not in _VALID_MODES:
        raise ValueError(f"非法模式: {mode}，必须为 {sorted(_VALID_MODES)}")

    if mode == "list":
        # ps aux + 可选用户过滤 + 可选名称过滤（grep）
        cmd = "ps aux"
        if filter_user:
            cmd += f" -u {_shell_escape(filter_user)}"
        if filter_name:
            cmd += f" | grep {_shell_escape(filter_name)} | grep -v grep"
        return cmd

    if mode == "top":
        # 优先 ps aux --sort=-%cpu（兼容性更好，不依赖 top 的 -bn1 行为差异）
        n = max(1, min(int(top_n), _MAX_TOP_N))
        cmd = "ps aux --sort=-%cpu"
        if filter_user:
            cmd += f" -u {_shell_escape(filter_user)}"
        cmd += f" | head -n {n + 1}"  # +1 保留表头
        return cmd

    if mode == "detail":
        if pid and pid > 0:
            # ps -p <pid> -o pid,ppid,user,%cpu,%mem,stat,start,time,command
            return (
                f"ps -p {int(pid)} -o pid,ppid,user,%cpu,%mem,stat,start,time,command"
            )
        if filter_name:
            # 按名称查进程详情
            return (
                f"ps aux | grep {_shell_escape(filter_name)} | grep -v grep | "
                f"head -n 20"
            )
        raise ValueError("detail 模式需提供 pid 或 filter_name 参数")

    raise ValueError(f"未实现的模式: {mode}")


def _parse_processes(raw_output: str, mode: str) -> list[dict[str, Any]]:
    """解析 ps 输出为进程列表

    Args:
        raw_output: ps 命令原始输出
        mode: 模式（影响字段解析）

    Returns:
        进程 dict 列表，每个 dict 含 user/pid/%cpu/%mem/stat/command 等字段
        （解析失败时返回空列表，不抛错）
    """
    if not raw_output:
        return []

    lines = raw_output.strip().splitlines()
    if len(lines) < 2:
        return []

    # 第一行是表头
    header = lines[0].split()
    # 找各字段下标（ps aux 标准输出）
    try:
        idx_user = header.index("USER")
        idx_pid = header.index("PID")
        idx_cpu = header.index("%CPU")
        idx_mem = header.index("%MEM")
        idx_stat = header.index("STAT")
        idx_cmd = header.index("COMMAND")
    except ValueError:
        # 表头不标准，降级返回原始行
        return [{"raw": line} for line in lines[1:]]

    processes: list[dict[str, Any]] = []
    for line in lines[1:]:
        parts = line.split(None, idx_cmd)
        if len(parts) < idx_cmd + 1:
            continue
        try:
            processes.append({
                "user": parts[idx_user],
                "pid": int(parts[idx_pid]),
                "cpu": float(parts[idx_cpu]),
                "mem": float(parts[idx_mem]),
                "stat": parts[idx_stat],
                "command": parts[idx_cmd],
            })
        except (ValueError, IndexError):
            # 单行解析失败跳过，不影响其他行
            continue

    return processes


def invoke_process_inspector_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """进程检查工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - mode (str, 可选): list / top / detail，默认 list
            - filter_user (str, 可选): 用户过滤（list / top 模式）
            - filter_name (str, 可选): 进程名过滤（list / detail 模式）
            - pid (int, 可选): 进程 ID（detail 模式优先用）
            - top_n (int, 可选): top 模式展示前 N 进程，默认 20
            - ssh_session_id (str, 可选): SSH 会话 ID，空则用 ctx.ssh_session_id
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: 模式非法 / detail 模式 pid 和 filter_name 都为空
    """
    mode = params.get("mode", "list") or "list"
    filter_user = params.get("filter_user", "") or ""
    filter_name = params.get("filter_name", "") or ""
    pid = int(params.get("pid", 0) or 0)
    top_n = int(params.get("top_n", _DEFAULT_TOP_N))
    ssh_session_id = params.get("ssh_session_id", "") or ""

    # 构建命令（可能抛 ValueError）
    command = _build_command(mode, filter_user, filter_name, pid, top_n)

    # 推送 tool_call 开始事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="inspect_processes",
                params={"mode": mode, "filter_user": filter_user, "filter_name": filter_name, "pid": pid},
                status="started",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.process_inspector",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call started failed: {e}")

    # 通过 execute_via_ssh 执行
    exec_result = execute_via_ssh(
        ctx=ctx,
        command=command,
        ssh_session_id=ssh_session_id,
        timeout=15,
        tool_name="inspect_processes",
    )

    if exec_result.get("status") != "success":
        return {
            **exec_result,
            "mode": mode,
            "filter_user": filter_user,
            "filter_name": filter_name,
        }

    # 成功 → 解析进程列表
    raw_output = exec_result.get("output", "")
    processes = _parse_processes(raw_output, mode)
    count = len(processes)

    # 摘要
    summary = {
        "mode": mode,
        "count": count,
        "filter_user": filter_user,
        "filter_name": filter_name,
        "top_cpu": (
            sorted(processes, key=lambda p: p.get("cpu", 0), reverse=True)[:5]
            if processes else []
        ),
    }

    # 推送 tool_call 完成事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="inspect_processes",
                params={"mode": mode, "filter_user": filter_user, "filter_name": filter_name, "pid": pid},
                result={"status": "success", "count": count},
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.process_inspector",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return {
        "status": "success",
        "mode": mode,
        "command": command,
        "ssh_session_id": exec_result.get("ssh_session_id", ""),
        "raw_output": raw_output,
        "processes": processes,
        "count": count,
        "summary": summary,
        "message": f"进程检查完成（模式={mode}，共 {count} 个进程）",
    }


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_process_inspector_tool(ctx: ToolContext):
    """构建进程检查工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数
    """
    @tool
    def inspect_processes(
        mode: str = "list",
        filter_user: str = "",
        filter_name: str = "",
        pid: int = 0,
        top_n: int = _DEFAULT_TOP_N,
        ssh_session_id: str = "",
    ) -> dict:
        """检查 SSH 会话上的远程服务器进程状态。

        支持 3 种模式：
        - list:   列出所有进程（ps aux），可按用户/名称过滤
        - top:    按 CPU 占用排序展示前 N 进程（ps aux --sort=-%cpu | head）
        - detail: 查询指定进程的详细信息（ps -p <pid> 或 ps aux | grep <name>）

        Args:
            mode (str): 模式 list / top / detail，默认 list。
            filter_user (str): 用户过滤（list / top 模式可选）。
            filter_name (str): 进程名过滤（list / detail 模式可选）。
            pid (int): 进程 ID（detail 模式优先用）。
            top_n (int): top 模式展示前 N 进程，默认 20，上限 200。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认会话。

        Returns:
            dict: 结构化结果，含 status / mode / processes / count / summary 等字段。
                status 取值: success | needs_approval | unavailable | error
        """
        return invoke_process_inspector_tool(
            params={
                "mode": mode,
                "filter_user": filter_user,
                "filter_name": filter_name,
                "pid": pid,
                "top_n": top_n,
                "ssh_session_id": ssh_session_id,
            },
            ctx=ctx,
        )

    inspect_processes.__name__ = "inspect_processes"
    return inspect_processes


__all__ = [
    "invoke_process_inspector_tool",
    "make_process_inspector_tool",
]
