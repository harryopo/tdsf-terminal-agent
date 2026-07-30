"""
strands_backend/tools/__init__.py — Strands 运维工具公共基础设施
================================================================

职责：
- 提供 ``@tool`` 装饰器的降级 fallback（Strands 未安装时退化为 passthrough，
  保证模块可被 import / 单元测试 / 适配层优雅降级）。
- 定义 ``RustBridge`` 协议 + ``DefaultRustBridge`` 默认实现：工具通过它调用
  Rust 后端（ipc_invoke），不直接 ssh/sftp，复用现有 Tauri invoke 机制。
  *当前架构下 Python→Rust 是单向 JSON-RPC，DefaultRustBridge 在未注入
  send_request 回调时返回 unavailable 状态，等待 P2 阶段双向 JSON-RPC 扩展。*
- 定义 ``ToolContext`` dataclass：工具运行时上下文（event_bus / rust_bridge /
  agent_name / session_id / user_id），由适配层注入，工具通过闭包访问。
- 提供 ``RiskChecker`` 公共类：检测高危命令（rm -rf / reboot / shutdown /
  mkfs / dd / fork bomb 等），命中时通过 ``event_bus.emit_needs_you`` 推送
  审批事件，与现有 ``needs_you.py`` 协调服务对齐。
- 提供 ``execute_via_ssh`` 辅助函数：统一通过 RustBridge 调 ssh_command。
  （TDSF 魔改 2026-07-30 P0-C4: 原 "ssh_exec_in_session" 与 Rust 侧命名约定
  不一致，已对齐为 "ssh_command"；当前 Rust 侧尚未实现此命令，属 P2 backlog，
  rust_bridge=None 时返回 unavailable 不会触发实际调用。）
- 导出 5 个运维工具的工厂函数 + invoke 函数（供适配层注册与单测调用）。

设计原则：
1. Strands 是条件依赖（运行时缺失时优雅降级，不影响 sidecar 启动）。
2. 工具函数签名清晰，docstring 完整（中文注释），返回结构化 dict（不返回裸字符串）。
3. 高危命令需 needs_you 审批（emit_needs_you 事件），不直接执行。
4. 工具内部不直接 ssh/sftp，全部通过 RustBridge 调 Rust 后端。
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

logger = logging.getLogger("sidecar.strands_backend.tools")

# ============================================================================
# @tool 装饰器（Strands 不可用时降级为 passthrough）
# ============================================================================

try:
    from strands import tool as _strands_tool  # type: ignore[import]
    _STRANDS_AVAILABLE = True
except ImportError:  # Strands 未安装时优雅降级
    _STRANDS_AVAILABLE = False

    def _strands_tool(func):  # type: ignore[misc]
        """Strands 不可用时的 passthrough 装饰器

        保留函数原签名与可调用性，附加 ``_is_strands_tool=False`` 标记，
        适配层据此判断是否真实 Strands 工具。
        """
        func._is_strands_tool = False  # type: ignore[attr-defined]
        func._tool_description = func.__doc__ or ""  # type: ignore[attr-defined]
        return func

# 统一对外导出的 @tool 装饰器
tool = _strands_tool
TOOL_DECORATOR_AVAILABLE = _STRANDS_AVAILABLE


# ============================================================================
# RustBridge 协议 — Python 调用 Rust 后端的抽象层
# ============================================================================

class RustBridge(Protocol):
    """RustBridge 协议：工具通过它调用 Rust 后端的 Tauri command

    协议方法：
        ipc_invoke(method: str, params: dict) -> Any

    实际调用链（P2 阶段双向 JSON-RPC 扩展后）：
        Python 工具 → RustBridge.ipc_invoke("ssh_command", {...})
        → Python sidecar send_request(method, params)  # 带 id 的 JSON-RPC request
        → Rust ipc.rs 收到 request → 调对应 Tauri command
        → 返回结果给 Python

    TDSF 魔改 2026-07-30 P0-C4 注：
        "ssh_command" 当前 Rust 侧未实现（src-tauri/src/modules/ssh/mod.rs 仅有
        ssh_connect/ssh_write/ssh_resize/ssh_disconnect/ssh_status/ssh_test
        等 PTY 模式命令，无"执行单条命令并返回输出"的 exec 模式命令）。
        P2 backlog：新增 Rust ssh_command Tauri command（基于 russh channel exec
        而非 PTY，返回 {ok, output, exit_code, duration}）。
        当前架构下 rust_bridge=None，ipc_invoke 返回 unavailable，工具降级。

    当前架构（Python→Rust 单向 notification）下，DefaultRustBridge 未注入
    send_request 回调时返回 unavailable 状态，工具据此降级（返回"未配置"
    结构化结果，而非抛错阻塞 agent loop）。
    """

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any: ...


class DefaultRustBridge:
    """默认 RustBridge 实现

    Args:
        send_request: 双向 JSON-RPC 请求回调，签名 (method: str, params: dict) -> Any。
                      None 时所有 ipc_invoke 返回 unavailable 状态（当前架构默认）。

    用法：
        # P2 阶段：main.py 注入真实 send_request
        bridge = DefaultRustBridge(send_request=main.send_request_to_rust)
        # 当前阶段：未注入，工具返回 unavailable
        bridge = DefaultRustBridge()
    """

    def __init__(self, send_request: Callable[[str, dict[str, Any]], Any] | None = None) -> None:
        self._send_request = send_request

    def ipc_invoke(self, method: str, params: dict[str, Any]) -> Any:
        if self._send_request is None:
            logger.debug(
                f"rust_bridge unavailable: method={method} "
                f"(需 P2 双向 JSON-RPC 扩展)"
            )
            return {
                "status": "unavailable",
                "reason": "rust_bridge_not_configured",
                "method": method,
                "message": (
                    "Python→Rust 反向调用未配置，需 P2 阶段扩展双向 JSON-RPC。"
                    "当前工具调用降级为返回不可用状态。"
                ),
            }
        try:
            return self._send_request(method, params)
        except Exception as e:
            logger.exception(f"rust_bridge ipc_invoke failed: method={method}, error={e}")
            return {
                "status": "error",
                "reason": "ipc_invoke_exception",
                "method": method,
                "error": str(e),
            }


# ============================================================================
# ToolContext — 工具运行时上下文（由适配层注入，工具通过闭包访问）
# ============================================================================

@dataclass
class ToolContext:
    """工具运行时上下文

    适配层（StrandsAgentAdapter）在构造每个工具时注入此上下文，
    工具函数通过闭包访问 event_bus / rust_bridge / agent_name 等。

    Attributes:
        event_bus: EventBus 实例（用于 emit_needs_you / emit_agent_message 等）
        rust_bridge: RustBridge 实例（用于调 Rust 后端）
        agent_name: 当前 Agent 名（如 "main" / "debug"），用于事件 source 标识
        session_id: 会话 ID（用于事件路由 + needs_you 关联）
        user_id: 用户 ID（可选，用于权限审批）
        ssh_session_id: 默认 SSH 会话 ID（可选，工具调用时未显式传则用它）
    """
    event_bus: Any = None
    rust_bridge: RustBridge | None = None
    agent_name: str = "main"
    session_id: str = ""
    user_id: str = ""
    ssh_session_id: str = ""


# ============================================================================
# RiskChecker — 高危命令检测 + needs_you 审批
# ============================================================================

# 高危命令正则规则（命中即触发 needs_you 审批，不直接执行）
# 每条规则：(name, pattern, reason)
_HIGH_RISK_PATTERNS: list[tuple[str, str, str]] = [
    (
        "rm_rf_root",
        r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive\s+--force)\s+(/|\*|\s/\s|$)",
        "递归删除根目录或通配符，将造成不可恢复的数据损失",
    ),
    (
        "rm_rf",
        r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive\s+--force)\s+",
        "递归强制删除，需用户确认目标路径",
    ),
    (
        "reboot",
        r"\b(reboot|shutdown\s+(-r|-h)?\s*now?|halt|poweroff|init\s+0|init\s+6)\b",
        "重启/关机命令将中断服务器运行",
    ),
    (
        "mkfs",
        r"\bmkfs\.[a-z0-9]+\s+/dev/",
        "格式化块设备将摧毁文件系统",
    ),
    (
        "dd_to_disk",
        r"\bdd\s+.*\s+of=/dev/(sd|nvme|vd|hd)",
        "dd 写入块设备可能摧毁磁盘数据",
    ),
    (
        "fork_bomb",
        r":\(\)\s*\{\s*:\|\s*:\&\s*\}\s*;",
        "fork bomb 将耗尽系统进程资源",
    ),
    (
        "chmod_777_root",
        r"chmod\s+(-R\s+)?777\s+/",
        "对根目录递归 777 将破坏系统权限模型",
    ),
    (
        "killall_system",
        r"killall\s+(-9\s+)?(systemd|init|sshd|nginx|mysql|postgres)",
        "杀死关键系统进程将导致服务中断",
    ),
    (
        "iptables_flush",
        r"iptables\s+(-F|-X|-Z)\b",
        "清空防火墙规则可能中断网络连接",
    ),
    (
        "drop_database",
        r"(DROP\s+DATABASE|DROP\s+SCHEMA)\b",
        "删除数据库将造成数据丢失",
    ),
]


class RiskChecker:
    """高危命令检测器

    用法：
        result = RiskChecker.check(command)
        if result.high_risk:
            RiskChecker.emit_needs_you(event_bus, command, result, agent, session_id)
            # 返回 needs_approval 状态，不执行命令

    设计：
    - 纯静态检测（正则匹配），不依赖 RiskEngine YAML 配置
    - 与现有 ``tools/risk.py`` 的 ``invoke_risk_tool`` 互补：
      * RiskChecker 仅做高危命令快速拦截（同步、无依赖）
      * invoke_risk_tool 做 4 层风控管道（YAML 规则 + 资产 + 语法 + 调整）
    - 适配层可二选一或叠加使用（推荐叠加：先 RiskChecker 快速拦，再 risk_tool 精评）
    """

    @staticmethod
    def check(command: str) -> dict[str, Any]:
        """检测命令是否高危

        Args:
            command: 待检测的 shell 命令字符串

        Returns:
            dict:
                high_risk: bool, 是否高危
            level: str, 风险等级（L0-L4，高危命中即 L4）
            matched_rules: list[str], 命中的规则名
            reason: str, 风险原因（拼接所有命中规则的原因）
            require_approval: bool, 是否需要用户审批
        """
        matched: list[str] = []
        reasons: list[str] = []
        for name, pattern, reason in _HIGH_RISK_PATTERNS:
            try:
                if re.search(pattern, command, re.IGNORECASE):
                    matched.append(name)
                    reasons.append(f"[{name}] {reason}")
            except re.error:
                # 正则本身错误（理论上不会发生），跳过该规则
                logger.exception(f"RiskChecker regex error: rule={name}")

        if not matched:
            return {
                "high_risk": False,
                "level": "L0",
                "matched_rules": [],
                "reason": "",
                "require_approval": False,
            }

        return {
            "high_risk": True,
            "level": "L4",
            "matched_rules": matched,
            "reason": "; ".join(reasons),
            "require_approval": True,
        }

    @staticmethod
    def emit_needs_you(
        event_bus: Any,
        command: str,
        risk_result: dict[str, Any],
        agent_name: str,
        session_id: str,
        tool_name: str = "ssh_command",
    ) -> None:
        """通过 event_bus 推送 needs_you 审批事件

        与现有 ``needs_you.py`` 协调服务对齐：
        - needs_type="approval"
        - priority="high"（高危命令）
        - 前端渲染审批卡片，用户批准后才继续 agentic loop

        Args:
            event_bus: EventBus 实例（None 时静默跳过）
            command: 触发审批的命令
            risk_result: RiskChecker.check 返回的 dict
            agent_name: 来源 Agent 名
            session_id: 会话 ID
            tool_name: 触发工具名
        """
        if event_bus is None:
            logger.warning(
                f"RiskChecker.emit_needs_you skipped (no event_bus): "
                f"command={command[:80]}, agent={agent_name}"
            )
            return
        try:
            event_bus.emit_needs_you(
                needs_type="approval",
                title=f"高危命令审批请求: {risk_result.get('matched_rules', ['unknown'])[0]}",
                description=(
                    f"Agent {agent_name} 试图通过工具 {tool_name} 执行高危命令:\n"
                    f"  命令: {command[:200]}\n"
                    f"  风险等级: {risk_result.get('level', 'L4')}\n"
                    f"  原因: {risk_result.get('reason', '')}\n"
                    f"请确认是否批准执行。"
                ),
                session_id=session_id or None,
                source=f"{agent_name}_agent.strands_tool.{tool_name}",
                priority="high",
                command=command,
                risk_level=risk_result.get("level", "L4"),
                matched_rules=risk_result.get("matched_rules", []),
                tool_name=tool_name,
            )
        except Exception as e:
            logger.exception(f"RiskChecker.emit_needs_you failed: {e}")


# ============================================================================
# execute_via_ssh — 统一 SSH 命令执行辅助函数
# ============================================================================

def execute_via_ssh(
    ctx: ToolContext,
    command: str,
    ssh_session_id: str = "",
    timeout: int = 30,
    tool_name: str = "ssh_command",
) -> dict[str, Any]:
    """通过 RustBridge 调用 Rust 后端执行 SSH 命令

    内部流程：
    1. 解析 ssh_session_id（优先参数，其次 ctx 默认）
    2. RiskChecker.check 高危检测
       - 命中：emit_needs_you + 返回 needs_approval 状态（不执行）
    3. RustBridge.ipc_invoke("ssh_command", {...}) 调 Rust 后端
       - rust_bridge 未配置：返回 unavailable 状态（不抛错）
       - rust_bridge 调用异常：返回 error 状态
       - TDSF 魔改 2026-07-30 P0-C4: Rust 侧 ssh_command 命令尚未实现，
         P2 阶段补 Rust 后端 russh channel exec 模式（非 PTY）。
    4. 返回结构化 dict

    Args:
        ctx: ToolContext 运行时上下文
        command: 待执行的 shell 命令
        ssh_session_id: SSH 会话 ID（空则用 ctx.ssh_session_id）
        timeout: 超时秒数（默认 30）
        tool_name: 调用方工具名（用于事件 source 标识）

    Returns:
        dict:
            status: "success" | "needs_approval" | "unavailable" | "error"
            command: 原命令
            ssh_session_id: 使用的会话 ID
            output: 命令输出（success 时）
            exit_code: 退出码（success 时）
            duration: 执行耗时秒（success 时）
            risk: 风险评估结果（needs_approval 时）
            error: 错误信息（error 时）
    """
    session_id = ssh_session_id or ctx.ssh_session_id

    # 1. 风险评估
    risk = RiskChecker.check(command)
    if risk["high_risk"]:
        RiskChecker.emit_needs_you(
            event_bus=ctx.event_bus,
            command=command,
            risk_result=risk,
            agent_name=ctx.agent_name,
            session_id=ctx.session_id,
            tool_name=tool_name,
        )
        logger.warning(
            f"execute_via_ssh blocked (high risk): tool={tool_name}, "
            f"command={command[:80]}, rules={risk['matched_rules']}"
        )
        return {
            "status": "needs_approval",
            "command": command,
            "ssh_session_id": session_id,
            "risk": risk,
            "message": "高危命令已触发 needs_you 审批，未执行",
        }

    # 2. 检查 RustBridge 配置
    if ctx.rust_bridge is None:
        logger.warning(
            f"execute_via_ssh unavailable (no rust_bridge): tool={tool_name}, "
            f"command={command[:80]}"
        )
        return {
            "status": "unavailable",
            "command": command,
            "ssh_session_id": session_id,
            "reason": "rust_bridge_not_injected",
            "message": "RustBridge 未注入，工具无法调用 Rust 后端",
        }

    # 3. 通过 RustBridge 调 Rust 后端
    # TDSF 魔改 2026-07-30 P0-C4: 对齐 Rust 命令名约定（ssh_command），
    # 当前 Rust 侧尚未实现此命令，P2 backlog 补 russh channel exec 模式。
    # TDSF 修复 2026-07-30 (Critical Bug): 参数名对齐 Rust camelCase (sessionId)，
    # 并把 str session_id 转为 int（Rust 侧期望 u32 via as_u64()）。
    # 前端 LiveSnapshot.sshSessionId 是 number（rustSessionId: u32），
    # 但经 JSON 序列化→Python dict→ToolContext.ssh_session_id(str) 后变成 str，
    # 这里转回 int 才能被 Rust as_u64() 解析。
    try:
        session_id_int = int(session_id) if session_id else 0
    except (ValueError, TypeError) as e:
        logger.error(
            f"execute_via_ssh invalid session_id: id={session_id!r}, error={e}"
        )
        return {
            "status": "error",
            "command": command,
            "ssh_session_id": session_id,
            "error": f"invalid session_id (expect int-convertible): {session_id!r}",
        }

    if session_id_int <= 0:
        logger.warning(
            f"execute_via_ssh no active ssh session: tool={tool_name}, "
            f"command={command[:80]}"
        )
        return {
            "status": "unavailable",
            "command": command,
            "ssh_session_id": session_id,
            "reason": "no_ssh_session",
            "message": "无活跃 SSH 会话，请先连接 SSH 再调用运维工具",
        }

    try:
        result = ctx.rust_bridge.ipc_invoke("ssh_command", {
            "sessionId": session_id_int,
            "command": command,
            "timeout": int(timeout),
        })
    except Exception as e:
        logger.exception(
            f"execute_via_ssh ipc_invoke exception: tool={tool_name}, "
            f"command={command[:80]}, error={e}"
        )
        return {
            "status": "error",
            "command": command,
            "ssh_session_id": session_id,
            "error": f"ipc_invoke 异常: {e}",
        }

    # 4. 整理返回结果
    if isinstance(result, dict) and result.get("status") in ("unavailable", "error"):
        return {
            "status": result.get("status", "error"),
            "command": command,
            "ssh_session_id": session_id,
            "reason": result.get("reason", ""),
            "error": result.get("error", result.get("message", "")),
        }

    # Rust 后端返回的成功结果（假设结构：{ok, output, exit_code, duration}）
    return {
        "status": "success",
        "command": command,
        "ssh_session_id": session_id,
        "output": result.get("output", "") if isinstance(result, dict) else str(result),
        "exit_code": result.get("exit_code", 0) if isinstance(result, dict) else 0,
        "duration": result.get("duration", 0.0) if isinstance(result, dict) else 0.0,
    }


# ============================================================================
# 5 个运维工具的工厂函数 + invoke 函数导出
# ============================================================================

# 延迟导入避免循环依赖，提供模块级便捷访问
def _import_tool_functions() -> None:
    """延迟导入 5 个工具的工厂函数 + invoke 函数

    在 __init__.py 末尾调用，确保 from strands_backend.tools import make_ssh_command_tool 可用
    """
    from strands_backend.tools.ssh_command import (  # noqa: F401
        invoke_ssh_command_tool,
        make_ssh_command_tool,
    )
    from strands_backend.tools.remote_file import (  # noqa: F401
        invoke_remote_file_tool,
        make_remote_file_tool,
    )
    from strands_backend.tools.log_analyzer import (  # noqa: F401
        invoke_log_analyzer_tool,
        make_log_analyzer_tool,
    )
    from strands_backend.tools.process_inspector import (  # noqa: F401
        invoke_process_inspector_tool,
        make_process_inspector_tool,
    )
    from strands_backend.tools.network_diagnostic import (  # noqa: F401
        invoke_network_diagnostic_tool,
        make_network_diagnostic_tool,
    )


# 工具名注册表（供适配层枚举注册）
OPS_TOOL_NAMES: list[str] = [
    "ssh_command",
    "remote_file",
    "log_analyzer",
    "process_inspector",
    "network_diagnostic",
]


def make_all_ops_tools(ctx: ToolContext) -> list:
    """构建全部 5 个运维工具（带 ctx 闭包）

    Args:
        ctx: ToolContext 运行时上下文

    Returns:
        Strands @tool 装饰后的工具函数列表（Strands 不可用时为 passthrough 装饰）
    """
    from strands_backend.tools.ssh_command import make_ssh_command_tool
    from strands_backend.tools.remote_file import make_remote_file_tool
    from strands_backend.tools.log_analyzer import make_log_analyzer_tool
    from strands_backend.tools.process_inspector import make_process_inspector_tool
    from strands_backend.tools.network_diagnostic import make_network_diagnostic_tool

    return [
        make_ssh_command_tool(ctx),
        make_remote_file_tool(ctx),
        make_log_analyzer_tool(ctx),
        make_process_inspector_tool(ctx),
        make_network_diagnostic_tool(ctx),
    ]


__all__ = [
    # 装饰器
    "tool",
    "TOOL_DECORATOR_AVAILABLE",
    # RustBridge
    "RustBridge",
    "DefaultRustBridge",
    # 上下文
    "ToolContext",
    # 风险检测
    "RiskChecker",
    # 辅助函数
    "execute_via_ssh",
    # 工具注册
    "OPS_TOOL_NAMES",
    "make_all_ops_tools",
]
