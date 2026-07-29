"""
tests/test_byoa.py — BYOA Harness 单元测试（T-P4-02）
======================================================

验证内容：
1. ADAPTER_REGISTRY 完整性
   - 包含 5 个 adapter（claude/codex/cursor/aider/continue）
2. BaseAdapter 抽象基类
   - 不能直接实例化
   - 子类必须实现 name/cli_command/_run_mock/_run_real
3. ClaudeAdapter / CodexAdapter / CursorAdapter / AiderAdapter / ContinueAdapter
   - name 属性
   - cli_command 属性
   - mock 模式调用返回非空字符串
   - 调用统计正确（invocations / mock_calls）
4. BYOAHarness
   - list_adapters() 返回 5 个适配器
   - get_adapter() 获取指定适配器
   - invoke() 调用 mock 模式返回正确结果
   - invoke_all() 调用所有适配器
   - get_stats() / reset_stats() 统计管理

运行：
    cd python-sidecar
    python -m pytest tests/test_byoa.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import byoa 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

# === byoa 模块导入 ===
from byoa.adapters import (
    ADAPTER_REGISTRY,
    AiderAdapter,
    BaseAdapter,
    ClaudeAdapter,
    CodexAdapter,
    ContinueAdapter,
    CursorAdapter,
)
from byoa.adapters.base import BaseAdapter
from byoa.harness import BYOAHarness


# ============================================================================
# 1. ADAPTER_REGISTRY 完整性测试
# ============================================================================

class TestAdapterRegistry:
    """ADAPTER_REGISTRY 注册表完整性测试"""

    def test_registry_contains_5_adapters(self) -> None:
        """注册表应包含 5 个 adapter"""
        assert len(ADAPTER_REGISTRY) == 5

    def test_registry_keys(self) -> None:
        """注册表应包含指定 5 个 key"""
        expected = {"claude", "codex", "cursor", "aider", "continue"}
        assert set(ADAPTER_REGISTRY.keys()) == expected

    def test_registry_values_are_classes(self) -> None:
        """注册表 value 应为 BaseAdapter 子类"""
        for cls in ADAPTER_REGISTRY.values():
            assert issubclass(cls, BaseAdapter)


# ============================================================================
# 2. BaseAdapter 抽象基类测试
# ============================================================================

class TestBaseAdapter:
    """BaseAdapter 抽象基类测试"""

    def test_cannot_instantiate_directly(self) -> None:
        """BaseAdapter 不能直接实例化（抽象类）"""
        with pytest.raises(TypeError):
            BaseAdapter(mock=True)  # type: ignore[abstract]


# ============================================================================
# 3. 各 Adapter 单元测试
# ============================================================================

class TestClaudeAdapter:
    """ClaudeAdapter 测试"""

    def test_name_property(self) -> None:
        adapter = ClaudeAdapter(mock=True)
        assert adapter.name == "claude"

    def test_cli_command_property(self) -> None:
        adapter = ClaudeAdapter(mock=True)
        assert adapter.cli_command == "claude"

    def test_run_mock_returns_non_empty(self) -> None:
        """mock 模式调用应返回非空字符串"""
        adapter = ClaudeAdapter(mock=True)
        output = adapter.run("test prompt")
        assert isinstance(output, str)
        assert len(output) > 0
        assert "mock-claude" in output

    def test_stats_incremented(self) -> None:
        """调用统计应正确递增"""
        adapter = ClaudeAdapter(mock=True)
        adapter.run("prompt 1")
        adapter.run("prompt 2")
        stats = adapter.get_stats()
        assert stats["invocations"] == 2
        assert stats["mock_calls"] == 2
        assert stats["real_calls"] == 0
        assert stats["errors"] == 0

    def test_reset_stats(self) -> None:
        """reset_stats 应清零所有统计"""
        adapter = ClaudeAdapter(mock=True)
        adapter.run("prompt")
        adapter.reset_stats()
        stats = adapter.get_stats()
        assert all(v == 0 for v in stats.values())


class TestCodexAdapter:
    """CodexAdapter 测试"""

    def test_name_property(self) -> None:
        adapter = CodexAdapter(mock=True)
        assert adapter.name == "codex"

    def test_run_mock_returns_non_empty(self) -> None:
        adapter = CodexAdapter(mock=True)
        output = adapter.run("test prompt")
        assert isinstance(output, str)
        assert len(output) > 0


class TestCursorAdapter:
    """CursorAdapter 测试"""

    def test_name_property(self) -> None:
        adapter = CursorAdapter(mock=True)
        assert adapter.name == "cursor"

    def test_run_mock_returns_non_empty(self) -> None:
        adapter = CursorAdapter(mock=True)
        output = adapter.run("test prompt")
        assert isinstance(output, str)
        assert len(output) > 0


class TestAiderAdapter:
    """AiderAdapter 测试"""

    def test_name_property(self) -> None:
        adapter = AiderAdapter(mock=True)
        assert adapter.name == "aider"

    def test_run_mock_returns_non_empty(self) -> None:
        adapter = AiderAdapter(mock=True)
        output = adapter.run("test prompt")
        assert isinstance(output, str)
        assert len(output) > 0


class TestContinueAdapter:
    """ContinueAdapter 测试"""

    def test_name_property(self) -> None:
        adapter = ContinueAdapter(mock=True)
        assert adapter.name == "continue"

    def test_run_mock_returns_non_empty(self) -> None:
        adapter = ContinueAdapter(mock=True)
        output = adapter.run("test prompt")
        assert isinstance(output, str)
        assert len(output) > 0


# ============================================================================
# 4. BYOAHarness 测试
# ============================================================================

class TestBYOAHarness:
    """BYOAHarness 主入口测试"""

    def test_init_default_mock(self) -> None:
        """默认 mock=True"""
        harness = BYOAHarness()
        assert harness.mock is True
        assert harness.timeout == 30

    def test_list_adapters_returns_5(self) -> None:
        """list_adapters() 返回 5 个 adapter"""
        harness = BYOAHarness(mock=True)
        adapters = harness.list_adapters()
        assert len(adapters) == 5
        assert set(adapters) == {"claude", "codex", "cursor", "aider", "continue"}

    def test_get_adapter_returns_instance(self) -> None:
        """get_adapter() 返回 adapter 实例"""
        harness = BYOAHarness(mock=True)
        adapter = harness.get_adapter("claude")
        assert isinstance(adapter, ClaudeAdapter)
        assert adapter.mock is True

    def test_get_adapter_unknown_raises(self) -> None:
        """未知 adapter 名应抛出 KeyError"""
        harness = BYOAHarness(mock=True)
        with pytest.raises(KeyError):
            harness.get_adapter("unknown")

    def test_invoke_returns_correct_structure(self) -> None:
        """invoke() 返回正确结构"""
        harness = BYOAHarness(mock=True)
        result = harness.invoke("claude", "test prompt")
        assert "adapter" in result
        assert "output" in result
        assert "mock" in result
        assert "stats" in result
        assert result["adapter"] == "claude"
        assert result["mock"] is True
        assert isinstance(result["output"], str)
        assert len(result["output"]) > 0

    def test_invoke_all_calls_all_adapters(self) -> None:
        """invoke_all() 调用所有 adapter"""
        harness = BYOAHarness(mock=True)
        result = harness.invoke_all("test prompt")
        assert "results" in result
        assert "mock" in result
        assert len(result["results"]) == 5

    def test_get_stats_returns_all_adapters(self) -> None:
        """get_stats() 返回所有 adapter 的统计"""
        harness = BYOAHarness(mock=True)
        harness.invoke("claude", "prompt")
        stats = harness.get_stats()
        assert "claude" in stats
        assert stats["claude"]["invocations"] == 1

    def test_reset_stats_clears_all(self) -> None:
        """reset_stats() 清零所有 adapter 统计"""
        harness = BYOAHarness(mock=True)
        harness.invoke("claude", "prompt")
        harness.reset_stats()
        stats = harness.get_stats()
        assert stats["claude"]["invocations"] == 0

    def test_repr_returns_string(self) -> None:
        """__repr__ 返回字符串"""
        harness = BYOAHarness(mock=True)
        s = repr(harness)
        assert isinstance(s, str)
        assert "BYOAHarness" in s
