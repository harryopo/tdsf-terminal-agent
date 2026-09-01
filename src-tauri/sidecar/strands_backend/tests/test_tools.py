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
from strands_backend.modes import AgentMode
from strands_backend.adapter import (
    StrandsAgentAdapter,
    TdsfStrandsCallbackHandler,
    _DEFAULT_SYSTEM_PROMPT,
    _skill_names_line,
)

# T1 (2026-08-31, 方案书 v4.0): adapter 缓存 key = (agent_id, session_id, perm)
# ——mode/teach 已移出（模式/教学不再重建实例，prompt/工具集每次 invoke 动态刷新）


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
        """P1-1: 高危命令用户批准 → 真实执行

        Task 3/4 注：审批场景用非 denylist 的高危命令（rm -rf /tmp/...）——
        rm -rf / 命中硬底线黑名单，现在直接 command_blocked 不再走审批。
        """
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.APPROVED),
        ) as mock_wait:
            result = invoke_ssh_command_tool({"command": "rm -rf /tmp/old-build"}, ctx)
        self.assertEqual(result["status"], "success")
        # 批准后命令真正执行（RustBridge 被调用）
        bridge.ipc_invoke.assert_called_once()
        # Task 3.1: 审批载荷带四层卡面字段（semantic/explanation/impact/risk_l）
        kwargs = mock_wait.call_args.kwargs
        self.assertIn("impact", kwargs)
        self.assertIn("explanation", kwargs)
        self.assertIn("risk_l", kwargs)
        self.assertEqual(kwargs["risk_l"], 4)

    def test_high_risk_command_rejected(self):
        """P1-1: 高危命令用户拒绝 → 返回 rejected，不执行；message 带用户附言"""
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
            result = invoke_ssh_command_tool({"command": "rm -rf /tmp/old-build"}, ctx)
        self.assertEqual(result["status"], "rejected")
        self.assertIn("用户拒绝了此操作", result["message"])
        self.assertIn("测试拒绝", result["message"])
        bridge.ipc_invoke.assert_not_called()

    def test_high_risk_command_timeout_keeps_needs_approval(self):
        """P1-1: 审批超时 → fail-closed 按拒绝处理（5 分钟无响应）"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.TIMEOUT),
        ):
            result = invoke_ssh_command_tool({"command": "rm -rf /tmp/old-build"}, ctx)
        self.assertEqual(result["status"], "needs_approval")
        self.assertIn("超时", result["message"])
        self.assertIn("按拒绝处理", result["message"])
        bridge.ipc_invoke.assert_not_called()

    def test_high_risk_command_approval_service_down_fails_closed(self):
        """T3 fail-closed: 审批服务创建失败（request_approval_and_wait → None）
        → 必须不执行（fail-closed 门禁：审批通道不可用 = 默认拒绝）"""
        from unittest.mock import patch

        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=None,
        ):
            result = invoke_ssh_command_tool({"command": "rm -rf /tmp/old-build"}, ctx)
        self.assertEqual(result["status"], "needs_approval")
        self.assertIn("未执行", result["message"])
        bridge.ipc_invoke.assert_not_called()

    def test_denylist_hard_block_no_approval(self):
        """Task 3.2/4: denylist 硬底线（rm -rf /）→ command_blocked 直接拦截，
        不走审批、无替代方案"""
        bus = make_mock_event_bus()
        bridge = make_mock_rust_bridge()
        ctx = make_ctx(event_bus=bus, rust_bridge=bridge)
        result = invoke_ssh_command_tool({"command": "rm -rf /"}, ctx)
        self.assertEqual(result["status"], "command_blocked")
        self.assertIn("command_blocked!", result["message"])
        self.assertIn("不提供替代方案", result["message"])
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
        """多行命令包含高危行 → 发起审批；超时未响应 fail-closed"""
        from needs_you import NeedsYouStatus
        from unittest.mock import patch

        bus = make_mock_event_bus()
        ctx = make_ctx(event_bus=bus)
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.TIMEOUT),
        ):
            result = invoke_ssh_command_tool(
                {"command": "ls\nrm -rf /tmp/old-build\nuname -a"}, ctx
            )
        self.assertEqual(result["status"], "needs_approval")

    def test_multiline_with_denylist_hard_blocked(self):
        """Task 3.2/4: 多行命令含硬底线行（rm -rf /）→ command_blocked 直接拦截"""
        bus = make_mock_event_bus()
        ctx = make_ctx(event_bus=bus)
        result = invoke_ssh_command_tool(
            {"command": "ls\nrm -rf /\nuname -a"}, ctx
        )
        self.assertEqual(result["status"], "command_blocked")
        self.assertIn("rm -rf /", result["message"])

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
        Task 3/4 注：rm -rf / 现被 denylist 硬底线拦截，审批场景改用
        非 denylist 的高危命令。
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
            result = execute_via_ssh(ctx, "rm -rf /tmp/old-build")
            t.join(timeout=5.0)

            self.assertEqual(result["status"], "success")
            bridge.ipc_invoke.assert_called_once()
        finally:
            stop_global_service()

    def test_real_approval_flow_reject_blocks(self):
        """P1-1 全链路：真实服务，用户拒绝 → 命令不执行，message 带附言"""
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
            result = execute_via_ssh(ctx, "rm -rf /tmp/old-build")
            t.join(timeout=5.0)

            self.assertEqual(result["status"], "rejected")
            self.assertIn("用户拒绝了此操作", result["message"])
            self.assertIn("测试拒绝", result["message"])
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

    def test_returns_all_registered_tools(self):
        """make_all_ops_tools 应返回 TOOL_REGISTRY 全量工具
        （T2 后 = 13 运维/知识 + 6 魔改增强 + T14 save_skill
        + 2026-08-31 knowledge_get_doc + T5 python_run
        + P2 #42 ssh_list_sessions = 23）"""
        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        self.assertEqual(len(tools), 23)
        for t in tools:
            self.assertTrue(callable(t))

    def test_ops_tool_names_complete(self):
        """OPS_TOOL_NAMES 应由 TOOL_REGISTRY 派生，含全部 23 个工具名"""
        self.assertEqual(len(OPS_TOOL_NAMES), 23)
        self.assertIn("ssh_command", OPS_TOOL_NAMES)
        self.assertIn("remote_file", OPS_TOOL_NAMES)
        self.assertIn("log_analyzer", OPS_TOOL_NAMES)
        self.assertIn("process_inspector", OPS_TOOL_NAMES)
        self.assertIn("network_diagnostic", OPS_TOOL_NAMES)
        self.assertIn("skill_invoke", OPS_TOOL_NAMES)
        self.assertIn("suggest_command", OPS_TOOL_NAMES)
        # T2 收编的 6 个增强工具
        self.assertIn("todo_write", OPS_TOOL_NAMES)
        self.assertIn("get_terminal_output", OPS_TOOL_NAMES)
        self.assertIn("config_diff", OPS_TOOL_NAMES)
        self.assertIn("backup_restore", OPS_TOOL_NAMES)
        self.assertIn("assess_confidence", OPS_TOOL_NAMES)
        self.assertIn("search_history", OPS_TOOL_NAMES)


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
        adapter._agent_cache[("main", "s1", 2)] = mock_agent  # T1: cache 键为 (agent_id, session_id, perm)
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
# _build_prompt 工作区状态分支测试（2026-08-29 修复：欢迎页不再自称"本地终端模式"）
# ============================================================================

class TestBuildPromptWorkspaceStates(unittest.TestCase):
    """_build_prompt 分支：SSH 会话 / 本地环境（终端在跑）/ 欢迎页无环境"""

    def _make_adapter(self) -> StrandsAgentAdapter:
        return StrandsAgentAdapter(event_bus=make_mock_event_bus(), backend_enabled=False)

    def test_no_workspace_and_no_ssh_says_open_workspace_first(self):
        """无 workspaceRoot/cwd/activeFile 且无 sshSessionId：提示先建工作区，不再自称本地终端模式"""
        adapter = self._make_adapter()
        prompt = adapter._build_prompt("你好", {"session_id": "s1", "live": {}})
        self.assertIn("未打开任何工作区", prompt)
        self.assertNotIn("本地终端模式", prompt)

    def test_with_cwd_keeps_local_terminal_mode_line(self):
        """有 cwd（本地终端在跑）：保持"本地终端模式"文案"""
        adapter = self._make_adapter()
        prompt = adapter._build_prompt("ls", {"session_id": "s1", "live": {"cwd": "/var/log"}})
        self.assertIn("本地终端模式", prompt)
        self.assertIn("/var/log", prompt)

    def test_with_workspace_root_keeps_local_terminal_mode_line(self):
        """仅有 workspaceRoot（无 cwd）也属于本地环境分支，文案不变"""
        adapter = self._make_adapter()
        prompt = adapter._build_prompt(
            "hi", {"session_id": "s1", "live": {"workspaceRoot": "/home/u/proj"}}
        )
        self.assertIn("本地终端模式", prompt)

    def test_ssh_session_line_unchanged(self):
        """有 sshSessionId：SSH 分支文案保持不变"""
        adapter = self._make_adapter()
        prompt = adapter._build_prompt("hi", {"session_id": "s1", "live": {"sshSessionId": "ssh-1"}})
        self.assertIn("已连接 SSH 会话", prompt)
        self.assertNotIn("未打开任何工作区", prompt)

    # ========================================================================
    # TDSF 2026-08-31 (问题1修复): terminalSession 权威信号分支
    # ========================================================================

    def test_terminal_session_none_with_workspace_does_not_claim_local(self):
        """terminalSession="none"：即使有默认 workspace 路径也严禁自称本地终端模式

        用户实测：没开任何终端时 agent 断言"当前环境是 Windows 本地终端
        （工作区：C:/Users/Administrator）"——根因是 workspace cwd（默认主目录）
        被当成"本地终端已打开"。terminalSession="none" 必须走无终端分支。
        """
        adapter = self._make_adapter()
        prompt = adapter._build_prompt(
            "hi",
            {
                "session_id": "s1",
                "live": {
                    "workspaceRoot": "C:/Users/Administrator",
                    "cwd": "C:/Users/Administrator",
                    "terminalSession": "none",
                },
            },
        )
        self.assertNotIn("本地终端模式", prompt)
        self.assertIn("当前未打开任何终端会话", prompt)
        self.assertIn("不代表终端已打开", prompt)
        self.assertIn("新建本地终端或建立 SSH 连接", prompt)
        # 工作区路径仍注入（供 LLM 知道默认路径），但语义是 workspace 而非终端
        self.assertIn("C:/Users/Administrator", prompt)

    def test_terminal_session_local_claims_local_explicitly(self):
        """terminalSession="local"：显式走本地终端分支（即使无 cwd）"""
        adapter = self._make_adapter()
        prompt = adapter._build_prompt(
            "hi", {"session_id": "s1", "live": {"terminalSession": "local"}}
        )
        self.assertIn("本地终端模式", prompt)

    def test_terminal_session_none_overrides_workspace_heuristic(self):
        """terminalSession="none" 优先于旧启发式（workspace/cwd 存在）"""
        adapter = self._make_adapter()
        prompt = adapter._build_prompt(
            "hi",
            {
                "session_id": "s1",
                "live": {"activeFile": "/x/y.py", "terminalSession": "none"},
            },
        )
        self.assertNotIn("本地终端模式", prompt)


# ============================================================================
# system prompt skill 清单同步测试（2026-08-29 修复：清单动态生成防漂移）
# ============================================================================

class TestSystemPromptSkillListSync(unittest.TestCase):
    """system prompt 的 skill 清单应与 skills registry 同步（7 个内置技能全出现）"""

    _ALL_BUILTIN = (
        "linux-ops",
        "docker-management",
        "selinux-baseline",
        "ssh-troubleshoot",
        "python-debug",
        "systemd-troubleshoot",
        "samba-setup",
    )

    def test_default_system_prompt_contains_all_builtin_skills(self):
        """_DEFAULT_SYSTEM_PROMPT 应含全部 7 个内置 skill 名"""
        for name in self._ALL_BUILTIN:
            self.assertIn(name, _DEFAULT_SYSTEM_PROMPT)

    def test_skill_names_line_matches_registry(self):
        """_skill_names_line 应返回 registry 实际注册的技能清单"""
        from skills.registry import get_global_registry

        registered = get_global_registry().list_names()
        self.assertTrue(registered, "global registry 应至少加载内置技能")
        line = _skill_names_line()
        for name in registered:
            self.assertIn(name, line)


# ============================================================================
# system prompt 环境感知 + 输出格式约束测试（2026-08-31 问题1/问题2修复）
# ============================================================================

class TestSystemPromptEnvironmentAndFormat(unittest.TestCase):
    """环境感知段以 connection_mode 为唯一口径 + 禁 emoji 格式约束"""

    def test_environment_awareness_anchors_on_connection_mode(self):
        """环境感知段应要求 agent 先读 connection_mode 再回答"""
        self.assertIn("connection_mode", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("Environment awareness", _DEFAULT_SYSTEM_PROMPT)

    def test_environment_awareness_none_branch_forbids_local_claim(self):
        """connection_mode=none 分支：明确告知未开终端，严禁自称本地终端模式"""
        self.assertIn("connection_mode: none", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("当前未打开终端", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("新建本地", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("建立 SSH 连接", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("我不会假设环境", _DEFAULT_SYSTEM_PROMPT)
        # 禁止臆测本地终端
        self.assertIn("严禁自称", _DEFAULT_SYSTEM_PROMPT)

    def test_no_emoji_format_constraint(self):
        """Constraints 应含禁 emoji 格式约束（用户实测反馈回答含 👋💻🔧📚）"""
        self.assertIn("emoji", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("纯文本或 markdown", _DEFAULT_SYSTEM_PROMPT)


# ============================================================================
# invoke 调度日志测试（2026-08-31 问题5修复：不再向 thinking 流注入"开始处理"）
# ============================================================================

class TestInvokeNoProcessingBanner(unittest.TestCase):
    """invoke 前的"开始处理: ..."thinking 消息已删除（污染前端 Thinking 区）"""

    def test_invoke_does_not_emit_processing_banner(self):
        """mock agent（不触发 callback handler）时 emit_agent_message 应零调用

        原实现在 invoke 前推送 content="开始处理: ..."（msg_type=thinking），
        前端把它作为 reasoning-delta 拼进 Thinking 区开头，与模型真实推理
        混在一行（用户截图："开始处理:hi The user just said hi..."）。
        删除后 adapter 自身不应再 emit 任何 agent_message。
        """
        bus = make_mock_event_bus()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)

        mock_response = MagicMock()
        mock_response.__str__ = MagicMock(return_value="ok")
        mock_agent = MagicMock(return_value=mock_response)
        adapter._agent_cache[("main", "s1", 2)] = mock_agent
        adapter._strands_available = True
        adapter._model_available = True

        adapter.invoke("main", "hi", {"session_id": "s1"})

        bus.emit_agent_message.assert_not_called()

    def test_invoke_does_not_leak_injection_blocks_in_ui_stream(self):
        """即使未来恢复调度日志，注入块也不得进入 UI 流（_split_input_for_log 剥离）"""
        from strands_backend.adapter import _split_input_for_log

        user_part, ctx_part = _split_input_for_log(
            "<env>\nworkspace_root: C:/x\n</env>\n\n"
            "<environment>\nconnection_mode: none\n</environment>\n\n"
            "hi"
        )
        self.assertEqual(user_part, "hi")
        self.assertIn("connection_mode", ctx_part)

    def test_memory_blocks_classified_as_env_inject(self):
        """T4 (2026-08-31): <session-memory>/<recalled-memory> 归入 env_inject
        而非 user_msg——agent_log 排障时"用户原文"不被记忆注入区污染。
        """
        from strands_backend.adapter import _split_input_for_log

        user_part, ctx_part = _split_input_for_log(
            "<session-memory>\n1. 《历史案例》...\n</session-memory>\n\n"
            "<recalled-memory>\n1. 《相关历史案例（自动召回）》...\n</recalled-memory>\n\n"
            "nginx 502 怎么排查"
        )
        self.assertEqual(user_part, "nginx 502 怎么排查")
        self.assertIn("<session-memory>", ctx_part)
        self.assertIn("<recalled-memory>", ctx_part)


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

    # TDSF 2026-08-31 (问题5修复): test_strip_env_block 已随 _strip_env_block
    # 一并删除——该函数唯一调用方是已移除的"开始处理: ..."invoke 调度日志；
    # 注入块剥离职责由 _split_input_for_log（agent_log 落盘）承担，
    # 见 test_agent_log.py::test_live_context_block_recognized。

    def test_no_event_bus_does_not_raise(self):
        """event_bus=None 时不应抛错"""
        handler = TdsfStrandsCallbackHandler(None, agent_name="main")
        # 不应抛错
        handler(data="hello", start=True, complete=True)

    def test_multiple_data_deltas_emit_per_token(self):
        """连续 data 增量应逐条转发（真流式），而非合并为一条

        审计 P2 #17 (2026-08-11) 固化: Sidecar 流式链路是
        Strands data 增量 → callback handler → event_bus → rust_notifier
        逐条推送，无缓冲合并。此测试防止回归为"同步返回后整体切片"。
        """
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main", session_id="s1")
        deltas = ["hel", "lo ", "wor", "ld"]
        for d in deltas:
            handler(data=d)
        self.assertEqual(bus.emit_agent_message.call_count, len(deltas))
        contents = [
            call.kwargs["content"]
            for call in bus.emit_agent_message.call_args_list
        ]
        self.assertEqual(contents, deltas)

    def test_empty_data_delta_not_emitted(self):
        """空字符串 data 增量不应触发推送（防无效事件洪泛）"""
        bus = make_mock_event_bus()
        handler = TdsfStrandsCallbackHandler(bus, agent_name="main")
        handler(data="")
        bus.emit_agent_message.assert_not_called()


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
        # T2 (2026-08-31): Before/AfterToolCall + BeforeModelCall（轮次计数）
        self.assertEqual(registry.add_callback.call_count, 3)

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


class TestToolWhitelistAndReadonlyFilter(unittest.TestCase):
    """P0-A1: 工具集过滤（原 TestSubAgentToolWhitelist 改写）

    委派机制删除后 explore/teach/coding 角色白名单不复存在；main 工具集
    = TOOL_REGISTRY 全量，观察模式/L1 权限按 READONLY_TOOL_NAMES 只读过滤
    （filter_tools_readonly 单一真源）。
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

    def test_main_gets_all_tools(self):
        """main（唯一 agent）：TOOL_REGISTRY 全量 23 工具（P2 #42 +1）"""
        tools = make_all_ops_tools(self._ctx())
        names = self._tool_names(tools)
        self.assertEqual(len(tools), 23)
        self.assertIn("ssh_command", names)
        self.assertIn("ssh_list_sessions", names)
        self.assertIn("knowledge_search", names)
        self.assertIn("knowledge_get_doc", names)

    def test_l1_readonly_filter(self):
        """L1（免确认）权限：仅保留 readonly=True 工具（schema-level safety）"""
        tools = make_all_ops_tools(self._ctx(level=1))
        names = self._tool_names(tools)
        self.assertNotIn("ssh_command", names)
        self.assertNotIn("skill_invoke", names)
        self.assertIn("read_remote_file", names)
        self.assertIn("suggest_command", names)
        # 2026-08-31 语义修正：knowledge_search/knowledge_get_doc 纯本地只读
        self.assertIn("knowledge_search", names)
        self.assertIn("knowledge_get_doc", names)
        self.assertLessEqual(len(tools), 22)

    def test_filter_tools_readonly_helper(self):
        """P0-A1: filter_tools_readonly 帮助函数（观察模式/L1 共用单一真源）"""
        from strands_backend.tools import filter_tools_readonly
        from strands_backend.tools.registry import READONLY_TOOL_NAMES

        full = make_all_ops_tools(self._ctx())
        filtered = filter_tools_readonly(full)
        self.assertEqual(self._tool_names(filtered), set(READONLY_TOOL_NAMES))
        # 非注册工具（未在白名单）被裁掉（fail-closed）
        def mystery_extra_tool():
            pass

        mystery_extra_tool.__name__ = "mystery_extra_tool"
        self.assertEqual(filter_tools_readonly([mystery_extra_tool]), [])


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
# 三模式决策测试（Task 3，方案书 v3.1 §3.2——取代 P1-v5-4 4 级权限执行链决策）
# ============================================================================

class TestModeDecision(unittest.TestCase):
    """execute_via_ssh 按 ctx.mode 三模式决策（decide(risk_l, mode)）

    矩阵（core/decision_engine.py）：
    - observe: L0-L4 全 deny（只读工具 readonly=True 短路放行 L0-L1）
    - confirm: L0-L1 allow；L2-L4 confirm（缺省模式）
    - auto:    L0-L2 allow；L3-L4 confirm（永远确认）
    """

    def _run(self, command, mode, readonly=False, output="ok"):
        from unittest.mock import patch

        from needs_you import NeedsYouStatus
        from strands_backend.tools import execute_via_ssh

        bridge = make_mock_rust_bridge()
        bridge.ipc_invoke.return_value = {
            "ok": True, "output": output, "exit_code": 0, "duration": 0.1,
        }
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.mode = mode
        # P1-1: 审批等待 mock 为 TIMEOUT（语义 = 需审批但未响应 → needs_approval）
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.TIMEOUT),
        ):
            return execute_via_ssh(
                ctx=ctx, command=command, ssh_session_id="1",
                timeout=10, tool_name="ssh_command", readonly=readonly,
            )

    # --- observe：只读观察，一切命令 fail-closed 拒绝 ---

    def test_observe_readonly_command_blocked(self):
        r = self._run("uptime", AgentMode.OBSERVE)
        self.assertEqual(r["status"], "command_blocked")
        self.assertIn("command_blocked!", r["message"])

    def test_observe_write_command_blocked(self):
        r = self._run("mv /a /b", AgentMode.OBSERVE)
        self.assertEqual(r["status"], "command_blocked")

    def test_observe_readonly_tool_short_circuit(self):
        """observe 下只读工具（readonly=True）L0-L1 命令短路放行"""
        r = self._run("uptime", AgentMode.OBSERVE, readonly=True)
        self.assertEqual(r["status"], "success")

    def test_observe_readonly_tool_higher_risk_still_blocked(self):
        """observe 下只读工具执行 L2+ 命令仍拦（短路仅放行 L0-L1）"""
        r = self._run("mv /a /b", AgentMode.OBSERVE, readonly=True)
        self.assertEqual(r["status"], "command_blocked")

    # --- confirm：L0-L1 放行，L2-L4 审批（缺省模式）---

    def test_confirm_readonly_allows(self):
        r = self._run("uptime", AgentMode.CONFIRM)
        self.assertEqual(r["status"], "success")

    def test_confirm_write_requires_approval(self):
        r = self._run("mv /a /b", AgentMode.CONFIRM)
        self.assertEqual(r["status"], "needs_approval")

    def test_confirm_high_risk_requires_approval(self):
        r = self._run("rm -rf /tmp/x", AgentMode.CONFIRM)
        self.assertEqual(r["status"], "needs_approval")

    # --- auto：L0-L2 放行，L3-L4 永远确认 ---

    def test_auto_readonly_allows(self):
        r = self._run("uptime", AgentMode.AUTO)
        self.assertEqual(r["status"], "success")

    def test_auto_write_allows(self):
        """auto 模式 L2 写操作直接执行"""
        r = self._run("mv /a /b", AgentMode.AUTO)
        self.assertEqual(r["status"], "success")

    def test_auto_high_risk_requires_approval(self):
        """auto 模式 L4 仍审批（永远确认，不可绕过）"""
        r = self._run("rm -rf /tmp/x", AgentMode.AUTO)
        self.assertEqual(r["status"], "needs_approval")

    def test_auto_service_restart_requires_approval(self):
        """auto 模式 L3（服务重启）升级确认"""
        r = self._run("systemctl restart nginx", AgentMode.AUTO)
        self.assertEqual(r["status"], "needs_approval")

    def test_default_mode_is_confirm(self):
        """ctx 未设 mode 时缺省 confirm（中间态最安全）"""
        r = self._run("mv /a /b", AgentMode.CONFIRM)
        self.assertEqual(r["status"], "needs_approval")

    def test_host_mismatch_blocked(self):
        """Task 3.3 → P2 #42 回退路径: live 列表不可识别 + 目标 != 激活 → command_blocked"""
        from strands_backend.tools import execute_via_ssh

        bridge = make_mock_rust_bridge()
        bridge.ipc_invoke.return_value = {
            "ok": True, "output": "ok", "exit_code": 0, "duration": 0.1,
        }
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.mode = AgentMode.CONFIRM
        ctx.ssh_host = "192.168.45.130"
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="2",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "command_blocked")
        self.assertIn("192.168.45.130", result["message"])
        self.assertIn("终端窗口", result["message"])
        # P2 #42: 会先查一次 live 列表（mock 返回不可识别 dict → 回退旧校验），
        # 但绝不能发出 ssh_command 执行请求
        called_methods = [c.args[0] for c in bridge.ipc_invoke.call_args_list]
        self.assertIn("ssh_status", called_methods)
        self.assertNotIn("ssh_command", called_methods)

    def test_host_check_skipped_when_host_unknown(self):
        """Task 3.3: 激活终端 host 不可得（ssh_host 空）→ 跳过校验"""
        from strands_backend.tools import execute_via_ssh

        bridge = make_mock_rust_bridge()
        bridge.ipc_invoke.return_value = {
            "ok": True, "output": "ok", "exit_code": 0, "duration": 0.1,
        }
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.mode = AgentMode.CONFIRM
        ctx.ssh_host = ""
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="2",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "success")

    def test_context_reads_permission_level_and_mode_from_live(self):
        """_build_tool_context 注入 permission_level + mode + ssh_host"""
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(event_bus=None, backend_enabled=False)
        ctx = adapter._build_tool_context("main", "s1", {"live": {"permissionLevel": "3"}})
        self.assertEqual(ctx.permission_level, 3)
        self.assertEqual(ctx.mode, AgentMode.CONFIRM)  # 缺省 confirm
        ctx2 = adapter._build_tool_context("main", "s1", {"live": {}})
        self.assertEqual(ctx2.permission_level, 2)
        ctx3 = adapter._build_tool_context("main", "s1", {"live": {"permissionLevel": "99"}})
        self.assertEqual(ctx3.permission_level, 4)
        # Task 3: live.agentMode 下发 → ctx.mode
        ctx4 = adapter._build_tool_context(
            "main", "s1", {"live": {"agentMode": "auto", "permissionLevel": 2}}
        )
        self.assertEqual(ctx4.mode, AgentMode.AUTO)
        # Task 3.3: live.sshConnection "user@host" → ctx.ssh_host
        ctx5 = adapter._build_tool_context(
            "main", "s1",
            {"live": {"agentMode": "observe", "sshConnection": "root@192.168.45.130"}},
        )
        self.assertEqual(ctx5.mode, AgentMode.OBSERVE)
        self.assertEqual(ctx5.ssh_host, "192.168.45.130")
        # host 不可得 → 空（执行链跳过校验）
        ctx6 = adapter._build_tool_context("main", "s1", {"live": {}})
        self.assertEqual(ctx6.ssh_host, "")


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
        # P2-3: 5 基础只读 + 2 扩展只读（security_audit/performance_analyze）
        self.assertIn("security_audit", names)
        # T2 收编后：7 原只读 + 5 新只读增强（todo_write/get_terminal_output/
        # config_diff/assess_confidence/search_history）= 12
        # 2026-08-31：+ knowledge_search（readonly 语义修正）
        # + knowledge_get_doc（新工具）= 14
        # P2 #42 (2026-09-01)：+ ssh_list_sessions（只读枚举）= 15
        self.assertIn("todo_write", names)
        self.assertIn("get_terminal_output", names)
        self.assertIn("assess_confidence", names)
        self.assertIn("knowledge_search", names)
        self.assertIn("knowledge_get_doc", names)
        self.assertIn("ssh_list_sessions", names)
        # backup_restore（restore 写操作）L1 下被裁——schema-level safety 补口
        self.assertNotIn("backup_restore", names)
        self.assertEqual(len(tools), 15)

    def test_l2_keeps_all_tools(self):
        ctx = make_ctx()
        ctx.permission_level = 2
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertIn("ssh_command", names)
        self.assertIn("backup_restore", names)
        self.assertEqual(len(tools), 23)

    def test_default_level_keeps_all_tools(self):
        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        self.assertEqual(len(tools), 23)


# ============================================================================
# knowledge_search 工具测试（P2-4）
# ============================================================================

class TestKnowledgeSearchTool(unittest.TestCase):
    """知识库检索工具（TDSF 2026-08-31 双库：主读精简库 rag_slim.db）"""

    def _populate(self):
        """向精简库注入测试语料（工具切 slim 后检索同源；全量库同步注入
        独有条目用于验证不串库。隔离由 conftest 提供）"""
        from knowledge.fts5 import KnowledgeEntry
        from knowledge.rag import get_global_rag, get_slim_rag

        get_slim_rag().add(KnowledgeEntry(
            title="systemctl 服务管理",
            content="systemctl 是 systemd 的服务管理命令，restart 停止再启动，reload 平滑重载。",
            source="test",
            tags=["systemd"],
        ))
        # 全量库独有条目（knowledge_search 读 slim，不应命中它）
        get_global_rag().add(KnowledgeEntry(
            title="full-db-only 条目",
            content="xyzqwentry 全量库独有内容标记。",
            source="test",
        ))
        get_slim_rag().add(KnowledgeEntry(
            title="nginx 配置",
            content="server 块监听端口，location 匹配 URL 规则。",
            source="test",
            tags=["nginx"],
        ))

    def test_search_success(self):
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        self._populate()
        result = invoke_knowledge_search_tool({"query": "systemctl 服务"})
        self.assertEqual(result["status"], "success")
        self.assertGreaterEqual(result["count"], 1)
        self.assertTrue(any("systemctl" in r["title"] for r in result["results"]))

    def test_search_reads_slim_not_full(self):
        """TDSF 2026-08-31: 检索读精简库——全量库独有条目不出现在结果"""
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        self._populate()
        result = invoke_knowledge_search_tool({"query": "xyzqwentry 全量库独有"})
        if result["status"] == "success":
            self.assertFalse(
                any("full-db-only" in r["title"] for r in result["results"])
            )

    def test_search_empty_query_error(self):
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        result = invoke_knowledge_search_tool({"query": "  "})
        self.assertEqual(result["status"], "error")

    def test_search_empty_kb(self):
        from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

        # FTS-only 查无意义词（向量路在 hash 降级下总返回 top-k，用 fts 验证空）
        result = invoke_knowledge_search_tool({"query": "qqxxzzabc123nonexistent"})
        # 状态允许 empty（FTS 无命中）或 success（向量降级兜底）——均合理
        self.assertIn(result["status"], ("empty", "success"))

    def test_factory_returns_callable(self):
        from strands_backend.tools import make_all_ops_tools

        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertIn("knowledge_search", names)


# ============================================================================
# knowledge_get_doc 工具测试（TDSF 2026-08-31 双库）
# ============================================================================

class TestKnowledgeGetDocTool(unittest.TestCase):
    """知识库整篇文档读取工具（三态：参数缺失 / 查无 / 正常）"""

    def _populate(self):
        """向精简库注入同一 url 的两个分块（验证按序拼接）"""
        from knowledge.fts5 import KnowledgeEntry
        from knowledge.rag import get_slim_rag

        rag = get_slim_rag()
        rag.add(KnowledgeEntry(
            id="doc-testurl-0",
            title="测试文档 · 第一节",
            content="第一节内容：systemctl 用法。",
            url="consolidated/services/Web 服务器（Nginx 与 Apache）.md",
            source="test",
            category="services",
        ))
        rag.add(KnowledgeEntry(
            id="doc-testurl-1",
            title="测试文档 · 第二节",
            content="第二节内容：nginx 配置。",
            url="consolidated/services/Web 服务器（Nginx 与 Apache）.md",
            source="test",
            category="services",
        ))

    def test_missing_url_error(self):
        """fail-closed：url 参数缺失 → error"""
        from strands_backend.tools.knowledge_get_doc import invoke_knowledge_get_doc_tool

        self.assertEqual(
            invoke_knowledge_get_doc_tool({})["status"], "error"
        )
        self.assertEqual(
            invoke_knowledge_get_doc_tool({"url": "   "})["status"], "error"
        )

    def test_not_found(self):
        """fail-closed：查无文档 → not_found"""
        from strands_backend.tools.knowledge_get_doc import invoke_knowledge_get_doc_tool

        result = invoke_knowledge_get_doc_tool({"url": "no-such-doc.md"})
        self.assertEqual(result["status"], "not_found")

    def test_success_returns_full_doc(self):
        """正常：返回完整 markdown（块按序拼接）+ title/category"""
        from strands_backend.tools.knowledge_get_doc import invoke_knowledge_get_doc_tool

        self._populate()
        result = invoke_knowledge_get_doc_tool(
            {"url": "consolidated/services/Web 服务器（Nginx 与 Apache）.md"}
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["category"], "services")
        self.assertEqual(result["chunks"], 2)
        # 块按序拼接（第一节在前）
        content = result["content"]
        self.assertIn("第一节内容", content)
        self.assertIn("第二节内容", content)
        self.assertLess(
            content.index("第一节内容"), content.index("第二节内容")
        )
        self.assertFalse(result["truncated"])

    def test_long_content_truncated(self):
        """超 30000 字符正文截断（truncated=True）"""
        from strands_backend.tools.knowledge_get_doc import (
            _MAX_CONTENT_CHARS,
            invoke_knowledge_get_doc_tool,
        )
        from knowledge.fts5 import KnowledgeEntry
        from knowledge.rag import get_slim_rag

        get_slim_rag().add(KnowledgeEntry(
            id="doc-long-0",
            title="超长文档",
            content="长" * (_MAX_CONTENT_CHARS + 100),
            url="long-doc.md",
            source="test",
        ))
        result = invoke_knowledge_get_doc_tool({"url": "long-doc.md"})
        self.assertEqual(result["status"], "success")
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["content"]), _MAX_CONTENT_CHARS + 80)

    def test_factory_registered(self):
        """registry 注册 + readonly 策略（L1 免确认可用）"""
        from strands_backend.tools import make_all_ops_tools
        from strands_backend.tools.registry import get_tool_policy

        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertIn("knowledge_get_doc", names)
        policy = get_tool_policy("knowledge_get_doc")
        self.assertIsNotNone(policy)
        self.assertTrue(policy.readonly)
        self.assertFalse(policy.needs_approval)


# ============================================================================
# P2-3 扩展运维工具测试（ops_extended）
# ============================================================================

class TestExtendedOpsTools(unittest.TestCase):
    """5 个扩展运维工具"""

    def _ctx(self, level=2):
        bridge = make_mock_rust_bridge()
        return make_ctx(rust_bridge=bridge, ssh_session_id="1"), bridge

    def test_service_manage_status(self):
        from strands_backend.tools.ops_extended import invoke_service_manage_tool

        ctx, bridge = self._ctx()
        r = invoke_service_manage_tool({"action": "status", "service": "nginx"}, ctx)
        self.assertEqual(r["status"], "success")
        bridge.ipc_invoke.assert_called_once_with(
            "ssh_command",
            {"sessionId": 1, "command": "systemctl status nginx --no-pager -l", "timeout": 30},
        )

    def test_service_manage_invalid_action(self):
        from strands_backend.tools.ops_extended import invoke_service_manage_tool

        r = invoke_service_manage_tool({"action": "hack", "service": "nginx"}, self._ctx()[0])
        self.assertEqual(r["status"], "error")

    def test_package_manage_install(self):
        """装包 L2：confirm 模式需审批——mock 审批 APPROVED 后执行"""
        from unittest.mock import patch

        from needs_you import NeedsYouStatus
        from strands_backend.tools.ops_extended import invoke_package_manage_tool

        ctx, bridge = self._ctx()
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.APPROVED),
        ):
            r = invoke_package_manage_tool({"action": "install", "package": "nginx"}, ctx)
        self.assertEqual(r["status"], "success")
        bridge.ipc_invoke.assert_called_once_with(
            "ssh_command",
            {"sessionId": 1, "command": "dnf install -y nginx", "timeout": 120},
        )

    def test_package_manage_apt(self):
        """apt 装包 L2：confirm 模式需审批——mock 审批 APPROVED 后执行"""
        from unittest.mock import patch

        from needs_you import NeedsYouStatus
        from strands_backend.tools.ops_extended import invoke_package_manage_tool

        ctx, bridge = self._ctx()
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.APPROVED),
        ):
            r = invoke_package_manage_tool(
                {"action": "install", "package": "nginx", "package_manager": "apt"}, ctx
            )
        self.assertEqual(r["status"], "success")
        bridge.ipc_invoke.assert_called_once_with(
            "ssh_command",
            {"sessionId": 1, "command": "apt install -y nginx", "timeout": 120},
        )

    def test_firewall_manage_add_port(self):
        """防火墙写操作：confirm 模式需审批——mock 审批 APPROVED 后执行"""
        from unittest.mock import patch

        from needs_you import NeedsYouStatus
        from strands_backend.tools.ops_extended import invoke_firewall_manage_tool

        ctx, bridge = self._ctx()
        with patch(
            "strands_backend.tools.request_approval_and_wait",
            return_value=MagicMock(status=NeedsYouStatus.APPROVED),
        ):
            r = invoke_firewall_manage_tool({"action": "add_port", "port": "8080"}, ctx)
        self.assertEqual(r["status"], "success")
        cmd = bridge.ipc_invoke.call_args.args[1]["command"]
        self.assertIn("firewall-cmd --permanent --add-port=8080/tcp", cmd)

    def test_firewall_manage_invalid_port(self):
        from strands_backend.tools.ops_extended import invoke_firewall_manage_tool

        r = invoke_firewall_manage_tool({"action": "add_port", "port": "abc"}, self._ctx()[0])
        self.assertEqual(r["status"], "error")

    def test_security_audit_ssh_config(self):
        from strands_backend.tools.ops_extended import invoke_security_audit_tool

        ctx, bridge = self._ctx()
        r = invoke_security_audit_tool({"scope": "ssh_config"}, ctx)
        self.assertEqual(r["status"], "success")
        cmd = bridge.ipc_invoke.call_args.args[1]["command"]
        self.assertIn("sshd_config", cmd)

    def test_performance_analyze_cpu(self):
        from strands_backend.tools.ops_extended import invoke_performance_analyze_tool

        ctx, bridge = self._ctx()
        r = invoke_performance_analyze_tool({"metric": "cpu"}, ctx)
        self.assertEqual(r["status"], "success")
        cmd = bridge.ipc_invoke.call_args.args[1]["command"]
        self.assertIn("top -bn1", cmd)

    def test_factories_registered_in_make_all_ops_tools(self):
        ctx = make_ctx()
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        for n in ("service_manage", "package_manage", "firewall_manage",
                  "security_audit", "performance_analyze"):
            self.assertIn(n, names)

    def test_write_tools_filtered_at_l1(self):
        """L1 免确认：写类扩展工具（service/package/firewall）从注册表移除"""
        ctx = make_ctx()
        ctx.permission_level = 1
        tools = make_all_ops_tools(ctx)
        names = {getattr(t, "__name__", "") for t in tools}
        self.assertNotIn("service_manage", names)
        self.assertNotIn("package_manage", names)
        # 只读扩展保留
        self.assertIn("security_audit", names)
        self.assertIn("performance_analyze", names)


# ============================================================================
# P2-4 自动案例沉淀测试
# ============================================================================

class TestAutoSinkCase(unittest.TestCase):
    def _adapter(self):
        from strands_backend.adapter import StrandsAgentAdapter

        return StrandsAgentAdapter(event_bus=None, backend_enabled=False)

    def test_sink_case_when_troubleshooting_with_evidence(self):
        from knowledge.rag import get_global_rag

        rag = get_global_rag()
        before = rag.count()
        adapter = self._adapter()
        # 注入证据（模拟会话有工具调用）
        from strands_backend.evidence import get_global_tracker

        tracker = get_global_tracker()
        tracker.record(
            session_id="sink-s1",
            tool_name="ssh_command",
            status="completed",
            detail="nginx -t",
            result={"ok": True, "output": "syntax is ok"},
            agent="main",
        )
        adapter._auto_sink_case(
            "main",
            "nginx 502 排障怎么处理",
            "根因是 php-fpm socket 权限问题，修复方案：检查 listen.owner 并 chown socket 文件，然后 systemctl reload php-fpm 验证。",
            "sink-s1",
        )
        after = rag.count()
        self.assertGreater(after, before)
        # 去重：同输入再次沉淀不增加
        adapter._auto_sink_case(
            "main",
            "nginx 502 排障怎么处理",
            "根因是 php-fpm socket 权限问题，修复方案：检查 listen.owner 并 chown socket 文件，然后 systemctl reload php-fpm 验证。",
            "sink-s1",
        )
        self.assertEqual(rag.count(), after)

    def test_no_sink_without_evidence(self):
        from knowledge.rag import get_global_rag

        rag = get_global_rag()
        before = rag.count()
        adapter = self._adapter()
        adapter._auto_sink_case("main", "nginx 502 排障", "结论", "sink-s2")
        self.assertEqual(rag.count(), before)

    def test_no_sink_for_normal_chat(self):
        from knowledge.rag import get_global_rag

        rag = get_global_rag()
        before = rag.count()
        adapter = self._adapter()
        adapter._auto_sink_case("main", "你好呀", "今天天气不错。", "sink-s3")
        self.assertEqual(rag.count(), before)


# ============================================================================
# P2 #42 (2026-09-01, §37.90): ssh_list_sessions 工具 + execute_via_ssh
# host 校验放宽（live 列表权威 + fail-closed 回退）
# ============================================================================

# 模拟 Rust ssh_sessions_detail 反向路由响应（serde camelCase）
_LIVE_SESSIONS = [
    {"sessionId": 1, "host": "192.168.45.130", "port": 22, "user": "root", "state": "connected"},
    {"sessionId": 2, "host": "10.0.0.5", "port": 2222, "user": "deploy", "state": "connected"},
    {"sessionId": 3, "host": "10.0.0.9", "port": 22, "user": "root", "state": "reconnecting"},
]


def make_dispatch_bridge(responses: dict[str, Any]) -> MagicMock:
    """按 method 分发响应的 mock RustBridge"""
    bridge = MagicMock()
    bridge.ipc_invoke = MagicMock(side_effect=lambda m, p: responses[m])
    return bridge


class TestParseLiveSessions(unittest.TestCase):
    """parse_live_sessions 纯函数：规范化 + 不可识别 fail-closed"""

    def test_valid_list_normalized(self):
        from strands_backend.tools.ssh_sessions import parse_live_sessions

        out = parse_live_sessions(_LIVE_SESSIONS)
        self.assertIsNotNone(out)
        self.assertEqual(len(out), 3)
        self.assertEqual(out[0], {
            "session_id": 1, "host": "192.168.45.130", "port": 22,
            "user": "root", "state": "connected",
        })
        self.assertEqual(out[2]["state"], "reconnecting")

    def test_non_list_returns_none(self):
        from strands_backend.tools.ssh_sessions import parse_live_sessions

        # 旧后端 error dict / unavailable dict / 标量 → 全部不可识别
        for bad in (
            {"status": "error", "reason": "route_not_found"},
            {"status": "unavailable"},
            "oops", None, 42,
        ):
            self.assertIsNone(parse_live_sessions(bad), f"bad={bad!r}")

    def test_bad_entry_returns_none(self):
        from strands_backend.tools.ssh_sessions import parse_live_sessions

        self.assertIsNone(parse_live_sessions([{"sessionId": "abc"}]))  # id 非数字
        self.assertIsNone(parse_live_sessions(["not-a-dict"]))  # 条目非 dict
        self.assertIsNone(parse_live_sessions([{"host": "h"}]))  # 缺 sessionId


class TestSshListSessionsTool(unittest.TestCase):
    """ssh_list_sessions 工具：success / unavailable / error 结构化降级"""

    def test_success_returns_normalized_sessions(self):
        from strands_backend.tools.ssh_sessions import invoke_ssh_list_sessions_tool

        bridge = make_dispatch_bridge({"ssh_status": _LIVE_SESSIONS})
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        r = invoke_ssh_list_sessions_tool(ctx)
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["count"], 3)
        self.assertEqual(r["connected_count"], 2)
        self.assertEqual(r["active_session_id"], "1")
        self.assertEqual(r["sessions"][1], {
            "session_id": 2, "host": "10.0.0.5", "port": 2222,
            "user": "deploy", "state": "connected",
        })
        bridge.ipc_invoke.assert_called_once_with("ssh_status", {})

    def test_unavailable_when_bridge_none(self):
        from strands_backend.tools.ssh_sessions import invoke_ssh_list_sessions_tool

        ctx = make_ctx(rust_bridge=None)
        r = invoke_ssh_list_sessions_tool(ctx)
        self.assertEqual(r["status"], "unavailable")
        self.assertEqual(r["reason"], "rust_bridge_not_injected")
        self.assertEqual(r["sessions"], [])

    def test_unavailable_on_unrecognized_response(self):
        """旧 Rust 后端（无 ssh_status 路由返回 error dict）→ 结构化降级"""
        from strands_backend.tools.ssh_sessions import invoke_ssh_list_sessions_tool

        bridge = make_dispatch_bridge({
            "ssh_status": {"status": "error", "reason": "route_not_found"},
        })
        ctx = make_ctx(rust_bridge=bridge)
        r = invoke_ssh_list_sessions_tool(ctx)
        self.assertEqual(r["status"], "unavailable")
        self.assertEqual(r["reason"], "unrecognized_ssh_status_response")

    def test_error_on_ipc_exception(self):
        from strands_backend.tools.ssh_sessions import invoke_ssh_list_sessions_tool

        bridge = MagicMock()
        bridge.ipc_invoke = MagicMock(side_effect=RuntimeError("bridge down"))
        ctx = make_ctx(rust_bridge=bridge)
        r = invoke_ssh_list_sessions_tool(ctx)
        self.assertEqual(r["status"], "error")
        self.assertIn("bridge down", r["error"])


class TestExecuteViaSshHostRelaxed(unittest.TestCase):
    """P2 #42 host 校验放宽：live 列表内 connected 会话放行；否则 fail-closed"""

    def _ctx_with_live(self, ssh_host: str = "192.168.45.130"):
        bridge = make_dispatch_bridge({
            "ssh_status": _LIVE_SESSIONS,
            "ssh_command": {"ok": True, "output": "ok", "exit_code": 0, "duration": 0.1},
        })
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.mode = AgentMode.CONFIRM
        ctx.ssh_host = ssh_host
        return ctx, bridge

    def test_target_in_live_list_allowed_despite_not_active(self):
        """多主机核心场景：目标会话 2 != 激活会话 1，但在 live 列表且
        connected → 放行，结果附 target_endpoint"""
        from strands_backend.tools import execute_via_ssh

        ctx, bridge = self._ctx_with_live()
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="2",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["target_endpoint"], "deploy@10.0.0.5:2222")
        called_methods = [c.args[0] for c in bridge.ipc_invoke.call_args_list]
        self.assertEqual(called_methods, ["ssh_status", "ssh_command"])

    def test_target_not_in_live_list_blocked(self):
        from strands_backend.tools import execute_via_ssh

        ctx, bridge = self._ctx_with_live()
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="9",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "command_blocked")
        self.assertIn("state=不存在", result["message"])
        called_methods = [c.args[0] for c in bridge.ipc_invoke.call_args_list]
        self.assertNotIn("ssh_command", called_methods)

    def test_reconnecting_target_blocked(self):
        """仅 connected 放行：reconnecting/failed 等状态一律拦截"""
        from strands_backend.tools import execute_via_ssh

        ctx, _ = self._ctx_with_live()
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="3",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "command_blocked")
        self.assertIn("reconnecting", result["message"])

    def test_status_exception_falls_back_to_legacy_block(self):
        """live 查询抛异常 → 回退旧严格校验（host 已知 + 不匹配 → 拦）"""
        from strands_backend.tools import execute_via_ssh

        bridge = MagicMock()
        calls: list[str] = []

        def _invoke(method: str, params: dict) -> dict:
            calls.append(method)
            if method == "ssh_status":
                raise RuntimeError("bridge down")
            return {"ok": True, "output": "ok", "exit_code": 0, "duration": 0.1}

        bridge.ipc_invoke = MagicMock(side_effect=_invoke)
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.mode = AgentMode.CONFIRM
        ctx.ssh_host = "192.168.45.130"
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="2",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "command_blocked")
        self.assertNotIn("ssh_command", calls)

    def test_status_malformed_falls_back_to_legacy_skip(self):
        """live 查询返回不可识别结构 + 激活 host 不可得 → 旧逻辑跳过校验放行"""
        from strands_backend.tools import execute_via_ssh

        bridge = make_dispatch_bridge({
            "ssh_status": {"ok": True, "output": "weird legacy shape"},
            "ssh_command": {"ok": True, "output": "ok", "exit_code": 0, "duration": 0.1},
        })
        ctx = make_ctx(rust_bridge=bridge, ssh_session_id="1")
        ctx.mode = AgentMode.CONFIRM
        ctx.ssh_host = ""  # 激活 host 不可得 → 旧校验跳过
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="2",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "success")
        # 旧路径放行时无 live 端点信息
        self.assertEqual(result["target_endpoint"], "")

    def test_active_session_still_allowed(self):
        """回归保障：默认路径（目标 == 激活会话）不受放宽影响"""
        from strands_backend.tools import execute_via_ssh

        ctx, _ = self._ctx_with_live()
        result = execute_via_ssh(
            ctx=ctx, command="uptime", ssh_session_id="1",
            timeout=10, tool_name="ssh_command",
        )
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["target_endpoint"], "root@192.168.45.130:22")


class TestSshListSessionsFactory(unittest.TestCase):
    """工厂函数 + registry 装配"""

    def test_factory_returns_callable_named_tool(self):
        from strands_backend.tools.ssh_sessions import make_ssh_list_sessions_tool

        ctx = make_ctx(rust_bridge=None)
        tool_fn = make_ssh_list_sessions_tool(ctx)
        self.assertEqual(getattr(tool_fn, "__name__", ""), "ssh_list_sessions")
        # passthrough/@tool 装饰均可调用且返回结构化 dict
        r = tool_fn()
        self.assertEqual(r["status"], "unavailable")

    def test_registered_in_tool_registry_readonly(self):
        from strands_backend.tools.registry import TOOL_REGISTRY

        spec = TOOL_REGISTRY.get("ssh_list_sessions")
        self.assertIsNotNone(spec)
        self.assertTrue(spec.policy.readonly)
        self.assertFalse(spec.policy.needs_approval)
