"""
tests/test_steer_inject.py — SteerInject tool 单元测试（T-P4-06）
===================================================================

验证内容：
1. 参数校验
   - agent_name 必填 + 字符串类型
   - instruction 必填 + 字符串类型
   - session_id 类型校验
   - priority 校验（low/normal/high）
2. 注入队列
   - 单条指令入队
   - 多条指令按入队顺序
   - 不同 agent_name / session_id 隔离
3. get_pending_instructions
   - 取出指令后清空队列
   - 按优先级排序（high > normal > low）
   - 不存在的队列返回空
4. clear_queue
   - 清空所有队列
   - 按 agent_name / session_id 清空
5. 工具元数据
   - get_tool_metadata() 返回正确结构
6. 工具注册表集成
   - TOOL_REGISTRY 包含 steer_inject
   - invoke_tool 路由正确

运行：
    cd python-sidecar
    python -m pytest tests/test_steer_inject.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import tools 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from tools.steer_inject import (
    clear_queue,
    get_pending_instructions,
    get_tool_metadata,
    invoke_steer_inject_tool,
)
from tools import TOOL_REGISTRY, invoke_tool


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture(autouse=True)
def reset_queue():
    """每个测试前后清空注入队列，保证隔离"""
    clear_queue()
    yield
    clear_queue()


# ============================================================================
# 1. 参数校验测试
# ============================================================================

class TestSteerInjectValidation:
    """SteerInject 参数校验测试"""

    def test_missing_agent_name_raises(self) -> None:
        """缺少 agent_name 应抛 ValueError"""
        with pytest.raises(ValueError, match="agent_name must not be empty"):
            invoke_steer_inject_tool({
                "instruction": "use type hints",
            })

    def test_empty_agent_name_raises(self) -> None:
        """空 agent_name 应抛 ValueError"""
        with pytest.raises(ValueError, match="agent_name must not be empty"):
            invoke_steer_inject_tool({
                "agent_name": "",
                "instruction": "test",
            })

    def test_non_str_agent_name_raises(self) -> None:
        """非字符串 agent_name 应抛 ValueError"""
        with pytest.raises(ValueError, match="agent_name must be str"):
            invoke_steer_inject_tool({
                "agent_name": 123,  # type: ignore[dict-item]
                "instruction": "test",
            })

    def test_missing_instruction_raises(self) -> None:
        """缺少 instruction 应抛 ValueError"""
        with pytest.raises(ValueError, match="instruction must not be empty"):
            invoke_steer_inject_tool({
                "agent_name": "coding",
            })

    def test_empty_instruction_raises(self) -> None:
        """空 instruction 应抛 ValueError"""
        with pytest.raises(ValueError, match="instruction must not be empty"):
            invoke_steer_inject_tool({
                "agent_name": "coding",
                "instruction": "",
            })

    def test_non_str_instruction_raises(self) -> None:
        """非字符串 instruction 应抛 ValueError"""
        with pytest.raises(ValueError, match="instruction must be str"):
            invoke_steer_inject_tool({
                "agent_name": "coding",
                "instruction": 123,  # type: ignore[dict-item]
            })

    def test_non_str_session_id_raises(self) -> None:
        """非字符串 session_id 应抛 ValueError"""
        with pytest.raises(ValueError, match="session_id must be str"):
            invoke_steer_inject_tool({
                "agent_name": "coding",
                "instruction": "test",
                "session_id": 123,  # type: ignore[dict-item]
            })

    def test_invalid_priority_raises(self) -> None:
        """非法 priority 应抛 ValueError"""
        with pytest.raises(ValueError, match="priority must be one of"):
            invoke_steer_inject_tool({
                "agent_name": "coding",
                "instruction": "test",
                "priority": "urgent",  # type: ignore[dict-item]
            })


# ============================================================================
# 2. 注入队列测试
# ============================================================================

class TestSteerInjectQueue:
    """SteerInject 注入队列测试"""

    def test_single_inject_returns_correct_structure(self) -> None:
        """单条注入返回正确结构"""
        result = invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "use type hints",
        })
        assert result["ok"] is True
        assert result["agent_name"] == "coding"
        assert result["instruction"] == "use type hints"
        assert result["queued"] is True
        assert result["queue_size"] == 1
        assert "timestamp" in result
        assert result["priority"] == "normal"  # 默认值

    def test_multiple_increments_queue_size(self) -> None:
        """多次注入增加 queue_size"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "first",
        })
        result = invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "second",
        })
        assert result["queue_size"] == 2

    def test_different_agents_isolated(self) -> None:
        """不同 agent_name 的队列隔离"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "for coding",
        })
        result = invoke_steer_inject_tool({
            "agent_name": "teach",
            "instruction": "for teach",
        })
        # teach 的队列只有 1 条
        assert result["queue_size"] == 1

    def test_different_sessions_isolated(self) -> None:
        """不同 session_id 的队列隔离"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "sess1 instr",
            "session_id": "sess-1",
        })
        result = invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "sess2 instr",
            "session_id": "sess-2",
        })
        # sess-2 的队列只有 1 条
        assert result["queue_size"] == 1

    def test_priority_stored(self) -> None:
        """priority 字段被存储"""
        result = invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "high priority task",
            "priority": "high",
        })
        assert result["priority"] == "high"


# ============================================================================
# 3. get_pending_instructions 测试
# ============================================================================

class TestGetPendingInstructions:
    """get_pending_instructions 测试"""

    def test_returns_instructions_in_order(self) -> None:
        """按入队顺序返回指令"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "first",
        })
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "second",
        })

        items = get_pending_instructions("coding")
        assert len(items) == 2
        # 默认 priority 相同，按入队顺序
        assert items[0]["instruction"] == "first"
        assert items[1]["instruction"] == "second"

    def test_clears_queue_after_get(self) -> None:
        """取出后清空队列"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "test",
        })

        items1 = get_pending_instructions("coding")
        assert len(items1) == 1

        items2 = get_pending_instructions("coding")
        assert len(items2) == 0

    def test_priority_ordering(self) -> None:
        """按优先级排序：high > normal > low"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "low prio",
            "priority": "low",
        })
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "high prio",
            "priority": "high",
        })
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "normal prio",
            "priority": "normal",
        })

        items = get_pending_instructions("coding")
        assert len(items) == 3
        # high 优先级排第一
        assert items[0]["instruction"] == "high prio"
        assert items[0]["priority"] == "high"
        # normal 第二
        assert items[1]["instruction"] == "normal prio"
        # low 最后
        assert items[2]["instruction"] == "low prio"

    def test_empty_queue_returns_empty_list(self) -> None:
        """空队列返回空列表"""
        items = get_pending_instructions("nonexistent")
        assert items == []

    def test_session_id_filtering(self) -> None:
        """按 session_id 过滤"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "sess1",
            "session_id": "sess-1",
        })
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "sess2",
            "session_id": "sess-2",
        })

        items1 = get_pending_instructions("coding", "sess-1")
        assert len(items1) == 1
        assert items1[0]["instruction"] == "sess1"

        items2 = get_pending_instructions("coding", "sess-2")
        assert len(items2) == 1
        assert items2[0]["instruction"] == "sess2"


# ============================================================================
# 4. clear_queue 测试
# ============================================================================

class TestClearQueue:
    """clear_queue 测试"""

    def test_clear_all_returns_count(self) -> None:
        """清空所有队列返回清空数量"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "a",
        })
        invoke_steer_inject_tool({
            "agent_name": "teach",
            "instruction": "b",
        })

        count = clear_queue()
        assert count == 2

        # 队列已清空
        assert get_pending_instructions("coding") == []
        assert get_pending_instructions("teach") == []

    def test_clear_by_agent_name(self) -> None:
        """按 agent_name 清空"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "a",
        })
        invoke_steer_inject_tool({
            "agent_name": "teach",
            "instruction": "b",
        })

        count = clear_queue(agent_name="coding")
        assert count == 1

        # coding 队列已清空
        assert get_pending_instructions("coding") == []
        # teach 队列保留
        assert len(get_pending_instructions("teach")) == 1

    def test_clear_by_session_id(self) -> None:
        """按 session_id 清空"""
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "sess1",
            "session_id": "sess-1",
        })
        invoke_steer_inject_tool({
            "agent_name": "coding",
            "instruction": "sess2",
            "session_id": "sess-2",
        })

        count = clear_queue(session_id="sess-1")
        assert count == 1

        # sess-1 已清空
        assert get_pending_instructions("coding", "sess-1") == []
        # sess-2 保留
        assert len(get_pending_instructions("coding", "sess-2")) == 1

    def test_clear_empty_queue_returns_zero(self) -> None:
        """清空空队列返回 0"""
        count = clear_queue()
        assert count == 0


# ============================================================================
# 5. 工具元数据测试
# ============================================================================

class TestSteerInjectMetadata:
    """SteerInject 工具元数据测试"""

    def test_metadata_structure(self) -> None:
        """元数据结构正确"""
        meta = get_tool_metadata()
        assert meta["name"] == "steer_inject"
        assert "description" in meta
        assert "input_schema" in meta
        assert "output_schema" in meta

    def test_input_schema_required_fields(self) -> None:
        """input_schema 包含必填字段"""
        meta = get_tool_metadata()
        required = meta["input_schema"]["required"]
        assert "agent_name" in required
        assert "instruction" in required

    def test_input_schema_properties(self) -> None:
        """input_schema 包含字段定义"""
        meta = get_tool_metadata()
        properties = meta["input_schema"]["properties"]
        assert "agent_name" in properties
        assert "instruction" in properties
        assert "session_id" in properties
        assert "priority" in properties

    def test_priority_enum(self) -> None:
        """priority 字段包含 enum 定义"""
        meta = get_tool_metadata()
        priority = meta["input_schema"]["properties"]["priority"]
        assert "enum" in priority
        assert set(priority["enum"]) == {"low", "normal", "high"}


# ============================================================================
# 6. 工具注册表集成测试
# ============================================================================

class TestSteerInjectRegistry:
    """SteerInject 工具注册表集成测试"""

    def test_registered_in_tool_registry(self) -> None:
        """steer_inject 已注册到 TOOL_REGISTRY"""
        assert "steer_inject" in TOOL_REGISTRY

    def test_invoke_tool_routes_to_steer_inject(self) -> None:
        """invoke_tool 正确路由到 steer_inject"""
        result = invoke_tool("steer_inject", {
            "agent_name": "coding",
            "instruction": "via invoke_tool",
        })
        assert result["ok"] is True
        assert result["agent_name"] == "coding"
        assert result["instruction"] == "via invoke_tool"

    def test_unknown_tool_raises_key_error(self) -> None:
        """未知工具名抛 KeyError"""
        with pytest.raises(KeyError):
            invoke_tool("nonexistent_tool", {})
