"""
strands_backend/tests/test_strands_priv.py — 私有字段收口 + 漂移必须可见
==========================================================================

`strands_priv` 是本项目读 strands 私有字段的唯一入口。本文件钉两件事：

1. **字段名对得上真 SDK**：用真的 `ToolRegistry` / `_PluginRegistry` 实例核对，
   strands 一改名这条就红，而不是等到"插件工具静默消失"才在生产里发现
   （A4 丢 8 个工具、#83 丢一半工具，都是"静默缺失"这一族）。
2. **"没有这个字段"和"字段是空的"必须走两条路**：前者 ERROR（= 漂移），
   后者静默（= 用户没启用插件，正常）。

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_strands_priv.py -v
"""
from __future__ import annotations

import logging
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

try:
    from strands import tool  # type: ignore[import]
    from strands.plugins.registry import _PluginRegistry  # type: ignore[import]
    from strands.tools.registry import ToolRegistry  # type: ignore[import]

    _STRANDS_AVAILABLE = True
except ImportError:
    _STRANDS_AVAILABLE = False

from strands_backend.strands_priv import (  # noqa: E402
    DYNAMIC_TOOLS_ATTR,
    PLUGINS_ATTR,
    PLUGIN_REGISTRY_ATTR,
    TOOL_MAP_ATTR,
    iter_plugin_tools,
    replace_registered_tools,
)


class _DummyAgent:
    """`_PluginRegistry` 会对 agent 取弱引用，SimpleNamespace 做不到。"""


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过私有字段核对")
class TestFieldNamesMatchRealSdk(unittest.TestCase):
    """改名 = 这条先红，而不是生产里静默丢功能。"""

    def test_tool_registry_attrs_exist(self) -> None:
        registry = ToolRegistry()
        self.assertIn(TOOL_MAP_ATTR, vars(registry))
        self.assertIn(DYNAMIC_TOOLS_ATTR, vars(registry))

    def test_plugin_registry_dict_attr_exists(self) -> None:
        registry = _PluginRegistry(_DummyAgent())
        self.assertIn(PLUGINS_ATTR, vars(registry))

    def test_agent_declares_plugin_registry_attr(self) -> None:
        import inspect

        from strands.agent.agent import Agent  # type: ignore[import]

        self.assertIn(
            PLUGIN_REGISTRY_ATTR,
            inspect.getsource(Agent.__init__),
            "Agent 构造里已找不到插件注册表字段 —— strands 改了私有实现，"
            "需要更新 strands_priv.PLUGIN_REGISTRY_ATTR",
        )


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过插件工具收集")
class TestIterPluginTools(unittest.TestCase):
    def test_returns_tools_from_real_registry(self) -> None:
        @tool
        def alpha() -> str:
            """alpha"""
            return "a"

        plugin = SimpleNamespace(tools=[alpha])
        inner = _PluginRegistry(_DummyAgent())
        agent = SimpleNamespace(**{PLUGIN_REGISTRY_ATTR: inner})
        getattr(agent, PLUGIN_REGISTRY_ATTR)._plugins["p"] = plugin

        self.assertEqual([alpha], iter_plugin_tools(agent))

    def test_no_plugins_configured_is_silent(self) -> None:
        """`_plugin_registry = None` 是"用户没传 plugins"，不该报 ERROR。"""
        agent = SimpleNamespace(**{PLUGIN_REGISTRY_ATTR: None})
        with self.assertLogs("sidecar.strands_backend.strands_priv", level="DEBUG") as cap:
            self.assertEqual([], iter_plugin_tools(agent))
        self.assertTrue(all(r.levelno < logging.ERROR for r in cap.records))

    def test_missing_attr_is_an_error_not_a_silent_empty(self) -> None:
        """字段整个不存在 = SDK 漂移，必须留下可见证据。"""
        agent = SimpleNamespace(tool_registry=ToolRegistry())
        with self.assertLogs("sidecar.strands_backend.strands_priv", level="ERROR") as cap:
            self.assertEqual([], iter_plugin_tools(agent))
        self.assertIn(PLUGIN_REGISTRY_ATTR, cap.records[0].getMessage())


class TestReplaceRegisteredTools(unittest.TestCase):
    def test_without_strands_the_helper_still_swaps(self) -> None:
        """没有 strands 也要能验证"换干净"这件事（CI 环境可能装不上）。"""

        class FakeRegistry:
            def __init__(self) -> None:
                self.registry: dict[str, object] = {}
                self.dynamic_tools: set[str] = set()
                self.seen: list[list[str]] = []

            def process_tools(self, tools: list) -> None:
                names = [t.__name__ for t in tools]
                self.seen.append(names)
                self.registry.update({n: n for n in names})

        def make(name: str):
            return SimpleNamespace(__name__=name)

        registry = FakeRegistry()
        replace_registered_tools(registry, [make("first")])
        replace_registered_tools(registry, [make("second")])
        # 少了任何一次 clear，这里就会同时留着两轮的工具
        self.assertEqual(["second"], sorted(registry.registry))
        self.assertEqual([["first"], ["second"]], registry.seen)


if __name__ == "__main__":
    unittest.main()
