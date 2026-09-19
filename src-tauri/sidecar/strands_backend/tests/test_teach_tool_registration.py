"""
strands_backend/tests/test_teach_tool_registration.py — 教学包装工具必须能被 SDK 注册
=====================================================================================

深度体检 A4（2026-09-19）：`wrap_tool_for_teach_mode` 早先用裸
`functools.wraps` 函数作为返回值，而 SDK 的 `ToolRegistry.process_tools`
只接受 AgentTool 实例，对未知规格**只打一条 WARNING 就静默丢弃**。后果不是
"拦截没生效"而是**工具整个消失**：教学模式一开，ssh_command /
read_remote_file / analyze_logs / inspect_processes / network_diagnose /
security_audit / performance_analyze / config_diff 全部不再出现在工具集里，
模型连调用的机会都没有，学生看不到任何命令卡。

既有的 `test_strands_adapter_context.py` 用假 Registry（process_tools 只把
list 存下来）断言 `"ssh_command" in names`，所以在生产丢工具的情况下依然全绿。
本文件用**真的 ToolRegistry** 钉住这条不变量。

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/test_teach_tool_registration.py -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

try:
    from strands.tools.registry import ToolRegistry  # type: ignore[import]

    _STRANDS_AVAILABLE = True
except ImportError:
    _STRANDS_AVAILABLE = False

from strands_backend.tools import (  # noqa: E402
    ToolContext,
    make_all_ops_tools,
    wrap_tool_for_teach_mode,
)
from strands_backend.tools.shell_mapping import has_shell_mapping  # noqa: E402


def _teach_ctx() -> ToolContext:
    return ToolContext(
        event_bus=None,
        rust_bridge=None,
        agent_name="teach-reg-test",
        session_id="s-teach",
        ssh_session_id="",
        # permission_level=2：L1 会把非只读工具从 schema 里裁掉，
        # 那样 ssh_command 根本不在集合里，本测试就测不到包装器的行为了
        permission_level=2,
        workspace="",
        wsl_distro="",
        teach=True,
    )


def _registered(tools: list) -> set[str]:
    """过一遍真的 SDK registry，返回它实际接受的工具名。"""
    registry = ToolRegistry()
    registry.process_tools(tools)
    return set(registry.registry.keys())


@unittest.skipUnless(_STRANDS_AVAILABLE, "strands-agents 未安装，跳过注册回归")
class TestTeachWrapperKeepsToolsRegistered(unittest.TestCase):
    def test_shell_mapped_tools_survive_wrapping(self) -> None:
        """核心回归：包装前后被 registry 接受的集合必须一致（旧实现少 8 个）。"""
        ctx = _teach_ctx()
        tools = make_all_ops_tools(ctx)
        before = _registered(tools)
        after = _registered([wrap_tool_for_teach_mode(t, ctx) for t in tools])
        dropped = before - after
        self.assertEqual(
            set(),
            dropped,
            f"教学包装把工具从 SDK registry 里弄丢了：{sorted(dropped)}",
        )
        # 断言的不是"数量差不多"，而是这一批确实存在且没丢
        mapped = {
            getattr(t, "__name__", "")
            for t in tools
            if has_shell_mapping(getattr(t, "__name__", ""))
        }
        self.assertTrue(mapped, "shell_mapping 表为空，本测试失去意义")
        self.assertTrue(
            mapped <= after,
            f"有 shell 映射的工具必须仍在工具集内：缺 {sorted(mapped - after)}",
        )

    def test_wrapped_tool_spec_matches_original(self) -> None:
        """重新装饰后 schema 必须与原工具逐字段相同（否则模型看到的契约变了）。"""
        ctx = _teach_ctx()
        tools = {getattr(t, "__name__", ""): t for t in make_all_ops_tools(ctx)}
        original = tools["ssh_command"]
        wrapped = wrap_tool_for_teach_mode(original, ctx)
        for field in ("name", "description", "inputSchema"):
            self.assertEqual(
                original.tool_spec[field],
                wrapped.tool_spec[field],
                f"tool_spec.{field} 在包装后发生变化",
            )

    def test_wrapped_tool_still_intercepts(self) -> None:
        """注册回来了，拦截语义也必须还在：返回 teach_command 卡而非真执行。"""
        ctx = _teach_ctx()
        tools = {getattr(t, "__name__", ""): t for t in make_all_ops_tools(ctx)}
        wrapped = wrap_tool_for_teach_mode(tools["ssh_command"], ctx)
        # 重新装饰后它是真的 DecoratedFunctionTool，按工具签名具名调用
        result = wrapped(command="systemctl status nginx")
        self.assertEqual("teach_command", result.get("status"))
        self.assertIn("systemctl", str(result.get("command", "")))

    def test_unmapped_tools_returned_unchanged(self) -> None:
        """无 shell 映射的工具走快速路径：原对象直接返回（不重新装饰）。"""
        ctx = _teach_ctx()
        tools = {getattr(t, "__name__", ""): t for t in make_all_ops_tools(ctx)}
        name = next(
            n for n, t in tools.items() if not has_shell_mapping(n)
        )
        self.assertIs(tools[name], wrap_tool_for_teach_mode(tools[name], ctx))


if __name__ == "__main__":
    unittest.main()
