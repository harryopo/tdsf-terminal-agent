"""
tests/test_rlm_fanout.py — RLMFanout tool 单元测试（T-P4-04）
=================================================================

验证内容：
1. 参数校验
   - prompt 必填 + 非空
   - n 校验（正整数，限制 1-16）
   - strategy 校验（voting/longest/highest）
   - mock 校验（bool）
2. mock 模式执行
   - 多路并行执行
   - 返回结果结构正确
   - mock=True 时不调用真实 LLM
3. 聚合策略
   - voting: 多数投票
   - longest: 最长输出
   - highest: 最高评分
4. n 限制
   - n > 16 应被截断为 16
   - n < 1 应被截断为 1
5. 工具元数据

运行：
    cd python-sidecar
    python -m pytest tests/test_rlm_fanout.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import tools 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from tools.rlm_fanout import (
    _aggregate_results,
    get_tool_metadata,
    invoke_rlm_fanout_tool,
)


# ============================================================================
# 1. 参数校验测试
# ============================================================================

class TestRLMFanoutValidation:
    """参数校验测试"""

    def test_empty_prompt_raises(self) -> None:
        """空 prompt 应抛出 ValueError"""
        with pytest.raises(ValueError, match="prompt must not be empty"):
            invoke_rlm_fanout_tool({"prompt": ""})

    def test_prompt_not_str_raises(self) -> None:
        """prompt 非 str 应抛出 ValueError"""
        with pytest.raises(ValueError, match="prompt must be str"):
            invoke_rlm_fanout_tool({"prompt": 123})  # type: ignore[arg-type]

    def test_n_invalid_raises(self) -> None:
        """n 非正整数应抛出 ValueError"""
        with pytest.raises(ValueError, match="n must be positive int"):
            invoke_rlm_fanout_tool({"prompt": "p", "n": 0})

    def test_strategy_invalid_raises(self) -> None:
        """strategy 非法值应抛出 ValueError"""
        with pytest.raises(ValueError, match="strategy must be one of"):
            invoke_rlm_fanout_tool({
                "prompt": "p",
                "strategy": "invalid",
            })

    def test_mock_not_bool_raises(self) -> None:
        """mock 非 bool 应抛出 ValueError"""
        with pytest.raises(ValueError, match="mock must be bool"):
            invoke_rlm_fanout_tool({
                "prompt": "p",
                "mock": "yes",  # type: ignore[arg-type]
            })


# ============================================================================
# 2. mock 模式执行测试
# ============================================================================

class TestRLMFanoutMockExecution:
    """mock 模式执行测试"""

    def test_single_n_mock(self) -> None:
        """n=1 mock 模式执行"""
        result = invoke_rlm_fanout_tool({
            "prompt": "fix nginx config",
            "n": 1,
            "mock": True,
        })
        assert result["n"] == 1
        assert result["succeeded"] == 1
        assert result["mock"] is True
        assert isinstance(result["aggregated_output"], str)
        assert len(result["aggregated_output"]) > 0
        assert len(result["results"]) == 1

    def test_multiple_n_mock(self) -> None:
        """n=4 mock 模式并行执行"""
        result = invoke_rlm_fanout_tool({
            "prompt": "fix nginx config",
            "n": 4,
            "mock": True,
        })
        assert result["n"] == 4
        assert result["succeeded"] == 4
        assert len(result["results"]) == 4

    def test_n_capped_at_16(self) -> None:
        """n > 16 应被截断为 16"""
        result = invoke_rlm_fanout_tool({
            "prompt": "p",
            "n": 100,
            "mock": True,
        })
        assert result["n"] == 16
        assert len(result["results"]) == 16

    def test_n_min_1(self) -> None:
        """n < 1 应抛出 ValueError（参数校验）"""
        with pytest.raises(ValueError, match="n must be positive int"):
            invoke_rlm_fanout_tool({
                "prompt": "p",
                "n": -5,
                "mock": True,
            })

    def test_default_strategy_is_voting(self) -> None:
        """默认 strategy=voting"""
        result = invoke_rlm_fanout_tool({
            "prompt": "p",
            "mock": True,
        })
        assert result["strategy"] == "voting"


# ============================================================================
# 3. 聚合策略测试
# ============================================================================

class TestRLMFanoutAggregation:
    """3 种聚合策略测试"""

    def test_voting_strategy_returns_most_common(self) -> None:
        """voting 策略：选择最常见的输出"""
        results = [
            {"idx": 0, "output": "A", "score": 0.9, "success": True},
            {"idx": 1, "output": "A", "score": 0.8, "success": True},
            {"idx": 2, "output": "B", "score": 0.95, "success": True},
        ]
        aggregated = _aggregate_results(results, "voting")
        assert aggregated == "A"  # A 出现 2 次，B 出现 1 次

    def test_longest_strategy_returns_longest(self) -> None:
        """longest 策略：选择最长的输出"""
        results = [
            {"idx": 0, "output": "short", "score": 0.9, "success": True},
            {"idx": 1, "output": "this is a longer output", "score": 0.7, "success": True},
            {"idx": 2, "output": "mid", "score": 0.95, "success": True},
        ]
        aggregated = _aggregate_results(results, "longest")
        assert aggregated == "this is a longer output"

    def test_highest_strategy_returns_highest_score(self) -> None:
        """highest 策略：选择评分最高的输出"""
        results = [
            {"idx": 0, "output": "low", "score": 0.5, "success": True},
            {"idx": 1, "output": "high", "score": 0.95, "success": True},
            {"idx": 2, "output": "mid", "score": 0.7, "success": True},
        ]
        aggregated = _aggregate_results(results, "highest")
        assert aggregated == "high"

    def test_aggregate_empty_results_returns_empty(self) -> None:
        """空结果应返回空字符串"""
        aggregated = _aggregate_results([], "voting")
        assert aggregated == ""

    def test_aggregate_all_failed_returns_empty(self) -> None:
        """全部失败的结果应返回空字符串"""
        results = [
            {"idx": 0, "output": "", "score": 0.0, "success": False},
        ]
        aggregated = _aggregate_results(results, "voting")
        assert aggregated == ""

    def test_highest_without_score_falls_back_to_longest(self) -> None:
        """highest 策略无 score 字段时应退化为 longest"""
        results = [
            {"idx": 0, "output": "short", "success": True},
            {"idx": 1, "output": "this is longer", "success": True},
        ]
        aggregated = _aggregate_results(results, "highest")
        assert aggregated == "this is longer"


# ============================================================================
# 4. 结果结构测试
# ============================================================================

class TestRLMFanoutResultStructure:
    """返回结果结构测试"""

    def test_result_has_required_fields(self) -> None:
        """返回结果包含必需字段"""
        result = invoke_rlm_fanout_tool({
            "prompt": "p",
            "n": 2,
            "mock": True,
        })
        for field in (
            "aggregated_output", "strategy", "results", "n",
            "succeeded", "duration", "mock",
        ):
            assert field in result, f"missing field: {field}"

    def test_each_result_has_required_fields(self) -> None:
        """每个子任务结果包含必需字段"""
        result = invoke_rlm_fanout_tool({
            "prompt": "p",
            "n": 2,
            "mock": True,
        })
        for r in result["results"]:
            for field in ("idx", "output", "score", "success", "duration"):
                assert field in r, f"missing field in result: {field}"


# ============================================================================
# 5. 工具元数据测试
# ============================================================================

class TestRLMFanoutMetadata:
    """工具元数据测试"""

    def test_get_tool_metadata_structure(self) -> None:
        meta = get_tool_metadata()
        assert "name" in meta
        assert "description" in meta
        assert "input_schema" in meta
        assert "output_schema" in meta
        assert meta["name"] == "rlm_fanout"

    def test_input_schema_has_prompt(self) -> None:
        meta = get_tool_metadata()
        assert "prompt" in meta["input_schema"]["properties"]
        assert "prompt" in meta["input_schema"]["required"]

    def test_strategy_enum_has_3_options(self) -> None:
        meta = get_tool_metadata()
        strategy_prop = meta["input_schema"]["properties"]["strategy"]
        assert set(strategy_prop["enum"]) == {"voting", "longest", "highest"}


# ============================================================================
# 6. 集成测试（与 TOOL_REGISTRY）
# ============================================================================

class TestRLMFanoutIntegration:
    """通过 TOOL_REGISTRY 调用测试"""

    def test_invoke_via_registry(self) -> None:
        from tools import TOOL_REGISTRY, invoke_tool

        assert "rlm_fanout" in TOOL_REGISTRY
        result = invoke_tool("rlm_fanout", {
            "prompt": "p",
            "n": 2,
            "mock": True,
        })
        assert result["n"] == 2
        assert result["succeeded"] == 2
