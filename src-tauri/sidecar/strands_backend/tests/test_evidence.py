"""
strands_backend/tests/test_evidence.py — 会话证据追踪器测试（P1-2）
====================================================================

覆盖：
1. record：会话隔离 / 字段截断 / 结果脱敏
2. list / clear / stats
3. 与 execute_via_ssh 集成：命令执行产生证据
4. 与 agent-as-tool 集成：子 agent 委派产生证据
"""
from __future__ import annotations

import unittest

from strands_backend.evidence import (
    EvidenceTracker,
    get_global_tracker,
    reset_global_tracker,
)


class TestEvidenceTracker(unittest.TestCase):
    def setUp(self):
        self.tracker = EvidenceTracker()

    def test_record_and_list(self):
        self.tracker.record(
            session_id="s1",
            tool_name="ssh_command",
            status="completed",
            detail="uptime",
            result={"ok": True, "output": "load average: 0.08", "exit_code": 0},
            agent="main",
        )
        evs = self.tracker.list("s1")
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["tool_name"], "ssh_command")
        self.assertEqual(evs[0]["status"], "completed")
        self.assertIn("load average", evs[0]["result"])

    def test_session_isolation(self):
        self.tracker.record(session_id="s1", tool_name="a", status="completed")
        self.tracker.record(session_id="s2", tool_name="b", status="completed")
        self.assertEqual(len(self.tracker.list("s1")), 1)
        self.assertEqual(len(self.tracker.list("s2")), 1)
        self.assertEqual(len(self.tracker.list("s3")), 0)

    def test_empty_session_skipped(self):
        self.assertIsNone(
            self.tracker.record(session_id="", tool_name="a", status="completed")
        )

    def test_result_redacted_and_summarized(self):
        self.tracker.record(
            session_id="s1",
            tool_name="ssh_command",
            status="completed",
            detail="cat /etc/passwd",
            result={"ok": True, "output": "root:x:0:0\nmysql -u root -pS3cretPw"},
        )
        ev = self.tracker.list("s1")[0]
        self.assertNotIn("S3cretPw", ev["result"])
        self.assertIn("root", ev["result"])

    def test_result_truncated(self):
        self.tracker.record(
            session_id="s1",
            tool_name="ssh_command",
            status="completed",
            detail="big output",
            result={"ok": True, "output": "x" * 5000},
        )
        ev = self.tracker.list("s1")[0]
        self.assertLessEqual(len(ev["result"]), 500)

    def test_clear_and_stats(self):
        self.tracker.record(session_id="s1", tool_name="a", status="completed")
        self.tracker.record(session_id="s1", tool_name="b", status="completed")
        self.tracker.record(session_id="s2", tool_name="c", status="completed")
        self.assertEqual(self.tracker.clear("s1"), 2)
        self.assertEqual(len(self.tracker.list("s1")), 0)
        stats = self.tracker.stats()
        self.assertEqual(stats["sessions"], 1)
        self.assertEqual(stats["total_evidence"], 1)

    def test_cap_per_session(self):
        for i in range(250):
            self.tracker.record(
                session_id="s1", tool_name="t", status="completed", detail=str(i)
            )
        self.assertLessEqual(len(self.tracker.list("s1")), 200)


class TestEvidenceIntegration(unittest.TestCase):
    """与工具/agent 链路集成"""

    def test_execute_via_ssh_produces_evidence(self):
        from unittest.mock import patch

        from strands_backend.tools import execute_via_ssh

        reset_global_tracker()
        bridge = __import__("unittest.mock", fromlist=["MagicMock"]).MagicMock()
        bridge.ipc_invoke.return_value = {
            "ok": True, "output": "total 4", "exit_code": 0, "duration": 0.1,
        }
        from strands_backend.tools import ToolContext

        ctx = ToolContext(
            event_bus=None,
            rust_bridge=bridge,
            agent_name="main",
            session_id="ev-s1",
            ssh_session_id="1",
            permission_level=2,
        )
        result = execute_via_ssh(ctx, "ls -la")
        self.assertEqual(result["status"], "success")
        tracker = get_global_tracker()
        evs = tracker.list("ev-s1")
        self.assertEqual(len(evs), 1)
        self.assertEqual(evs[0]["tool_name"], "ssh_command")
        self.assertEqual(evs[0]["detail"], "ls -la")

    def test_agent_delegation_produces_evidence(self):
        """P0-A1: 委派机制已删除——main handler 不再产生 agent: 前缀证据。

        原"子 agent 完成回填 → agent:teach 证据"用例随 agent-as-tool 委派
        机制删除；保留用例名验证 handler 构造不再需要 sub_agent_names，
        且普通 invoke 不产生 agent: 前缀证据（fail-safe 回归）。
        """
        from unittest.mock import MagicMock

        from strands_backend.adapter import TdsfStrandsCallbackHandler

        reset_global_tracker()
        bus = MagicMock()
        # P0-A1: handler 签名已无 sub_agent_names 参数
        handler = TdsfStrandsCallbackHandler(
            event_bus=bus,
            agent_name="main",
            session_id="ev-s2",
        )
        self.assertFalse(hasattr(handler, "sub_agent_names"))
        # main 事件流只发 agent_message/mood，无 agent: 前缀 tool_call
        handler(data="hello", start=True)
        bus.emit_tool_call.assert_not_called()
        tracker = get_global_tracker()
        self.assertEqual(tracker.list("ev-s2"), [])


if __name__ == "__main__":
    unittest.main()
