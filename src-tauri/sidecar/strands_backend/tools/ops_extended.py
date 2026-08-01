"""
strands_backend/tools/ops_extended.py — 扩展运维工具（P2-3，方案书 §4.3）
==========================================================================

新增 5 个运维工具（7 → 12），全部复用 execute_via_ssh（统一风险检测 +
4 级权限审批 + 脱敏 + 审计）：

1. service_manage     — systemctl 服务管理（status/start/stop/restart/reload/enable/disable）
2. package_manage     — 包管理（install/remove/search/update）
3. firewall_manage    — 防火墙（status/list/add_port/remove_port）
4. security_audit     — 只读安全审计（ssh 配置/权限/开放端口）
5. performance_analyze— 只读性能分析（cpu/内存/磁盘/负载）

写操作（start/stop/restart/install/remove/add_port 等）由 execute_via_ssh
自动检测（_WRITE_PATTERNS）→ 按权限级别审批；只读工具（security_audit/
performance_analyze）直接执行。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, execute_via_ssh, tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_extended")

# ============================================================================
# 1. service_manage — systemctl 服务管理
# ============================================================================

_SERVICE_ACTIONS: dict[str, str] = {
    "status": "systemctl status {svc} --no-pager -l",
    "start": "systemctl start {svc}",
    "stop": "systemctl stop {svc}",
    "restart": "systemctl restart {svc}",
    "reload": "systemctl reload {svc}",
    "enable": "systemctl enable {svc}",
    "disable": "systemctl disable {svc}",
}

def invoke_service_manage_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    action = (params.get("action") or "").strip().lower()
    service = (params.get("service") or "").strip()
    if action not in _SERVICE_ACTIONS:
        return {
            "status": "error",
            "message": f"action 必须为 {list(_SERVICE_ACTIONS.keys())} 之一",
        }
    if not service:
        return {"status": "error", "message": "service 参数缺失"}
    command = _SERVICE_ACTIONS[action].format(svc=service)
    return execute_via_ssh(
        ctx=ctx,
        command=command,
        ssh_session_id=params.get("ssh_session_id", "") or "",
        timeout=int(params.get("timeout", 30)),
        tool_name="service_manage",
    )

def make_service_manage_tool(ctx: ToolContext):
    @tool
    def service_manage(action: str, service: str, ssh_session_id: str = "", timeout: int = 30) -> dict:
        """管理 systemd 服务（状态/启停/重载/开机自启）。

        写操作（start/stop/restart/enable/disable）按权限级别触发审批。
        适合"重启 nginx 服务""查看 mysql 状态"等请求。

        Args:
            action (str): status/start/stop/restart/reload/enable/disable。
            service (str): 服务名（如 nginx / mysql / php-fpm）。
            ssh_session_id (str): SSH 会话 ID，空则用上下文默认。
            timeout (int): 超时秒数，默认 30。

        Returns:
            dict: 含 status / command / output / exit_code。
        """
        return invoke_service_manage_tool(
            params={
                "action": action,
                "service": service,
                "ssh_session_id": ssh_session_id,
                "timeout": timeout,
            },
            ctx=ctx,
        )

    service_manage.__name__ = "service_manage"
    return service_manage


# ============================================================================
# 2. package_manage — 包管理
# ============================================================================

_PACKAGE_ACTIONS: dict[str, str] = {
    "install": "{pm} install -y {pkg}",
    "remove": "{pm} remove -y {pkg}",
    "search": "{pm} search {pkg}",
    "update": "{pm} update",
    "list_installed": "{pm} list installed",
}

def invoke_package_manage_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    action = (params.get("action") or "").strip().lower()
    package = (params.get("package") or "").strip()
    pm = (params.get("package_manager") or "").strip().lower() or "dnf"
    if action not in _PACKAGE_ACTIONS:
        return {
            "status": "error",
            "message": f"action 必须为 {list(_PACKAGE_ACTIONS.keys())} 之一",
        }
    if pm not in ("dnf", "yum", "apt", "apt-get"):
        return {"status": "error", "message": "package_manager 支持 dnf/yum/apt"}
    command = _PACKAGE_ACTIONS[action].format(pm=pm, pkg=package or "")
    return execute_via_ssh(
        ctx=ctx,
        command=command,
        ssh_session_id=params.get("ssh_session_id", "") or "",
        timeout=int(params.get("timeout", 120)),
        tool_name="package_manage",
    )

def make_package_manage_tool(ctx: ToolContext):
    @tool
    def package_manage(action: str, package: str = "", package_manager: str = "dnf", ssh_session_id: str = "", timeout: int = 120) -> dict:
        """管理软件包（安装/卸载/搜索/更新）。

        安装/卸载为写操作，按权限级别触发审批。适合"安装 nginx""查看
        已装包"等请求。

        Args:
            action (str): install/remove/search/update/list_installed。
            package (str): 包名（search/install/remove 需要）。
            package_manager (str): dnf/yum/apt（默认 dnf，适配 CentOS/RHEL）。
            ssh_session_id (str): SSH 会话 ID。
            timeout (int): 超时秒数，默认 120（包操作较慢）。

        Returns:
            dict: 含 status / command / output / exit_code。
        """
        return invoke_package_manage_tool(
            params={
                "action": action,
                "package": package,
                "package_manager": package_manager,
                "ssh_session_id": ssh_session_id,
                "timeout": timeout,
            },
            ctx=ctx,
        )

    package_manage.__name__ = "package_manage"
    return package_manage


# ============================================================================
# 3. firewall_manage — 防火墙管理
# ============================================================================

_FIREWALL_ACTIONS: dict[str, str] = {
    "status": "firewall-cmd --state",
    "list": "firewall-cmd --list-all",
    "add_port": "firewall-cmd --permanent --add-port={port}/tcp && firewall-cmd --reload",
    "remove_port": "firewall-cmd --permanent --remove-port={port}/tcp && firewall-cmd --reload",
    "add_service": "firewall-cmd --permanent --add-service={svc} && firewall-cmd --reload",
    "remove_service": "firewall-cmd --permanent --remove-service={svc} && firewall-cmd --reload",
}

def invoke_firewall_manage_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    action = (params.get("action") or "").strip().lower()
    port = (params.get("port") or "").strip()
    service = (params.get("service") or "").strip()
    if action not in _FIREWALL_ACTIONS:
        return {
            "status": "error",
            "message": f"action 必须为 {list(_FIREWALL_ACTIONS.keys())} 之一",
        }
    command = _FIREWALL_ACTIONS[action]
    if "{port}" in command:
        if not port.isdigit() or not (1 <= int(port) <= 65535):
            return {"status": "error", "message": "port 必须为 1-65535 的数字"}
        command = command.format(port=port)
    elif "{svc}" in command:
        if not service:
            return {"status": "error", "message": "service 参数缺失"}
        command = command.format(svc=service)
    return execute_via_ssh(
        ctx=ctx,
        command=command,
        ssh_session_id=params.get("ssh_session_id", "") or "",
        timeout=int(params.get("timeout", 30)),
        tool_name="firewall_manage",
    )

def make_firewall_manage_tool(ctx: ToolContext):
    @tool
    def firewall_manage(action: str, port: str = "", service: str = "", ssh_session_id: str = "", timeout: int = 30) -> dict:
        """管理 firewalld 防火墙（状态/规则/放行端口与服务）。

        增删规则为写操作，按权限级别触发审批。适合"放行 8080 端口"
        "查看防火墙规则"等请求。

        Args:
            action (str): status/list/add_port/remove_port/add_service/remove_service。
            port (str): 端口号（add_port/remove_port 需要，1-65535）。
            service (str): 服务名（add_service/remove_service 需要）。
            ssh_session_id (str): SSH 会话 ID。
            timeout (int): 超时秒数，默认 30。

        Returns:
            dict: 含 status / command / output / exit_code。
        """
        return invoke_firewall_manage_tool(
            params={
                "action": action,
                "port": port,
                "service": service,
                "ssh_session_id": ssh_session_id,
                "timeout": timeout,
            },
            ctx=ctx,
        )

    firewall_manage.__name__ = "firewall_manage"
    return firewall_manage


# ============================================================================
# 4. security_audit — 只读安全审计
# ============================================================================

_SECURITY_CHECKS: dict[str, str] = {
    "ssh_config": "grep -E 'PermitRootLogin|PasswordAuthentication|Port ' /etc/ssh/sshd_config 2>/dev/null | grep -v '^#'",
    "open_ports": "ss -tlnp | awk 'NR>1 {print $4, $6}'",
    "world_writable": "find / -maxdepth 3 -type f -perm -0002 2>/dev/null | head -20",
    "users": "awk -F: '$3>=1000 && $3<65534 {print $1, $3, $7}' /etc/passwd",
    "quick": "ss -tlnp | awk 'NR>1 {print $4, $6}' | head -10; grep -E 'PermitRootLogin|PasswordAuthentication' /etc/ssh/sshd_config 2>/dev/null | grep -v '^#'",
}

def invoke_security_audit_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    scope = (params.get("scope") or "").strip().lower() or "quick"
    if scope not in _SECURITY_CHECKS:
        return {
            "status": "error",
            "message": f"scope 必须为 {list(_SECURITY_CHECKS.keys())} 之一",
        }
    return execute_via_ssh(
        ctx=ctx,
        command=_SECURITY_CHECKS[scope],
        ssh_session_id=params.get("ssh_session_id", "") or "",
        timeout=int(params.get("timeout", 30)),
        tool_name="security_audit",
    )

def make_security_audit_tool(ctx: ToolContext):
    @tool
    def security_audit(scope: str = "quick", ssh_session_id: str = "", timeout: int = 30) -> dict:
        """只读安全审计（SSH 配置/开放端口/全局可写文件/用户）。

        纯只读命令，不触发审批。适合"检查服务器安全配置""看开放了哪些
        端口"等请求。

        Args:
            scope (str): ssh_config/open_ports/world_writable/users/quick。
            ssh_session_id (str): SSH 会话 ID。
            timeout (int): 超时秒数，默认 30。

        Returns:
            dict: 含 status / command / output / exit_code。
        """
        return invoke_security_audit_tool(
            params={"scope": scope, "ssh_session_id": ssh_session_id, "timeout": timeout},
            ctx=ctx,
        )

    security_audit.__name__ = "security_audit"
    return security_audit


# ============================================================================
# 5. performance_analyze — 只读性能分析
# ============================================================================

_PERF_CHECKS: dict[str, str] = {
    "cpu": "top -bn1 | head -12",
    "memory": "free -m",
    "disk": "df -hT | grep -v tmpfs",
    "load": "uptime",
    "top_processes": "ps aux --sort=-%cpu | head -8",
}

def invoke_performance_analyze_tool(params: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    metric = (params.get("metric") or "").strip().lower() or "load"
    if metric not in _PERF_CHECKS:
        return {
            "status": "error",
            "message": f"metric 必须为 {list(_PERF_CHECKS.keys())} 之一",
        }
    return execute_via_ssh(
        ctx=ctx,
        command=_PERF_CHECKS[metric],
        ssh_session_id=params.get("ssh_session_id", "") or "",
        timeout=int(params.get("timeout", 30)),
        tool_name="performance_analyze",
    )

def make_performance_analyze_tool(ctx: ToolContext):
    @tool
    def performance_analyze(metric: str = "load", ssh_session_id: str = "", timeout: int = 30) -> dict:
        """只读性能分析（CPU/内存/磁盘/负载/TOP 进程）。

        纯只读命令，不触发审批。适合"查看系统负载""内存占用"等请求。

        Args:
            metric (str): cpu/memory/disk/load/top_processes。
            ssh_session_id (str): SSH 会话 ID。
            timeout (int): 超时秒数，默认 30。

        Returns:
            dict: 含 status / command / output / exit_code。
        """
        return invoke_performance_analyze_tool(
            params={"metric": metric, "ssh_session_id": ssh_session_id, "timeout": timeout},
            ctx=ctx,
        )

    performance_analyze.__name__ = "performance_analyze"
    return performance_analyze


# ============================================================================
# 注册表
# ============================================================================

EXTENDED_TOOL_FACTORIES: dict[str, Any] = {
    "service_manage": make_service_manage_tool,
    "package_manage": make_package_manage_tool,
    "firewall_manage": make_firewall_manage_tool,
    "security_audit": make_security_audit_tool,
    "performance_analyze": make_performance_analyze_tool,
}

# 只读工具（schema-level safety 白名单用）
EXTENDED_READONLY_TOOLS = {"security_audit", "performance_analyze"}

# 各 agent 可用工具集（扩展部分）：
#   main: 全部 5 个；coding: service/package/firewall（写操作需审批）+ 只读；
#   explore: 只读 2 个；teach/history: 不引入（保持轻量）
AGENT_EXTENDED_TOOLS: dict[str, set[str]] = {
    "main": set(EXTENDED_TOOL_FACTORIES.keys()),
    "coding": {"service_manage", "package_manage", "firewall_manage", "security_audit", "performance_analyze"},
    "explore": EXTENDED_READONLY_TOOLS,
}


__all__ = [
    "EXTENDED_TOOL_FACTORIES",
    "EXTENDED_READONLY_TOOLS",
    "AGENT_EXTENDED_TOOLS",
    "make_service_manage_tool",
    "make_package_manage_tool",
    "make_firewall_manage_tool",
    "make_security_audit_tool",
    "make_performance_analyze_tool",
]
