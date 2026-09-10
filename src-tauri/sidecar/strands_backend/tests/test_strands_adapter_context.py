"""
strands_backend/tests/test_strands_adapter_context.py — T1 上下文连续性单测
==========================================================================

spec: add-agent-loop-closure Task 1（方案书 v4.0 感知→思考断点修复）

验证内容：
1. 切模式（observe/confirm/auto）与教学开关不再触发实例重建——
   缓存 key 不含 mode/teach（同 perm 同 session 始终同一实例）
2. messages 与实例解耦：
   - 同实例切模式：messages 原样保留（零丢失）
   - perm 变化重建实例：历史从 _session_messages 迁移进新 Agent
   - update_model 清缓存重建：历史同样迁移（换模型不丢上下文）
3. context_manager="auto" 生效：conversation_manager 为
   SummarizingConversationManager（summary_ratio=0.3,
   compression_threshold=0.85 主动压缩）
4. invoke 全流程：切模式后 agent 记得此前对话（messages 连续增长）

策略（与 test_e2e_strands.py 一致）：
- 需要真实 strands 包（skipif 未安装）
- LLM 用 FakeContextModel（单轮 end_turn 固定文本，无工具调用）
- RustBridge 用 MagicMock（不触发真实工具）
"""
from __future__ import annotations

import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

from strands_backend.modes import AgentMode  # noqa: E402 — sys.path 先行注入

class TestTeachContinuationIntent(unittest.TestCase):
    """A bare continuation inherits teaching only after an explicit lesson."""

    def test_recognizes_only_short_continuation_requests(self):
        from strands_backend.adapter import _is_teaching_continuation

        self.assertTrue(_is_teaching_continuation("继续"))
        self.assertTrue(_is_teaching_continuation("接着讲"))
        self.assertTrue(_is_teaching_continuation("continue"))
        self.assertFalse(_is_teaching_continuation("继续查看知识库"))

    def test_teach_observe_keeps_shell_mapped_commands_as_cards(self):
        from strands_backend.adapter import _filter_teach_tools
        from strands_backend.tools import ToolContext, make_all_ops_tools
        from strands_backend.tools.teach_command import make_teach_command_tool

        ctx = ToolContext(permission_level=1, mode=AgentMode.OBSERVE, teach=True)
        tools = _filter_teach_tools(
            make_all_ops_tools(ctx, include_teach_shell_tools=True)
            + [make_teach_command_tool(ctx)]
        )
        names = {getattr(tool, "__name__", "") for tool in tools}
        self.assertIn("teach_command", names)
        self.assertIn("ssh_command", names)
        self.assertIn("read_remote_file", names)
        self.assertIn("knowledge_search", names)
        self.assertNotIn("service_manage", names)
        self.assertNotIn("suggest_command", names)
        self.assertNotIn("todo_write", names)
        self.assertNotIn("get_terminal_output", names)

    def test_teach_prompt_requires_command_cards_instead_of_prose_commands(self):
        from strands_backend.adapter import _compose_system_prompt

        prompt = _compose_system_prompt(AgentMode.OBSERVE, teach=True)
        self.assertIn("teach_command", prompt)
        self.assertIn("反引号命令", prompt)
        self.assertIn("任何可执行命令都必须进入教学命令卡", prompt)
        self.assertIn("不用 ;、&&、|| 串联多个步骤", prompt)

    def test_runtime_always_registers_dedicated_teaching_card_tool(self):
        from strands_backend.adapter import StrandsAgentAdapter
        from strands_backend.tools import ToolContext

        class Registry:
            registry: dict = {}
            dynamic_tools: dict = {}

            def process_tools(self, tools):
                self.tools = tools

        registry = Registry()
        agent = SimpleNamespace(tool_registry=registry, _plugin_registry=None)
        adapter = object.__new__(StrandsAgentAdapter)
        adapter.extra_tools = []
        adapter.system_prompt = "base"

        StrandsAgentAdapter._refresh_agent_runtime(
            adapter,
            agent,
            ToolContext(permission_level=1, mode=AgentMode.OBSERVE, teach=True),
            mode=AgentMode.OBSERVE,
            teach=True,
        )

        names = {getattr(tool, "__name__", "") for tool in registry.tools}
        self.assertIn("teach_command", names)
        self.assertIn("ssh_command", names)

    def test_callback_remembers_marker_across_stream_chunks(self):
        from strands_backend.adapter import TdsfStrandsCallbackHandler

        handler = TdsfStrandsCallbackHandler(event_bus=None)
        handler.begin_turn(teach=True, allow_teach_output=True)
        handler._emit_agent_message("<!-- tdsf:")
        handler._emit_agent_message("teach -->\n第一节")
        self.assertTrue(handler._emitted_teach_marker)


try:
    from strands.models.model import Model  # type: ignore[import]
    _STRANDS_AVAILABLE = True
except ImportError:
    _STRANDS_AVAILABLE = False
    Model = object  # type: ignore[assignment,misc]  # skipped test class still needs a base


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class FakeContextModel(Model):
    """单轮 end_turn 假模型：直接输出固定文本（无工具调用）。

    每次调用计数（供断言 invoke 轮次），文本可带轮次编号以便观察。
    """

    def __init__(self, final_text: str = "ok") -> None:
        self.final_text = final_text
        self.round = 0

    def supports_tool_calls(self) -> bool:
        return True

    def get_config(self) -> dict:
        return {"model": "fake-context"}

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
class TestCacheKeyExcludesModeTeach(unittest.TestCase):
    """T1.2: 缓存 key 不含 mode/teach——模式/教学切换不重建实例"""

    def _make_adapter(self) -> object:
        from strands_backend.adapter import StrandsAgentAdapter

        bus = MagicMock()
        adapter = StrandsAgentAdapter(
            event_bus=bus,
            rust_bridge=MagicMock(),
            backend_enabled=True,
            strands_model=FakeContextModel(),
        )
        adapter._strands_available = True
        adapter._model_available = True
        return adapter

    def test_mode_switch_reuses_instance(self):
        """同 perm 同 session：observe→confirm→auto 全程同一实例"""
        adapter = self._make_adapter()
        ctx = adapter._build_tool_context("main", "t1-s1", {})
        a_observe = adapter._get_or_create_agent("main", ctx, mode=AgentMode.OBSERVE)
        a_confirm = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM)
        a_auto = adapter._get_or_create_agent("main", ctx, mode=AgentMode.AUTO)
        self.assertIs(a_observe, a_confirm)
        self.assertIs(a_confirm, a_auto)
        # 缓存只有一条（mode/teach 不入 key）
        self.assertEqual(len(adapter._agent_cache), 1)
        self.assertEqual(list(adapter._agent_cache.keys()), [("main", "t1-s1", 2)])

    def test_teach_switch_reuses_instance(self):
        """同 perm 同 session：teach 开关切换不重建实例"""
        adapter = self._make_adapter()
        ctx = adapter._build_tool_context("main", "t1-s1", {})
        a_plain = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM, teach=False)
        a_teach = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM, teach=True)
        self.assertIs(a_plain, a_teach)
        self.assertEqual(len(adapter._agent_cache), 1)

    def test_mode_switch_updates_system_prompt_and_toolset(self):
        """切模式后 prompt 与工具集动态刷新（同实例即时生效）"""
        adapter = self._make_adapter()
        ctx = adapter._build_tool_context("main", "t1-s2", {})
        a = adapter._get_or_create_agent("main", ctx, mode=AgentMode.OBSERVE)
        # observe：只读白名单 + OBSERVE prompt
        self.assertNotIn("ssh_command", set(a.tool_names))
        self.assertIn("Current mode: OBSERVE", a.system_prompt)
        self.assertNotIn("教学皮肤（已开启）", a.system_prompt)
        # 切 confirm + teach：同实例，全量工具 + CONFIRM/TEACH prompt
        a2 = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM, teach=True)
        self.assertIs(a, a2)
        self.assertIn("ssh_command", set(a2.tool_names))
        self.assertIn("Current mode: CONFIRM", a2.system_prompt)
        self.assertIn("教学皮肤（已开启）", a2.system_prompt)

    def test_perm_change_creates_new_instance(self):
        """perm 变化仍重建实例（权限影响工具集合法性）"""
        adapter = self._make_adapter()
        ctx_p2 = adapter._build_tool_context(
            "main", "t1-s3", {"live": {"permissionLevel": 2}}
        )
        ctx_p3 = adapter._build_tool_context(
            "main", "t1-s3", {"live": {"permissionLevel": 3}}
        )
        a_p2 = adapter._get_or_create_agent("main", ctx_p2, mode=AgentMode.CONFIRM)
        a_p3 = adapter._get_or_create_agent("main", ctx_p3, mode=AgentMode.CONFIRM)
        self.assertIsNot(a_p2, a_p3)
        self.assertEqual(len(adapter._agent_cache), 2)


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class TestContextManagerAuto(unittest.TestCase):
    """T1.3: context_manager="auto" 配置生效"""

    def test_conversation_manager_is_summarizing(self):
        """实例的 conversation_manager 为 SummarizingConversationManager"""
        from strands.agent.conversation_manager import (
            SummarizingConversationManager,
        )
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(
            event_bus=MagicMock(),
            rust_bridge=MagicMock(),
            backend_enabled=True,
            strands_model=FakeContextModel(),
        )
        adapter._strands_available = True
        adapter._model_available = True
        ctx = adapter._build_tool_context("main", "t1-cm", {})
        agent = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM)
        self.assertIsInstance(agent.conversation_manager, SummarizingConversationManager)
        # auto 组合参数：summary_ratio 0.3 + 主动压缩阈值 0.85
        # （阈值存于基类私有属性 _compression_threshold，见
        #   strands/agent/conversation_manager/conversation_manager.py:94）
        self.assertEqual(agent.conversation_manager.summary_ratio, 0.3)
        self.assertEqual(agent.conversation_manager._compression_threshold, 0.85)
        # Runtime tool refresh must preserve the ContextOffloader retrieval
        # tool; otherwise oversized tool results become unreadable references.
        self.assertIn("retrieve_offloaded_content", set(agent.tool_names))

    def test_tool_executor_is_sequential_until_all_events_have_ids(self):
        from strands.tools.executors import SequentialToolExecutor
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(
            event_bus=MagicMock(),
            rust_bridge=MagicMock(),
            backend_enabled=True,
            strands_model=FakeContextModel(),
        )
        adapter._strands_available = True
        adapter._model_available = True
        ctx = adapter._build_tool_context("main", "t1-executor", {})
        agent = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM)
        self.assertIsInstance(agent.tool_executor, SequentialToolExecutor)


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class TestMessagesContinuityAcrossInvoke(unittest.TestCase):
    """T1.1: messages 与实例解耦——invoke 全流程历史保留"""

    def _make_adapter(self) -> tuple:
        from strands_backend.adapter import StrandsAgentAdapter

        bus = MagicMock()
        model = FakeContextModel("reply")
        adapter = StrandsAgentAdapter(
            event_bus=bus,
            rust_bridge=MagicMock(),
            backend_enabled=True,
            strands_model=model,
        )
        adapter._strands_available = True
        adapter._model_available = True
        return adapter, model

    def _roles(self, agent) -> list[str]:
        return [m.get("role") for m in agent.messages]

    def test_mode_switch_preserves_messages(self):
        """切模式后历史保留：observe→confirm 连续两轮对话 messages 连续增长"""
        adapter, _ = self._make_adapter()
        state = {"session_id": "t1-m1", "live": {}}

        # 第一轮：observe 模式
        r1 = adapter.invoke("main", "第一问", dict(state, live={"agentMode": "observe"}))
        self.assertEqual(r1["next_step"], "done")
        agent_after_r1 = next(iter(adapter._agent_cache.values()))
        roles_after_r1 = self._roles(agent_after_r1)
        self.assertEqual(roles_after_r1, ["user", "assistant"])
        msgs_after_r1 = list(agent_after_r1.messages)

        # 第二轮：切 confirm 模式——同一实例，messages 追加而非清零
        r2 = adapter.invoke("main", "第二问", dict(state, live={"agentMode": "confirm"}))
        self.assertEqual(r2["next_step"], "done")
        agent_after_r2 = next(iter(adapter._agent_cache.values()))
        self.assertIs(agent_after_r1, agent_after_r2)
        roles_after_r2 = self._roles(agent_after_r2)
        self.assertEqual(roles_after_r2, ["user", "assistant", "user", "assistant"])
        # 前两轮消息对象原样保留（零丢失）
        self.assertEqual(agent_after_r2.messages[: len(msgs_after_r1)], msgs_after_r1)

    def test_perm_change_migrates_messages(self):
        """perm 变化重建实例：历史从 _session_messages 迁移进新实例"""
        adapter, _ = self._make_adapter()

        # 第一轮 perm=2
        adapter.invoke("main", "第一问", {
            "session_id": "t1-m2",
            "live": {"permissionLevel": 2, "agentMode": "confirm"},
        })
        self.assertEqual(len(adapter._agent_cache), 1)
        self.assertEqual(len(adapter._session_messages), 1)
        saved = adapter._session_messages[("main", "t1-m2")]
        self.assertEqual([m.get("role") for m in saved], ["user", "assistant"])

        # 第二轮 perm=3 → 新实例，messages 装载迁移
        adapter.invoke("main", "第二问", {
            "session_id": "t1-m2",
            "live": {"permissionLevel": 3, "agentMode": "confirm"},
        })
        self.assertEqual(len(adapter._agent_cache), 2)
        new_agent = adapter._agent_cache[("main", "t1-m2", 3)]
        # 迁移后历史 = 第一轮 user/assistant + 第二轮 user/assistant
        roles = self._roles(new_agent)
        self.assertEqual(roles, ["user", "assistant", "user", "assistant"])

    def test_update_model_rebuild_keeps_history(self):
        """update_model 清缓存重建：历史经 _session_messages 保留"""
        adapter, _ = self._make_adapter()
        adapter.invoke("main", "第一问", {
            "session_id": "t1-m3",
            "live": {"agentMode": "confirm"},
        })
        self.assertEqual(len(adapter._session_messages), 1)

        # 换模型 → clear_cache（实例清空，历史保留）
        adapter.update_model(FakeContextModel("new-model"))

        self.assertEqual(len(adapter._agent_cache), 0)
        self.assertEqual(len(adapter._session_messages), 1)

        # 重建后历史迁移，新对话在其上追加
        r = adapter.invoke("main", "第二问", {
            "session_id": "t1-m3",
            "live": {"agentMode": "confirm"},
        })
        self.assertEqual(r["next_step"], "done")
        agent = adapter._agent_cache[("main", "t1-m3", 2)]
        roles = self._roles(agent)
        self.assertEqual(roles, ["user", "assistant", "user", "assistant"])
        self.assertIn("new-model", r["observation"])

    def test_sync_session_messages_skips_empty_session(self):
        """匿名调用（session_id 为空）不同步历史，不抛错"""
        adapter, _ = self._make_adapter()
        # None agent + 空 session 双保险路径
        adapter._sync_session_messages("main", "", object())
        self.assertEqual(len(adapter._session_messages), 0)
        adapter._sync_session_messages("main", "s", None)
        self.assertEqual(len(adapter._session_messages), 0)


class TestTeachingPromptExecutionBoundary(unittest.TestCase):
    """教学命令卡必须等待学生显式提交受限执行结果。"""

    def test_prompt_forbids_scrollback_read_and_requires_structured_result(self):
        from strands_backend.adapter import _compose_system_prompt

        prompt = _compose_system_prompt(AgentMode.OBSERVE, teach=True)

        self.assertIn("本轮工具调用不会得到执行结果", prompt)
        self.assertIn("禁止调用 suggest_command、todo_write 或 get_terminal_output", prompt)
        self.assertIn("<teaching-command-result>", prompt)
        self.assertIn("基于结果继续讲解", prompt)


if __name__ == "__main__":
    unittest.main()
