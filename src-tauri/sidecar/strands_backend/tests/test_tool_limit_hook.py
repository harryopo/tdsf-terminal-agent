"""
strands_backend/tests/test_tool_limit_hook.py — T2 循环护栏单测
==========================================================================

spec: add-agent-loop-closure Task 2（挂载 ToolCallLimitHook + 进度上报）

覆盖：
1. 连续失败 ≥3 熔断：cancelled 置位 + cancel_tool 带解释 + emit_agent_message
   推送用户可见解释（含失败工具名与错误摘要，只发一次防刷屏）
2. 总上限 50 不误杀：50 次成功调用全部放行；第 51 次熔断
3. 熔断后后续工具调用全部取消（循环停止语义）
4. loop_progress 落盘 agent_log（round/tool_count/tool_name/status）
5. loop_progress 前端推流（event_bus.emit_loop_progress）
6. reset 单任务语义（计数归零后重新放行）
7. round 轮次计数（BeforeModelCallEvent 模拟）

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_tool_limit_hook.py -v
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _isolate_agent_log(tmp_path, monkeypatch):
    """隔离：TDSF_DATA_DIR → tmp_path（loop_progress 落盘目标）"""
    from strands_backend.agent_log import reset_for_test

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    yield
    reset_for_test()


def _make_event(name="ssh_command", exception=None):
    """构造 hook 回调事件（MagicMock——直接调 hook 内部方法，不依赖 strands 执行）"""
    event = MagicMock()
    event.tool_use = {"name": name}
    event.cancel_tool = False
    event.exception = exception
    return event


def _make_hook(session_id="hook-s1", **kwargs) -> "ToolCallLimitHook":
    from strands_backend.adapter import ToolCallLimitHook

    return ToolCallLimitHook(
        agent_name="main",
        event_bus=MagicMock(),
        session_id=session_id,
        **kwargs,
    )


def _run_calls(hook, count, name="ssh_command", fail=False):
    """模拟 count 次工具调用（每次 before + after）"""
    for _ in range(count):
        before = _make_event(name)
        hook._before_tool_call(before)
        after = _make_event(name, exception=RuntimeError("boom") if fail else None)
        hook._after_tool_call(after)


# ============================================================================
# 1. 连续失败 ≥3 熔断（含用户可见解释）
# ============================================================================


class TestConsecutiveFailureBreaker:
    def test_breaker_trips_on_3_consecutive_failures(self):
        """同一工具连续失败 3 次后，第 4 次调用触发熔断（cancelled + 解释）"""
        hook = _make_hook()
        _run_calls(hook, 3, fail=True)

        before = _make_event("ssh_command")
        hook._before_tool_call(before)
        assert hook.cancelled is True
        # cancel_tool 为熔断解释（回传 LLM 的 tool result error，含失败次数）
        assert "连续失败" in before.cancel_tool
        assert "ssh_command" in before.cancel_tool

    def test_breaker_emits_visible_explanation_with_failure_detail(self):
        """熔断解释经 event_bus.emit_agent_message 推送（含工具名与错误摘要）"""
        hook = _make_hook()
        _run_calls(hook, 3, fail=True)
        hook._before_tool_call(_make_event("ssh_command"))

        bus = hook.event_bus
        bus.emit_agent_message.assert_called_once()
        kwargs = bus.emit_agent_message.call_args.kwargs
        text = kwargs["content"]
        assert "ssh_command" in text
        assert "boom" in text  # 错误摘要
        assert kwargs["message_type"] == "output"
        assert kwargs["session_id"] == "hook-s1"

    def test_breaker_explanation_emitted_only_once(self):
        """熔断后多次工具调用尝试不重复 emit（防刷屏）"""
        hook = _make_hook()
        _run_calls(hook, 3, fail=True)
        for _ in range(5):
            hook._before_tool_call(_make_event("ssh_command"))
        hook.event_bus.emit_agent_message.assert_called_once()

    def test_after_breaker_all_tools_cancelled(self):
        """熔断后任何工具调用都被取消（循环停止语义）"""
        hook = _make_hook()
        _run_calls(hook, 3, fail=True)
        hook._before_tool_call(_make_event("ssh_command"))  # 触发熔断

        other = _make_event("another_tool")
        hook._before_tool_call(other)
        assert other.cancel_tool is True
        assert hook.cancelled is True

    def test_success_resets_failure_streak(self):
        """失败 2 次 + 成功 1 次 → 计数重置，不熔断"""
        hook = _make_hook()
        _run_calls(hook, 2, fail=True)
        hook._after_tool_call(_make_event("ssh_command", exception=None))
        hook._before_tool_call(_make_event("ssh_command"))
        assert hook.cancelled is False


# ============================================================================
# 2. 总上限 50 不误杀
# ============================================================================


class TestTotalCallLimit:
    def test_50_calls_allowed_51st_breaks(self):
        """默认 50：第 50 次放行、第 51 次熔断"""
        hook = _make_hook()
        for i in range(50):
            before = _make_event(f"tool_{i}")
            hook._before_tool_call(before)
            assert not before.cancel_tool, f"call {i + 1} should pass"
            hook._after_tool_call(_make_event(f"tool_{i}"))

        assert hook.total_calls == 50
        before_51 = _make_event("tool_50")
        hook._before_tool_call(before_51)
        assert hook.cancelled is True
        assert "50" in before_51.cancel_tool

    def test_50_limit_is_per_invoke_after_reset(self):
        """reset（单任务语义）后 50 上限重新计算，不跨 invoke 累计误杀"""
        hook = _make_hook()
        _run_calls(hook, 50)  # 第一次 invoke 用满 50 次
        hook._before_tool_call(_make_event("over"))
        assert hook.cancelled is True

        hook.reset()  # 第二次 invoke 开始
        assert hook.cancelled is False
        assert hook.total_calls == 0
        _run_calls(hook, 50)  # 第二次 invoke 同样可用满 50 次
        assert hook.cancelled is False


# ============================================================================
# 3. loop_progress 进度上报（落盘 + 推流）
# ============================================================================


class TestLoopProgressReporting:
    def test_loop_progress_written_to_agent_log(self):
        """每次工具调用完成 → agent_log 落盘 loop_progress（含轮次/计数/状态）"""
        from strands_backend.agent_log import tail

        hook = _make_hook()
        hook._before_model_call(_make_event())  # round 1
        _run_calls(hook, 2)

        result = tail(session_id="hook-s1", lines=10)
        progress = [ln for ln in result["lines"] if ln["type"] == "loop_progress"]
        assert len(progress) == 2
        first = json.loads(progress[0]["content"])
        assert first["round"] == 1
        assert first["tool_count"] == 1
        assert first["tool_name"] == "ssh_command"
        assert first["status"] == "success"
        assert progress[0]["meta"]["agent"] == "main"

    def test_loop_progress_emitted_to_event_bus(self):
        """每次工具调用完成 → event_bus.emit_loop_progress（前端推流）"""
        hook = _make_hook()
        _run_calls(hook, 2)
        bus = hook.event_bus
        assert bus.emit_loop_progress.call_count == 2
        kwargs = bus.emit_loop_progress.call_args.kwargs
        assert kwargs["tool_count"] == 2
        assert kwargs["status"] == "success"
        assert kwargs["session_id"] == "hook-s1"

    def test_round_counts_llm_iterations(self):
        """round 由 BeforeModelCallEvent 计数（LLM 轮次）"""
        hook = _make_hook()
        hook._before_model_call(_make_event())
        hook._before_model_call(_make_event())
        _run_calls(hook, 1)
        kwargs = hook.event_bus.emit_loop_progress.call_args.kwargs
        assert kwargs["round"] == 2

    def test_breaker_progress_logged_with_status_breaker(self):
        """熔断解释落盘为 loop_progress（meta.status=breaker）"""
        from strands_backend.agent_log import tail

        hook = _make_hook()
        _run_calls(hook, 3, fail=True)
        hook._before_tool_call(_make_event("ssh_command"))

        result = tail(session_id="hook-s1", lines=10)
        breakers = [
            ln for ln in result["lines"]
            if ln["type"] == "loop_progress" and ln["meta"].get("status") == "breaker"
        ]
        assert len(breakers) == 1
        assert "ssh_command" in breakers[0]["content"]
        assert "boom" in breakers[0]["content"]

    def test_empty_session_skips_agent_log(self):
        """匿名 hook（无 session_id）不落盘 agent_log（防污染 default）"""
        from strands_backend.agent_log import tail

        hook = _make_hook(session_id="")
        _run_calls(hook, 2)
        result = tail(session_id="default", lines=10)
        assert result["returned"] == 0


# ============================================================================
# 4. adapter 挂载与单任务 reset（集成点）
# ============================================================================


class TestAdapterHookMounting:
    def test_default_limit_is_50(self):
        """adapter 常量与 hook 默认值均为 50（spec 单任务上限）"""
        from strands_backend.adapter import StrandsAgentAdapter, ToolCallLimitHook

        assert StrandsAgentAdapter.MAX_TOOL_CALLS == 50
        assert ToolCallLimitHook().max_tool_calls == 50

    def test_hook_cached_per_session(self):
        """hook 实例按 (agent_id, session_id) 缓存复用"""
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(event_bus=MagicMock(), backend_enabled=True)
        h1 = adapter._get_limit_hook("main", "s1")
        h2 = adapter._get_limit_hook("main", "s1")
        h_other = adapter._get_limit_hook("main", "s2")
        assert h1 is h2
        assert h1 is not h_other
        assert len(adapter._limit_hooks) == 2

    def test_hook_bound_event_bus_and_session(self):
        """hook 绑定 adapter 的 event_bus 与 session_id（熔断解释/进度推送路由正确）"""
        from strands_backend.adapter import StrandsAgentAdapter

        bus = MagicMock()
        adapter = StrandsAgentAdapter(event_bus=bus, backend_enabled=True)
        hook = adapter._get_limit_hook("main", "s9")
        assert hook.event_bus is bus
        assert hook.session_id == "s9"


if __name__ == "__main__":
    import unittest

    unittest.main()


# ===========================================================================
# #44 回归（2026-09-02）：用真实 strands 结果形状判定失败
# ===========================================================================
#
# 本文件其余用例喂的是 MagicMock 事件——`.status` 在 mock 上是属性、取得到值，
# 于是"hook 看不见工具失败"这个缺陷（#44）在单测里长期不可见。以下用例改用
# 实测到的真实形状（ToolResult 是 TypedDict dict；ops 工具的返回 dict 被
# strands JSON 序列化进 content 块文本），锁死这条契约。


def _real_event(payload: dict, name: str = "ssh_command"):
    """按 strands 真实形状造 AfterToolCallEvent 替身（dict，不是 MagicMock）"""
    from types import SimpleNamespace

    return SimpleNamespace(
        tool_use={"name": name, "input": {"command": "systemctl restart nginx"}},
        result={
            "toolUseId": "1-0",
            "status": "success",  # strands 外层恒 success（工具返回无 content 键）
            "content": [{"text": json.dumps(payload, ensure_ascii=False)}],
        },
        exception=None,
    )


class TestRealStrandsResultShape:
    def test_error_status_in_content_text_counts_as_failure(self):
        """工具自报 status=error 藏在 content 块文本里 → 计入失败并给出摘要"""
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook()
        hook._after_tool_call(_real_event({"status": "error", "error": "boom"}))
        assert hook.failures_by_tool["ssh_command"] == 1
        assert hook.tool_log[0]["success"] is False
        assert "boom" in hook._last_failure[1]

    def test_three_consecutive_failures_trip_breaker(self):
        """连续 3 次失败后，第 4 次调用前熔断（护栏真正生效的路径）"""
        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook(max_tool_calls=50, max_failures=3, session_id="")
        for _ in range(3):
            hook._before_tool_call(_real_event({"status": "error"}))
            hook._after_tool_call(_real_event({"status": "error"}))
        assert hook.cancelled is False
        fourth = _real_event({"status": "error"})
        hook._before_tool_call(fourth)
        assert hook.cancelled is True
        assert fourth.cancel_tool

    def test_blocked_and_rejected_count_as_failure(self):
        """ssh_command 的非 error 失败态同样算失败；success 不涨计数"""
        from strands_backend.adapter import ToolCallLimitHook

        for status in ("command_blocked", "rejected", "needs_approval", "unavailable"):
            hook = ToolCallLimitHook()
            hook._after_tool_call(_real_event({"status": status}))
            assert hook.failures_by_tool["ssh_command"] == 1, status

        ok = ToolCallLimitHook()
        ok._after_tool_call(_real_event({"status": "success", "exit_code": 0}))
        assert ok.failures_by_tool.get("ssh_command", 0) == 0
        assert ok.tool_log[0]["success"] is True

    def test_plain_text_result_is_not_failure(self):
        """纯文本结果（非 JSON 对象）无状态信号 → 不误判为失败"""
        from types import SimpleNamespace

        from strands_backend.adapter import ToolCallLimitHook

        hook = ToolCallLimitHook()
        hook._after_tool_call(SimpleNamespace(
            tool_use={"name": "read_remote_file", "input": {}},
            result={"toolUseId": "1-0", "status": "success", "content": [{"text": "file body"}]},
            exception=None,
        ))
        assert hook.failures_by_tool.get("read_remote_file", 0) == 0
