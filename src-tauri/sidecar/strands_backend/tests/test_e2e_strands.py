"""
strands_backend/tests/test_e2e_strands.py — Strands 真实端到端测试（P0-A1）
==========================================================================

用**真实 Strands Agent**（非 MagicMock）验证三模式信任体系（方案书 v3.1）：

1. main（唯一 agent）+ Teach 教学皮肤：真实创建 → FakeModel 第一轮调
   read_remote_file → 工具经 mock RustBridge 执行 → 第二轮输出教学文本
2. observe 模式：真实 Strands Agent 工具集无任何 readonly=False 工具
   （schema-level safety 在模式过滤下生效）
3. confirm/auto 模式：全量 21 工具（TOOL_REGISTRY 全量，委派 4 子 agent
   工具已删除）
4. T1 上下文连续性 (2026-08-31)：模式切换不再重建实例（缓存 key 移除
   mode/teach），工具集/prompt 每次 invoke 动态刷新

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

from strands_backend.modes import AgentMode  # noqa: E402 — sys.path 先行注入

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
    """真实 Strands Agent + 三模式信任体系端到端"""

    @classmethod
    def setUpClass(cls):
        from strands_backend.adapter import StrandsAgentAdapter
        from strands_backend.tools import DefaultRustBridge

        cls.adapter_cls = StrandsAgentAdapter
        cls.bridge_cls = DefaultRustBridge

    def _make_adapter(self, model: Model) -> tuple[Any, MagicMock]:
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

    def test_main_teach_skin_invoke_with_tool_call(self):
        """main + Teach 皮肤：真实 invoke + read_remote_file 经 bridge 执行

        P0-A1: 原 teach 子 agent 入口收敛为 main + teach=True 传参。
        """
        model = FakeStrandsModel(
            file_content=b"server { listen 80; }\n",
            final_text="## 1. Concept\nnginx.conf is the main Nginx config.\n\n## 2. Exercise\nCheck the server block.",
        )
        adapter, bus = self._make_adapter(model)

        result = adapter.invoke(
            "main",
            "讲解 nginx.conf 结构",
            {"session_id": "e2e-s1", "live": {"sshSessionId": 1, "teach": True}},
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

        # 3. 事件：agent_switch 全部是 main（委派删除后无子 agent 切换）
        switches = [
            c.kwargs.get("agent") for c in bus.emit_agent_switch.call_args_list
        ]
        self.assertTrue(switches)
        self.assertEqual(set(switches), {"main"})
        self.assertGreaterEqual(bus.emit_agent_message.call_count, 1)

        # 4. 模型确实走了两轮（工具调用 → 文本）
        self.assertEqual(model.round, 2)

    def test_observe_mode_toolset_readonly_on_real_agent(self):
        """observe 模式：真实 Strands Agent 工具集无 readonly=False 工具

        spec 验收「观察模式 schema 级隔离」：LLM 无法调用不存在于 schema
        的执行/写类工具（原 explore agent 只读语义由模式过滤承接）。

        T1 (2026-08-31, 方案书 v4.0): 模式不再触发实例重建（缓存 key
        移除 mode/teach）——切到 confirm 后是**同一实例**，工具集由
        _refresh_agent_runtime 动态刷回全量（原"模式缓存隔离"断言随
        T1 行为变更而更新）。
        """
        from strands_backend.tools.registry import (
            READONLY_TOOL_NAMES,
            get_tool_policy,
        )

        model = FakeStrandsModel(file_content=b"x", final_text="observe 结果")
        adapter, _ = self._make_adapter(model)

        ctx = adapter._build_tool_context("main", "e2e-s2", {})
        observe_agent = adapter._get_or_create_agent(
            "main", ctx, mode=AgentMode.OBSERVE, teach=False
        )
        tool_names = set(observe_agent.tool_names)
        # 无任何 readonly=False 工具（schema 级隔离）
        for name in tool_names:
            policy = get_tool_policy(name)
            self.assertIsNotNone(policy, f"{name} 未注册（白名单外泄）")
            self.assertTrue(policy.readonly, f"observe schema 出现 readonly=False 工具: {name}")
        self.assertEqual(tool_names, set(READONLY_TOOL_NAMES))
        self.assertNotIn("ssh_command", tool_names)
        self.assertIn("read_remote_file", tool_names)
        self.assertIn("suggest_command", tool_names)

        # T1: observe 与 confirm 是同一实例（模式不再重建），
        # 工具集动态刷新回全量（schema 随 invoke 即时切换）
        confirm_agent = adapter._get_or_create_agent(
            "main", ctx, mode=AgentMode.CONFIRM, teach=False
        )
        self.assertIs(observe_agent, confirm_agent)
        self.assertIn("ssh_command", set(confirm_agent.tool_names))
        self.assertEqual(len(set(confirm_agent.tool_names)), 22)

    def test_main_agent_has_full_toolset(self):
        """main（唯一 agent）：TOOL_REGISTRY 全量 22 工具

        P0-A1 BREAKING：原 24 = 20 registry + 4 子 agent（agent-as-tool）
        ——委派删除后收敛为 20；2026-08-31 + knowledge_get_doc = 21；
        T5 (2026-08-31) + python_run = 22。
        """
        model = FakeStrandsModel(file_content=b"", final_text="ok")
        adapter, _ = self._make_adapter(model)
        ctx = adapter._build_tool_context("main", "e2e-s3", {})
        agent = adapter._get_or_create_agent("main", ctx, mode=AgentMode.CONFIRM)
        tool_names = set(agent.tool_names)
        self.assertEqual(len(tool_names), 22)
        # 核心工具齐全
        for name in (
            "ssh_command", "skill_invoke", "knowledge_search",
            "knowledge_get_doc",
            "service_manage", "package_manage", "firewall_manage",
            "security_audit", "performance_analyze", "save_skill",
            "python_run",
        ):
            self.assertIn(name, tool_names)
        # 子 agent 委派工具不复存在
        for sub in ("teach", "coding", "explore", "history"):
            self.assertNotIn(sub, tool_names)

    def test_unknown_agent_uses_main_toolset(self):
        """未知 agent_id：使用同一套 main 全量工具集（兼容旧调用方）"""
        model = FakeStrandsModel(file_content=b"", final_text="ok")
        adapter, _ = self._make_adapter(model)
        ctx = adapter._build_tool_context("not_exist", "e2e-s4", {})
        agent = adapter._get_or_create_agent(
            "not_exist", ctx, mode=AgentMode.CONFIRM, teach=False
        )
        tool_names = set(agent.tool_names)
        self.assertIn("ssh_command", tool_names)
        self.assertEqual(len(tool_names), 22)


if __name__ == "__main__":
    unittest.main()
