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

    def test_high_risk_command_approved_executes(self):
        """P1-1: 高危命令用户批准 → 真实执行"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.APPROVED),
        ):
            result = invoke_ssh_command_tool({"command": "rm -rf /"}, ctx)
        self.assertEqual(result["status"], "success")
        # 批准后命令真正执行（RustBridge 被调用）
        bridge.ipc_invoke.assert_called_once()

    def test_high_risk_command_rejected(self):
        """P1-1: 高危命令用户拒绝 → 返回 rejected，不执行"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(
                status=NeedsYouStatus.REJECTED, response={"reason": "测试拒绝"}
            ),
        ):
            result = invoke_ssh_command_tool({"command": "rm -rf /"}, ctx)
        self.assertEqual(result["status"], "rejected")
        self.assertIn("拒绝", result["message"])
        bridge.ipc_invoke.assert_not_called()

    def test_high_risk_command_timeout_keeps_needs_approval(self):
        """P1-1: 审批超时 → 保持 needs_approval（旧行为兜底）"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.TIMEOUT),
        ):
            result = invoke_ssh_command_tool({"command": "rm -rf /"}, ctx)
        self.assertEqual(result["status"], "needs_approval")
        self.assertIn("超时", result["message"])
        bridge.ipc_invoke.assert_not_called()

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
        """多行命令包含高危行 → 发起审批；超时未响应保持 needs_approval"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        ctx = make_ctx(event_bus=bus)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.TIMEOUT),
        ):
            result = invoke_ssh_command_tool(
                {"command": "ls\nrm -rf /\nuname -a"}, ctx
            )
        self.assertEqual(result["status"], "needs_approval")

    def test_multiline_approved_executes_whole(self):
        """P1-1: 多行命令批准后整条执行"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bridge = make_mock_rust_bridge()
        ctx = make_ctx(rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.APPROVED),
        ):
            result = invoke_ssh_command_tool(
                {"command": "ls\nrm -rf /tmp/x\nuname -a"}, ctx
            )
        self.assertEqual(result["status"], "success")
        bridge.ipc_invoke.assert_called_once()

    def test_factory_returns_callable(self):
        """make_ssh_command_tool 应返回可调用对象"""
        ctx = make_ctx()
        tool_fn = make_ssh_command_tool(ctx)
        self.assertTrue(callable(tool_fn))
        result = tool_fn(command="ls")
        self.assertIn("status", result)

    def test_real_approval_flow_approve_executes(self):
        """P1-1 全链路：真实 needs_you 服务，用户批准 → 高危命令真正执行

        不 mock 审批等待——真实 request_approval_and_wait 阻塞，
        线程模拟用户在 0.3s 后点「批准」（needs_you.approve），
        工具被唤醒并执行命令。
        """
        import threading
        import time

        from needs_you import (
            get_global_service,
            start_global_service,
            stop_global_service,
        )
        from strands_backend.tools import execute_via_ssh

        start_global_service()
        try:
            bridge = make_mock_rust_bridge()
            ctx = make_ctx(rust_bridge=bridge)

            def approve_later():
                time.sleep(0.3)
                svc = get_global_service()
                pending = [r for r in svc.list_all() if r.get("status") == "pending"]
                if pending:
                    svc.approve(pending[0]["id"])

            t = threading.Thread(target=approve_later, daemon=True)
            t.start()
            result = execute_via_ssh(ctx, "rm -rf /")
            t.join(timeout=5.0)

            self.assertEqual(result["status"], "success")
            bridge.ipc_invoke.assert_called_once()
        finally:
            stop_global_service()

    def test_real_approval_flow_reject_blocks(self):
        """P1-1 全链路：真实服务，用户拒绝 → 命令不执行"""
        import threading
        import time

        from needs_you import (
            get_global_service,
            start_global_service,
            stop_global_service,
        )
        from strands_backend.tools import execute_via_ssh

        start_global_service()
        try:
            bridge = make_mock_rust_bridge()
            ctx = make_ctx(rust_bridge=bridge)

            def reject_later():
                time.sleep(0.3)
                svc = get_global_service()
                pending = [r for r in svc.list_all() if r.get("status") == "pending"]
                if pending:
                    svc.reject(pending[0]["id"], reason="测试拒绝")

            t = threading.Thread(target=reject_later, daemon=True)
            t.start()
            result = execute_via_ssh(ctx, "rm -rf /")
            t.join(timeout=5.0)

            self.assertEqual(result["status"], "rejected")
            self.assertIn("拒绝", result["message"])
            bridge.ipc_invoke.assert_not_called()
        finally:
            stop_global_service()


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
        self.assertEqual(len(tools), 8)
        for t in tools:
            self.assertTrue(callable(t))

    def test_ops_tool_names_complete(self):
        """OPS_TOOL_NAMES 应包含 7 个工具名"""
        self.assertEqual(len(OPS_TOOL_NAMES), 8)
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
        adapter._agent_cache[("main", "s1", 2)] = mock_agent  # cache 键为 (agent_id, session_id) 元组
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
        adapter._agent_cache[("main", "s1", 2)] = mock_agent
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
        adapter._agent_cache[("main", "s1", 2)] = mock_agent
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
        adapter._agent_cache[("main", "s1", 2)] = mock_agent
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
# P0-1 多 agent 测试（方案书 B 方案，2026-08-01）
# ============================================================================

class TestAgentSwitchEmission(unittest.TestCase):
    """P0-1: invoke 按真实 agent 发 agent_switch（前端 Pill 与后端一致）

    取代旧 TestMainAgentRouting（关键词路由模拟已删除）：无论调用哪个
    agent_id，都 emit agent_switch(该 agent_id)——Pill 显示的就是真实
    正在运行的 Strands Agent。
    """

    def _adapter_with_mock_agent(self, agent_id: str = "main"):
        from strands_backend.adapter import StrandsAgentAdapter

        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)
        mock_response = MagicMock()
        mock_response.__str__ = MagicMock(return_value="回答内容")
        mock_response.metrics = {}
        mock_agent = MagicMock(return_value=mock_response)
        adapter._agent_cache[(agent_id, "s1", 2)] = mock_agent
        adapter._strands_available = True
        adapter._model_available = True
        return adapter, bus, mock_agent

    def test_invoke_teach_emits_agent_switch_teach(self):
        adapter, bus, _ = self._adapter_with_mock_agent("teach")
        adapter.invoke("teach", "解释一下什么是负载均衡", {"session_id": "s1"})
        bus.emit_agent_switch.assert_called_once()
        self.assertEqual(bus.emit_agent_switch.call_args.kwargs["agent"], "teach")

    def test_invoke_main_emits_agent_switch_main(self):
        adapter, bus, _ = self._adapter_with_mock_agent("main")
        adapter.invoke("main", "nginx 服务状态如何", {"session_id": "s1"})
        # P0-6: main invoke 发 2 次 agent_switch（开始 + 结束归位到 main）
        calls = bus.emit_agent_switch.call_args_list
        self.assertGreaterEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs["agent"], "main")
        self.assertEqual(calls[-1].kwargs["agent"], "main")

    def test_invoke_coding_no_role_hint_in_prompt(self):
        adapter, bus, mock_agent = self._adapter_with_mock_agent("coding")
        adapter.invoke("coding", "解释一下什么是负载均衡", {"session_id": "s1"})
        prompt = mock_agent.call_args[0][0]
        # 关键词路由模拟已移除：prompt 不再含"路由到 X"注入
        self.assertNotIn("路由到", prompt)
        self.assertEqual(bus.emit_agent_switch.call_args.kwargs["agent"], "coding")

    def test_unknown_agent_falls_back_to_main(self):
        adapter, bus, mock_agent = self._adapter_with_mock_agent("main")
        adapter.invoke("not_exist", "hello", {"session_id": "s1"})
        self.assertEqual(bus.emit_agent_switch.call_args.kwargs["agent"], "not_exist")


class TestSubAgentToolWhitelist(unittest.TestCase):
    """P0-1: 子 agent 工具白名单（schema-level safety，OPENDEV 范式）

    explore/teach 无 ssh_command（LLM 无法调用不存在于 schema 的执行
    工具）；coding 有 ssh_command；main 全量 7 工具。
    """

    def _ctx(self, level: int = 2):
        return ToolContext(
            event_bus=None,
            rust_bridge=make_mock_rust_bridge(),
            agent_name="x",
            session_id="s1",
            permission_level=level,
        )

    def _tool_names(self, tools) -> set[str]:
        return {getattr(t, "__name__", str(t)) for t in tools}

    def test_explore_is_readonly_no_ssh_command(self):
        from strands_backend.adapter import _SUB_AGENT_SPECS

        tools = make_all_ops_tools(
            self._ctx(),
            tool_names=_SUB_AGENT_SPECS["explore"]["tool_names"],
        )
        names = self._tool_names(tools)
        self.assertNotIn("ssh_command", names)
        self.assertNotIn("skill_invoke", names)
        self.assertIn("read_remote_file", names)
        self.assertIn("suggest_command", names)

    def test_teach_no_ssh_command_has_skill_invoke(self):
        from strands_backend.adapter import _SUB_AGENT_SPECS

        tools = make_all_ops_tools(
            self._ctx(),
            tool_names=_SUB_AGENT_SPECS["teach"]["tool_names"],
        )
        names = self._tool_names(tools)
        self.assertNotIn("ssh_command", names)
        self.assertIn("skill_invoke", names)
        self.assertIn("analyze_logs", names)

    def test_coding_has_ssh_command(self):
        from strands_backend.adapter import _SUB_AGENT_SPECS

        tools = make_all_ops_tools(
            self._ctx(),
            tool_names=_SUB_AGENT_SPECS["coding"]["tool_names"],
        )
        names = self._tool_names(tools)
        self.assertIn("ssh_command", names)
        self.assertIn("read_remote_file", names)

    def test_main_gets_all_tools(self):
        from strands_backend.adapter import _SUB_AGENT_SPECS

        tools = make_all_ops_tools(
            self._ctx(),
            tool_names=_SUB_AGENT_SPECS["main"]["tool_names"],
        )
        names = self._tool_names(tools)
        self.assertEqual(len(tools), 8)
        self.assertIn("ssh_command", names)

    def test_whitelist_composes_with_l1_readonly(self):
        # L1（免确认）+ explore 白名单：ssh_command 仍未出现，且总数 ≤ 只读 5
        from strands_backend.adapter import _SUB_AGENT_SPECS

        tools = make_all_ops_tools(
            self._ctx(level=1),
            tool_names=_SUB_AGENT_SPECS["explore"]["tool_names"],
        )
        names = self._tool_names(tools)
        self.assertNotIn("ssh_command", names)
        self.assertLessEqual(len(tools), 5)


# ============================================================================
# 输出脱敏测试（P1-v5-5）
# ============================================================================

class TestRedactSensitive(unittest.TestCase):
    """ssh 命令输出脱敏"""

    def _redact(self, text):
        from strands_backend.tools import redact_sensitive

        return redact_sensitive(text)

    def test_private_key_block_redacted(self):
        out = self._redact(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc123secret\n-----END OPENSSH PRIVATE KEY-----\n"
        )
        self.assertNotIn("abc123secret", out)
        self.assertIn("[REDACTED]", out)

    def test_password_assignment_redacted(self):
        out = self._redact("mysql -u root -pS3cretPw\nDB_PASSWORD=hunter2\n")
        self.assertNotIn("S3cretPw", out)
        self.assertNotIn("hunter2", out)

    def test_aws_access_key_redacted(self):
        out = self._redact("AKIAIOSFODNN7EXAMPLE\n")
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", out)

    def test_url_embedded_credentials_redacted(self):
        out = self._redact("git clone https://user:pass123@example.com/repo.git\n")
        self.assertNotIn("pass123", out)
        self.assertIn("user:***@", out)

    def test_bearer_token_redacted(self):
        out = self._redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc\n")
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", out)

    def test_normal_output_untouched(self):
        out = self._redact("load average: 0.08, 0.03, 0.05\n")
        self.assertEqual(out, "load average: 0.08, 0.03, 0.05\n")

    def test_empty_and_none_safe(self):
        self.assertEqual(self._redact(""), "")
        self.assertEqual(self._redact(None), None)

    def test_ssh_command_result_redacted(self):
        from strands_backend.tools import execute_via_ssh

        bridge = make_mock_rust_bridge()
        bridge.ipc_invoke.return_value = {
            "ok": True,
            "output": "DB_PASSWORD=hunter2\nuptime ok",
            "exit_code": 0,
            "duration": 0.1,
        }
        ctx = make_ctx(rust_bridge=bridge)
        result = execute_via_ssh(ctx=ctx, command="cat .env", ssh_session_id="1", timeout=10, tool_name="ssh_command")
        self.assertEqual(result["status"], "success")
        self.assertNotIn("hunter2", result["output"])
        self.assertIn("uptime ok", result["output"])


# ============================================================================
# 4 级权限测试（P1-v5-4）
# ============================================================================

class TestFourLevelPermission(unittest.TestCase):
    """execute_via_ssh 按 permission_level 决策审批"""

    def _run(self, command, level, output="ok"):
        from unittest.mock import patch

        from needs_you import NeedsYouStatus
        from strands_backend.tools import execute_via_ssh

        bridge = make_mock_rust_bridge()
        bridge.ipc_invoke.return_value = {
            "ok": True, "output": output, "exit_code": 0, "duration": 0.1,
        }
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.permission_level = level
        # P1-1: 审批等待 mock 为 TIMEOUT（语义 = 需审批但未响应 → needs_approval）
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.TIMEOUT),
        ):
            return execute_via_ssh(ctx=ctx, command=command, ssh_session_id="1", timeout=10, tool_name="ssh_command")

    def test_l1_read_auto(self):
        r = self._run("uptime", 1)
        self.assertEqual(r["status"], "success")

    def test_l1_write_auto(self):
        # L1 免确认：写操作也直接执行
        r = self._run("mv /a /b", 1)
        self.assertEqual(r["status"], "success")

    def test_l2_high_risk_approval_default(self):
        r = self._run("rm -rf /tmp/x", 2)
        self.assertEqual(r["status"], "needs_approval")

    def test_l2_write_auto(self):
        # L2 仅高危：写操作（非高危）自动执行（原行为）
        r = self._run("mv /a /b", 2)
        self.assertEqual(r["status"], "success")

    def test_l3_write_requires_approval(self):
        r = self._run("mv /a /b", 3)
        self.assertEqual(r["status"], "needs_approval")

    def test_l4_all_requires_approval(self):
        r = self._run("uptime", 4)
        self.assertEqual(r["status"], "needs_approval")

    def test_context_reads_permission_level_from_live(self):
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(event_bus=None, backend_enabled=False)
        ctx = adapter._build_tool_context("main", "s1", {"live": {"permissionLevel": "3"}})
        self.assertEqual(ctx.permission_level, 3)
        ctx2 = adapter._build_tool_context("main", "s1", {"live": {}})
        self.assertEqual(ctx2.permission_level, 2)
        ctx3 = adapter._build_tool_context("main", "s1", {"live": {"permissionLevel": "99"}})
        self.assertEqual(ctx3.permission_level, 4)


# ============================================================================
# schema-level safety 测试（P1-v5-2）
# ============================================================================

class TestSchemaLevelToolFilter(unittest.TestCase):
    """L1 免确认权限下执行类工具从 registry 移除"""

    def test_l1_removes_execution_tools(self):
        ctx = make_ctx()
        ctx.permission_level = 1
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertNotIn("ssh_command", names)
        self.assertNotIn("skill_invoke", names)
        self.assertIn("read_remote_file", names)
        self.assertIn("suggest_command", names)
        self.assertEqual(len(tools), 5)

    def test_l2_keeps_all_tools(self):
        ctx = make_ctx()
        ctx.permission_level = 2
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertIn("ssh_command", names)
        self.assertEqual(len(tools), 8)

    def test_default_level_keeps_all_tools(self):
        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        self.assertEqual(len(tools), 8)


# ============================================================================
# knowledge_search 工具测试（P2-4）
# ============================================================================

class TestKnowledgeSearchTool(unittest.TestCase):
    """知识库检索工具"""

    def _populate(self):
        """向全局 RAG 注入测试语料（隔离由 conftest 提供）"""
        from knowledge.fts5 import KnowledgeEntry
        from knowledge.rag import get_global_rag

        rag = get_global_rag()
        rag.add(KnowledgeEntry(
            title="systemctl 服务管理",
            content="systemctl 是 systemd 的服务管理命令，restart 停止再启动，reload 平滑重载。",
            source="test",
            tags=["systemd"],
        ))
        rag.add(KnowledgeEntry(
            title="nginx 配置",
            content="server 块监听端口，location 匹配 URL 规则。",
            source="test",
            tags=["nginx"],
        ))
        return rag

    def test_search_success(self):
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        self._populate()
        result = invoke_knowledge_search_tool({"query": "systemctl 服务"})
        self.assertEqual(result["status"], "success")
        self.assertGreaterEqual(result["count"], 1)
        self.assertTrue(any("systemctl" in r["title"] for r in result["results"]))

    def test_search_empty_query_error(self):
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        result = invoke_knowledge_search_tool({"query": "  "})
        self.assertEqual(result["status"], "error")

    def test_search_empty_kb(self):
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        result = invoke_knowledge_search_tool({"query": "不存在的主题xyzabc"})
        self.assertEqual(result["status"], "empty")

    def test_factory_returns_callable(self):
        from strands_backend.tools import make_all_ops_tools

        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertIn("knowledge_search", names)
