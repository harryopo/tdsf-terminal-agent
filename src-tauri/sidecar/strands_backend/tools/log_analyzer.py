"""
strands_backend/tools/log_analyzer.py — 日志分析工具
====================================================

职责：
- 在 SSH 会话上分析远程日志文件，支持 3 种模式：
  * tail:  读取日志末尾 N 行（默认 100）
  * grep:  关键词过滤（grep -F 固定字符串匹配）
  * regex: 正则表达式匹配（grep -E 扩展正则）
- 不直接 ssh，复用 ``execute_via_ssh`` 调 Rust 后端 ``ssh_command``。
- 高危命令通过 ``RiskChecker`` 检测（虽然 tail/grep 是只读，但保险起见仍过一道）。
- 返回结构化 dict：原始行 + 匹配行 + 摘要统计。

设计：
- ``invoke_log_analyzer_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_log_analyzer_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 装饰函数。

工具签名：
    analyze_logs(log_path, mode="tail", lines=100, pattern="", ssh_session_id="") -> dict

返回结构：
    success:
        {status:"success", log_path, mode, lines, pattern, raw_output, matched_lines, summary}
    unavailable:
        {status:"unavailable", log_path, mode, reason, message}
    error:
        {status:"error", log_path, mode, error}
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, execute_via_ssh, tool

logger = logging.getLogger("sidecar.strands_backend.tools.log_analyzer")

# 合法模式
_VALID_MODES = {"tail", "grep", "regex"}
# 最大返回行数上限（防止日志洪水撑爆 agent 上下文）
_MAX_LINES = 2000


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def _build_command(log_path: str, mode: str, lines: int, pattern: str) -> str:
    """根据模式构建 shell 命令

    Args:
        log_path: 日志文件路径
        mode: 模式（tail / grep / regex）
        lines: 行数
        pattern: 匹配模式（grep / regex 模式用）

    Returns:
        shell 命令字符串

    Raises:
        ValueError: 模式非法 / grep+regex 模式 pattern 为空
    """
    if mode not in _VALID_MODES:
        raise ValueError(f"非法模式: {mode}，必须为 {sorted(_VALID_MODES)}")

    # shell 转义单引号（防注入：log_path / pattern 用单引号包裹，内部单引号转义）
    def _shell_escape(s: str) -> str:
        return "'" + s.replace("'", "'\"'\"'") + "'"

    safe_path = _shell_escape(log_path)

    if mode == "tail":
        n = max(1, min(int(lines), _MAX_LINES))
        return f"tail -n {n} {safe_path}"

    if mode == "grep":
        if not pattern:
            raise ValueError("grep 模式必填参数缺失: pattern")
        n = max(1, min(int(lines), _MAX_LINES))
        safe_pattern = _shell_escape(pattern)
        # grep -F 固定字符串匹配 + -n 行号 + 末尾 tail 限制行数
        return f"grep -Fn {safe_pattern} {safe_path} | tail -n {n}"

    if mode == "regex":
        if not pattern:
            raise ValueError("regex 模式必填参数缺失: pattern")
        n = max(1, min(int(lines), _MAX_LINES))
        safe_pattern = _shell_escape(pattern)
        # grep -E 扩展正则 + -n 行号 + 末尾 tail 限制行数
        return f"grep -En {safe_pattern} {safe_path} | tail -n {n}"

    # 理论不可达（_VALID_MODES 已校验）
    raise ValueError(f"未实现的模式: {mode}")


def _summarize(raw_output: str, mode: str, pattern: str) -> dict[str, Any]:
    """对原始输出做摘要统计

    Args:
        raw_output: 命令原始输出
        mode: 分析模式
        pattern: 匹配模式

    Returns:
        dict:
            total_lines: 总行数
            matched_lines: 匹配行数（tail 模式 = total_lines）
            pattern: 使用的模式
            mode: 分析模式
            sample: 前 5 行预览
    """
    lines = raw_output.splitlines() if raw_output else []
    total = len(lines)
    # grep / regex 模式下，所有输出行都是匹配行；tail 模式下也是
    matched = total
    sample = "\n".join(lines[:5])

    return {
        "total_lines": total,
        "matched_lines": matched,
        "pattern": pattern,
        "mode": mode,
        "sample": sample,
    }


def invoke_log_analyzer_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """日志分析工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - log_path (str, 必填): 日志文件绝对路径
            - mode (str, 可选): 分析模式，tail / grep / regex，默认 tail
            - lines (int, 可选): 返回行数，默认 100，上限 2000
            - pattern (str, 可选): 匹配模式（grep / regex 模式必填）
            - ssh_session_id (str, 可选): SSH 会话 ID，空则用 ctx.ssh_session_id
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: log_path 缺失 / 模式非法 / grep+regex 模式 pattern 为空
    """
    log_path = params.get("log_path", "").strip()
    if not log_path:
        raise ValueError("log_analyzer 工具必填参数缺失: log_path")

    mode = params.get("mode", "tail") or "tail"
    lines = int(params.get("lines", 100))
    pattern = params.get("pattern", "") or ""
    ssh_session_id = params.get("ssh_session_id", "") or ""

    # 构建命令（可能抛 ValueError）
    command = _build_command(log_path, mode, lines, pattern)

    # 推送 tool_call 开始事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="analyze_logs",
                params={"log_path": log_path, "mode": mode, "lines": lines, "pattern": pattern},
                status="started",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.log_analyzer",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call started failed: {e}")

    # 通过 execute_via_ssh 执行（内部含影响预测 + 三模式决策 + RustBridge）。
    # readonly=True：analyze_logs 是 registry 只读工具——observe 模式下
    # L0-L1 命令（tail/grep）短路放行（方案书 §3.2 只读短路）
    exec_result = execute_via_ssh(
        ctx=ctx,
        command=command,
        ssh_session_id=ssh_session_id,
        timeout=30,
        tool_name="analyze_logs",
        readonly=True,
    )

    # 失败 / 不可用 / 待审批 → 直接返回，附加元数据
    if exec_result.get("status") != "success":
        return {
            **exec_result,
            "log_path": log_path,
            "mode": mode,
            "pattern": pattern,
        }

    # 成功 → 提取输出 + 摘要
    raw_output = exec_result.get("output", "")
    summary = _summarize(raw_output, mode, pattern)

    # 推送 tool_call 完成事件
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_tool_call(
                tool_name="analyze_logs",
                params={"log_path": log_path, "mode": mode, "lines": lines, "pattern": pattern},
                result={"status": "success", "total_lines": summary["total_lines"]},
                status="completed",
                session_id=ctx.session_id or None,
                source=f"{ctx.agent_name}_agent.strands_tool.log_analyzer",
            )
        except Exception as e:
            logger.debug(f"emit_tool_call completed failed: {e}")

    return {
        "status": "success",
        "log_path": log_path,
        "mode": mode,
        "lines": lines,
        "pattern": pattern,
        "command": command,
        "ssh_session_id": exec_result.get("ssh_session_id", ""),
        "raw_output": raw_output,
        "exit_code": exec_result.get("exit_code", 0),
        "summary": summary,
        "message": (
            f"日志分析完成（模式={mode}，共 {summary['total_lines']} 行，"
            f"匹配 {summary['matched_lines']} 行）"
        ),
    }


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_log_analyzer_tool(ctx: ToolContext):
    """构建日志分析工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数
    """
    @tool
    def analyze_logs(
        log_path: str,
        mode: str = "tail",
        lines: int = 100,
        pattern: str = "",
        ssh_session_id: str = "",
    ) -> dict:
        """分析 SSH 会话上的远程日志文件。

        支持 3 种模式：
        - tail:  读取日志末尾 N 行（默认 100）
        - grep:  关键词过滤（grep -F 固定字符串匹配，pattern 必填）
        - regex: 正则表达式匹配（grep -E 扩展正则，pattern 必填）

        Args:
            log_path (str): 日志文件绝对路径。
            mode (str): 分析模式，tail / grep / regex，默认 tail。
            lines (int): 返回行数，默认 100，上限 2000。
            pattern (str): 匹配模式（grep / regex 模式必填）。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认会话。

        Returns:
            dict: 结构化结果，含 status / log_path / mode / raw_output / summary 等字段。
                status 取值: success | needs_approval | unavailable | error
        """
        return invoke_log_analyzer_tool(
            params={
                "log_path": log_path,
                "mode": mode,
                "lines": lines,
                "pattern": pattern,
                "ssh_session_id": ssh_session_id,
            },
            ctx=ctx,
        )

    analyze_logs.__name__ = "analyze_logs"
    return analyze_logs


__all__ = [
    "invoke_log_analyzer_tool",
    "make_log_analyzer_tool",
]
