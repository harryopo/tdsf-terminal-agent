"""
strands_backend/tests/test_verify_followup.py — T7 执行后验证回环单测
==========================================================================

spec: add-agent-loop-closure Task 7（写后必须只读验证 + 收尾检测追加轮）

覆盖：
1. 工具分类常量与 TOOL_REGISTRY 对齐（写类/验证类工具名均真实注册）
2. "写后未验证"判定纯函数 _needs_verify_followup：
   - 写后无验证 → 触发
   - 写后有验证（含 ssh_command 只读命令验证）→ 不触发
   - 纯读会话 → 不触发
   - 写类调用失败（被拦截/拒绝）→ 不算写成功，不触发
   - ssh_command 只读命令不算写（命令级细分，防纯查询误报）
3. hook tool_log：_after_tool_call 逐次记录 name/input/success；reset 清空
4. adapter._maybe_verify_followup：触发追加一轮（fake agent 可调用断言）；
   限一次（会话级 flag）；空 session 不触发；判定不满足不触发；
   追加轮异常降级返回空串；verify_followup 事件落盘 agent_log
5. 系统提示含 Post-change verification 行动段
6. 与 T3 追加轮独立计数（todo followup 触发后 verify 仍可触发）

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_verify_followup.py -v
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

import pytest

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)


@pytest.fixture(autouse=True)
def _isolate_env(tmp_path, monkeypatch):
    from strands_backend.agent_log import reset_for_test
    from strands_backend.tools.todo_write import reset_session_todos

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path))
    reset_for_test()
    reset_session_todos()
    yield
    reset_for_test()
    reset_session_todos()


def _entry(name, success=True, **input_kwargs):
    """构造 tool_log 条目"""
    return {"name": name, "input": dict(input_kwargs), "success": success}


def _make_adapter():
    """构建 adapter（无真实 model，仅方法级测试用）"""
    from strands_backend.adapter import StrandsAgentAdapter

    adapter = StrandsAgentAdapter(
        event_bus=MagicMock(),
        rust_bridge=MagicMock(),
        backend_enabled=True,
    )
    return adapter


class _FakeAgent:
    """fake strands_agent：记录调用并返回可断言文本"""

    def __init__(self, reply="verify-done"):
        self.reply = reply
        self.calls: list[str] = []

    def __call__(self, prompt):
        self.calls.append(prompt)
        return self.reply


# ============================================================================
# 1. 分类常量与注册表对齐
# ============================================================================


class TestToolClassification:
    def test_class_sets_subset_of_registry(self):
        """写类/验证类工具名均真实注册在 TOOL_REGISTRY（防拼写漂移）"""
        from strands_backend.tools import TOOL_REGISTRY
        from strands_backend.tools import (
            VERIFY_CLASS_TOOL_NAMES,
            WRITE_CLASS_TOOL_NAMES,
        )

        assert WRITE_CLASS_TOOL_NAMES <= set(TOOL_REGISTRY.keys())
        assert VERIFY_CLASS_TOOL_NAMES <= set(TOOL_REGISTRY.keys())

    def test_class_sets_disjoint(self):
        """写类与验证类不相交（ssh_command 的双身份由命令级细分处理）"""
        from strands_backend.tools import (
            VERIFY_CLASS_TOOL_NAMES,
            WRITE_CLASS_TOOL_NAMES,
        )

        assert not (WRITE_CLASS_TOOL_NAMES & VERIFY_CLASS_TOOL_NAMES)

    def test_spec_mandated_tools_covered(self):
        """spec 钦定清单对齐：ssh_command/python_run 写类；
        read_remote_file/get_terminal_output/knowledge_search 验证类"""
        from strands_backend.tools import (
            VERIFY_CLASS_TOOL_NAMES,
            WRITE_CLASS_TOOL_NAMES,
        )

        assert "ssh_command" in WRITE_CLASS_TOOL_NAMES
        assert "python_run" in WRITE_CLASS_TOOL_NAMES
        assert "read_remote_file" in VERIFY_CLASS_TOOL_NAMES
        assert "get_terminal_output" in VERIFY_CLASS_TOOL_NAMES
        assert "knowledge_search" in VERIFY_CLASS_TOOL_NAMES


# ============================================================================
# 2. 判定纯函数 _needs_verify_followup
# ============================================================================


class TestNeedsVerifyJudgment:
    def test_write_without_verify_triggers(self):
        """写后无验证 → 触发"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", command="systemctl restart nginx"),
            _entry("ssh_command", command="systemctl restart httpd"),
        ]
        assert _needs_verify_followup(log) is True

    def test_write_followed_by_verify_not_triggers(self):
        """写后有验证（read_remote_file）→ 不触发"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", command="systemctl restart nginx"),
            _entry("read_remote_file", path="/etc/nginx/nginx.conf"),
        ]
        assert _needs_verify_followup(log) is False

    def test_write_followed_by_readonly_ssh_command_not_triggers(self):
        """写后用 ssh_command 只读命令验证（systemctl status）→ 不触发"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", command="systemctl restart nginx"),
            _entry("ssh_command", command="systemctl status nginx"),
        ]
        assert _needs_verify_followup(log) is False

    def test_pure_readonly_session_not_triggers(self):
        """纯读会话（只读命令/只读工具）→ 不触发"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", command="systemctl status nginx"),
            _entry("read_remote_file", path="/etc/hosts"),
            _entry("get_terminal_output"),
        ]
        assert _needs_verify_followup(log) is False

    def test_failed_write_not_triggers(self):
        """写类调用失败（被拦截/异常）→ 不算写成功，不触发"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", success=False, command="systemctl restart nginx"),
        ]
        assert _needs_verify_followup(log) is False

    def test_write_class_tools_by_name_triggers(self):
        """非 ssh_command 的写类工具（python_run/service_manage）成功 → 触发"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("python_run", code="open('x','w').close()"),
            _entry("service_manage", action="restart", service="nginx"),
        ]
        assert _needs_verify_followup(log) is True

    def test_verify_then_write_triggers(self):
        """先验证后写（验证在写之前）→ 仍触发（写后必须有验证）"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", command="systemctl status nginx"),
            _entry("ssh_command", command="systemctl restart nginx"),
        ]
        assert _needs_verify_followup(log) is True

    def test_write_verify_write_triggers(self):
        """写-验证-写（最后仍是写）→ 触发（最后一次写之后无验证）"""
        from strands_backend.adapter import _needs_verify_followup

        log = [
            _entry("ssh_command", command="systemctl restart nginx"),
            _entry("ssh_command", command="systemctl status nginx"),
            _entry("ssh_command", command="echo hi >> /etc/hosts"),
        ]
        assert _needs_verify_followup(log) is True

    def test_empty_log_not_triggers(self):
        """空调用流水 → 不触发"""
        from strands_backend.adapter import _needs_verify_followup

        assert _needs_verify_followup([]) is False

    def test_systemctl_status_is_not_write_pattern(self):
        """RiskChecker 写模式不误伤只读命令（status/cat/ls）"""
        from strands_backend.adapter import (
            _tool_call_is_verify_class,
            _tool_call_is_write_class,
        )

        assert _tool_call_is_write_class("ssh_command", {"command": "systemctl status nginx"}) is False
        assert _tool_call_is_verify_class("ssh_command", {"command": "systemctl status nginx"}) is True
        assert _tool_call_is_write_class("ssh_command", {"command": "cat /etc/hosts"}) is False
        assert _tool_call_is_write_class("ssh_command", {"command": "systemctl restart nginx"}) is True


# ============================================================================
# 3. hook tool_log 记录
# ============================================================================


class TestHookToolLog:
    def _make_hook(self):
        from strands_backend.adapter import ToolCallLimitHook

        return ToolCallLimitHook(
            agent_name="main", event_bus=MagicMock(), session_id="t7-hook"
        )

    def _make_event(self, name, command=None, exception=None):
        event = MagicMock()
        tool_use = {"name": name}
        if command is not None:
            tool_use["input"] = {"command": command}
        event.tool_use = tool_use
        event.cancel_tool = False
        event.exception = exception
        return event

    def test_after_tool_call_appends_log(self):
        """每次工具调用完成 → tool_log 追加 name/input/success"""
        hook = self._make_hook()
        hook._after_tool_call(self._make_event("ssh_command", "systemctl restart nginx"))
        hook._after_tool_call(
            self._make_event("read_remote_file", exception=RuntimeError("boom"))
        )

        assert len(hook.tool_log) == 2
        first, second = hook.tool_log
        assert first["name"] == "ssh_command"
        assert first["input"] == {"command": "systemctl restart nginx"}
        assert first["success"] is True
        assert second["success"] is False

    def test_reset_clears_tool_log(self):
        """reset（单任务语义）清空 tool_log"""
        hook = self._make_hook()
        hook._after_tool_call(self._make_event("ssh_command", "true"))
        hook.reset()
        assert hook.tool_log == []

    def test_tool_log_feeds_needs_verify(self):
        """tool_log 直接喂判定：写后未验证触发"""
        from strands_backend.adapter import _needs_verify_followup

        hook = self._make_hook()
        hook._after_tool_call(self._make_event("ssh_command", "systemctl restart nginx"))
        assert _needs_verify_followup(hook.tool_log) is True


# ============================================================================
# 4. adapter._maybe_verify_followup（追加轮行为）
# ============================================================================


class TestVerifyFollowupOnAdapter:
    def test_write_without_verify_triggers_followup_round(self):
        """写后未验证 → fake agent 被追加调用一次，返回其文本"""
        adapter = _make_adapter()
        agent = _FakeAgent("verify-ok")
        log = [_entry("ssh_command", command="systemctl restart nginx")]

        result = adapter._maybe_verify_followup(agent, "main", "t7-f1", log)
        assert result == "verify-ok"
        assert len(agent.calls) == 1
        assert "验证" in agent.calls[0]

    def test_followup_only_once_per_session(self):
        """限一次：第二次调用（同会话）不再追加"""
        adapter = _make_adapter()
        agent = _FakeAgent()
        log = [_entry("ssh_command", command="systemctl restart nginx")]

        adapter._maybe_verify_followup(agent, "main", "t7-f2", log)
        adapter._maybe_verify_followup(agent, "main", "t7-f2", log)
        assert len(agent.calls) == 1

    def test_no_write_no_followup(self):
        """纯读会话 → 不追加"""
        adapter = _make_adapter()
        agent = _FakeAgent()
        log = [_entry("read_remote_file", path="/etc/hosts")]

        result = adapter._maybe_verify_followup(agent, "main", "t7-f3", log)
        assert result == ""
        assert agent.calls == []

    def test_verified_write_no_followup(self):
        """写后有验证 → 不追加"""
        adapter = _make_adapter()
        agent = _FakeAgent()
        log = [
            _entry("ssh_command", command="systemctl restart nginx"),
            _entry("ssh_command", command="systemctl status nginx"),
        ]

        result = adapter._maybe_verify_followup(agent, "main", "t7-f4", log)
        assert result == ""

    def test_empty_session_no_followup(self):
        """空 session → 不追加（匿名调用无会话归属）"""
        adapter = _make_adapter()
        agent = _FakeAgent()
        log = [_entry("ssh_command", command="systemctl restart nginx")]

        result = adapter._maybe_verify_followup(agent, "main", "", log)
        assert result == ""
        assert agent.calls == []

    def test_followup_failure_returns_empty(self):
        """追加轮异常 → 降级返回空串（调用方沿用主轮结果），不抛错"""
        adapter = _make_adapter()

        def exploding_agent(prompt):
            raise RuntimeError("verify round exploded")

        log = [_entry("ssh_command", command="systemctl restart nginx")]
        result = adapter._maybe_verify_followup(
            exploding_agent, "main", "t7-f5", log
        )
        assert result == ""

    def test_followup_prompt_logged_to_agent_log(self):
        """追加轮注入内容落盘 verify_followup 事件"""
        from strands_backend.agent_log import tail

        adapter = _make_adapter()
        agent = _FakeAgent()
        log = [
            _entry("ssh_command", command="systemctl restart nginx"),
        ]
        adapter._maybe_verify_followup(agent, "main", "t7-f6", log)

        result = tail(session_id="t7-f6", lines=20)
        events = [ln for ln in result["lines"] if ln["type"] == "verify_followup"]
        assert len(events) == 1
        assert "未经验证不得声称操作成功" in events[0]["content"]
        assert "只读工具验证" in events[0]["content"]

    def test_independent_from_todo_followup_flag(self):
        """与 T3 独立计数：todo 追加已触发不挤占 verify 追加机会"""
        adapter = _make_adapter()
        agent = _FakeAgent()
        # T3 flag 已置位
        adapter._todo_followup_done.add(("main", "t7-f7"))
        log = [_entry("ssh_command", command="systemctl restart nginx")]

        result = adapter._maybe_verify_followup(agent, "main", "t7-f7", log)
        assert result == "verify-done"
        assert len(agent.calls) == 1


# ============================================================================
# 5. 系统提示行动段
# ============================================================================


class TestSystemPromptVerificationSection:
    def test_default_prompt_contains_verification_constraint(self):
        """系统提示含 T7 行动段：写后必须只读验证，未验证不得声称成功

        2026-09-01 精简改写（4000 字符预算）：'凡执行写操作…验证结果' →
        '写操作…用只读工具验证'，断言同步为改写后的稳定短语。
        """
        from strands_backend.adapter import _DEFAULT_SYSTEM_PROMPT

        assert "写操作（写文件/改配置/修改类命令）" in _DEFAULT_SYSTEM_PROMPT
        assert "未验证不得声称成功" in _DEFAULT_SYSTEM_PROMPT
        assert "只读工具验证" in _DEFAULT_SYSTEM_PROMPT

    def test_prompt_mentions_playbook(self):
        """系统提示含 T6 剧本指引（skill_invoke 返回 playbook_text 时按步骤执行）"""
        from strands_backend.adapter import _DEFAULT_SYSTEM_PROMPT

        assert "playbook_text" in _DEFAULT_SYSTEM_PROMPT


if __name__ == "__main__":
    import unittest

    unittest.main()
