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

# P1-1 (2026-08-01): 审批状态枚举（真实 HITL 闭环），供 ssh_command 等工具使用
# 局部导入避免模块加载期依赖（needs_you 无反向依赖，安全）
from needs_you import NeedsYouStatus  # noqa: F401

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

    TDSF 魔改 2026-07-30 P0-D/P0-E 注：
        "ssh_command" Rust 侧已实现（src-tauri/src/modules/ssh/mod.rs:658
        `ssh_command` Tauri command，基于 russh channel exec 模式，返回
        {ok, output, stderr, exit_code, duration}，与 PTY 模式 ssh_write 互斥）。
        P0-D 已完成：Rust 侧 ssh_command 命令 + SshCommandResult 结构。
        P0-E 已完成：main.py 注入 RustBridge（_rust_bridge = RustBridge(write_message)）
        + DefaultRustBridge(send_request=lambda m,p: _rust_bridge.send_request(m,p))
        + agents.set_backend() 注入 Strands 适配层 + invoke_agent 优先走 override。

    当前架构（Python→Rust 双向 JSON-RPC）下，DefaultRustBridge 已注入
    send_request 回调时正常调 Rust 后端；未注入时返回 unavailable 状态，
    工具据此降级（返回"未配置"结构化结果，而非抛错阻塞 agent loop）。
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
    # P1-v5-4: 4 级权限（1=免确认 2=仅高危 3=高危+写操作 4=全部确认）
    permission_level: int = 2


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

    # 写操作模式（P1-v5-4）：修改状态但未必破坏——L3 权限下需要审批
    # 元组顺序与 _HIGH_RISK_PATTERNS 一致：(name, pattern, reason)
    _WRITE_PATTERNS: list[tuple[str, str, str]] = [
        ("file_mutation", r"\b(?:mv|cp|ln|chmod|chown|touch|mkdir)\s", "文件/属性修改"),
        ("inplace_edit", r"\b(?:sed|perl|awk)\s+.*\-i\b", "原地编辑文件"),
        ("redirect_write", r">>?\s*/", "重定向写文件"),
        ("file_editor", r"\b(?:vi|vim|nano|tee)\b", "编辑器/tee 写入"),
        ("process_control", r"\b(?:kill|pkill|killall|systemctl\s+(?:restart|stop|start|reload))\b", "进程/服务操作"),
        ("delete", r"\b(?:rm|rmdir)\s", "删除操作"),
    ]

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
            write: bool, 是否写操作（P1-v5-4：L3 权限下需审批）
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

        write_rules: list[str] = []
        for name, pattern, reason in RiskChecker._WRITE_PATTERNS:
            try:
                if re.search(pattern, command, re.IGNORECASE):
                    write_rules.append(name)
            except re.error:
                logger.exception(f"RiskChecker write regex error: rule={name}")

        if not matched and not write_rules:
            return {
                "high_risk": False,
                "level": "L0",
                "matched_rules": [],
                "reason": "",
                "require_approval": False,
                "write": False,
            }

        return {
            "high_risk": bool(matched),
            "level": "L4" if matched else "L1",
            "matched_rules": matched,
            "reason": "; ".join(reasons),
            "require_approval": bool(matched),
            "write": bool(write_rules),
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

def request_approval_and_wait(
    ctx: ToolContext,
    command: str,
    risk_result: dict[str, Any],
    tool_name: str = "ssh_command",
) -> Any | None:
    """发起审批请求并阻塞等待用户响应（P1-1，真实 HITL 闭环）

    之前的实现只 emit_needs_you 事件 + 返回 needs_approval，前端"批准"
    按钮无 RPC 回传，命令永远不会执行——审批是显示层摆设。
    现在：登记到 needs_you 服务（拿 req_id）→ 发事件（前端可解析）→
    阻塞等待 respond/超时 唤醒 → 返回最终状态请求对象。

    Returns:
        最终状态的 NeedsYouRequest；请求创建失败返回 None
    """
    from needs_you import get_global_service

    service = get_global_service()
    matched = risk_result.get("matched_rules", ["unknown"])
    title = f"高危命令审批请求: {matched[0] if matched else 'unknown'}"
    description = (
        f"Agent {ctx.agent_name} 试图通过工具 {tool_name} 执行高危命令:\n"
        f"  命令: {command[:200]}\n"
        f"  风险等级: {risk_result.get('level', 'L4')}\n"
        f"  原因: {risk_result.get('reason', '')}\n"
        f"  选择「批准」执行、「拒绝」不执行（30s 无响应自动拒绝）"
    )
    try:
        req = service.request_approval(
            title=title,
            description=description,
            session_id=ctx.session_id or None,
            source=f"{ctx.agent_name}_agent.strands_tool.{tool_name}",
            command=command,
            risk=risk_result,
            tool_name=tool_name,
            agent=ctx.agent_name,
        )
    except Exception as e:
        logger.exception(f"request_approval failed: {e}")
        return None

    # 前端审批卡片事件（字段对齐 AgentPanel 解析：type/detail/id）
    if ctx.event_bus is not None:
        try:
            ctx.event_bus.emit_needs_you(
                needs_type="approval",
                title=req.title,
                description=req.description,
                session_id=ctx.session_id or None,
                source=req.source,
                priority="high",
                id=req.id,
                type="approval",
                detail=req.description,
                command=command,
                risk_level=risk_result.get("level", "L4"),
                agent=ctx.agent_name,
                tool_name=tool_name,
            )
        except Exception as e:
            logger.debug(f"emit_needs_you failed: {e}")

    logger.info(
        f"approval requested: id={req.id}, session={ctx.session_id}, "
        f"tool={tool_name}, command={command[:80]}"
    )
    return service.wait_for_response(req.id)


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

    # 1. 风险评估（P1-v5-4: 4 级权限决策）
    #    L1 免确认 / L2 仅高危（默认，原行为）/ L3 高危+写操作 / L4 全部确认
    # P1-1 (2026-08-01): 命中审批 → 真实等待用户响应（approve 执行 /
    #   reject 拒绝 / 超时保持 needs_approval），不再是显示层摆设。
    risk = RiskChecker.check(command)
    permission_level = getattr(ctx, "permission_level", 2)
    needs_approval = permission_needs_approval(risk, permission_level)
    if needs_approval:
        req = request_approval_and_wait(ctx, command, risk, tool_name)
        if req is None:
            return {
                "status": "needs_approval",
                "command": command,
                "ssh_session_id": session_id,
                "risk": risk,
                "message": "审批请求创建失败，未执行",
            }
        from needs_you import NeedsYouStatus

        if req.status == NeedsYouStatus.APPROVED:
            logger.info(
                f"execute_via_ssh approved by user: tool={tool_name}, "
                f"command={command[:80]}"
            )
            # 用户批准 → 继续执行（不再重复检测）
        elif req.status == NeedsYouStatus.REJECTED:
            reason = ""
            if isinstance(req.response, dict):
                reason = str(req.response.get("reason", ""))
            logger.warning(
                f"execute_via_ssh rejected by user: tool={tool_name}, "
                f"command={command[:80]}, reason={reason}"
            )
            _audit_append(
                event="approval",
                decision="rejected",
                tool=tool_name,
                command=command,
                session_id=session_id,
                agent=ctx.agent_name,
                reason=reason,
            )
            return {
                "status": "rejected",
                "command": command,
                "ssh_session_id": session_id,
                "risk": risk,
                "message": f"用户拒绝执行该命令{('（' + reason + '）') if reason else ''}",
            }
        else:  # TIMEOUT / CANCELLED / 未知
            logger.warning(
                f"execute_via_ssh approval not answered: "
                f"status={req.status.value}, tool={tool_name}, command={command[:80]}"
            )
            _audit_append(
                event="approval",
                decision="timeout",
                tool=tool_name,
                command=command,
                session_id=session_id,
                agent=ctx.agent_name,
            )
            return {
                "status": "needs_approval",
                "command": command,
                "ssh_session_id": session_id,
                "risk": risk,
                "message": "审批超时未响应，未执行（可让用户重新触发）",
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
    # TDSF 修复 2026-08-01 (P1-v5-5): 返回前统一脱敏，防止密码/密钥/token
    # 泄漏到前端工具行、LLM 上下文与日志。
    output_text = redact_sensitive(
        result.get("output", "") if isinstance(result, dict) else str(result)
    )
    # P1-3: 命令执行成功入审计链（命令已脱敏）
    _audit_append(
        event="command_executed",
        tool=tool_name,
        command=command,
        session_id=session_id,
        agent=ctx.agent_name,
        exit_code=result.get("exit_code", 0) if isinstance(result, dict) else 0,
    )
    return {
        "status": "success",
        "command": command,
        "ssh_session_id": session_id,
        "output": output_text,
        "exit_code": result.get("exit_code", 0) if isinstance(result, dict) else 0,
        "duration": result.get("duration", 0.0) if isinstance(result, dict) else 0.0,
    }


def _audit_append(**entry: Any) -> None:
    """追加审计记录（敏感字段先脱敏；审计失败不影响主流程）"""
    try:
        from strands_backend.audit_chain import get_global_chain

        entry["command"] = redact_sensitive(str(entry.get("command", "")))
        get_global_chain().append(entry)
    except Exception as e:
        logger.debug(f"audit append failed: {e}")


# ============================================================================
# 输出脱敏（P1-v5-5）
# ============================================================================

# 敏感内容模式 → 替换。保守原则：宁可多脱敏，不可泄漏。
# 覆盖：SSH 私钥块、password/secret/token/api_key 赋值、AWS access key、
# URL 内嵌凭据（://user:pass@）、Authorization Bearer。
_SENSITIVE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            re.DOTALL,
        ),
        "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----",
    ),
    (
        re.compile(
            r"(?i)(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)"
            r"\s*[:=]\s*['\"]?[^\s'\"&|;]+"
        ),
        r"\1=***",
    ),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "AKIA***"),
    # mysql 风格内联密码：-pS3cretPw（-p 后无空格直接跟密码）
    (re.compile(r"(?<!\S)-p\S+"), "-p***"),
    (re.compile(r"(://[^:/\s]+:)[^@/\s]+(@)"), r"\1***\2"),
    (re.compile(r"(?i)(authorization:\s*bearer\s+)\S+"), r"\1***"),
]


def permission_needs_approval(
    risk: dict[str, Any], permission_level: int
) -> bool:
    """4 级权限决策（P1-v5-4）

    L1 免确认 / L2 仅高危（默认）/ L3 高危+写操作 / L4 全部确认。
    execute_via_ssh 与各工具多行检测共用，保证决策一致。
    """
    level = max(1, min(4, int(permission_level)))
    if level >= 4:
        return True
    if risk.get("high_risk"):
        return True
    if level >= 3 and risk.get("write"):
        return True
    return False


def redact_sensitive(text: str) -> str:
    """替换命令输出中的敏感内容（密码/密钥/token 等）

    用于 ssh_command 等工具结果返回前统一脱敏，防止敏感信息
    进入前端工具行 / LLM 上下文 / 日志。
    """
    if not text:
        return text
    for pattern, repl in _SENSITIVE_PATTERNS:
        text = pattern.sub(repl, text)
    return text


# ============================================================================
# 5 个运维工具的工厂函数 + invoke 函数导出
# ============================================================================

# 延迟导入避免循环依赖，提供模块级便捷访问
def _import_tool_functions() -> None:
    """延迟导入 7 个工具的工厂函数 + invoke 函数

    在 __init__.py 末尾调用，确保 from strands_backend.tools import make_ssh_command_tool 可用

    TDSF 修复 2026-07-31 (P4): 新增 skill_invoke 工具导入
    TDSF 修复 2026-07-31 (P4-b): 新增 suggest_command 工具导入
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
    from strands_backend.tools.skill_invoke import (  # noqa: F401
        invoke_skill_tool,
        make_skill_invoke_tool,
    )
    from strands_backend.tools.suggest_command import (  # noqa: F401
        invoke_suggest_command_tool,
        make_suggest_command_tool,
    )


# 工具名注册表（供适配层枚举注册）
# TDSF 修复 2026-07-31 (P4): 新增 skill_invoke 工具
# TDSF 修复 2026-07-31 (P4-b): 新增 suggest_command 工具
OPS_TOOL_NAMES: list[str] = [
    "ssh_command",
    "remote_file",
    "log_analyzer",
    "process_inspector",
    "network_diagnostic",
    "skill_invoke",
    "suggest_command",
]

# P1-v5-2 schema-level safety: L1（免确认）只保留只读工具
# （@tool 装饰后的实际函数名，与 OPS_TOOL_NAMES 的注册名不同）
_L1_READONLY_TOOL_NAMES = {
    "read_remote_file",
    "analyze_logs",
    "inspect_processes",
    "network_diagnose",
    "suggest_command",
}


def make_all_ops_tools(
    ctx: ToolContext,
    tool_names: set[str] | list[str] | None = None,
) -> list:
    """构建全部 7 个工具（5 个运维 + Skill 调用 + 命令建议，带 ctx 闭包）

    TDSF 修复 2026-07-31 (P4): 新增 skill_invoke 工具，让 Strands Agent
    能在 agentic loop 中主动调用已注册的 Skill（linux-ops / docker-management /
    selinux-baseline / ssh-troubleshoot / python-debug），增强领域知识。

    TDSF 修复 2026-07-31 (P4-b): 新增 suggest_command 工具，让 Strands Agent
    能根据用户意图生成可执行的 Linux 命令，并通过前端工具卡片展示 Insert 按钮。

    TDSF 修复 2026-08-01 (P1-v5-2, OPENDEV schema-level safety):
    L1（免确认）权限下，执行/写类工具（ssh_command / skill_invoke）直接从
    registry 移除——LLM 无法调用不存在于 schema 的工具（remove 优于
    instruct+intercept），从根源杜绝免确认模式下执行任意命令。

    TDSF 修复 2026-08-01 (P0-1 多 agent): 新增 tool_names 白名单参数，
    供子 Agent（explore/teach/coding/history）按角色裁剪工具集——
    schema-level safety 在 agent 维度生效（如 explore 无 ssh_command）。

    Args:
        ctx: ToolContext 运行时上下文
        tool_names: @tool 装饰后函数名的白名单（None = 全量，按角色过滤用）

    Returns:
        Strands @tool 装饰后的工具函数列表（Strands 不可用时为 passthrough 装饰）
    """
    from strands_backend.tools.ssh_command import make_ssh_command_tool
    from strands_backend.tools.remote_file import make_remote_file_tool
    from strands_backend.tools.log_analyzer import make_log_analyzer_tool
    from strands_backend.tools.process_inspector import make_process_inspector_tool
    from strands_backend.tools.network_diagnostic import make_network_diagnostic_tool
    from strands_backend.tools.skill_invoke import make_skill_invoke_tool
    from strands_backend.tools.suggest_command import make_suggest_command_tool

    tools = [
        make_ssh_command_tool(ctx),
        make_remote_file_tool(ctx),
        make_log_analyzer_tool(ctx),
        make_process_inspector_tool(ctx),
        make_network_diagnostic_tool(ctx),
        make_skill_invoke_tool(ctx),
        make_suggest_command_tool(ctx),
    ]

    if getattr(ctx, "permission_level", 2) <= 1:
        tools = [
            t for t in tools
            if getattr(t, "__name__", "") in _L1_READONLY_TOOL_NAMES
        ]
    if tool_names is not None:
        allowed = set(tool_names)
        tools = [
            t for t in tools if getattr(t, "__name__", "") in allowed
        ]
    return tools


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
