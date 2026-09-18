"""
strands_backend/tests/test_execution_gate_release.py — 审批执行门释放保证（深度体检 A3）
=========================================================================================

背景（为什么单独钉这一组测试）：
needs_you 的 execution_gate 审批在用户「批准」后**仍然占用该 session 的审批
队首**（needs_you.py:181 注释），必须等真正的执行路径调用 complete_execution
才放行下一条。这意味着：任何一条"批准后却提前 return / 抛异常"的路径都会把
该会话的审批队列永久卡死——用户再也看不到审批卡，agent 则一直等在队首后面。

needs_you.py:697 的契约写得很明白：「调用方必须在 Rust SSH 调用的 finally 中
调用」。但 execute_via_ssh 旧实现是在二十多个 return 站点上手工调
complete_approval_execution，其中"批准后账本迁移失败"那条直接 return 漏了释放。

本文件钉住修复后的保证：
1. _ExecutionGate 幂等——release 只生效一次（避免重复 complete 产生噪声警告）
2. 实现体抛异常 → 外壳 finally 仍释放
3. 正常返回 → 只释放一次（实现体内部释放后，外壳不重复释放）
4. 批准后账本迁移失败提前 return（旧缺陷现场）→ 照样释放

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_execution_gate_release.py -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from strands_backend.tools import (  # noqa: E402
    ToolContext,
    _ExecutionGate,
    execute_via_ssh,
)


def make_ctx(**kwargs: Any) -> ToolContext:
    """最小可用 ToolContext（事件总线/Rust 桥按需 mock）"""
    return ToolContext(
        event_bus=kwargs.get("event_bus", MagicMock()),
        rust_bridge=kwargs.get("rust_bridge", MagicMock()),
        agent_name="gate-test",
        session_id="s-gate",
        ssh_session_id="1",
        permission_level=2,
    )


class TestExecutionGateSemantics(unittest.TestCase):
    def test_release_calls_completion_once_only(self) -> None:
        """adopt 后 release 触发一次 complete；再次 release 不重复触发"""
        req = MagicMock(id="req-1")
        gate = _ExecutionGate()
        with patch(
            "strands_backend.tools.complete_approval_execution"
        ) as complete:
            gate.release()  # 未 adopt：什么都不该做
            self.assertEqual(complete.call_count, 0)

            gate.adopt(req)
            gate.release()
            gate.release()
            self.assertEqual(complete.call_count, 1)
            complete.assert_called_once_with(req)

    def test_adopt_replaces_pending_request(self) -> None:
        """同一 gate 只跟踪最后一次 adopt 的请求（外壳对每次调用新建 gate）"""
        first, second = MagicMock(id="a"), MagicMock(id="b")
        gate = _ExecutionGate()
        with patch(
            "strands_backend.tools.complete_approval_execution"
        ) as complete:
            gate.adopt(first)
            gate.adopt(second)
            gate.release()
        self.assertEqual(complete.call_count, 1)
        self.assertIs(complete.call_args.args[0], second)


class TestWrapperGuarantees(unittest.TestCase):
    def test_impl_exception_still_releases_gate(self) -> None:
        """A3 核心：实现体批准命令后抛异常，异常照旧上抛，但队首必须被释放"""
        from strands_backend.tools import _ExecutionGate as Gate

        req = MagicMock(id="req-boom")

        def boom(ctx: Any, command: Any, **kwargs: Any) -> Any:
            gate: Gate = kwargs["gate"]
            gate.adopt(req)
            raise RuntimeError("bridge exploded mid-execution")

        with patch(
            "strands_backend.tools._execute_via_ssh_impl", side_effect=boom
        ), patch(
            "strands_backend.tools.complete_approval_execution"
        ) as complete:
            with self.assertRaises(RuntimeError):
                execute_via_ssh(make_ctx(), "rm -rf /tmp/old")
        complete.assert_called_once_with(req)

    def test_normal_path_releases_exactly_once(self) -> None:
        """正常返回：实现体自己释放后，外壳 finally 不得重复释放"""
        req = MagicMock(id="req-ok")

        def ok(ctx: Any, command: Any, **kwargs: Any) -> Any:
            gate = kwargs["gate"]
            gate.adopt(req)
            gate.release()  # 模拟 _complete_after_execution 的正常释放
            return {"status": "success"}

        with patch(
            "strands_backend.tools._execute_via_ssh_impl", side_effect=ok
        ), patch(
            "strands_backend.tools.complete_approval_execution"
        ) as complete:
            result = execute_via_ssh(make_ctx(), "rm -rf /tmp/old")
        self.assertEqual(result["status"], "success")
        self.assertEqual(complete.call_count, 1)


class _LedgerThatFailsOnApproved:
    """操作账本替身：派发前状态可记，批准后的状态迁移抛错（触发旧缺陷路径）"""

    def create_operation(self, **kwargs: Any) -> dict[str, str]:
        return {"id": "op-1"}

    def transition_operation(self, operation_id: str, state: str, **kw: Any) -> None:
        if state == "approved":
            raise RuntimeError("ledger write rejected")


class TestApprovedEarlyReturnPath(unittest.TestCase):
    def test_approved_then_ledger_failure_releases_gate(self) -> None:
        """旧缺陷现场：用户已批准，账本迁移失败 → return error，队首必须被释放"""
        from needs_you import NeedsYouStatus

        req = MagicMock(id="req-ledger")
        req.status = NeedsYouStatus.APPROVED
        req.response = {}

        ctx = make_ctx()
        ctx.operation_service = _LedgerThatFailsOnApproved()

        assessment = {
            "decision": "confirm",
            "risk": {"level": "L4", "matched_rules": ["rm_rf"]},
            "impact": None,
            "risk_l": 4,
            "reason": "test",
        }
        with patch(
            "strands_backend.tools.assess_command", return_value=assessment
        ), patch(
            "strands_backend.tools.request_approval_and_wait", return_value=req
        ), patch(
            "strands_backend.tools.complete_approval_execution"
        ) as complete:
            result = execute_via_ssh(ctx, "rm -rf /tmp/old")

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["reason"], "operation_ledger_transition_failed")
        complete.assert_called_once_with(req)
        # 未派发命令（fail-closed）
        ctx.rust_bridge.ipc_invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()
