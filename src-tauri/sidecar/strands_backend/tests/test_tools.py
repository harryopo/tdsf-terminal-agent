"""
strands_backend/tests/test_tools.py — Strands 后端工具 + 适配层单元测试
=====================================================================

覆盖范围：
1. RiskChecker 高危命令检测（rm -rf / reboot / mkfs / dd / fork bomb 等）
2. 5 个运维工具的 invoke_*_tool 核心函数（mock RustBridge + mock EventBus）：
   - ssh_command: 成功路径 + 高危审批 + RustBridge 未配置
   - remote_file: 成功路径 + 二进制检测 + RustBridge 未配置
   - log_analyzer: tail / grep / regex 三种模式
   - process_inspector: list / top / detail 三种模式
   - network_diagnostic: ping / ss / netstat / ip / dns 五种模式
3. StrandsAgentAdapter 降级路径（feature flag / Strands 不可用 / model 未注入）
4. StrandsAgentAdapter invoke 成功路径（mock Strands Agent + mock model）
5. StrandsAgentAdapter invoke 异常路径（mock Strands Agent 抛错）
6. 工具工厂函数（make_*_tool 返回可调用对象）

测试原则：
- 不依赖真实 Strands（Strands 可能未安装，工具 @tool 装饰器降级为 passthrough）
- 不依赖真实 RustBridge（用 Mock 模拟 ipc_invoke 返回值）
- 不依赖真实 EventBus（用 Mock 模拟 emit_* 方法）
- 验证工具返回结构化 dict（不返回裸字符串）
- 验证高危命令触发 emit_needs_you
"""
from __future__ import annotations

import sys
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

# 确保 sidecar 目录在 sys.path（pytest 自动发现时可能需要）
# 测试由 sidecar 目录运行：cd src-tauri/sidecar && python -m pytest strands_backend/tests/
import os
_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

from strands_backend.tools import (
    DefaultRustBridge,
    RiskChecker,
    ToolContext,
    make_all_ops_tools,
    OPS_TOOL_NAMES,
)
from strands_backend.tools.ssh_command import invoke_ssh_command_tool, make_ssh_command_tool
from strands_backend.tools.remote_file import invoke_remote_file_tool, make_remote_file_tool
from strands_backend.tools.log_analyzer import invoke_log_analyzer_tool, make_log_analyzer_tool
from strands_backend.tools.process_inspector import (
    invoke_process_inspector_tool,
    make_process_inspector_tool,
)
from strands_backend.tools.network_diagnostic import (
    invoke_network_diagnostic_tool,
    make_network_diagnostic_tool,
)
from strands_backend.adapter import StrandsAgentAdapter, TdsfStrandsCallbackHandler


# ============================================================================
# 测试辅助：Mock 工厂
# ============================================================================

def make_mock_event_bus() -> MagicMock:
    """构建 mock EventBus（记录所有 emit_* 调用）"""
    bus = MagicMock()
    bus.emit_needs_you = MagicMock(return_value=1)
    bus.emit_agent_message = MagicMock(return_value=1)
    bus.emit_mood_change = MagicMock(return_value=1)
    bus.emit_tool_call = MagicMock(return_value=1)
    return bus


def make_mock_rust_bridge(response: dict[str, Any] | None = None) -> MagicMock:
    """构建 mock RustBridge（ipc_invoke 返回指定响应）"""
    bridge = MagicMock()
    if response is None:
        response = {"ok": True, "output": "mock output", "exit_code": 0, "duration": 0.1}
    bridge.ipc_invoke = MagicMock(return_value=response)
    return bridge


# 哨兵对象：区分"未传 rust_bridge 参数"（用 mock）和"显式传 None"（真 None）
_RUST_BRIDGE_UNSET = object()


def make_ctx(
    event_bus: Any = None,
    rust_bridge: Any = _RUST_BRIDGE_UNSET,
    agent_name: str = "main",
    session_id: str = "test-session",
    ssh_session_id: str = "1",
) -> ToolContext:
    """构建测试用 ToolContext

    Args:
        event_bus: EventBus 实例，None 时用 mock
        rust_bridge: RustBridge 实例。未传（默认 _RUST_BRIDGE_UNSET）时用 mock；
                     显式传 None 时保留 None（用于测试 unavailable 路径）
        agent_name: Agent 名
        session_id: 会话 ID
        ssh_session_id: SSH 会话 ID（Rust 侧期望 int-convertible u32，
                        2026-08-01 修正默认值：旧 "ssh-1" 会被 execute_via_ssh
                        的 int 校验拒绝）
    """
    return ToolContext(
        event_bus=event_bus or make_mock_event_bus(),
        rust_bridge=make_mock_rust_bridge() if rust_bridge is _RUST_BRIDGE_UNSET else rust_bridge,
        agent_name=agent_name,
        session_id=session_id,
        ssh_session_id=ssh_session_id,
    )


# ============================================================================
# RiskChecker 测试
# ============================================================================

class TestRiskChecker(unittest.TestCase):
    """RiskChecker 高危命令检测"""

    def test_safe_command_low_risk(self):
        """安全命令应返回 L0 低风险"""
        result = RiskChecker.check("ls -la /var/log")
        self.assertFalse(result["high_risk"])
        self.assertEqual(result["level"], "L0")
        self.assertFalse(result["require_approval"])
        self.assertEqual(result["matched_rules"], [])

    def test_rm_rf_root_high_risk(self):
        """rm -rf / 应命中 rm_rf_root 规则"""
        result = RiskChecker.check("rm -rf /")
        self.assertTrue(result["high_risk"])
        self.assertEqual(result["level"], "L4")
        self.assertTrue(result["require_approval"])
        self.assertIn("rm_rf_root", result["matched_rules"])

    def test_rm_rf_recursive(self):
        """rm -rf /tmp/abc 应命中 rm_rf 规则"""
        result = RiskChecker.check("rm -rf /tmp/abc")
        self.assertTrue(result["high_risk"])
        self.assertIn("rm_rf", result["matched_rules"])

    def test_reboot_high_risk(self):
        """reboot 应命中 reboot 规则"""
        result = RiskChecker.check("reboot")
        self.assertTrue(result["high_risk"])
        self.assertIn("reboot", result["matched_rules"])

    def test_shutdown_now_high_risk(self):
        """shutdown -h now 应命中 reboot 规则"""
        result = RiskChecker.check("shutdown -h now")
        self.assertTrue(result["high_risk"])
        self.assertIn("reboot", result["matched_rules"])

    def test_mkfs_high_risk(self):
        """mkfs.ext4 /dev/sda 应命中 mkfs 规则"""
        result = RiskChecker.check("mkfs.ext4 /dev/sda1")
        self.assertTrue(result["high_risk"])
        self.assertIn("mkfs", result["matched_rules"])

    def test_dd_to_disk_high_risk(self):
        """dd if=... of=/dev/sda 应命中 dd_to_disk 规则"""
        result = RiskChecker.check("dd if=/dev/zero of=/dev/sda bs=1M count=10")
        self.assertTrue(result["high_risk"])
        self.assertIn("dd_to_disk", result["matched_rules"])

    def test_fork_bomb_high_risk(self):
        """fork bomb :(){ :|:& };: 应命中 fork_bomb 规则"""
        result = RiskChecker.check(":(){ :|:& };:")
        self.assertTrue(result["high_risk"])
        self.assertIn("fork_bomb", result["matched_rules"])

    def test_chmod_777_root_high_risk(self):
        """chmod -R 777 / 应命中 chmod_777_root 规则"""
        result = RiskChecker.check("chmod -R 777 /")
        self.assertTrue(result["high_risk"])
        self.assertIn("chmod_777_root", result["matched_rules"])

    def test_killall_system_high_risk(self):
        """killall systemd 应命中 killall_system 规则"""
        result = RiskChecker.check("killall systemd")
        self.assertTrue(result["high_risk"])
        self.assertIn("killall_system", result["matched_rules"])

    def test_iptables_flush_high_risk(self):
        """iptables -F 应命中 iptables_flush 规则"""
        result = RiskChecker.check("iptables -F")
        self.assertTrue(result["high_risk"])
        self.assertIn("iptables_flush", result["matched_rules"])

    def test_drop_database_high_risk(self):
        """DROP DATABASE 应命中 drop_database 规则"""
        result = RiskChecker.check("psql -c 'DROP DATABASE prod;'")
        self.assertTrue(result["high_risk"])
        self.assertIn("drop_database", result["matched_rules"])

    def test_emit_needs_you_calls_event_bus(self):
        """emit_needs_you 应调用 event_bus.emit_needs_you"""
        bus = make_mock_event_bus()
        risk = RiskChecker.check("reboot")
        RiskChecker.emit_needs_you(
            event_bus=bus,
            command="reboot",
            risk_result=risk,
            agent_name="main",
            session_id="s1",
            tool_name="ssh_command",
        )
        bus.emit_needs_you.assert_called_once()
        call_kwargs = bus.emit_needs_you.call_args.kwargs
        self.assertEqual(call_kwargs["needs_type"], "approval")
        self.assertEqual(call_kwargs["priority"], "high")
        self.assertIn("command", call_kwargs)
        self.assertEqual(call_kwargs["command"], "reboot")

    def test_emit_needs_you_no_event_bus(self):
        """event_bus=None 时应静默跳过不抛错"""
        risk = RiskChecker.check("reboot")
        # 不应抛错
        RiskChecker.emit_needs_you(
            event_bus=None,
            command="reboot",
            risk_result=risk,
            agent_name="main",
            session_id="s1",
        )


# ============================================================================
# ssh_command 工具测试
# ============================================================================

class TestSshCommandTool(unittest.TestCase):
    """SSH 命令执行工具"""

    def test_safe_command_success(self):
        """安全命令应通过 RustBridge 执行并返回 success"""
        bridge = make_mock_rust_bridge({"ok": True, "output": "total 4\ndrwxr-xr-x 2 root root 4096", "exit_code": 0, "duration": 0.05})
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_ssh_command_tool({"command": "ls -la /tmp"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["command"], "ls -la /tmp")
        self.assertIn("output", result)
        bridge.ipc_invoke.assert_called_once_with(
            "ssh_command",
            {"sessionId": 1, "command": "ls -la /tmp", "timeout": 30},
        )

    def test_high_risk_command_needs_approval(self):
        """高危命令应返回 needs_approval 并触发 emit_needs_you"""
        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        result = invoke_ssh_command_tool({"command": "rm -rf /"}, ctx)
        self.assertEqual(result["status"], "needs_approval")
        self.assertIn("rm_rf_root", result["risk"]["matched_rules"])
        # RustBridge 不应被调用
        bridge.ipc_invoke.assert_not_called()
        # emit_needs_you 应被调用
        bus.emit_needs_you.assert_called_once()

    def test_no_rust_bridge_unavailable(self):
        """RustBridge=None 时应返回 unavailable"""
        ctx = make_ctx(rust_bridge=None)
        result = invoke_ssh_command_tool({"command": "ls"}, ctx)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"], "rust_bridge_not_injected")

    def test_missing_command_raises(self):
        """command 参数缺失应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_ssh_command_tool({}, ctx)

    def test_multiline_with_high_risk_blocked(self):
        """多行命令包含高危行应被拦截"""
        bus = make_mock_event_bus()
        ctx = make_ctx(event_bus=bus)
        result = invoke_ssh_command_tool(
            {"command": "ls\nrm -rf /\nuname -a"}, ctx
        )
        self.assertEqual(result["status"], "needs_approval")

    def test_factory_returns_callable(self):
        """make_ssh_command_tool 应返回可调用对象"""
        ctx = make_ctx()
        tool_fn = make_ssh_command_tool(ctx)
        self.assertTrue(callable(tool_fn))
        result = tool_fn(command="ls")
        self.assertIn("status", result)


# ============================================================================
# remote_file 工具测试
# ============================================================================

class TestRemoteFileTool(unittest.TestCase):
    """远程文件读取工具"""

    def test_read_text_file_success(self):
        """读取文本文件应返回 success + content"""
        bridge = make_mock_rust_bridge({
            "ok": True,
            "content": "line1\nline2\nline3\n",
            "size": 18,
            "truncated": False,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_remote_file_tool({"path": "/etc/hosts"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["path"], "/etc/hosts")
        self.assertEqual(result["content"], "line1\nline2\nline3\n")
        self.assertFalse(result["truncated"])
        bridge.ipc_invoke.assert_called_once_with(
            "sftp_read",
            {"sessionId": 1, "path": "/etc/hosts", "max_size": 1048576},
        )

    def test_read_binary_file_detected(self):
        """含 NUL 字节应返回 binary 状态"""
        bridge = make_mock_rust_bridge({
            "ok": True,
            "content": b"\x7fELF\x02\x01\x01\x00\x00\x00",
            "size": 10,
            "truncated": False,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_remote_file_tool({"path": "/bin/ls"}, ctx)
        self.assertEqual(result["status"], "binary")
        self.assertNotIn("content", result)

    def test_truncated_file_flagged(self):
        """截断文件应设置 truncated=True"""
        bridge = make_mock_rust_bridge({
            "ok": True,
            "content": "a" * 100,
            "size": 200,
            "truncated": True,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_remote_file_tool(
            {"path": "/var/log/big.log", "max_size": 100}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["truncated"])

    def test_no_rust_bridge_unavailable(self):
        """RustBridge=None 时应返回 unavailable"""
        ctx = make_ctx(rust_bridge=None)
        result = invoke_remote_file_tool({"path": "/etc/hosts"}, ctx)
        self.assertEqual(result["status"], "unavailable")

    def test_missing_path_raises(self):
        """path 参数缺失应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_remote_file_tool({}, ctx)

    def test_factory_returns_callable(self):
        """make_remote_file_tool 应返回可调用对象"""
        ctx = make_ctx()
        tool_fn = make_remote_file_tool(ctx)
        self.assertTrue(callable(tool_fn))
        result = tool_fn(path="/etc/hosts")
        self.assertIn("status", result)


# ============================================================================
# log_analyzer 工具测试
# ============================================================================

class TestLogAnalyzerTool(unittest.TestCase):
    """日志分析工具"""

    def test_tail_mode_success(self):
        """tail 模式应执行 tail -n 命令"""
        bridge = make_mock_rust_bridge({
            "ok": True,
            "output": "line1\nline2\nline3",
            "exit_code": 0,
            "duration": 0.02,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_log_analyzer_tool(
            {"log_path": "/var/log/syslog", "mode": "tail", "lines": 50}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["mode"], "tail")
        self.assertEqual(result["summary"]["total_lines"], 3)
        # 命令应包含 tail -n 50
        self.assertIn("tail -n 50", result["command"])

    def test_grep_mode_success(self):
        """grep 模式应执行 grep -F 命令"""
        bridge = make_mock_rust_bridge({
            "ok": True,
            "output": "1:error here\n2:another error",
            "exit_code": 0,
            "duration": 0.02,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_log_analyzer_tool(
            {"log_path": "/var/log/syslog", "mode": "grep", "pattern": "error", "lines": 100},
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["mode"], "grep")
        self.assertIn("grep -Fn", result["command"])
        self.assertEqual(result["summary"]["matched_lines"], 2)

    def test_regex_mode_success(self):
        """regex 模式应执行 grep -E 命令"""
        bridge = make_mock_rust_bridge({
            "ok": True,
            "output": "1:ERR code1\n2:ERR code2",
            "exit_code": 0,
            "duration": 0.02,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_log_analyzer_tool(
            {"log_path": "/var/log/syslog", "mode": "regex", "pattern": "ERR"},
            ctx,
        )
        self.assertEqual(result["status"], "success")
        self.assertIn("grep -En", result["command"])

    def test_grep_mode_missing_pattern_raises(self):
        """grep 模式无 pattern 应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_log_analyzer_tool(
                {"log_path": "/var/log/syslog", "mode": "grep"}, ctx
            )

    def test_invalid_mode_raises(self):
        """非法模式应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_log_analyzer_tool(
                {"log_path": "/x", "mode": "invalid"}, ctx
            )

    def test_no_rust_bridge_unavailable(self):
        """RustBridge=None 时应返回 unavailable"""
        ctx = make_ctx(rust_bridge=None)
        result = invoke_log_analyzer_tool(
            {"log_path": "/var/log/syslog"}, ctx
        )
        self.assertEqual(result["status"], "unavailable")

    def test_factory_returns_callable(self):
        """make_log_analyzer_tool 应返回可调用对象"""
        ctx = make_ctx()
        tool_fn = make_log_analyzer_tool(ctx)
        self.assertTrue(callable(tool_fn))
        result = tool_fn(log_path="/var/log/syslog", mode="tail")
        self.assertIn("status", result)


# ============================================================================
# process_inspector 工具测试
# ============================================================================

class TestProcessInspectorTool(unittest.TestCase):
    """进程检查工具"""

    def test_list_mode_success(self):
        """list 模式应执行 ps aux"""
        output = (
            "USER PID %CPU %MEM STAT COMMAND\n"
            "root 1 0.0 0.0 S00 /sbin/init\n"
            "root 1234 1.5 2.0 Ss /usr/sbin/sshd -D\n"
        )
        bridge = make_mock_rust_bridge({
            "ok": True, "output": output, "exit_code": 0, "duration": 0.05
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_process_inspector_tool({"mode": "list"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["mode"], "list")
        self.assertEqual(result["count"], 2)
        self.assertEqual(len(result["processes"]), 2)
        self.assertEqual(result["processes"][0]["pid"], 1)
        self.assertIn("ps aux", result["command"])

    def test_top_mode_success(self):
        """top 模式应按 CPU 排序"""
        output = (
            "USER PID %CPU %MEM STAT COMMAND\n"
            "root 999 15.0 2.0 R stress\n"
            "root 1234 1.5 2.0 Ss sshd\n"
        )
        bridge = make_mock_rust_bridge({
            "ok": True, "output": output, "exit_code": 0, "duration": 0.05
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_process_inspector_tool(
            {"mode": "top", "top_n": 10}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertIn("sort=-%cpu", result["command"])
        self.assertEqual(result["summary"]["count"], 2)

    def test_detail_mode_with_pid(self):
        """detail 模式 + pid 应执行 ps -p"""
        bridge = make_mock_rust_bridge({
            "ok": True, "output": "USER PID ...\nroot 1234 ...", "exit_code": 0, "duration": 0.05
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_process_inspector_tool(
            {"mode": "detail", "pid": 1234}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertIn("ps -p 1234", result["command"])

    def test_detail_mode_no_pid_no_name_raises(self):
        """detail 模式无 pid 无 name 应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_process_inspector_tool({"mode": "detail"}, ctx)

    def test_list_mode_with_filters(self):
        """list 模式带 filter_user + filter_name 应构建过滤命令"""
        bridge = make_mock_rust_bridge({
            "ok": True, "output": "USER PID ...\nroot 1234 sshd", "exit_code": 0, "duration": 0.05
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_process_inspector_tool(
            {"mode": "list", "filter_user": "root", "filter_name": "sshd"}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertIn("-u 'root'", result["command"])
        self.assertIn("grep 'sshd'", result["command"])

    def test_factory_returns_callable(self):
        ctx = make_ctx()
        tool_fn = make_process_inspector_tool(ctx)
        self.assertTrue(callable(tool_fn))
        result = tool_fn(mode="list")
        self.assertIn("status", result)


# ============================================================================
# network_diagnostic 工具测试
# ============================================================================

class TestNetworkDiagnosticTool(unittest.TestCase):
    """网络诊断工具"""

    def test_ping_mode_success(self):
        """ping 模式应执行 ping -c 命令"""
        output = (
            "PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.\n"
            "64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=10.5 ms\n"
            "4 packets transmitted, 4 received, 0% packet loss\n"
            "rtt min/avg/max/mdev = 10.5/10.6/10.8/0.1 ms"
        )
        bridge = make_mock_rust_bridge({
            "ok": True, "output": output, "exit_code": 0, "duration": 4.2
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_network_diagnostic_tool(
            {"mode": "ping", "target": "8.8.8.8", "count": 4}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["mode"], "ping")
        self.assertIn("ping -c 4", result["command"])
        self.assertTrue(result["summary"]["reachable"])
        self.assertEqual(result["summary"]["transmitted"], 4)
        self.assertEqual(result["summary"]["received"], 4)
        self.assertEqual(result["summary"]["loss_percent"], 0)

    def test_ping_mode_no_target_raises(self):
        """ping 模式无 target 应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_network_diagnostic_tool({"mode": "ping"}, ctx)

    def test_ss_mode_success(self):
        """ss 模式应执行 ss -tulnp"""
        output = (
            "Netid State  Local Address:Port Peer Address:Port\n"
            "tcp   LISTEN 0.0.0.0:22          0.0.0.0:*\n"
            "tcp   LISTEN 0.0.0.0:80          0.0.0.0:*\n"
        )
        bridge = make_mock_rust_bridge({
            "ok": True, "output": output, "exit_code": 0, "duration": 0.05
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_network_diagnostic_tool({"mode": "ss"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertIn("ss -tulnp", result["command"])
        self.assertEqual(result["summary"]["port_count"], 2)
        self.assertEqual(sorted(result["summary"]["listening_ports"]), [22, 80])

    def test_netstat_mode_success(self):
        """netstat 模式应执行 netstat -tulnp"""
        output = "tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN\n"
        bridge = make_mock_rust_bridge({
            "ok": True, "output": output, "exit_code": 0, "duration": 0.05
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_network_diagnostic_tool({"mode": "netstat"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertIn("netstat -tulnp", result["command"])

    def test_ip_mode_success(self):
        """ip 模式应执行 ip addr + ip route"""
        bridge = make_mock_rust_bridge({
            "ok": True, "output": "eth0: <BROADCAST...>---ROUTE---default via ...",
            "exit_code": 0, "duration": 0.05,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_network_diagnostic_tool({"mode": "ip"}, ctx)
        self.assertEqual(result["status"], "success")
        self.assertIn("ip addr", result["command"])
        self.assertIn("ip route", result["command"])
        self.assertEqual(result["summary"]["sections"], 2)

    def test_dns_mode_success(self):
        """dns 模式应执行 nslookup"""
        bridge = make_mock_rust_bridge({
            "ok": True, "output": "Server: 8.8.8.8\nAddress: 8.8.8.8#53\n...",
            "exit_code": 0, "duration": 0.5,
        })
        ctx = make_ctx(rust_bridge=bridge)
        result = invoke_network_diagnostic_tool(
            {"mode": "dns", "target": "example.com"}, ctx
        )
        self.assertEqual(result["status"], "success")
        self.assertIn("nslookup", result["command"])
        self.assertTrue(result["summary"]["resolved"])

    def test_dns_mode_no_target_raises(self):
        """dns 模式无 target 应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_network_diagnostic_tool({"mode": "dns"}, ctx)

    def test_invalid_mode_raises(self):
        """非法模式应抛 ValueError"""
        ctx = make_ctx()
        with self.assertRaises(ValueError):
            invoke_network_diagnostic_tool({"mode": "invalid", "target": "x"}, ctx)

    def test_factory_returns_callable(self):
        ctx = make_ctx()
        tool_fn = make_network_diagnostic_tool(ctx)
        self.assertTrue(callable(tool_fn))
        result = tool_fn(mode="ping", target="8.8.8.8")
        self.assertIn("status", result)


# ============================================================================
# 工具批量构建测试
# ============================================================================

class TestMakeAllOpsTools(unittest.TestCase):
    """make_all_ops_tools 批量构建测试"""

    def test_returns_7_tools(self):
        """make_all_ops_tools 应返回 7 个工具（2026-08-01: +skill_invoke/suggest_command）"""
        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        self.assertEqual(len(tools), 7)
        for t in tools:
            self.assertTrue(callable(t))

    def test_ops_tool_names_complete(self):
        """OPS_TOOL_NAMES 应包含 7 个工具名"""
        self.assertEqual(len(OPS_TOOL_NAMES), 7)
        self.assertIn("ssh_command", OPS_TOOL_NAMES)
        self.assertIn("remote_file", OPS_TOOL_NAMES)
        self.assertIn("log_analyzer", OPS_TOOL_NAMES)
        self.assertIn("process_inspector", OPS_TOOL_NAMES)
        self.assertIn("network_diagnostic", OPS_TOOL_NAMES)
        self.assertIn("skill_invoke", OPS_TOOL_NAMES)
        self.assertIn("suggest_command", OPS_TOOL_NAMES)


# ============================================================================
# DefaultRustBridge 测试
# ============================================================================

class TestDefaultRustBridge(unittest.TestCase):
    """DefaultRustBridge 默认实现"""

    def test_no_send_request_returns_unavailable(self):
        """未注入 send_request 时应返回 unavailable 状态"""
        bridge = DefaultRustBridge()
        result = bridge.ipc_invoke("ssh_command", {"session_id": "x"})
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"], "rust_bridge_not_configured")

    def test_with_send_request_returns_response(self):
        """注入 send_request 时应返回其结果"""
        callback = MagicMock(return_value={"ok": True, "output": "data"})
        bridge = DefaultRustBridge(send_request=callback)
        result = bridge.ipc_invoke("ssh_command", {"session_id": "x"})
        self.assertEqual(result, {"ok": True, "output": "data"})
        callback.assert_called_once_with("ssh_command", {"session_id": "x"})

    def test_with_send_request_exception_returns_error(self):
        """send_request 抛异常时应捕获并返回 error 状态"""
        callback = MagicMock(side_effect=RuntimeError("rust down"))
        bridge = DefaultRustBridge(send_request=callback)
        result = bridge.ipc_invoke("ssh_command", {"session_id": "x"})
        self.assertEqual(result["status"], "error")
        self.assertIn("rust down", result["error"])


# ============================================================================
# StrandsAgentAdapter 降级测试
# ============================================================================

class TestStrandsAgentAdapterDegraded(unittest.TestCase):
    """StrandsAgentAdapter 降级路径测试"""

    def test_feature_flag_disabled_degraded(self):
        """backend_enabled=False 应返回 degraded"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(
            event_bus=bus, backend_enabled=False,
        )
        result = adapter.invoke("main", "hello", {"session_id": "s1"})
        self.assertTrue(result["degraded"])
        self.assertEqual(result["degraded_reason"], "feature_flag_disabled")
        self.assertEqual(result["mood"], "done")
        bus.emit_needs_you.assert_called_once()

    def test_strands_not_installed_degraded(self):
        """Strands 不可用时应返回 degraded（patch 模拟）"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(
            event_bus=bus, backend_enabled=True,
        )
        # 强制模拟 Strands 不可用
        adapter._strands_available = False
        result = adapter.invoke("main", "hello", {"session_id": "s1"})
        self.assertTrue(result["degraded"])
        self.assertEqual(result["degraded_reason"], "strands_not_installed")

    def test_model_not_injected_degraded(self):
        """Strands 可用但 model=None 时应返回 degraded"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(
            event_bus=bus, backend_enabled=True, strands_model=None,
        )
        # 模拟 Strands 可用但 model 未注入
        adapter._strands_available = True
        adapter._model_available = False
        result = adapter.invoke("main", "hello", {"session_id": "s1"})
        self.assertTrue(result["degraded"])
        self.assertEqual(result["degraded_reason"], "strands_model_not_injected")

    def test_degraded_response_structure(self):
        """降级响应应包含完整字段（observation/next_step/mood/intermediate_results）"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=False)
        result = adapter.invoke("main", "hello", {"session_id": "s1"})
        self.assertIn("observation", result)
        self.assertIn("next_step", result)
        self.assertIn("mood", result)
        self.assertIn("intermediate_results", result)
        self.assertEqual(result["next_step"], "done")
        self.assertTrue(len(result["intermediate_results"]) > 0)


# ============================================================================
# StrandsAgentAdapter invoke 成功路径测试（mock Strands Agent）
# ============================================================================

class TestStrandsAgentAdapterInvokeSuccess(unittest.TestCase):
    """StrandsAgentAdapter invoke 成功路径（mock Strands Agent）"""

    def test_invoke_success_returns_observation(self):
        """invoke 成功应返回 observation + next_step=done"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)

        # Mock Strands Agent
        mock_response = MagicMock()
        mock_response.__str__ = MagicMock(return_value="nginx is running")
        mock_response.metrics = {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}

        mock_agent = MagicMock(return_value=mock_response)
        adapter._agent_cache[("main", "s1")] = mock_agent  # cache 键为 (agent_id, session_id) 元组
        adapter._strands_available = True
        adapter._model_available = True

        result = adapter.invoke("main", "检查 nginx 状态", {"session_id": "s1"})

        self.assertEqual(result["next_step"], "done")
        self.assertEqual(result["mood"], "done")
        self.assertEqual(result["observation"], "nginx is running")
        self.assertIn("tokens", result)
        mock_agent.assert_called_once()

    def test_invoke_with_live_context_in_prompt(self):
        """invoke 应把 live 上下文注入 prompt"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)

        mock_response = MagicMock()
        mock_response.__str__ = MagicMock(return_value="ok")
        mock_agent = MagicMock(return_value=mock_response)
        adapter._agent_cache[("main", "s1")] = mock_agent
        adapter._strands_available = True
        adapter._model_available = True

        adapter.invoke(
            "main",
            "ls",
            {"session_id": "s1", "live": {"cwd": "/var/log", "sshSessionId": "ssh-9"}},
        )

        # 检查 prompt 包含 live_context 块
        call_args = mock_agent.call_args
        prompt = call_args[0][0] if call_args[0] else call_args[1].get("prompt", "")
        self.assertIn("<live_context>", prompt)
        self.assertIn("/var/log", prompt)
        self.assertIn("ssh-9", prompt)

    def test_invoke_exception_returns_error(self):
        """Strands Agent 抛异常应返回 error 状态 + emit_needs_you"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)

        mock_agent = MagicMock(side_effect=RuntimeError("strands internal error"))
        adapter._agent_cache[("main", "s1")] = mock_agent
        adapter._strands_available = True
        adapter._model_available = True

        result = adapter.invoke("main", "hello", {"session_id": "s1"})

        self.assertEqual(result["next_step"], "error")
        self.assertEqual(result["mood"], "error")
        self.assertIn("strands internal error", result["error"])
        # 异常时应推送 needs_you
        bus.emit_needs_you.assert_called_once()

    def test_invoke_emits_mood_transitions(self):
        """invoke 应推送 mood_change 事件序列"""
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)

        mock_response = MagicMock()
        mock_response.__str__ = MagicMock(return_value="done")
        mock_agent = MagicMock(return_value=mock_response)
        adapter._agent_cache[("main", "s1")] = mock_agent
        adapter._strands_available = True
        adapter._model_available = True

        adapter.invoke("main", "hello", {"session_id": "s1"})

        # 应至少调用 3 次 mood_change: thinking → working → done
        self.assertGreaterEqual(bus.emit_mood_change.call_count, 3)


# ============================================================================
# TdsfStrandsCallbackHandler 测试
# ============================================================================

class TestTdsfStrandsCallbackHandler(unittest.TestCase):
    """Strands 事件 → event_bus 转发测试"""

    def test_data_event_emits_agent_message(self):
        """data 事件应触发 emit_agent_message"""
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main", session_id="s1")
        handler(data="hello world")
        bus.emit_agent_message.assert_called_once()
        kwargs = bus.emit_agent_message.call_args.kwargs
        self.assertEqual(kwargs["content"], "hello world")

    def test_start_event_emits_mood_thinking(self):
        """start 事件应触发 mood=thinking"""
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main")
        handler(start=True)
        bus.emit_mood_change.assert_called_once()
        self.assertEqual(bus.emit_mood_change.call_args.kwargs["mood"], "thinking")

    def test_complete_event_emits_mood_working(self):
        """complete 事件应触发 mood=working"""
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main")
        handler(complete=True)
        bus.emit_mood_change.assert_called_once()
        self.assertEqual(bus.emit_mood_change.call_args.kwargs["mood"], "working")

    def test_force_stop_event_emits_mood_error(self):
        """force_stop 事件应触发 mood=error"""
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main")
        handler(force_stop=True)
        bus.emit_mood_change.assert_called_once()
        self.assertEqual(bus.emit_mood_change.call_args.kwargs["mood"], "error")

    def test_current_tool_use_does_not_emit_tool_call(self):
        """current_tool_use 事件不应触发 emit_tool_call（2026-07-31 修复）

        Strands 的 current_tool_use 是流式中途态（input 为残缺 JSON 字符串），
        转发会产生 input={} 的空参数工具行；完整参数由工具实现内部 emit。
        """
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main")
        handler(current_tool_use={"name": "ssh_command", "input": {"command": "ls"}})
        bus.emit_tool_call.assert_not_called()

    def test_reasoning_text_emits_thinking(self):
        """reasoningText 事件应触发 emit_agent_message(type=thinking)"""
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main", session_id="s1")
        handler(reasoningText="让我先分析一下")
        bus.emit_agent_message.assert_called_once()
        kwargs = bus.emit_agent_message.call_args.kwargs
        self.assertEqual(kwargs["content"], "让我先分析一下")
        self.assertEqual(kwargs["message_type"], "thinking")

    def test_strip_env_block(self):
        """_strip_env_block 应剥离 <env> 块（thinking 展示不泄漏内部上下文）"""
        from strands_backend.adapter import _strip_env_block

        # 头部 env 块
        text = "<env>\nworkspace_root: /\nactive_terminal_cwd: C:/Users/Lenovo\n</env>\n\n帮我看看负载"
        self.assertEqual(_strip_env_block(text), "帮我看看负载")
        # 无 env 块原样返回
        self.assertEqual(_strip_env_block("普通问题"), "普通问题")
        # 空串安全
        self.assertEqual(_strip_env_block(""), "")
        # 未闭合 env 块（防御）
        self.assertEqual(_strip_env_block("<env>abc"), "")
        # 中间 env 块
        self.assertEqual(
            _strip_env_block("前缀<env>x</env>后缀"),
            "前缀后缀",
        )

    def test_no_event_bus_does_not_raise(self):
        """event_bus=None 时不应抛错"""
        handler = TdsfStrandsCallbackHandler(None, agent_name="main")
        # 不应抛错
        handler(data="hello", start=True, complete=True)


# ============================================================================
# 集成测试：包导入 + 公共 API
# ============================================================================

class TestPackageImport(unittest.TestCase):
    """包导入与公共 API 测试"""

    def test_import_strands_backend(self):
        """import strands_backend 应成功"""
        import strands_backend
        self.assertTrue(hasattr(strands_backend, "StrandsAgentAdapter"))
        self.assertTrue(hasattr(strands_backend, "configure_strands"))
        self.assertTrue(hasattr(strands_backend, "is_strands_available"))
        self.assertTrue(hasattr(strands_backend, "__version__"))

    def test_strands_agent_adapter_importable(self):
        """from strands_backend import StrandsAgentAdapter 应成功"""
        from strands_backend import StrandsAgentAdapter as Adapter
        self.assertTrue(callable(Adapter))

    def test_configure_strands_returns_adapter(self):
        """configure_strands 应返回 StrandsAgentAdapter 实例"""
        from strands_backend import configure_strands
        bus = make_mock_event_bus()
        adapter = configure_strands(event_bus=bus, backend_enabled=False)
        self.assertIsInstance(adapter, StrandsAgentAdapter)


if __name__ == "__main__":
    unittest.main()


# ============================================================================
# ToolCallLimitHook 测试（P1-NEW-v2-3 fix-loop 保护）
# ============================================================================

class TestToolCallLimitHook(unittest.TestCase):
    """工具调用次数保护 hook（不依赖 Strands 真实执行）"""

    def _make_event(self, name="ssh_command", exception=None):
        event = MagicMock()
        event.tool_use = {"name": name}
        event.cancel_tool = False
        event.exception = exception
        return event

    def test_register_hooks_registers_callbacks(self):
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook()
        registry = MagicMock()
        hook.register_hooks(registry)
        self.assertEqual(registry.add_callback.call_count, 2)

    def test_total_calls_limit_cancels(self):
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook(max_tool_calls=2)
        e1 = self._make_event()
        hook._before_tool_call(e1)
        self.assertFalse(e1.cancel_tool)
        e2 = self._make_event()
        hook._before_tool_call(e2)
        self.assertFalse(e2.cancel_tool)
        e3 = self._make_event()
        hook._before_tool_call(e3)
        self.assertTrue(e3.cancel_tool)
        self.assertTrue(hook.cancelled)

    def test_consecutive_failures_cancel_same_tool(self):
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook(max_failures=3)
        for i in range(3):
            before = self._make_event("ssh_command")
            hook._before_tool_call(before)
            self.assertFalse(before.cancel_tool, f"call {i} should pass")
            after = self._make_event("ssh_command", exception=RuntimeError("boom"))
            hook._after_tool_call(after)
        # 第 4 次调用同工具应被取消
        before = self._make_event("ssh_command")
        hook._before_tool_call(before)
        self.assertTrue(before.cancel_tool)

    def test_success_resets_failure_count(self):
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook(max_failures=2)
        hook._after_tool_call(self._make_event("ssh_command", exception=RuntimeError("e")))
        hook._after_tool_call(self._make_event("ssh_command", exception=RuntimeError("e")))
        # 成功调用重置
        hook._after_tool_call(self._make_event("ssh_command", exception=None))
        before = self._make_event("ssh_command")
        hook._before_tool_call(before)
        self.assertFalse(before.cancel_tool)

    def test_different_tools_independent_failures(self):
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook(max_failures=1)
        hook._after_tool_call(self._make_event("ssh_command", exception=RuntimeError("e")))
        # 另一工具不受影响
        before = self._make_event("sftp_read")
        hook._before_tool_call(before)
        self.assertFalse(before.cancel_tool)

    def test_reset_clears_state(self):
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook(max_tool_calls=1)
        hook._before_tool_call(self._make_event())
        hook._before_tool_call(self._make_event())
        self.assertTrue(hook.cancelled)
        hook.reset()
        self.assertFalse(hook.cancelled)
        self.assertEqual(hook.total_calls, 0)


# ============================================================================
# main_agent 路由恢复测试（P1-NEW-v2-4）
# ============================================================================

class TestMainAgentRouting(unittest.TestCase):
    """Strands 路径恢复 main_agent 关键词路由意图"""

    def _adapter_with_mock_agent(self):
        from strands_backend.adapter import StrandsAgentAdapter

        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)
        mock_response = MagicMock()
        mock_response.__str__ = MagicMock(return_value="回答内容")
        mock_response.metrics = {}
        mock_agent = MagicMock(return_value=mock_response)
        adapter._agent_cache[("main", "s1")] = mock_agent
        adapter._strands_available = True
        adapter._model_available = True
        return adapter, bus, mock_agent

    def test_teach_request_routes_and_injects_hint(self):
        adapter, bus, mock_agent = self._adapter_with_mock_agent()
        adapter.invoke("main", "解释一下什么是负载均衡", {"session_id": "s1"})
        prompt = mock_agent.call_args[0][0]
        self.assertIn("路由到 teach", prompt)
        self.assertIn("教学口吻", prompt)
        # agent_switch 事件应发出
        bus.emit_agent_switch.assert_called_once()
        self.assertEqual(bus.emit_agent_switch.call_args.kwargs["agent"], "teach")

    def test_ops_request_no_routing(self):
        adapter, bus, mock_agent = self._adapter_with_mock_agent()
        # 注意: "查看 nginx 状态" 含单字 "查" 会被 plan_task 路由到 explore（既有语义），
        # 运维类用例用无歧义表述
        adapter.invoke("main", "nginx 服务状态如何", {"session_id": "s1"})
        prompt = mock_agent.call_args[0][0]
        self.assertNotIn("路由到", prompt)
        bus.emit_agent_switch.assert_not_called()

    def test_non_main_agent_no_routing(self):
        adapter, bus, mock_agent = self._adapter_with_mock_agent()
        adapter._agent_cache[("coding", "s1")] = mock_agent
        adapter.invoke("coding", "解释一下什么是负载均衡", {"session_id": "s1"})
        bus.emit_agent_switch.assert_not_called()

    def test_route_main_agent_direct(self):
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(event_bus=None, backend_enabled=False)
        self.assertEqual(adapter._route_main_agent("main", "讲解一下进程", "s1"), "teach")
        self.assertIsNone(adapter._route_main_agent("main", "随便聊聊", "s1"))
        self.assertIsNone(adapter._route_main_agent("coding", "讲解一下", "s1"))
