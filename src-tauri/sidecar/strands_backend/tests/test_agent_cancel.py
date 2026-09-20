"""
strands_backend/tests/test_agent_cancel.py — #69 真取消 + 打断后衔接
==================================================================

用户口径（决策 4）：「真取消同意，但是要做好突然打断后又重新对话的衔接」。

Python 线程杀不掉，所以"真取消"落成三件可验证的事：
1. 该会话的循环护栏置熔断 → 之后的工具调用一律 cancel_tool（带停止原因）；
2. 挂在审批卡上的 needs-you 请求被结掉 → 阻塞等待的线程立刻醒来
   （不结的话取消要等满审批超时才传得进去，这是"点了停止却没停"的真因）；
3. 留一份中断现场 → 紧接的下一轮 prompt 带 <interrupted_task>，模型不会把
   "被打断"当成"已完成"，也不会自动重发上次没走完的写操作。

护栏/审批都用真对象（真 ToolCallLimitHook、真 NeedsYouService）——
项目里已踩过一次：假的 registry / 假的 bus 让断言永远绿。
"""
from __future__ import annotations

import threading
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    """隔离 agent_log 落盘目录 + 全局 needs_you / fix_loop 单例"""
    from fix_loop import reset_for_test as reset_fix_loop
    from needs_you import reset_for_test as reset_needs_you
    from strands_backend.agent_log import reset_for_test as reset_agent_log

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()
    yield
    reset_agent_log()
    reset_fix_loop()
    reset_needs_you()


def _hook(session_id: str = "s1", bus: MagicMock | None = None):
    from strands_backend.adapter import ToolCallLimitHook

    return ToolCallLimitHook(
        agent_name="main",
        event_bus=bus or MagicMock(),
        session_id=session_id,
    )


def _adapter(bus: MagicMock | None = None):
    from strands_backend.adapter import StrandsAgentAdapter

    return StrandsAgentAdapter(event_bus=bus or MagicMock(), backend_enabled=False)


def _tool_event(name: str = "ssh_command"):
    event = MagicMock()
    event.tool_use = {"name": name, "input": {"command": "ls"}}
    event.cancel_tool = False
    event.exception = None
    return event


class TestHookStop:
    def test_stop_cancels_subsequent_tool_calls_with_reason(self):
        hook = _hook()
        hook.round = 2
        hook.total_calls = 3

        snapshot = hook.request_user_stop("用户点击停止")

        assert hook.cancelled is True
        event = _tool_event()
        hook._before_tool_call(event)
        # 原因原文回传给模型（不是护栏熔断文案），且不进新工具计数
        assert event.cancel_tool == "用户点击停止"
        assert hook.total_calls == 3
        assert snapshot == {
            "agent": "main",
            "round": 2,
            "tool_count": 3,
            "last_tool": "",
            "reason": "用户点击停止",
        }

    def test_stop_emits_one_user_visible_notice(self):
        bus = MagicMock()
        hook = _hook(bus=bus)
        hook.round = 1
        hook.total_calls = 2
        hook.tool_log.append({"name": "ssh_command", "status": "success"})

        hook.request_user_stop("用户点击停止")
        hook.request_user_stop("用户又点了一次")  # 连点不刷屏

        assert bus.emit_agent_message.call_count == 1
        kwargs = bus.emit_agent_message.call_args.kwargs
        text = kwargs["content"]
        assert kwargs["message_type"] == "output"
        assert kwargs["session_id"] == "s1"
        assert text.startswith("[已停止] 用户点击停止")
        assert "第 1 轮" in text and "最后一步 ssh_command" in text
        assert "已经执行过的动作不会自动撤销" in text

    def test_reset_clears_stop_state_so_next_turn_runs_again(self):
        bus = MagicMock()
        hook = _hook(bus=bus)
        hook.request_user_stop("用户点击停止")

        hook.reset()

        assert hook.cancelled is False
        assert hook.cancel_reason == ""
        event = _tool_event()
        hook._before_tool_call(event)
        assert event.cancel_tool is False
        # 新一轮可以再回执一次（_stop_emitted 必须跟着 reset 清掉）
        hook.request_user_stop("第二次停止")
        assert bus.emit_agent_message.call_count == 2


class TestRequestCancel:
    def test_cancels_only_the_named_session_and_keeps_a_note(self):
        adapter = _adapter()
        hook_a = _hook("s1")
        hook_b = _hook("s2")
        adapter._limit_hooks[("main", "s1")] = hook_a
        adapter._limit_hooks[("main", "s2")] = hook_b

        out = adapter.request_cancel("s1", "用户点击停止")

        assert out["cancelled"] is True
        assert out["hooks"] == 1
        assert hook_a.cancelled is True
        assert hook_b.cancelled is False
        assert adapter._cancel_notes["s1"]["reason"] == "用户点击停止"

    def test_nothing_running_leaves_no_handoff_note(self):
        """没有东西被打断就不许留笔记 —— 否则下一轮会莫名看到"上次被打断"。"""
        adapter = _adapter()

        out = adapter.request_cancel("ghost-session", "用户点击停止")

        assert out["cancelled"] is False
        assert out["hooks"] == 0
        assert out["requests"] == 0
        assert adapter._cancel_notes == {}

    def test_empty_session_id_is_rejected_without_touching_hooks(self):
        adapter = _adapter()
        hook = _hook("s1")
        adapter._limit_hooks[("main", "s1")] = hook

        out = adapter.request_cancel("", "用户点击停止")

        assert out["cancelled"] is False
        assert hook.cancelled is False

    def test_wakes_a_thread_blocked_on_pending_approval(self):
        """取消必须立刻叫醒等审批的线程，而不是等满 5 分钟审批超时。"""
        import needs_you

        service = needs_you.get_global_service()
        req = service.request_approval(
            title="确认执行",
            description="rm -rf /tmp/tdsf-demo",
            session_id="s1",
        )
        outcome: dict[str, str] = {}

        def _wait() -> None:
            answered = service.wait_for_response(req.id, timeout=10)
            outcome["status"] = answered.status.value

        waiter = threading.Thread(target=_wait, daemon=True)
        waiter.start()
        try:
            waiter.join(0.3)
            assert waiter.is_alive(), "等审批的线程本该阻塞着"

            adapter = _adapter()
            out = adapter.request_cancel("s1", "用户点击停止")

            waiter.join(3)
            assert not waiter.is_alive(), "agent.cancel 没能叫醒审批等待线程"
            assert outcome["status"] == "cancelled"
            assert out["requests"] == 1
        finally:
            service.cancel(req.id, "test cleanup")


class TestHandoffNote:
    def test_next_prompt_carries_the_note_once(self):
        adapter = _adapter()
        adapter._cancel_notes["s1"] = {
            "agent": "main",
            "round": 2,
            "tool_count": 3,
            "last_tool": "ssh_command",
            "reason": "用户点击停止",
        }
        state = {"session_id": "s1", "live": {"cwd": "/tmp"}}

        first = adapter._build_prompt("继续", state)

        assert "<interrupted_task>" in first
        assert "第 2 轮 · 已调用 3 次工具（最后一步 ssh_command）" in first
        assert "不要自动重发" in first
        assert "先用只读命令核实现状" in first
        assert "<live_context>" in first  # 两段注入共存
        assert adapter._cancel_notes == {}

        second = adapter._build_prompt("继续", state)
        assert "<interrupted_task>" not in second

    def test_note_survives_when_no_live_context_is_known(self):
        adapter = _adapter()
        adapter._cancel_notes["s1"] = {"round": 1, "tool_count": 0, "reason": "停止"}

        prompt = adapter._build_prompt("继续", {"session_id": "s1"})

        assert "<interrupted_task>" in prompt

    def test_other_session_prompt_is_not_polluted(self):
        adapter = _adapter()
        adapter._cancel_notes["s1"] = {"round": 1, "tool_count": 0, "reason": "停止"}

        prompt = adapter._build_prompt("继续", {"session_id": "s2"})

        assert "<interrupted_task>" not in prompt
        assert "s1" in adapter._cancel_notes


class _RecordingLedger:
    """操作账本替身：只记录状态迁移，让审批分支能跑到 return 站点"""

    def __init__(self) -> None:
        self.states: list[str] = []

    def create_operation(self, **kwargs: object) -> dict[str, str]:
        return {"id": "op-cancel-1"}

    def transition_operation(
        self, operation_id: str, state: str, **kwargs: object
    ) -> None:
        self.states.append(state)


class TestCancelledApprovalBranch:
    def test_cancelled_approval_reads_as_stopped_not_timeout(self):
        """挂在审批卡上的命令被取消 → 回话要说"被停止"，命令不能派发。"""
        from unittest.mock import patch

        from needs_you import NeedsYouStatus
        from strands_backend.tools import ToolContext, execute_via_ssh

        req = MagicMock(id="req-cancelled")
        req.status = NeedsYouStatus.CANCELLED
        req.response = {}

        ctx = ToolContext(
            event_bus=MagicMock(),
            rust_bridge=MagicMock(),
            agent_name="cancel-branch-test",
            session_id="s1",
            ssh_session_id="1",
            permission_level=2,
        )
        ledger = _RecordingLedger()
        ctx.operation_service = ledger

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
        ), patch("strands_backend.tools.complete_approval_execution"):
            result = execute_via_ssh(ctx, "rm -rf /tmp/old")

        assert result["status"] == "rejected"
        message = result["message"]
        assert "停止了本次任务" in message
        # 关键区别：说"超时"模型会以为再等一次就能跑，说"停止"它才会收尾
        assert "超时" not in message
        assert "cancelled" in ledger.states
        ctx.rust_bridge.ipc_invoke.assert_not_called()


class TestFacadeRpc:
    def test_agent_cancel_is_registered_and_fail_soft_without_backend(self):
        import agent_facade as facade

        class FakeDispatcher:
            def __init__(self) -> None:
                self.methods: dict[str, object] = {}

            def register(self, name: str, handler: object) -> None:
                self.methods[name] = handler

        facade.reset_for_test()
        dispatcher = FakeDispatcher()
        facade.register_methods(dispatcher)
        try:
            assert "agent.cancel" in dispatcher.methods
            handler = dispatcher.methods["agent.cancel"]
            out = handler(session_id="s1", reason="用户点击停止")  # type: ignore[misc]
            assert out["cancelled"] is False
            assert out["session_id"] == "s1"
            assert facade.cancel_agent_session("s1")["cancelled"] is False
        finally:
            facade.reset_for_test()
