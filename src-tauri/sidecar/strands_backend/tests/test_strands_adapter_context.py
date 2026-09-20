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
        # L1 下 todo_write（readonly）随只读集合保留
        self.assertIn("todo_write", names)
        self.assertNotIn("service_manage", names)
        self.assertNotIn("suggest_command", names)
        self.assertNotIn("get_terminal_output", names)

    def test_teach_filter_keeps_skill_and_todo_at_confirmed_perm(self):
        """perm>=2 全量工具经教学白名单过滤后保留 skill_invoke/todo_write"""
        from strands_backend.adapter import _filter_teach_tools
        from strands_backend.tools import ToolContext, make_all_ops_tools

        ctx = ToolContext(permission_level=2, mode=AgentMode.OBSERVE, teach=True)
        tools = _filter_teach_tools(make_all_ops_tools(ctx))
        names = {getattr(tool, "__name__", "") for tool in tools}
        self.assertIn("skill_invoke", names)
        self.assertIn("todo_write", names)
        self.assertNotIn("suggest_command", names)

    def test_teach_prompt_requires_command_cards_instead_of_prose_commands(self):
        from strands_backend.adapter import _compose_system_prompt

        prompt = _compose_system_prompt(AgentMode.OBSERVE, teach=True)
        self.assertIn("teach_command", prompt)
        # 新教学输出契约：步骤结构化 + 每轮一张卡 + 命令禁入 bash 围栏
        self.assertIn("第 N 步 / 共 M 步", prompt)
        self.assertIn("每轮最多一张卡", prompt)
        self.assertIn("bash 围栏", prompt)
        self.assertIn("suggest_command、get_terminal_output", prompt)

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
        # 切 confirm：同实例，全量工具 + CONFIRM prompt；教学皮肤不跟过来
        # （#90：皮肤条件必须与工具注册条件 teach and OBSERVE 同一条）
        a2 = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM, teach=True)
        self.assertIs(a, a2)
        self.assertIn("ssh_command", set(a2.tool_names))
        self.assertIn("Current mode: CONFIRM", a2.system_prompt)
        self.assertNotIn("教学皮肤（已开启）", a2.system_prompt)
        # 切 observe + teach：教学皮肤与教学工具集同时到位
        a3 = adapter._get_or_create_agent(
            "main", ctx, mode=AgentMode.OBSERVE, teach=True
        )
        self.assertIs(a, a3)
        self.assertIn("教学皮肤（已开启）", a3.system_prompt)
        self.assertIn("teach_command", set(a3.tool_names))

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

        self.assertIn("学生点击后才注入终端执行", prompt)
        self.assertIn("suggest_command、get_terminal_output", prompt)
        self.assertIn("<teaching-command-result>", prompt)
        self.assertIn("永远不猜测命令输出", prompt)


class TestTeachPromptSurface(unittest.TestCase):
    """教学 prompt/gate 文本与工具白名单的静态契约（防内部措辞泄漏）。"""

    def test_teach_text_has_no_internal_jargon(self):
        from strands_backend.adapter import _TEACH_SKIN_PROMPT, _teach_turn_gate

        banned = (
            "信息汇报", "知识回合", "报告回合", "证据盘点",
            "事实层", "推断层", "未实层",
        )
        for text in (_TEACH_SKIN_PROMPT, _teach_turn_gate(True, True)):
            for word in banned:
                self.assertNotIn(word, text)

    def test_teach_gate_has_single_neutral_teaching_branch(self):
        from strands_backend.adapter import _teach_turn_gate

        self.assertEqual(_teach_turn_gate(False, False), "")
        self.assertEqual(_teach_turn_gate(False, True), "")
        for intent in (False, True):
            gate = _teach_turn_gate(True, intent)
            self.assertIn("[教学模式进行中]", gate)
            self.assertIn("绝不编造工具输出或终端回显", gate)

    def test_teach_aux_tools_include_skill_and_todo(self):
        from strands_backend.adapter import _TEACH_AUX_TOOL_NAMES

        self.assertIn("skill_invoke", _TEACH_AUX_TOOL_NAMES)
        self.assertIn("todo_write", _TEACH_AUX_TOOL_NAMES)

    def test_teach_skin_strict_turn_contract(self):
        """皮肤必须绑定严格回合制（单卡/不剧透/基础环境靠上下文），禁旧措辞"""
        from strands_backend.adapter import _TEACH_SKIN_PROMPT

        for required in (
            "严格回合制", "恰好一张命令卡", "<environment>",
            "绝不提前写出后续步骤",
        ):
            self.assertIn(required, _TEACH_SKIN_PROMPT)
        # v4 旧措辞（分步多建议/双轨命令）已按用户实测反馈移除
        for stale in ("一次回复可以按阶段给出多步建议", "命令卡与正文命令建议"):
            self.assertNotIn(stale, _TEACH_SKIN_PROMPT)
        # #90 (2026-09-20 用户实测)：开场自动环境探测整体下线
        for retired in ("system_probe_teaching", "探测", "基线"):
            self.assertNotIn(retired, _TEACH_SKIN_PROMPT)


class _PromptRecordingModel(FakeContextModel):
    """在 FakeContextModel 基础上记录 system_prompt 与 user 消息文本。"""

    def __init__(self, final_text: str = "ok") -> None:
        super().__init__(final_text)
        self.system_prompts: list[str] = []
        self.user_prompts: list[str] = []

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        if isinstance(system_prompt, str):
            self.system_prompts.append(system_prompt)
        for message in messages:
            if message.get("role") != "user":
                continue
            for block in message.get("content") or []:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    self.user_prompts.append(block["text"])
        async for chunk in super().stream(
            messages, tool_specs, system_prompt=system_prompt, **kwargs
        ):
            yield chunk


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class TestTeachIntentPassthrough(unittest.TestCase):
    """教学意图直通：teach=True 时任意学生回复都走教学分支（不再卡死）。"""

    def _invoke(self, model, text: str, teach: bool = True) -> dict:
        from strands_backend.adapter import StrandsAgentAdapter

        adapter = StrandsAgentAdapter(
            event_bus=MagicMock(),
            rust_bridge=MagicMock(),
            backend_enabled=True,
            strands_model=model,
        )
        adapter._strands_available = True
        adapter._model_available = True
        return adapter.invoke(
            "main",
            text,
            {
                "session_id": "t-teach-intent",
                "live": {"agentMode": "confirm", "teach": teach},
            },
        )

    def test_any_student_reply_is_teaching_intent(self):
        for text in ("开始", "下一步", "好的继续吧", "看到了，继续"):
            with self.subTest(input=text):
                model = _PromptRecordingModel("第 1 步 / 共 3 步：查看运行级别")
                result = self._invoke(model, text)
                self.assertEqual(result["next_step"], "done")
                # gate 注入教学模式分支文本，绝无知识/报告回合措辞
                joined = "\n".join(model.user_prompts)
                self.assertIn("[教学模式进行中]", joined)
                self.assertNotIn("[知识/报告回合]", joined)
                # 教学输出补 marker（TeachCard 显式契约）
                self.assertTrue(
                    result["observation"].startswith("<!-- tdsf:teach -->")
                )

    def test_non_teach_turn_strips_marker(self):
        model = _PromptRecordingModel("<!-- tdsf:teach -->\n普通回答")
        result = self._invoke(model, "普通问题", teach=False)
        self.assertEqual(result["next_step"], "done")
        self.assertFalse(result["observation"].startswith("<!-- tdsf:teach -->"))


if __name__ == "__main__":
    unittest.main()
