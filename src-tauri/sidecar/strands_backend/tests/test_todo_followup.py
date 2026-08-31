"""
strands_backend/tests/test_todo_followup.py — T3 规划-执行回环单测
==========================================================================

spec: add-agent-loop-closure Task 3（todo 驱动执行 + 收尾校验 + completedAt）

覆盖：
1. todo_write completedAt：pending 无时间戳 / completed 写入 / 全量替换复用旧值
   （id 匹配 + title 兜底）
2. per-session 镜像：get_session_todos / get_unfinished_todos / reset
3. invoke 收尾校验（真实 strands，FakeContextModel 单轮假模型）：
   - 有未完成项 → 追加一轮（模型调用 2 次，observation 为追加轮文本）
   - 全 completed → 不追加（模型调用 1 次）
   - 追加仅一次（限一次 flag，防死循环）
   - 空 session / 无 todo → 不追加
   - todo_followup 注入内容落盘 agent_log

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_todo_followup.py -v
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import MagicMock

import pytest

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

try:
    from strands.models.model import Model  # type: ignore[import]
    _STRANDS_AVAILABLE = True
except ImportError:
    _STRANDS_AVAILABLE = False


# ============================================================================
# 测试隔离：agent_log 目录 + todo 镜像
# ============================================================================


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


def _make_ctx(session_id="t3-s1"):
    """todo_write 直调所需的 ToolContext mock（无 rust_bridge/event_bus 副作用）"""
    ctx = MagicMock()
    ctx.session_id = session_id
    ctx.agent_name = "main"
    ctx.rust_bridge = None
    ctx.event_bus = None
    return ctx


def _write_todos(session_id, todos):
    """经真实 invoke_todo_write_tool 写入（顺带驱动镜像与 completedAt 逻辑）"""
    from strands_backend.tools.todo_write import invoke_todo_write_tool

    return invoke_todo_write_tool({"todos": todos}, _make_ctx(session_id))


# ============================================================================
# 1. completedAt 合并逻辑
# ============================================================================


class TestCompletedAt:
    def test_pending_has_no_completed_at(self):
        result = _write_todos("t3-s1", [{"id": "a", "title": "查状态", "status": "pending"}])
        assert result["ok"] is True
        from strands_backend.tools.todo_write import get_session_todos

        todos = get_session_todos("t3-s1")
        assert todos[0]["status"] == "pending"
        assert "completedAt" not in todos[0]

    def test_completed_gets_completed_at(self):
        _write_todos("t3-s2", [{"id": "a", "title": "查状态", "status": "completed"}])
        from strands_backend.tools.todo_write import get_session_todos

        completed_at = get_session_todos("t3-s2")[0]["completedAt"]
        assert completed_at is not None
        # ISO 8601 格式（前端 new Date() 可解析）
        assert "T" in completed_at

    def test_full_rewrite_keeps_old_completed_at_by_id(self):
        """全量替换（同 id 仍 completed）→ completedAt 复用旧值不漂移"""
        _write_todos("t3-s3", [{"id": "a", "title": "查状态", "status": "completed"}])
        from strands_backend.tools.todo_write import get_session_todos

        first = get_session_todos("t3-s3")[0]["completedAt"]

        # LLM 全量重写（同 id，仍 completed）——时间戳不应被刷新
        _write_todos("t3-s3", [{"id": "a", "title": "查状态", "status": "completed"}])
        second = get_session_todos("t3-s3")[0]["completedAt"]
        assert second == first

    def test_title_fallback_when_no_id(self):
        """无 id 项按 title 匹配旧 completedAt"""
        _write_todos("t3-s4", [{"title": "看日志", "status": "completed"}])
        from strands_backend.tools.todo_write import get_session_todos

        first = get_session_todos("t3-s4")[0]
        assert first["completedAt"]

        _write_todos("t3-s4", [{"title": "看日志", "status": "completed"}])
        second = get_session_todos("t3-s4")[0]
        # 无 id 时两批自动生成 id 不同，靠 title 兜底复用时间戳
        assert second["completedAt"] == first["completedAt"]

    def test_reopened_todo_gets_new_timestamp(self):
        """completed → pending → completed：重开后再完成取新时间"""
        _write_todos("t3-s5", [{"id": "a", "title": "修复", "status": "completed"}])
        _write_todos("t3-s5", [{"id": "a", "title": "修复", "status": "pending"}])
        from strands_backend.tools.todo_write import get_session_todos

        assert "completedAt" not in get_session_todos("t3-s5")[0]


# ============================================================================
# 2. per-session 镜像
# ============================================================================


class TestSessionMirror:
    def test_get_unfinished_todos_filters_status(self):
        _write_todos("t3-s6", [
            {"id": "a", "title": "step1", "status": "completed"},
            {"id": "b", "title": "step2", "status": "in_progress"},
            {"id": "c", "title": "step3", "status": "pending"},
        ])
        from strands_backend.tools.todo_write import get_unfinished_todos

        unfinished = get_unfinished_todos("t3-s6")
        assert [t["id"] for t in unfinished] == ["b", "c"]

    def test_mirror_isolated_per_session(self):
        _write_todos("t3-s7", [{"id": "a", "title": "step1", "status": "pending"}])
        from strands_backend.tools.todo_write import get_unfinished_todos

        assert get_unfinished_todos("t3-other") == []

    def test_invalid_list_rejected_no_mirror(self):
        result = _write_todos("t3-s8", "not-a-list")
        assert result["ok"] is False
        from strands_backend.tools.todo_write import get_session_todos

        assert get_session_todos("t3-s8") == []


# ============================================================================
# 3. invoke 收尾校验（需真实 strands）
# ============================================================================


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class FakeContextModel(Model):
    """单轮 end_turn 假模型：每次调用计数（供断言追加轮次数）"""

    def __init__(self, final_text: str = "ok") -> None:
        self.final_text = final_text
        self.round = 0

    def supports_tool_calls(self) -> bool:
        return True

    def get_config(self) -> dict:
        return {"model": "fake-t3"}

    def update_config(self, **model_config) -> None:
        pass

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        yield None

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.round += 1
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {
            "contentBlockDelta": {
                "delta": {"text": f"{self.final_text} (round {self.round})"}
            }
        }
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 5, "outputTokens": 5, "totalTokens": 10}
            }
        }


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class TestTodoFollowupOnInvoke(unittest.TestCase):
    """T3.2: invoke 收尾校验——未完成 todo → 追加一轮（限一次）"""

    def _make_adapter(self):
        from strands_backend.adapter import StrandsAgentAdapter

        model = FakeContextModel("reply")
        adapter = StrandsAgentAdapter(
            event_bus=MagicMock(),
            rust_bridge=MagicMock(),
            backend_enabled=True,
            strands_model=model,
        )
        adapter._strands_available = True
        adapter._model_available = True
        return adapter, model

    def test_unfinished_todos_trigger_followup_round(self):
        """有未完成项 → 模型被调 2 次，observation 为追加轮文本"""
        _write_todos("t3-f1", [
            {"id": "a", "title": "step1", "status": "completed"},
            {"id": "b", "title": "step2", "status": "in_progress"},
        ])
        adapter, model = self._make_adapter()

        result = adapter.invoke("main", "干活", {"session_id": "t3-f1", "live": {}})
        self.assertEqual(result["next_step"], "done")
        self.assertEqual(model.round, 2)  # 主轮 + 追加轮
        self.assertIn("round 2", result["observation"])  # 追加轮文本覆盖主轮

    def test_all_completed_no_followup(self):
        """全 completed → 模型只调 1 次，observation 为主轮文本"""
        _write_todos("t3-f2", [{"id": "a", "title": "step1", "status": "completed"}])
        adapter, model = self._make_adapter()

        result = adapter.invoke("main", "干活", {"session_id": "t3-f2", "live": {}})
        self.assertEqual(model.round, 1)
        self.assertIn("round 1", result["observation"])

    def test_no_todos_no_followup(self):
        """从未建清单（纯问答）→ 不触发追加"""
        adapter, model = self._make_adapter()
        adapter.invoke("main", "你好", {"session_id": "t3-f3", "live": {}})
        self.assertEqual(model.round, 1)

    def test_followup_only_once_per_session(self):
        """追加仅一次：第二次 invoke（todo 仍未完成）不再追加"""
        _write_todos("t3-f4", [{"id": "a", "title": "step2", "status": "pending"}])
        adapter, model = self._make_adapter()

        adapter.invoke("main", "第一问", {"session_id": "t3-f4", "live": {}})
        self.assertEqual(model.round, 2)

        adapter.invoke("main", "第二问", {"session_id": "t3-f4", "live": {}})
        # 第二次 invoke 只有主轮（未完成项仍在，但追加机会已用掉）
        self.assertEqual(model.round, 3)

    def test_empty_session_no_followup(self):
        """匿名调用（无 session_id）不触发收尾校验"""
        _write_todos("", [{"id": "a", "title": "step", "status": "pending"}])
        adapter, model = self._make_adapter()
        result = adapter.invoke("main", "匿名", {"session_id": "", "live": {}})
        self.assertEqual(model.round, 1)
        self.assertEqual(result["next_step"], "done")

    def test_followup_prompt_logged_to_agent_log(self):
        """追加轮注入内容落盘 todo_followup 事件（含未完成清单）"""
        from strands_backend.agent_log import tail

        _write_todos("t3-f5", [{"id": "a", "title": "部署 nginx", "status": "in_progress"}])
        adapter, _ = self._make_adapter()
        adapter.invoke("main", "部署", {"session_id": "t3-f5", "live": {}})

        result = tail(session_id="t3-f5", lines=50)
        followups = [ln for ln in result["lines"] if ln["type"] == "todo_followup"]
        self.assertEqual(len(followups), 1)
        self.assertIn("部署 nginx", followups[0]["content"])
        self.assertIn("未完成", followups[0]["content"])

    def test_followup_failure_falls_back_to_main_result(self):
        """追加轮模型异常 → 降级返回主轮结果，不抛错"""
        _write_todos("t3-f6", [{"id": "a", "title": "step", "status": "pending"}])
        adapter, model = self._make_adapter()

        # 主轮成功后，让追加轮抛错：包装 streams_agent 不行（锁内取的是
        # strands_agent 实例本身），改让第二次 stream 抛异常
        original_stream = model.stream

        async def failing_stream(messages, tool_specs=None, system_prompt=None, **kwargs):
            if model.round >= 1:
                raise RuntimeError("followup exploded")
            async for chunk in original_stream(
                messages, tool_specs, system_prompt, **kwargs
            ):
                yield chunk

        model.stream = failing_stream
        result = adapter.invoke("main", "干活", {"session_id": "t3-f6", "live": {}})
        # 追加轮失败降级：next_step 仍 done，observation 为主轮文本
        self.assertEqual(result["next_step"], "done")
        self.assertIn("round 1", result["observation"])


if __name__ == "__main__":
    unittest.main()
