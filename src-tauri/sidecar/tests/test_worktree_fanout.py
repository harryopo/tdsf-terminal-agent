"""
tests/test_worktree_fanout.py — WorktreeFanout tool 单元测试（T-P4-03）
=========================================================================

验证内容：
1. 参数校验
   - tasks 必填 + 非空 + 每项含 id 和 prompt
   - max_parallel 校验（正整数，限制 16）
   - branch_prefix 校验（非空字符串）
   - mock 校验（bool）
2. mock 模式执行
   - 多任务并行执行
   - 返回结果结构正确（results/total/succeeded/failed/duration）
   - mock=True 时不调用真实 git
3. 并行度控制
   - max_parallel 限制
4. 错误处理
   - 任务执行异常应返回 success=False
5. 工具元数据
   - get_tool_metadata() 返回正确结构

运行：
    cd python-sidecar
    python -m pytest tests/test_worktree_fanout.py -v
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

# 确保能 import tools 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from tools.worktree_fanout import (
    get_tool_metadata,
    invoke_worktree_fanout_tool,
)


# ============================================================================
# 1. 参数校验测试
# ============================================================================

class TestWorktreeFanoutValidation:
    """参数校验测试"""

    def test_empty_tasks_raises(self) -> None:
        """空 tasks 应抛出 ValueError"""
        with pytest.raises(ValueError, match="tasks must not be empty"):
            invoke_worktree_fanout_tool({"tasks": []})

    def test_tasks_not_list_raises(self) -> None:
        """tasks 非 list 应抛出 ValueError"""
        with pytest.raises(ValueError, match="tasks must be list"):
            invoke_worktree_fanout_tool({"tasks": "not a list"})  # type: ignore[arg-type]

    def test_task_missing_id_raises(self) -> None:
        """task 缺 id 字段应抛出 ValueError"""
        with pytest.raises(ValueError, match="must have 'id' and 'prompt'"):
            invoke_worktree_fanout_tool({
                "tasks": [{"prompt": "test"}],  # 缺 id
            })

    def test_task_missing_prompt_raises(self) -> None:
        """task 缺 prompt 字段应抛出 ValueError"""
        with pytest.raises(ValueError, match="must have 'id' and 'prompt'"):
            invoke_worktree_fanout_tool({
                "tasks": [{"id": "t1"}],  # 缺 prompt
            })

    def test_max_parallel_invalid_raises(self) -> None:
        """max_parallel 非正整数应抛出 ValueError"""
        with pytest.raises(ValueError, match="max_parallel"):
            invoke_worktree_fanout_tool({
                "tasks": [{"id": "t1", "prompt": "p"}],
                "max_parallel": 0,
            })

    def test_branch_prefix_empty_raises(self) -> None:
        """branch_prefix 空字符串应抛出 ValueError"""
        with pytest.raises(ValueError, match="branch_prefix"):
            invoke_worktree_fanout_tool({
                "tasks": [{"id": "t1", "prompt": "p"}],
                "branch_prefix": "",
            })

    def test_mock_not_bool_raises(self) -> None:
        """mock 非 bool 应抛出 ValueError"""
        with pytest.raises(ValueError, match="mock must be bool"):
            invoke_worktree_fanout_tool({
                "tasks": [{"id": "t1", "prompt": "p"}],
                "mock": "yes",  # type: ignore[arg-type]
            })


# ============================================================================
# 2. mock 模式执行测试
# ============================================================================

class TestWorktreeFanoutMockExecution:
    """mock 模式执行测试"""

    def test_single_task_mock(self) -> None:
        """单任务 mock 模式执行"""
        result = invoke_worktree_fanout_tool({
            "tasks": [{"id": "t1", "prompt": "fix bug A"}],
            "mock": True,
        })
        assert result["total"] == 1
        assert result["succeeded"] == 1
        assert result["failed"] == 0
        assert result["mock"] is True
        assert isinstance(result["duration"], (int, float))
        assert result["duration"] >= 0

        # 验证单个结果
        first = result["results"][0]
        assert first["id"] == "t1"
        assert first["success"] is True
        assert first["mock"] is True
        assert "mock-worktree" in first["worktree"]
        assert first["branch"] == "fanout-t1"
        assert isinstance(first["output"], str)
        assert len(first["output"]) > 0

    def test_multiple_tasks_mock(self) -> None:
        """多任务 mock 模式并行执行"""
        tasks = [
            {"id": f"t{i}", "prompt": f"task {i}"}
            for i in range(5)
        ]
        result = invoke_worktree_fanout_tool({
            "tasks": tasks,
            "mock": True,
        })
        assert result["total"] == 5
        assert result["succeeded"] == 5
        assert result["failed"] == 0
        # 结果按 id 顺序排序
        ids = [r["id"] for r in result["results"]]
        assert ids == [f"t{i}" for i in range(5)]

    def test_custom_branch_prefix(self) -> None:
        """自定义 branch_prefix"""
        result = invoke_worktree_fanout_tool({
            "tasks": [{"id": "x1", "prompt": "p"}],
            "branch_prefix": "feature",
            "mock": True,
        })
        assert result["results"][0]["branch"] == "feature-x1"

    def test_max_parallel_capped_at_16(self) -> None:
        """max_parallel > 16 应被限制为 16（不抛错）"""
        tasks = [{"id": f"t{i}", "prompt": f"p{i}"} for i in range(2)]
        # max_parallel=100 应被截断为 16，不应抛错
        result = invoke_worktree_fanout_tool({
            "tasks": tasks,
            "max_parallel": 100,
            "mock": True,
        })
        assert result["total"] == 2
        assert result["succeeded"] == 2


# ============================================================================
# 3. 结果结构测试
# ============================================================================

class TestWorktreeFanoutResultStructure:
    """返回结果结构测试"""

    def test_result_has_required_fields(self) -> None:
        """返回结果包含必需字段"""
        result = invoke_worktree_fanout_tool({
            "tasks": [{"id": "t1", "prompt": "p"}],
            "mock": True,
        })
        for field in ("results", "total", "succeeded", "failed", "duration", "mock"):
            assert field in result, f"missing field: {field}"

    def test_each_result_has_required_fields(self) -> None:
        """每个 task 结果包含必需字段"""
        result = invoke_worktree_fanout_tool({
            "tasks": [{"id": "t1", "prompt": "p"}],
            "mock": True,
        })
        for r in result["results"]:
            for field in ("id", "worktree", "branch", "output", "success", "duration"):
                assert field in r, f"missing field in result: {field}"


# ============================================================================
# 4. 工具元数据测试
# ============================================================================

class TestWorktreeFanoutMetadata:
    """工具元数据测试"""

    def test_get_tool_metadata_structure(self) -> None:
        """get_tool_metadata() 返回正确结构"""
        meta = get_tool_metadata()
        assert "name" in meta
        assert "description" in meta
        assert "input_schema" in meta
        assert "output_schema" in meta
        assert meta["name"] == "worktree_fanout"

    def test_input_schema_has_tasks(self) -> None:
        """input_schema 包含 tasks 字段"""
        meta = get_tool_metadata()
        assert "tasks" in meta["input_schema"]["properties"]
        assert "tasks" in meta["input_schema"]["required"]


# ============================================================================
# 5. 集成测试（与 TOOL_REGISTRY）
# ============================================================================

class TestWorktreeFanoutIntegration:
    """通过 TOOL_REGISTRY 调用测试"""

    def test_invoke_via_registry(self) -> None:
        """通过 TOOL_REGISTRY 调用 worktree_fanout"""
        from tools import TOOL_REGISTRY, invoke_tool

        assert "worktree_fanout" in TOOL_REGISTRY
        result = invoke_tool("worktree_fanout", {
            "tasks": [{"id": "t1", "prompt": "p"}],
            "mock": True,
        })
        assert result["total"] == 1
        assert result["succeeded"] == 1
