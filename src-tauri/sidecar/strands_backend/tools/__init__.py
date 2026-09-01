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
# P0-A1/Task 3 (2026-08-29): 三模式信任——ToolContext.mode 供执行链 decide 消费
# （modes.py 零依赖，无环）
from strands_backend.modes import AgentMode, parse_mode  # noqa: F401

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
        send_notification: 单向通知回调，签名 (method: str, params: dict) -> None。
                      供 todo_write / ssh_command(visible) 等工具向前端推送
                      sidecar:update_todos / sidecar:inject_terminal 通知。
                      None 时静默降级（仅 debug 日志）。

    用法：
        # main.py 注入真实回调
        bridge = DefaultRustBridge(
            send_request=main.send_request_to_rust,
            send_notification=main.send_notification,
        )
        # 未注入降级
        bridge = DefaultRustBridge()
    """

    def __init__(
        self,
        send_request: Callable[[str, dict[str, Any]], Any] | None = None,
        send_notification: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self._send_request = send_request
        self._send_notification = send_notification

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

    def send_notification(self, method: str, params: dict[str, Any]) -> None:
        """向前端推送单向通知（JSON-RPC notification，无 id 无响应）

        2026-08-28 审查修复：此前该类只有 ipc_invoke，工具里调用
        send_notification 会 AttributeError 被 except 吞掉（仅 debug 日志），
        导致 update_todos（TodoStrip 双轨）与 inject_terminal（SSH 可见执行）
        两条通知链路静默失效。
        """
        if self._send_notification is None:
            logger.debug(
                f"rust_bridge send_notification unavailable: method={method} (未配置回调)"
            )
            return
        try:
            self._send_notification(method, params)
        except Exception as e:
            # 通知失败不应中断工具主流程，但必须可见（warning 而非 debug）
            logger.warning(f"rust_bridge send_notification failed: method={method}, error={e}")


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
    # Task 3 (2026-08-29): 仅保留 schema 级过滤职责（L1 只读裁剪）+ 缓存 key；
    # 执行链审批决策改由三模式 decide(risk_l, mode) 承担（方案书 v3.1 §3.2）
    permission_level: int = 2
    # Task 3 (2026-08-29): 三模式信任——执行链按 decide(risk_l, ctx.mode) 决策
    # allow/confirm/deny；缺省 confirm（中间态最安全，fail-closed）
    mode: AgentMode = AgentMode.CONFIRM
    # Task 3.3 host 校验: 激活终端会话主机名（前端 live.sshConnection
    # "user@host" 提取 @ 后部分；空 = 不可得 → execute_via_ssh 跳过校验）
    ssh_host: str = ""
    # TDSF 魔改 (2026-08-09): 终端执行模式——True 时 ssh_command 自动设 visible=True
    auto_execute_in_terminal: bool = False
    # T5 (2026-08-31, spec add-agent-loop-closure): 本地工作区路径
    # （live.workspaceRoot 优先，cwd 兜底）——python_run 的 subprocess cwd。
    # 空 = 不可得（python_run fail-closed 拒绝）；SSH 会话下不适用
    # （python_run 拒绝在远端执行）
    workspace: str = ""


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
# 执行链决策（Task 3 / Task 4 接入：影响预测 + RiskChecker + 三模式 decide）
# ============================================================================

def assess_command(
    ctx: ToolContext,
    command: str,
    readonly: bool = False,
) -> dict[str, Any]:
    """综合评估一条命令并产出三模式决策（Task 4 + Task 3 + Task 5 接入点）

    组合信号源与评估顺序（方案书 v3.1 §4.5-4.6 免确认记忆三级）：
    1. command_impact.analyze —— 影响预测（类别/对象/max_risk_l/denylist/
       危险构造），失败降级 None（不阻塞主流程，风险兜底走 RiskChecker）
    2. RiskChecker.check —— 高危/写操作快速拦截（legacy 信号，参与取 max）
    3. denylist 硬底线（impact.denied）→ blocked——永远最高优先，
       任何白名单/模式不可绕（spec「deny 硬底线」）
    4. 免确认记忆三级（Task 5，trust_store）：
       a. 白名单 deny 命中 → blocked；b. 白名单 allow 命中（无危险构造、
       risk_l<=3、非 observe）→ allow；c. 会话级免审命中（⚡只读免审
       risk_l<=1 / 前缀免批 risk_l<=3）→ allow；d. 白名单 ask 命中 →
       强制逐条审批（覆盖 decide 的 allow）
    5. core.decision_engine.decide —— 模式 × 风险映射（observe=全 deny /
       confirm=L0-L1 allow、L2-L4 confirm / auto=L0-L2 allow、L3-L4 confirm）；
       decide 抛 ValueError（非法输入）时 fail-closed 按 deny 处理
    6. observe 只读短路（readonly=True 时 L0-L1 放行）

    安全不变量：危险构造（$()/eval/管道到 shell → dangerous_construct=True）
    与 L4 命令永不自动放行（无任何模式/白名单可绕）；observe 模式跳过
    白名单 allow 与会话级免审（只读观察语义不被记忆体系扩大）。

    Args:
        ctx: 工具上下文（读 mode / session_id）
        command: 待执行命令
        readonly: 调用工具是否只读（registry policy.readonly=True 的工具传
            True）——observe 模式下 L0-L1 只读命令短路放行（方案书 §3.2
            「只读类由调用方按 ToolPolicy.readonly 先行短路」）

    Returns:
        dict:
            decision: "allow" | "confirm" | "deny" | "blocked"
              （blocked = denylist 硬底线 / 白名单 deny 命中，直接拦截不审批）
            risk_l: int 0-4（综合 risk level，decide 的输入）
            impact: dict | None（command_impact.analyze 产出）
            risk: dict（RiskChecker.check 产出）
            reason: str（deny/blocked 时的拦截原因）
            trust_source: str（自动放行来源："whitelist" / "session_readonly" /
              "session_prefix"；走 decide 正常决策时无此字段）
    """
    # 1. 影响预测（Task 4）——失败降级 None
    impact: dict[str, Any] | None = None
    try:
        from strands_backend.tools.command_impact import analyze as analyze_impact

        impact = analyze_impact(command)
    except Exception as e:  # noqa: BLE001 — 预测失败不阻塞，风险兜底走 RiskChecker
        logger.warning(f"command impact analyze failed, fallback to RiskChecker only: {e}")

    # 2. RiskChecker 高危检测（legacy 信号，与影响预测取 max）
    risk = RiskChecker.check(command)

    def _risk_token_level(token: str) -> int:
        try:
            return int(token[1:])
        except (ValueError, TypeError, IndexError):
            return 4 if token == "L4" else 0

    risk_l = _risk_token_level(str(risk.get("level", "L0")))
    if impact is not None:
        try:
            risk_l = max(risk_l, int(impact.get("max_risk_l", 0)))
        except (TypeError, ValueError):
            risk_l = max(risk_l, 3)  # 非法 max_risk_l → 保守偏高
    if risk.get("high_risk"):
        risk_l = max(risk_l, 4)

    # 3. denylist 硬底线（Task 4）→ blocked：直接拦截不审批、无替代方案
    #    （永远最高优先——任何白名单/模式不可绕，Task 5 单测锁定）
    if impact is not None and impact.get("denied"):
        deny_reason = ""
        for seg in impact.get("segments", []):
            if seg.get("denied"):
                deny_reason = str(seg.get("deny_reason", ""))
                break
        return {
            "decision": "blocked",
            "risk_l": 4,
            "impact": impact,
            "risk": risk,
            "reason": deny_reason or "命中硬底线黑名单",
        }

    # 3.5 免确认记忆三级（Task 5，方案书 v3.1 §4.5-4.6）——在 decide 之前：
    #     ① 白名单 deny 命中 → blocked（用户显式 deny 规则，直接拦截不审批）
    #     ② 白名单 allow 命中（无危险构造、risk_l<=3、非 observe）→ allow
    #     ③ 会话级免审命中（⚡只读免审 risk_l<=1 / 前缀免批 risk_l<=3）→ allow
    #     ④ 白名单 ask 命中 → 强制逐条审批（覆盖 decide 的 allow）
    #     安全不变量：危险构造（dangerous_construct）与 L4 永不自动放行；
    #     observe 模式跳过一切自动放行（fail-closed）；impact 解析失败
    #     （dangerous 不可判）时同样不放行。
    force_confirm = False
    try:
        from strands_backend.trust_store import (
            DECISION_ASK,
            DECISION_DENY,
            get_global_trust_store,
            get_global_whitelist,
        )

        wl_decision = get_global_whitelist().match_command(command)
        if wl_decision == DECISION_DENY:
            logger.info(
                f"assess_command whitelist deny hit: command={command[:80]}"
            )
            return {
                "decision": "blocked",
                "risk_l": risk_l,
                "impact": impact,
                "risk": risk,
                "reason": "命中项目白名单 deny 规则",
            }
        if wl_decision == DECISION_ASK:
            force_confirm = True

        dangerous = bool(impact.get("dangerous_construct")) if impact else True
        mode_value = getattr(ctx.mode, "value", str(ctx.mode))
        observe = mode_value == "observe"
        if wl_decision == "allow" and not dangerous and not observe and risk_l <= 3:
            logger.info(
                f"assess_command whitelist allow hit: command={command[:80]}"
            )
            return {
                "decision": "allow",
                "risk_l": risk_l,
                "impact": impact,
                "risk": risk,
                "reason": "",
                "trust_source": "whitelist",
            }

        if not dangerous and not observe:
            trust = get_global_trust_store()
            sid = ctx.session_id
            if risk_l <= 1 and trust.is_session_trusted(sid):
                logger.info(
                    f"assess_command session readonly-trust hit: "
                    f"session={sid}, command={command[:80]}"
                )
                return {
                    "decision": "allow",
                    "risk_l": risk_l,
                    "impact": impact,
                    "risk": risk,
                    "reason": "",
                    "trust_source": "session_readonly",
                }
            if risk_l <= 3 and trust.is_prefix_allowed(sid, command):
                logger.info(
                    f"assess_command session prefix-trust hit: "
                    f"session={sid}, command={command[:80]}"
                )
                return {
                    "decision": "allow",
                    "risk_l": risk_l,
                    "impact": impact,
                    "risk": risk,
                    "reason": "",
                    "trust_source": "session_prefix",
                }
    except Exception as e:  # noqa: BLE001 — 记忆体系不可用时退回纯模式决策
        logger.warning(f"trust evaluation unavailable, fallback to decide: {e}")
        force_confirm = False

    # 4. 三模式决策（Task 3）——ValueError fail-closed 按 deny
    try:
        from core.decision_engine import decide as mode_decide

        decision = mode_decide(risk_l, ctx.mode)
    except ValueError as e:
        logger.warning(f"decide invalid input, fail-closed to deny: {e}")
        decision = "deny"
    except Exception as e:  # noqa: BLE001 — 决策引擎不可用也 fail-closed
        logger.warning(f"decide unavailable, fail-closed to deny: {e}")
        decision = "deny"

    # 4.5 白名单 ask 命中 → 强制逐条审批（spec：ask = 每次询问，
    #     覆盖 decide 的 allow；deny/blocked 结果维持原样）
    if force_confirm and decision == "allow":
        decision = "confirm"

    # 5. observe 只读短路（方案书 §3.2：只读类由调用方按 ToolPolicy.readonly
    #    先行短路放行）——仅放行 L0-L1，L2+ 仍 deny（fail-closed）
    if readonly and decision == "deny" and risk_l <= 1:
        decision = "allow"

    reason = ""
    if decision == "deny":
        mode_value = getattr(ctx.mode, "value", str(ctx.mode))
        reason = f"当前模式为 {mode_value}（只读观察），禁止执行任何命令" \
            if mode_value == "observe" else \
            f"当前模式 {mode_value} 下风险等级 L{risk_l} 被禁止执行"

    return {
        "decision": decision,
        "risk_l": risk_l,
        "impact": impact,
        "risk": risk,
        "reason": reason,
    }


def _semantic_from_impact(impact: dict[str, Any] | None) -> str:
    """从影响预测生成动作语义描述（审批卡第 1 层）：想{类别中文}：{对象}"""
    if not impact:
        return ""
    for seg in impact.get("segments", []):
        if seg.get("denied"):
            return f"想执行被禁止的危险操作：{seg.get('deny_reason', '')}"
    for seg in impact.get("segments", []):
        if seg.get("category") != "readonly":
            objs = "、".join(seg.get("objects", [])[:3])
            label = seg.get("category_label", "")
            return f"想{label}：{objs}" if objs else f"想{label}"
    segs = impact.get("segments", [])
    if segs:
        return f"想只读查询：{segs[0].get('command', '')[:60]}"
    return ""


def request_approval_and_wait(
    ctx: ToolContext,
    command: str,
    risk_result: dict[str, Any],
    tool_name: str = "ssh_command",
    explanation: str = "",
    impact: dict[str, Any] | None = None,
    risk_l: int | None = None,
) -> Any | None:
    """发起审批请求并阻塞等待用户响应（P1-1，真实 HITL 闭环）

    Task 3.1: 载荷扩展四层卡面字段（semantic / explanation / impact / risk_l），
    经 request.extra 与 emit_needs_you 事件双通道透传前端。
    Task 3.3: 超时由 needs_you 服务统一管理（默认 300s，超时 TIMEOUT 状态）。

    之前的实现只 emit_needs_you 事件 + 返回 needs_approval，前端"批准"
    按钮无 RPC 回传，命令永远不会执行——审批是显示层摆设。
    现在：登记到 needs_you 服务（拿 req_id）→ 发事件（前端可解析）→
    阻塞等待 respond/超时 唤醒 → 返回最终状态请求对象。

    Args:
        ctx: 工具上下文
        command: 命令原文（审批卡第 2 层，前端代码块渲染，永不改写）
        risk_result: RiskChecker.check 产出
        tool_name: 触发工具名
        explanation: LLM 用途解释（审批卡第 3 层，可空）
        impact: command_impact.analyze 产出（审批卡第 4 层影响预测，可 None）
        risk_l: 综合 0-4 风险级（色带 + 会话免审按钮显隐；None 时从 risk_result 推）

    Returns:
        最终状态的 NeedsYouRequest；请求创建失败返回 None
    """
    from needs_you import get_global_service

    service = get_global_service()
    matched = risk_result.get("matched_rules", ["unknown"])
    title = f"高危命令审批请求: {matched[0] if matched else 'unknown'}"
    if risk_l is None:
        try:
            risk_l = int(str(risk_result.get("level", "L4"))[1:])
        except (ValueError, TypeError, IndexError):
            risk_l = 4
    semantic = _semantic_from_impact(impact)
    desc_lines = [
        f"Agent {ctx.agent_name} 试图通过工具 {tool_name} 执行命令:",
    ]
    if semantic:
        desc_lines.append(f"  意图: {semantic}")
    desc_lines.append(f"  命令: {command[:200]}")
    desc_lines.append(f"  风险等级: L{risk_l}")
    if impact:
        desc_lines.append(f"  影响: {impact.get('summary', '')}")
    if risk_result.get("reason"):
        desc_lines.append(f"  原因: {risk_result.get('reason', '')}")
    desc_lines.append("  选择「执行」放行、「拒绝」终止（5 分钟无响应按拒绝处理）")
    description = "\n".join(desc_lines)
    try:
        req = service.request_approval(
            title=title,
            description=description,
            session_id=ctx.session_id or None,
            source=f"{ctx.agent_name}_agent.strands_tool.{tool_name}",
            # Task 3.1 四层卡面字段（前端 tool.tsx 审批卡消费）
            command=command,
            semantic=semantic or None,
            explanation=explanation or None,
            impact=impact,
            risk_l=risk_l,
            risk=risk_result,
            tool_name=tool_name,
            agent=ctx.agent_name,
        )
    except Exception as e:
        logger.exception(f"request_approval failed: {e}")
        return None

    # 前端审批卡片事件（字段对齐 AgentPanel 解析：type/detail/id；Task 3.1
    # 四层字段随事件同步透传，前端可走事件或 request.extra 任一通道）
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
                semantic=semantic or None,
                explanation=explanation or None,
                impact=impact,
                risk_level=f"L{risk_l}",
                risk_l=risk_l,
                agent=ctx.agent_name,
                tool_name=tool_name,
            )
        except Exception as e:
            logger.debug(f"emit_needs_you failed: {e}")

    logger.info(
        f"approval requested: id={req.id}, session={ctx.session_id}, "
        f"tool={tool_name}, risk_l={risk_l}, command={command[:80]}"
    )
    return service.wait_for_response(req.id)


def execute_via_ssh(
    ctx: ToolContext,
    command: str,
    ssh_session_id: str = "",
    timeout: int = 30,
    tool_name: str = "ssh_command",
    explanation: str = "",
    readonly: bool = False,
    skip_approval: bool = False,
) -> dict[str, Any]:
    """通过 RustBridge 调用 Rust 后端执行 SSH 命令

    内部流程（Task 3 / Task 4 接入后）：
    1. 解析 ssh_session_id（优先参数，其次 ctx 默认）
    2. assess_command 综合决策（影响预测 + RiskChecker + 三模式 decide）：
       - blocked（denylist 硬底线命中）→ command_blocked（不审批、禁替代方案）
       - deny（observe 模式 / fail-closed）→ command_blocked
       - confirm → needs_you 审批（approve 执行 / reject 拒绝附言透传 /
         timeout 按拒绝处理）
    3. host 校验（Task 3.3）：目标会话 != 激活终端会话 → 拦截
    4. RustBridge.ipc_invoke("ssh_command", {...}) 调 Rust 后端
       - rust_bridge 未配置：返回 unavailable 状态（不抛错）
       - rust_bridge 调用异常：返回 error 状态
    5. 返回结构化 dict

    Args:
        ctx: ToolContext 运行时上下文
        command: 待执行的 shell 命令
        ssh_session_id: SSH 会话 ID（空则用 ctx.ssh_session_id）
        timeout: 超时秒数（默认 30）
        tool_name: 调用方工具名（用于事件 source 标识）
        explanation: LLM 用途解释（审批卡第 3 层透传，可空）
        readonly: 调用工具是否只读（registry policy.readonly=True 的工具传
            True）——observe 模式下 L0-L1 只读命令短路放行
        skip_approval: 跳过 confirm 审批（多行命令已整条审批通过时由
            ssh_command 传 True；denylist/observe 拦截不受此参数影响）

    Returns:
        dict:
            status: "success" | "command_blocked" | "rejected" |
                    "needs_approval" | "unavailable" | "error"
            command: 原命令
            ssh_session_id: 使用的会话 ID
            output: 命令输出（success 时）
            exit_code: 退出码（success 时）
            duration: 执行耗时秒（success 时）
            risk / impact: 风险评估与影响预测（拦截/审批时）
            message: 状态说明（含 command_blocked! 关键字）
            error: 错误信息（error 时）
    """
    session_id = ssh_session_id or ctx.ssh_session_id

    # 1. 综合决策（Task 4 影响预测 + Task 3 三模式 decide；denylist 命中
    #    返回 blocked——fail-closed，直接拦截不审批、禁替代方案）
    assessment = assess_command(ctx, command, readonly=readonly)
    decision = assessment["decision"]
    risk = assessment["risk"]
    impact = assessment["impact"]
    risk_l = assessment["risk_l"]

    def _blocked(message: str) -> dict[str, Any]:
        # Task 3.2 双轨反馈之「引擎拦截」轨：tool_result 含 command_blocked!
        # 关键字，系统提示词（adapter 模式指令段）已有如实报告约束——
        # 拦截类反馈禁替代方案（agent 只能如实报告未执行）。
        _audit_append(
            event="command_blocked",
            decision=decision,
            tool=tool_name,
            command=command,
            session_id=session_id,
            agent=ctx.agent_name,
            reason=assessment.get("reason", ""),
        )
        _track_evidence(
            session_id=ctx.session_id,
            tool_name=tool_name,
            status="blocked",
            detail=command,
            result={"message": message},
            agent=ctx.agent_name,
            source="strands_tool",
        )
        return {
            "status": "command_blocked",
            "command": command,
            "ssh_session_id": session_id,
            "risk": risk,
            "impact": impact,
            "message": message,
        }

    if decision == "blocked":
        logger.warning(
            f"execute_via_ssh denylist hit: tool={tool_name}, "
            f"command={command[:80]}, reason={assessment.get('reason', '')}"
        )
        return _blocked(
            f"command_blocked! 只读模式或安全规则禁止执行："
            f"{assessment.get('reason', '命中硬底线黑名单')}。"
            f"该命令已被拦截，不会执行，也不提供替代方案。"
        )
    if decision == "deny":
        logger.warning(
            f"execute_via_ssh denied by mode: tool={tool_name}, mode={ctx.mode}, "
            f"risk_l={risk_l}, command={command[:80]}"
        )
        return _blocked(
            f"command_blocked! 只读模式或安全规则禁止执行：{assessment['reason']}。"
            f"该命令未执行。"
        )

    # 2. confirm → needs_you 审批（真实 HITL 闭环；skip_approval 时跳过——
    #    多行命令已整条审批通过）
    if decision == "confirm" and not skip_approval:
        req = request_approval_and_wait(
            ctx, command, risk, tool_name,
            explanation=explanation,
            impact=impact,
            risk_l=risk_l,
        )
        if req is None:
            return {
                "status": "needs_approval",
                "command": command,
                "ssh_session_id": session_id,
                "risk": risk,
                "impact": impact,
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
            # Task 3.2 双轨反馈之「用户拒绝」轨：agent 收到规范文案 + 用户附言，
            # 供 agent 给替代方案（如实报告未执行，不编造结果）
            reason = ""
            if isinstance(req.response, dict):
                reason = str(req.response.get("reason", "") or "")
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
                "impact": impact,
                "message": (
                    f"用户拒绝了此操作。"
                    + (f"用户附言：{reason}" if reason else "")
                ),
            }
        else:  # TIMEOUT / CANCELLED / 未知 —— fail-closed 按拒绝处理
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
                "impact": impact,
                "message": "审批超时（5 分钟无响应），按拒绝处理，未执行。"
                           "如仍需执行请重新发起并等待用户审批。",
            }

    # 3. 会话校验（Task 3.3 → P2 #42 放宽，2026-09-01）：
    #    原规则：目标会话必须 == 激活终端会话（ctx.ssh_session_id）。
    #    放宽后（多主机运维）：目标会话只要是 Rust SshState 里**真实存在且
    #    state=connected** 的会话即放行——校验依据是 ipc_invoke("ssh_status")
    #    返回的 live 列表（权威数据源），不信任 LLM 传入的 session_id。
    #    威胁模型（勿破坏）：
    #    - deny 硬底线 / 审批链 / observe 裁剪均在此前的第 1-2 步，不受影响；
    #    - 仅放行 connected；reconnecting/failed/idle/closed 一律拦截；
    #    - live 列表查询失败 / 结构不可识别 → 回退下方旧严格校验
    #      （fail-closed 方向：只可能收紧、不会额外放宽）；
    #    - 放行时记录 target_endpoint（user@host:port），审计与结果可追溯。
    target_endpoint = ""
    live_checked = False
    target_id_str = str(ssh_session_id or "")
    if ctx.rust_bridge is not None and target_id_str.isdigit():
        try:
            # 函数级导入防循环依赖（ssh_sessions 不反向依赖本模块的运行时符号）
            from strands_backend.tools.ssh_sessions import (
                parse_live_sessions,
                session_endpoint,
            )

            resp = ctx.rust_bridge.ipc_invoke("ssh_status", {})
            live_sessions = parse_live_sessions(resp)
        except Exception as e:  # noqa: BLE001 — 查询失败走回退，不阻断
            logger.warning(f"execute_via_ssh live session query failed: {e}")
            live_sessions = None
        if live_sessions is not None:
            live_checked = True
            target = next(
                (s for s in live_sessions if s["session_id"] == int(target_id_str)),
                None,
            )
            if target is None or target["state"] != "connected":
                state_desc = target["state"] if target else "不存在"
                logger.warning(
                    f"execute_via_ssh target session not connected: "
                    f"target={ssh_session_id} ({state_desc}), tool={tool_name}"
                )
                _audit_append(
                    event="command_blocked",
                    decision="target_session_not_connected",
                    tool=tool_name,
                    command=command,
                    session_id=session_id,
                    agent=ctx.agent_name,
                    reason=f"target session {ssh_session_id} state={state_desc}",
                )
                return {
                    "status": "command_blocked",
                    "command": command,
                    "ssh_session_id": session_id,
                    "risk": risk,
                    "impact": impact,
                    "message": (
                        f"command_blocked! 目标会话 {ssh_session_id} 当前不可操作"
                        f"（state={state_desc}）。请先用 ssh_list_sessions 确认 "
                        f"state=connected 的会话，再对该会话执行命令。"
                    ),
                }
            target_endpoint = session_endpoint(target)
        # live_sessions is None（查询失败/不可识别）→ 落入下方旧严格校验
    if not live_checked:
        # 旧严格校验（Task 3.3 原逻辑，保留作回退）：目标会话必须 == 激活
        # 终端会话。数据源：ctx.ssh_host（前端 live.sshConnection "user@host"
        # 提取）。若激活终端 host 不可得（ctx.ssh_host 为空，如旧前端未下发
        # 或本地模式）→ 跳过校验（fail-open 仅此一处，其余门禁仍生效）。
        ssh_host = getattr(ctx, "ssh_host", "") or ""
        if ssh_host and ssh_session_id and ctx.ssh_session_id:
            try:
                if int(ssh_session_id) != int(ctx.ssh_session_id):
                    logger.warning(
                        f"execute_via_ssh host mismatch: target={ssh_session_id}, "
                        f"active={ctx.ssh_session_id} ({ssh_host}), tool={tool_name}"
                    )
                    _audit_append(
                        event="command_blocked",
                        decision="host_mismatch",
                        tool=tool_name,
                        command=command,
                        session_id=session_id,
                        agent=ctx.agent_name,
                        reason=f"target session {ssh_session_id} != active {ctx.ssh_session_id}",
                    )
                    return {
                        "status": "command_blocked",
                        "command": command,
                        "ssh_session_id": session_id,
                        "risk": risk,
                        "impact": impact,
                        "message": (
                            f"command_blocked! 只读模式或安全规则禁止执行："
                            f"host 校验失败——目标会话 {ssh_session_id} 不是当前激活"
                            f"终端的会话。请在 {ssh_host} 对应的终端窗口执行。"
                        ),
                    }
            except (ValueError, TypeError):
                # 会话 id 非 int-convertible：交给下方 invalid session_id 路径
                pass

    # 4. 检查 RustBridge 配置
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

    # 5. 通过 RustBridge 调 Rust 后端
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
        # P2 #42: 多主机场景记录实际目标端点（live 列表校验放行时有值）
        target_endpoint=target_endpoint,
    )
    # P1-2: 记录会话证据（前端证据面板展示 AI 依据的真实操作）
    # 注意：证据归属**对话会话**（ctx.session_id），不是 SSH 会话 id
    _track_evidence(
        session_id=ctx.session_id,
        tool_name=tool_name,
        status="completed",
        detail=command,
        result=result,
        agent=ctx.agent_name,
        source="strands_tool",
    )
    return {
        "status": "success",
        "command": command,
        "ssh_session_id": session_id,
        # P2 #42: 实际目标端点 user@host:port（live 校验放行时有值，
        # 旧严格校验路径为空串）——执行错主机时 LLM/用户可直接看到
        "target_endpoint": target_endpoint,
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


def _track_evidence(
    session_id: str,
    tool_name: str,
    status: str,
    detail: str = "",
    result: Any = None,
    agent: str = "main",
    source: str = "",
) -> None:
    """记录会话证据（P1-2；失败不影响主流程）"""
    try:
        from strands_backend.evidence import get_global_tracker

        get_global_tracker().record(
            session_id=session_id,
            tool_name=tool_name,
            status=status,
            detail=detail,
            result=result,
            agent=agent,
            source=source,
        )
    except Exception as e:
        logger.debug(f"evidence record failed: {e}")


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


# 工具名注册表（供适配层枚举注册；显示名，与 @tool 函数名可能不同）
# T2 (2026-08-28): 改由 TOOL_REGISTRY 单一真源派生——新增工具只改 registry.py，
# 这里自动跟随。显示名映射见 registry.OPS_TOOL_ALIASES。
from strands_backend.tools.registry import (  # noqa: F401
    APPROVAL_TOOL_NAMES,
    OPS_TOOL_ALIASES,
    READONLY_TOOL_NAMES,
    TOOL_REGISTRY,
    VERIFY_CLASS_TOOL_NAMES,
    WRITE_CLASS_TOOL_NAMES,
    get_tool_policy,
    tool_catalog_text,
)

OPS_TOOL_NAMES: list[str] = [
    OPS_TOOL_ALIASES.get(spec.name, spec.name) for spec in TOOL_REGISTRY.values()
]


def filter_tools_readonly(tools: list) -> list:
    """按 TOOL_REGISTRY 只读白名单过滤工具（schema-level safety 帮助函数）

    P0-A1 (2026-08-29, 方案书 v3.1 三模式): 从 L1（免确认）专用过滤泛化——
    L1 权限与观察模式（AgentMode.OBSERVE）统一消费本函数，单一真源为
    READONLY_TOOL_NAMES（registry 派生）。非注册工具（如 extra_tools 中
    未注册项）不在白名单内会被裁掉（fail-closed）。

    Args:
        tools: @tool 装饰后的工具函数列表

    Returns:
        仅含 policy.readonly=True 注册工具的列表
    """
    return [
        t for t in tools
        if getattr(t, "__name__", "") in READONLY_TOOL_NAMES
    ]


def make_all_ops_tools(
    ctx: ToolContext,
    tool_names: set[str] | list[str] | None = None,
) -> list:
    """构建全部已注册工具（TOOL_REGISTRY 单一真源，带 ctx 闭包）

    T2 (2026-08-28, 方案书 v3.0 工具三角色解耦): 不再硬编码工厂列表，
    改为遍历 TOOL_REGISTRY 按点路径延迟解析工厂——实现/Policy/Schema
    三角色统一在 registry.py 维护，新增工具零改动本函数。

    历史行为保持：
    - P1-v5-2 schema-level safety: L1（免确认）权限下仅保留 readonly=True
      的工具（READONLY_TOOL_NAMES，registry 派生；原 _L1_READONLY_TOOL_NAMES
      硬编码已删除）。执行/写类工具从 schema 移除——LLM 无法调用不存在于
      schema 的工具（remove 优于 instruct+intercept）。
      注意：2026-08-09 的 6 个增强工具原在 adapter 绕过此过滤直挂，T2
      收编后统一受管辖（backup_restore 在 L1 下被裁——fail-closed 收紧）。
    - P0-1 多 agent: tool_names 白名单参数，供子 Agent 按角色裁剪工具集。
    - 容错：单个工具工厂解析/构建失败仅 warning 跳过，不拖垮整体
      （对齐原 adapter 逐个 try 挂载的容错语义）。

    Args:
        ctx: ToolContext 运行时上下文
        tool_names: @tool 装饰后函数名的白名单（None = 全量，按角色过滤用）

    Returns:
        Strands @tool 装饰后的工具函数列表（Strands 不可用时为 passthrough 装饰）
    """
    from strands_backend.tools.registry import resolve_factory

    tools: list = []
    for spec in TOOL_REGISTRY.values():
        try:
            factory = resolve_factory(spec)
            tools.append(factory(ctx))
        except Exception as e:  # noqa: BLE001 — 单工具失败不阻断其余工具构建
            logger.warning(f"tool '{spec.name}' build failed, skipped: {e}")

    if getattr(ctx, "permission_level", 2) <= 1:
        tools = filter_tools_readonly(tools)
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
    "assess_command",
    "execute_via_ssh",
    "filter_tools_readonly",
    # 工具注册（T2: TOOL_REGISTRY 单一真源 + 派生集合）
    "OPS_TOOL_NAMES",
    "TOOL_REGISTRY",
    "READONLY_TOOL_NAMES",
    "APPROVAL_TOOL_NAMES",
    # T7 (2026-08-31): 验证回环写类/验证类分类
    "WRITE_CLASS_TOOL_NAMES",
    "VERIFY_CLASS_TOOL_NAMES",
    "get_tool_policy",
    "tool_catalog_text",
    "make_all_ops_tools",
]
