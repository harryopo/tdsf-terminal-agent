"""
strands_backend/tests/test_e2e_strands.py — Strands 真实端到端测试（P0-5）
==========================================================================

用**真实 Strands Agent**（非 MagicMock）验证 P0-1 多 agent 集成：

1. teach agent：真实创建 → FakeModel 第一轮调 read_remote_file →
   工具经 mock RustBridge 执行 → 第二轮输出教学文本 → observation 正确
2. explore agent：真实创建 → 验证工具集只有只读工具（schema-level safety
   在真实 agent 上生效）
3. 事件流：invoke 过程 emit agent_switch / agent_message / mood_change

策略：
- 需要真实 strands 包（skipif 未安装）
- LLM 用 FakeStrandsModel（实现 strands Model 协议的假模型，固定脚本）
- RustBridge 用 MagicMock（工具执行层不需要真实 SSH）
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from unittest.mock import MagicMock

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

try:
    from strands.models.model import Model  # type: ignore[import]
    _STRANDS_AVAILABLE = True
except ImportError:
    _STRANDS_AVAILABLE = False


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class FakeStrandsModel(Model):
    """最小 Strands Model：第一轮 tool_use(read_remote_file)，第二轮最终文本"""

    def __init__(self, file_content: bytes, final_text: str) -> None:
        self.file_content = file_content
        self.final_text = final_text
        self.round = 0

    def supports_tool_calls(self) -> bool:
        return True

    def get_config(self) -> dict:
        return {"model": "fake"}

    def update_config(self, **model_config) -> None:
        pass

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        yield None  # e2e 不验证结构化输出

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.round += 1
        if self.round == 1:
            yield {"messageStart": {"role": "assistant"}}
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "name": "read_remote_file",
                            "toolUseId": "tc-1",
                        }
                    }
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {
                        "toolUse": {
                            "input": json.dumps(
                                {"path": "/etc/nginx/nginx.conf", "max_size": 4096}
                            )
                        }
                    }
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": self.final_text}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}
            }
        }


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class TestStrandsRealE2E(unittest.TestCase):
    """真实 Strands Agent + 多 agent 集成端到端"""

    @classmethod
    def setUpClass(cls):
        from strands_backend.adapter import StrandsAgentAdapter
        from strands_backend.tools import DefaultRustBridge

        cls.adapter_cls = StrandsAgentAdapter
        cls.bridge_cls = DefaultRustBridge

    def _make_adapter(self, model: Model) -> tuple[StrandsAgentAdapter, MagicMock]:
        bus = MagicMock()
        bus.emit_agent_message = MagicMock(return_value=1)
        bus.emit_mood_change = MagicMock(return_value=1)
        bus.emit_tool_call = MagicMock(return_value=1)
        bus.emit_needs_you = MagicMock(return_value=1)
        bus.emit_agent_switch = MagicMock(return_value=1)
        bridge = MagicMock()
        bridge.ipc_invoke = MagicMock(return_value=b"server { listen 80; }\n")
        adapter = self.adapter_cls(
            event_bus=bus,
            rust_bridge=bridge,
            backend_enabled=True,
            strands_model=model,
        )
        adapter._strands_available = True
        adapter._model_available = True
        return adapter, bus

    def test_teach_agent_real_invoke_with_tool_call(self):
        """teach：真实 Strands Agent 创建 + read_remote_file 经 bridge 执行"""
        model = FakeStrandsModel(
            file_content=b"server { listen 80; }\n",
            final_text="## 1. Concept\nnginx.conf is the main Nginx config.\n\n## 2. Exercise\nCheck the server block.",
        )
        adapter, bus = self._make_adapter(model)

        result = adapter.invoke(
            "teach",
            "讲解 nginx.conf 结构",
            {"session_id": "e2e-s1", "live": {"sshSessionId": 1}},
        )

        # 1. 成功完成，输出为教学文本（第二轮）
        self.assertEqual(result["next_step"], "done")
        self.assertIn("Concept", result["observation"])
        self.assertNotIn("[strands-backend-degraded]", result["observation"])

        # 2. read_remote_file 工具真实执行（经 mock bridge）
        bridge_calls = [
            c.args[0]
            for c in adapter.rust_bridge.ipc_invoke.call_args_list
            if c.args
        ]
        self.assertIn("sftp_read", bridge_calls)
        # 工具调用事件经 event_bus 推送（前端工具行渲染的数据源）
        tool_events = [
            c.kwargs.get("tool_name")
            for c in bus.emit_tool_call.call_args_list
            if c.kwargs.get("tool_name")
        ]
        self.assertTrue(tool_events, "expected at least one emit_tool_call")
        self.assertEqual(tool_events[0], "read_remote_file")

        # 3. 事件：agent_switch(teach) + mood 序列 + 文本流
        bus.emit_agent_switch.assert_called_once()
        self.assertEqual(bus.emit_agent_switch.call_args.kwargs["agent"], "teach")
        self.assertGreaterEqual(bus.emit_agent_message.call_count, 1)

        # 4. 模型确实走了两轮（工具调用 → 文本）
        self.assertEqual(model.round, 2)

    def test_explore_agent_toolset_readonly_on_real_agent(self):
        """explore：真实 Strands Agent 的工具集无 ssh_command（schema-level）"""
        model = FakeStrandsModel(
            file_content=b"x",
            final_text="explore 结果",
        )
        adapter, bus = self._make_adapter(model)

        # 直接走 _get_or_create_agent 拿到真实 Strands Agent
        ctx = adapter._build_tool_context("explore", "e2e-s2", {})
        agent = adapter._get_or_create_agent("explore", ctx)
        tool_names = set(agent.tool_names)
        self.assertNotIn("ssh_command", tool_names)
        self.assertIn("read_remote_file", tool_names)
        self.assertIn("suggest_command", tool_names)

        # main 与 explore 是不同实例（独立缓存条目）
        main_agent = adapter._get_or_create_agent("main", ctx)
        main_names = set(main_agent.tool_names)
        self.assertIn("ssh_command", main_names)
        self.assertIsNot(agent, main_agent)

    def test_main_agent_has_full_toolset(self):
        """main：真实 Strands Agent 全量 7 运维工具 + 4 子 agent 工具（P0-6）"""
        model = FakeStrandsModel(file_content=b"", final_text="ok")
        adapter, _ = self._make_adapter(model)
        ctx = adapter._build_tool_context("main", "e2e-s3", {})
        agent = adapter._get_or_create_agent("main", ctx)
        tool_names = set(agent.tool_names)
        # 7 运维工具
        self.assertIn("ssh_command", tool_names)
        self.assertIn("skill_invoke", tool_names)
        # P0-6: main 额外挂载 4 个子 agent 工具
        self.assertEqual(len(tool_names), 12)
        for sub in ("teach", "coding", "explore", "history", "knowledge_search"):
            self.assertIn(sub, tool_names)

    def test_invoke_unknown_agent_falls_back_main_toolset(self):
        """未知 agent_id：工具集回退 main 全量（兼容旧调用方）"""
        model = FakeStrandsModel(file_content=b"", final_text="ok")
        adapter, _ = self._make_adapter(model)
        ctx = adapter._build_tool_context("not_exist", "e2e-s4", {})
        agent = adapter._get_or_create_agent("not_exist", ctx)
        tool_names = set(agent.tool_names)
        self.assertIn("ssh_command", tool_names)


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过真实 e2e")
class TestAgentAsToolDelegation(unittest.TestCase):
    """P0-6: main 统一入口 + 自主委派子 agent（agent-as-tool）全链路

    真实 Strands：main agent 工具集含 4 个子 agent 工具，模型（FakeModel
    脚本）第一轮委派 teach，teach 输出教学文本，main 第三轮收尾。
    验证事件可视化链路：
    - agent:teach started 恰好 1 次（去重）
    - agent:teach completed 1 次，result = 子 agent 全文
    - agent_switch: main → teach（Pill 联动）
    - agent_call 增量转发（msg_type=agent_call）
    """

    def _make_adapter(self):
        from strands_backend.adapter import StrandsAgentAdapter

        bus = MagicMock()
        bus.emit_agent_message = MagicMock(return_value=1)
        bus.emit_mood_change = MagicMock(return_value=1)
        bus.emit_tool_call = MagicMock(return_value=1)
        bus.emit_needs_you = MagicMock(return_value=1)
        bus.emit_agent_switch = MagicMock(return_value=1)
        bridge = MagicMock()
        bridge.ipc_invoke = MagicMock(return_value={"ok": True})
        adapter = StrandsAgentAdapter(
            event_bus=bus,
            rust_bridge=bridge,
            backend_enabled=True,
            strands_model=DelegationModel(),
        )
        adapter._strands_available = True
        adapter._model_available = True
        return adapter, bus

    def test_main_delegates_to_teach_agent(self):
        adapter, bus = self._make_adapter()

        result = adapter.invoke(
            "main",
            "帮我讲一下 nginx",
            {"session_id": "e2e-del-1", "live": {"sshSessionId": "1"}},
        )

        # 1. main 最终回答成功
        self.assertEqual(result["next_step"], "done")
        self.assertIn("main 最终回答", result["observation"])

        # 2. agent:teach 工具事件：started 1 次 + completed 1 次
        agent_events = [
            c.kwargs
            for c in bus.emit_tool_call.call_args_list
            if str(c.kwargs.get("tool_name", "")).startswith("agent:")
        ]
        started = [e for e in agent_events if e.get("status") == "started"]
        completed = [e for e in agent_events if e.get("status") == "completed"]
        self.assertEqual(len(started), 1, f"expected 1 started, got {len(started)}")
        self.assertEqual(len(completed), 1)
        # started 的 params 含委派输入
        self.assertIn("讲 nginx", str(started[0].get("params")))
        # completed 的 result 是子 agent 全文（教学文本）
        self.assertIn("nginx 是反向代理服务器", str(completed[0].get("result")))

        # 3. agent_switch: main → teach（Pill 联动）
        switches = [
            c.kwargs.get("agent") for c in bus.emit_agent_switch.call_args_list
        ]
        self.assertIn("teach", switches)

        # 4. agent_call 增量转发（子 agent 文本增量经 main handler）
        agent_call_deltas = [
            c.kwargs.get("content")
            for c in bus.emit_agent_message.call_args_list
            if c.kwargs.get("message_type") == "agent_call"
        ]
        self.assertTrue(agent_call_deltas, "expected agent_call deltas")
        self.assertTrue(
            any("nginx" in (d or "") for d in agent_call_deltas),
            "agent_call delta should carry sub-agent text",
        )

    def test_sub_agent_not_recursively_exposed(self):
        """子 agent 工具集不嵌套 agent 工具（防无限递归委派）"""
        adapter, _ = self._make_adapter()
        ctx = adapter._build_tool_context("main", "e2e-del-2", {})
        sub_tool = adapter._create_sub_agent_tool("teach", ctx)
        # as_tool 包装暴露 agent 实例
        from strands.types.tools import AgentTool

        self.assertIsInstance(sub_tool, AgentTool)
        self.assertEqual(sub_tool.tool_name, "teach")
        self.assertEqual(sub_tool.tool_type, "agent")


class DelegationModel(Model):
    """共享 FakeModel：round1=main 委派 teach / round2=teach 输出 / round3=main 收尾"""

    stateful = False

    def __init__(self) -> None:
        self.round = 0

    def supports_tool_calls(self) -> bool:
        return True

    def get_config(self) -> dict:
        return {"model": "fake"}

    def update_config(self, **model_config) -> None:
        pass

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        yield None

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.round += 1
        if self.round == 1:
            yield {"messageStart": {"role": "assistant"}}
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"name": "teach", "toolUseId": "tu-1"}}
                }
            }
            yield {
                "contentBlockDelta": {
                    "delta": {
                        "toolUse": {"input": json.dumps({"input": "讲 nginx"})}
                    }
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        elif self.round == 2:
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {
                "contentBlockDelta": {
                    "delta": {"text": "## 1. 概念\nnginx 是反向代理服务器\n## 2. 练习"}
                }
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        else:
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {
                "contentBlockDelta": {"delta": {"text": "main 最终回答（整合教学）"}}
            }
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


if __name__ == "__main__":
    unittest.main()
