"""
strands_backend/tools/ssh_command.py — SSH 命令执行工具
========================================================

职责：
- 通过 RustBridge 调用 Rust 后端 ``ssh_command`` Tauri command，
  在指定 SSH 会话上执行 shell 命令，返回结构化结果。
- 不直接 ssh（不引入 paramiko/asyncssh 等依赖），复用现有 Tauri invoke 机制
  + Rust russh 0.61 客户端，与 ``SshTerminalPane.tsx`` 共享会话。
- 高危命令（rm -rf / reboot / shutdown / mkfs / dd / fork bomb 等）通过
  ``RiskChecker`` 检测，命中即 ``emit_needs_you`` 推送审批事件，不直接执行。
- 返回结构化 dict（不返回裸字符串），与 Strands 工具协议对齐。

TDSF 2026-07-30 P0-C4:
- 原 docstring / 注释引用 "ssh_exec_in_session"，与 Rust 侧命名约定不一致。
  Rust 侧实际命令风格为 ssh_<verb>（如 ssh_connect/ssh_write/ssh_disconnect），
  故对齐为 "ssh_command"。
- 2026-08-18 P0-D 已完成：Rust 侧 ``ssh_command`` Tauri command（russh exec
  模式，非 PTY）+ sidecar.rs ``handle_reverse_request`` 反向 JSON-RPC 路由，
  rust_bridge 传递可用，工具经 ``execute_via_ssh`` 真实执行
  （30s 超时 + 8MiB 输出上限 + 被拒立即返回，见 ssh/mod.rs 与 sidecar.rs）。

设计：
- ``invoke_ssh_command_tool(params, ctx)``：核心实现，无 Strands 依赖，便于单测。
- ``make_ssh_command_tool(ctx)``：工厂函数，返回带 ctx 闭包的 @tool 装饰函数，
  供 ``StrandsAgentAdapter`` 注册到 Strands Agent。
- Strands 不可用时 @tool 退化为 passthrough，工厂仍返回可调用函数。

工具签名（Strands 从 docstring + 类型标注自动生成工具描述）：
    ssh_command(command, ssh_session_id="", explanation="", timeout=30) -> dict

返回结构：
    success:
        {status:"success", command, ssh_session_id, output, exit_code, duration}
    command_blocked:
        {status:"command_blocked", command, ssh_session_id, risk, impact, message}
        （denylist 硬底线 / observe 模式 / host 校验失败——拦截类反馈禁替代方案）
    rejected:
        {status:"rejected", command, ssh_session_id, risk, impact, message}
        （用户拒绝——message 含用户附言，agent 可据此给替代方案）
    needs_approval:
        {status:"needs_approval", command, ssh_session_id, risk, impact, message}
        （审批超时 / 请求创建失败——fail-closed 未执行）
    unavailable:
        {status:"unavailable", command, ssh_session_id, reason, message}
    error:
        {status:"error", command, ssh_session_id, error}
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import (
    ToolContext,
    assess_command,
    complete_approval_execution,
    execute_via_ssh,
    request_approval_and_wait,
    tool,
)

logger = logging.getLogger("sidecar.strands_backend.tools.ssh_command")


# ============================================================================
# 核心实现（无 Strands 依赖，便于单测）
# ============================================================================

def invoke_ssh_command_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """SSH 命令执行工具核心实现

    Args:
        params: 工具参数 dict，支持字段：
            - command (str, 必填): 待执行的 shell 命令，单行，无尾随换行
            - ssh_session_id (str, 可选): SSH 会话 ID，空则用 ctx.ssh_session_id
            - explanation (str, 可选): 命令解释（前端展示用）
            - timeout (int, 可选): 超时秒数，默认 30
            - tool_name (str, 可选): 发起方工具名（backup_restore / config_diff 这类
              复用本实现的工具必须传，否则卡与审批一律显示成 ssh_command）
        ctx: ToolContext 运行时上下文

    Returns:
        结构化 dict（见模块 docstring 返回结构）

    Raises:
        ValueError: command 参数缺失或为空
    """
    command = params.get("command", "").strip()
    if not command:
        raise ValueError("ssh_command 工具必填参数缺失: command")

    ssh_session_id = params.get("ssh_session_id", "") or ""
    explanation = params.get("explanation", "") or ""
    timeout = int(params.get("timeout", 30))

    # 复用本实现的上游工具（backup_restore / config_diff）在这里传自己的名字，
    # 否则审批卡、审计、聊天卡一律显示成 ssh_command（#114 用户报的"混用"）。
    tool_name = str(params.get("tool_name") or "ssh_command")

    # 多行命令拆分检测（Task 3 / Task 4 接入：每行走 assess_command 综合决策）
    # P1-1 (2026-08-01): 命中确认 → 真实等待用户响应，批准后整条执行
    # （execute_via_ssh 传 skip_approval=True 防止二次审批卡）
    multiline_approved = False
    multiline_approval_req: Any | None = None
    if "\n" in command.strip():
        confirm_lines: list[tuple[str, dict[str, Any]]] = []
        blocked: dict[str, Any] | None = None
        for line in command.strip().splitlines():
            line_stripped = line.strip()
            if not line_stripped or line_stripped.startswith("#"):
                continue
            assessment = assess_command(ctx, line_stripped)
            if assessment["decision"] in ("blocked", "deny"):
                # denylist 硬底线 / observe deny → 直接拦截（不审批）；
                # 拦截类反馈禁替代方案（Task 3.2）
                blocked = {
                    "status": "command_blocked",
                    "command": command,
                    "ssh_session_id": ssh_session_id or ctx.ssh_session_id,
                    "risk": assessment["risk"],
                    "impact": assessment["impact"],
                    "explanation": explanation,
                    "message": (
                        f"command_blocked! 只读模式或安全规则禁止执行："
                        f"多行命令中 '{line_stripped[:60]}' "
                        f"{assessment.get('reason') or '命中硬底线黑名单'}。"
                        f"该命令未执行"
                        + ("，也不提供替代方案。" if assessment["decision"] == "blocked" else "。")
                    ),
                }
                break
            if assessment["decision"] == "confirm":
                confirm_lines.append((line_stripped, assessment))
        if blocked is not None:
            return blocked
        if confirm_lines:
            from strands_backend.tools import (
                NeedsYouStatus,
                request_approval_and_wait,
            )

            first_line, first_assessment = confirm_lines[0]
            req = request_approval_and_wait(
                ctx,
                command,
                first_assessment["risk"],
                tool_name=tool_name,
                explanation=explanation,
                impact=first_assessment["impact"],
                risk_l=first_assessment["risk_l"],
            )
            if req is None or req.status != NeedsYouStatus.APPROVED:
                reason = ""
                if req is not None and isinstance(req.response, dict):
                    reason = str(req.response.get("reason", "") or "")
                # Task 3.2 双轨反馈：拒绝轨附用户附言（可给替代方案）；
                # 超时轨 fail-closed 按拒绝处理（5 分钟无响应）
                message = (
                    f"多行命令中第 '{first_line[:60]}' 需要用户审批，已发起审批"
                    + (
                        "，用户已拒绝，未执行" + (f"（用户附言：{reason}）" if reason else "")
                        if req is not None and req.status == NeedsYouStatus.REJECTED
                        else "，审批超时（5 分钟无响应），按拒绝处理，未执行"
                    )
                )
                return {
                    "status": "rejected" if req is not None and req.status == NeedsYouStatus.REJECTED else "needs_approval",
                    "command": command,
                    "ssh_session_id": ssh_session_id or ctx.ssh_session_id,
                    "risk": first_assessment["risk"],
                    "impact": first_assessment["impact"],
                    "explanation": explanation,
                    "message": message,
                }
            logger.info(
                f"multiline command approved by user: {len(confirm_lines)} confirm lines, "
                f"command={command[:80]}"
            )
            multiline_approved = True
            multiline_approval_req = req

    # TDSF 2026-09-23（#114）：这里原先手写一对 emit_tool_call（started / completed），
    # 现在由 execute_via_ssh 统一发——工具名跟着上游走，且拦截/审批/异常路径也会闭合。
    # 这里再发一遍就会双卡（test_terminal_tool_call_events.py 钉住"恰好一对"）。

    # #71 (2026-09-20): 这里原先有一段 `if False:` 的 inject_terminal 通知死块
    # （"后台执行前先让用户在终端看到命令"），发送端与前端监听一并删除。
    # 用户可见执行走 "visible-terminal" 通道（execution_channel 分流 +
    # sidecar:visible-terminal-execute），由 Rust PTY 真实执行并回读 OSC 块，
    # 不存在"通知注入 + 后台 exec"两条腿同时跑的双重执行路径。

    # 执行（Task 3/4 接入后内部含影响预测 + 三模式决策 + denylist 拦截 +
    # host 校验 + 审批链；多行命令已在上方整条审批通过时传 skip_approval）
    try:
        result = execute_via_ssh(
            ctx=ctx,
            command=command,
            ssh_session_id=ssh_session_id,
            timeout=timeout,
            tool_name=tool_name,
            explanation=explanation,
            skip_approval=bool(multiline_approved),
        )
    finally:
        complete_approval_execution(multiline_approval_req)

    # 补充 explanation 字段
    result["explanation"] = explanation

    return result


# ============================================================================
# Strands @tool 工厂（带 ctx 闭包）
# ============================================================================

def make_ssh_command_tool(ctx: ToolContext):
    """构建 SSH 命令执行工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数（Strands 不可用时为 passthrough 装饰）
    """
    @tool
    def ssh_command(
        command: str,
        ssh_session_id: str = "",
        explanation: str = "",
        timeout: int = 30,
    ) -> dict:
        """在 SSH 会话上执行 shell 命令。

        影响预测：命令按风险分级（只读/装包/改配置/操作服务/删除等），
        高危命令与写操作会弹出审批卡等待用户确认；denylist 硬底线
        （rm -rf / 等）直接拦截不提供审批。目标会话必须与当前激活终端一致。

        Args:
            command (str): 待执行的 shell 命令，单行，无尾随换行。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认会话。
            explanation (str): 命令解释，前端审批卡第 3 层展示用（可选）。
            timeout (int): 超时秒数，默认 30。

        Returns:
            dict: 结构化结果，含 status / command / output / exit_code / risk /
                impact 等字段。
                status 取值: success | command_blocked | rejected |
                needs_approval | unavailable | indeterminate | error
        """
        return invoke_ssh_command_tool(
            params={
                "command": command,
                "ssh_session_id": ssh_session_id,
                "explanation": explanation,
                "timeout": timeout,
            },
            ctx=ctx,
        )

    # Strands 从 __name__ 提取工具名，保持原名
    ssh_command.__name__ = "ssh_command"
    return ssh_command


def to_shell_command(params: dict[str, Any]) -> str | None:
    """ssh_command 工具→Shell 命令映射（A2，教学模式终端执行链路）

    ssh_command 的参数本身就是命令字符串，直接透传 params["command"]。

    Args:
        params: 工具参数 dict（含 command 字段）

    Returns:
        等价 shell 命令字符串；参数缺失返回 None
    """
    command = params.get("command", "").strip()
    return command if command else None


__all__ = [
    "invoke_ssh_command_tool",
    "make_ssh_command_tool",
    "to_shell_command",
]
