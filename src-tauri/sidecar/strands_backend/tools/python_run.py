"""
strands_backend/tools/python_run.py — Python 代码执行工具（T5，无沙箱版）
==========================================================================

职责（spec add-agent-loop-closure Task 5，方案书 v4.0 PTC 工具）：
- 在**本地工作区**用 subprocess 受控执行一段 Python 代码（``python -c``），
  供 agent 做多文件交叉统计 / 复杂解析 / 批量操作——写一段 Python 一次完成，
  优于逐工具往返。
- 受控（进程级，无沙箱——用户拍板暂不做沙箱）：
  * cwd 锁定 ``ToolContext.workspace``（本地工作区根目录）
  * 超时 30s（TimeoutExpired → 子进程 kill + 返回已捕获的部分输出）
  * stdout / stderr 各自截断 10KB（超出标注 truncated=true + 原始长度）
- fail-closed（不静默错跑）：
  * code 缺失 / 空白 → error
  * SSH 会话（ctx.ssh_session_id 非空）→ error（本期仅支持本地工作区，
    不静默跑在远端或别的机器）
  * workspace 不可得 → error（不臆测目录）

设计（对齐 suggest_command / ssh_command 的两层结构）：
- ``invoke_python_run_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_python_run_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 函数。

工具签名（Strands 从 docstring + 类型标注自动生成工具描述）：
    python_run(code: str) -> dict

返回结构：
    success:  {status:"success", exit_code:0, stdout, stderr, duration_ms, truncated}
    脚本失败: {status:"error", exit_code:<非零>, stdout, stderr, duration_ms,
              truncated, message}（失败信息看 stderr——"失败返回 exit_code+stderr"）
    超时:     {status:"timeout", exit_code:None, stdout, stderr, duration_ms,
              truncated, message}（stdout/stderr 为 kill 前已捕获的部分输出）
    fail-closed: {status:"error", exit_code:None, stdout:"", stderr:"",
              duration_ms:0, truncated:False, message}（参数/环境拒绝，未执行）

截断语义：stdout 与 stderr **各自**上限 10KB（text 模式按字符计，近似 10KB），
任一被截断则 truncated=true 并附 ``stdout_full_len`` / ``stderr_full_len``
原始长度。

已知限制（无沙箱版，进程级受控边界）：
- 只 kill 直接子进程，代码内 spawn 的孙进程不追踪（沙箱版再收口）。
- 代码以 sidecar 同款解释器（``sys.executable``）执行。
"""
from __future__ import annotations

import logging
import subprocess
import sys
import time
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.python_run")

# ============================================================================
# 受控边界常量（spec Task 5：30s 超时 / 10KB 输出截断）
# ============================================================================

DEFAULT_TIMEOUT_SECONDS = 30
# 上限即默认——@tool 签名不暴露 timeout 参数，调用方（测试）经 params 传入
# 也只能夹取到 [1, 30]，安全上限不可调大
MAX_TIMEOUT_SECONDS = 30
MAX_OUTPUT_CHARS = 10 * 1024  # 10KB（text 模式按字符近似）


def _as_text(data: Any) -> str:
    """把 TimeoutExpired.stdout/stderr 统一为 str（防御 bytes 形态）

    subprocess.run(text=True) 超时时 TimeoutExpired.stdout 理论上是解码后
    的 str（Windows 分支由内部 communicate() 回填）；历史版本/边界平台可能
    携带 bytes，这里统一兜底。
    """
    if data is None:
        return ""
    if isinstance(data, bytes):
        return data.decode("utf-8", errors="replace")
    return str(data)


def _truncate(text: str) -> tuple[str, bool, int]:
    """输出截断：超过 MAX_OUTPUT_CHARS 时截断，返回 (截断文本, 是否截断, 原始长度)"""
    full_len = len(text)
    if full_len <= MAX_OUTPUT_CHARS:
        return text, False, full_len
    return text[:MAX_OUTPUT_CHARS], True, full_len


def _timeout_params(timeout: Any) -> int:
    """解析并夹取 timeout（默认 30，上限 30——安全边界不可放大）"""
    try:
        value = int(timeout)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    return max(1, min(value, MAX_TIMEOUT_SECONDS))


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def invoke_python_run_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Python 代码执行工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - code (str, 必填): 要执行的 Python 源码（一段完整可执行的脚本）
            - timeout (int, 可选): 超时秒数，默认 30，夹取 [1, 30]
              （@tool 签名不暴露此参数，仅供单测缩短等待）
        ctx: ToolContext 运行时上下文（读 workspace / ssh_session_id）

    Returns:
        结构化 dict（见模块 docstring 返回结构）
    """
    # ---- fail-closed：参数校验 ----
    code = params.get("code")
    if code is None or not str(code).strip():
        result = {
            "status": "error",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "truncated": False,
            "message": "python_run 工具必填参数缺失或为空: code",
        }
        _emit_tool_call_completed(ctx, params, result)
        return result
    code = str(code)

    # ---- fail-closed：SSH 会话拒绝（本期仅本地执行，不静默错跑在别的机器）----
    if getattr(ctx, "ssh_session_id", ""):
        result = {
            "status": "error",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "truncated": False,
            "message": (
                "python_run 目前仅支持本地工作区（当前为 SSH 会话），"
                "未执行任何代码；远程分析请用 ssh_command 等远端工具。"
            ),
        }
        _emit_tool_call_completed(ctx, params, result)
        return result

    # ---- fail-closed：workspace 不可得（不臆测目录）----
    workspace = str(getattr(ctx, "workspace", "") or "")
    if not workspace:
        result = {
            "status": "error",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": 0,
            "truncated": False,
            "message": (
                "python_run 需要本地工作区（workspace 不可得），"
                "未执行任何代码；请先打开本地终端/工作区再试。"
            ),
        }
        _emit_tool_call_completed(ctx, params, result)
        return result

    timeout_s = _timeout_params(params.get("timeout", DEFAULT_TIMEOUT_SECONDS))

    # ---- 受控执行（cwd 锁定本地工作区；超时由 subprocess.run 内部 kill）----
    start = time.perf_counter()
    try:
        completed = subprocess.run(  # noqa: S603 — 解释器路径来自 sys.executable
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=workspace,
        )
    except subprocess.TimeoutExpired as exc:
        # subprocess.run 内部已 kill 子进程并回填部分输出（Windows 分支
        # 经内部 communicate() 收集）；孙进程不追踪（无沙箱版边界）
        duration_ms = int((time.perf_counter() - start) * 1000)
        stdout, out_trunc, out_len = _truncate(_as_text(exc.stdout))
        stderr, err_trunc, err_len = _truncate(_as_text(exc.stderr))
        result: dict[str, Any] = {
            "status": "timeout",
            "exit_code": None,
            "stdout": stdout,
            "stderr": stderr,
            "duration_ms": duration_ms,
            "truncated": out_trunc or err_trunc,
            "message": (
                f"执行超过 {timeout_s}s 已被终止（子进程已 kill，"
                f"stdout/stderr 为已捕获的部分输出）。"
            ),
        }
        if out_trunc or err_trunc:
            result["stdout_full_len"] = out_len
            result["stderr_full_len"] = err_len
        logger.warning(
            f"python_run timeout killed: timeout={timeout_s}s, "
            f"duration_ms={duration_ms}, code_len={len(code)}"
        )
        _emit_tool_call_completed(ctx, params, result)
        return result
    except OSError as exc:
        # 解释器启动失败（如 sys.executable 失效）——工具级 error
        duration_ms = int((time.perf_counter() - start) * 1000)
        result = {
            "status": "error",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration_ms": duration_ms,
            "truncated": False,
            "message": f"python 子进程启动失败: {exc}",
            "error": str(exc),
        }
        logger.exception(f"python_run spawn failed: {exc}")
        _emit_tool_call_completed(ctx, params, result)
        return result

    duration_ms = int((time.perf_counter() - start) * 1000)
    stdout, out_trunc, out_len = _truncate(completed.stdout or "")
    stderr, err_trunc, err_len = _truncate(completed.stderr or "")
    truncated = out_trunc or err_trunc

    result = {
        "status": "success" if completed.returncode == 0 else "error",
        "exit_code": completed.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "duration_ms": duration_ms,
        "truncated": truncated,
    }
    if truncated:
        result["stdout_full_len"] = out_len
        result["stderr_full_len"] = err_len
    if completed.returncode != 0:
        result["message"] = (
            f"脚本以退出码 {completed.returncode} 结束（失败详情见 stderr）"
        )

    _emit_tool_call_completed(ctx, params, result)
    return result


def _emit_tool_call_completed(
    ctx: ToolContext,
    params: dict[str, Any],
    result: dict[str, Any],
) -> None:
    """推送 tool_call 完成事件（started 由 make_python_run_tool 推送）

    事件失败静默（debug 日志）——事件是展示层加分项，不影响工具主流程。
    """
    if ctx.event_bus is None:
        return
    try:
        ctx.event_bus.emit_tool_call(
            tool_name="python_run",
            params={"code": str(params.get("code", ""))[:500]},
            result=result,
            status="completed",
            session_id=ctx.session_id or None,
            source=f"{ctx.agent_name}_agent.strands_tool.python_run",
        )
    except Exception as e:  # noqa: BLE001 — 事件推送失败不影响工具主流程
        logger.debug(f"emit_tool_call completed failed: {e}")


# ============================================================================
# Strands @tool 工厂
# ============================================================================

def make_python_run_tool(ctx: ToolContext):
    """构建 Python 代码执行工具（带 ctx 闭包）"""

    @tool
    def python_run(code: str) -> dict:
        """在本地工作区执行一段 Python 代码（受控：30s 超时、输出截断 10KB）。

        使用场景（写一段 Python 一次完成，优于逐工具往返）：
        - 多文件交叉统计（如统计多个日志文件的错误分布）
        - 复杂解析（正则/JSON/CSV 多层处理）
        - 批量操作（一次处理一批文件）

        约束：
        - 仅本地工作区可用（SSH 会话下返回 error，不在远端执行）
        - 工作目录锁定为本地工作区根目录
        - 执行超过 30 秒会被终止（status=timeout）
        - stdout/stderr 各自超过 10KB 会截断（truncated=true）

        Args:
            code (str): 要执行的 Python 源码（一段完整可执行的脚本）。

        Returns:
            dict: {status, exit_code, stdout, stderr, duration_ms, truncated}。
            status: success（退出码 0）/ error（脚本失败或参数/环境被拒，
            fail-closed 未执行）/ timeout（超时被终止）。
        """
        # 推送 tool_call 开始事件，让前端实时显示工具调用卡片
        if ctx.event_bus is not None:
            try:
                ctx.event_bus.emit_tool_call(
                    tool_name="python_run",
                    params={"code": str(code)[:500]},
                    status="started",
                    session_id=ctx.session_id or None,
                    source=f"{ctx.agent_name}_agent.strands_tool.python_run",
                )
            except Exception as e:  # noqa: BLE001 — 事件推送失败不影响工具主流程
                logger.debug(f"emit_tool_call started failed: {e}")

        return invoke_python_run_tool(params={"code": code}, ctx=ctx)

    python_run.__name__ = "python_run"
    return python_run


__all__ = [
    "invoke_python_run_tool",
    "make_python_run_tool",
]
