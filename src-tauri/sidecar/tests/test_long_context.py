"""
tests/test_long_context.py — LongContextManager 单元测试（T-P5-02）
====================================================================

验证内容：
1. token 估算
2. feature flag 开关（enabled True/False 行为差异）
3. chunk 分块（段落边界 + 句子边界 + 字符强制切分）
4. merge 合并
5. summarize 摘要（hash 模拟）
6. FeatureFlags 加载
7. JSON-RPC 注册方法

运行：
    cd python-sidecar
    python -m pytest tests/test_long_context.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from long_context import (
    FeatureFlags,
    LongContextManager,
    get_feature_flags,
    get_manager,
    reset_manager,
)


# ============================================================================
# Fixture
# ============================================================================

@pytest.fixture
def disabled_mgr() -> LongContextManager:
    """关闭状态的 LongContextManager"""
    return LongContextManager(enabled=False)


@pytest.fixture
def enabled_mgr() -> LongContextManager:
    """启用状态的 LongContextManager"""
    return LongContextManager(enabled=True, max_tokens_per_chunk=100, summary_max_tokens=50)


@pytest.fixture
def flags() -> FeatureFlags:
    """加载真实 config/feature_flags.yaml 的 FeatureFlags"""
    config_path = Path(__file__).parent.parent / "config" / "feature_flags.yaml"
    return FeatureFlags(config_path=config_path)


# ============================================================================
# 1. token 估算测试
# ============================================================================

class TestTokenEstimation:
    """token 估算测试"""

    def test_empty_text_yields_zero(self):
        """空文本 → 0 token"""
        assert LongContextManager.estimate_tokens("") == 0

    def test_short_text_yields_at_least_one(self):
        """短文本 → 至少 1 token"""
        assert LongContextManager.estimate_tokens("hello") >= 1

    def test_long_text_scales_linearly(self):
        """长文本 token 数应随长度增加"""
        short_tokens = LongContextManager.estimate_tokens("a" * 100)
        long_tokens = LongContextManager.estimate_tokens("a" * 1000)
        assert long_tokens > short_tokens


# ============================================================================
# 2. feature flag 开关测试
# ============================================================================

class TestFeatureFlagSwitch:
    """feature flag 开关测试"""

    def test_disabled_chunk_returns_single_chunk(self, disabled_mgr: LongContextManager):
        """关闭时 chunk 应返回单块（不分块）"""
        long_text = "a" * 10000  # 超长文本
        chunks = disabled_mgr.chunk(long_text, max_tokens=100)
        assert len(chunks) == 1
        assert chunks[0] == long_text

    def test_enabled_chunk_splits_long_text(self, enabled_mgr: LongContextManager):
        """启用时 chunk 应切分超长文本"""
        # 构造 1000 字符的文本（约 400 token），max_tokens=100 → 应切多块
        long_text = "word " * 200  # ~1000 字符
        chunks = enabled_mgr.chunk(long_text, max_tokens=100)
        assert len(chunks) > 1

    def test_disabled_summarize_no_hash_annotation(self, disabled_mgr: LongContextManager):
        """关闭时 summarize 不加 hash 标注"""
        text = "hello world"
        summary = disabled_mgr.summarize(text, max_tokens=100)
        assert "[summary]" not in summary
        assert "[hash=" not in summary

    def test_enabled_summarize_long_text_adds_hash(self, enabled_mgr: LongContextManager):
        """启用时超长文本 → hash 回退标注"""
        text = "hello world " * 100  # 超长（> max_chars）触发摘要路径
        summary = enabled_mgr.summarize(text, max_tokens=100)
        assert "[summary]" in summary
        assert "[hash=" in summary


# ============================================================================
# 3. chunk 分块测试
# ============================================================================

class TestChunking:
    """chunk 分块测试"""

    def test_empty_text_returns_single_empty_chunk(self, enabled_mgr: LongContextManager):
        """空文本 → [""]"""
        chunks = enabled_mgr.chunk("")
        assert chunks == [""]

    def test_short_text_returns_single_chunk(self, enabled_mgr: LongContextManager):
        """短文本 → 单块（不切分）"""
        chunks = enabled_mgr.chunk("short text", max_tokens=1000)
        assert len(chunks) == 1

    def test_paragraph_boundary_split(self, enabled_mgr: LongContextManager):
        """按段落边界切分"""
        # 每段约 50 字符，max_tokens=20（~50 字符）→ 每段一块
        text = "paragraph one with enough words.\n\nparagraph two with enough words.\n\nparagraph three."
        chunks = enabled_mgr.chunk(text, max_tokens=20)
        assert len(chunks) >= 2

    def test_long_paragraph_splits_by_sentence(self, enabled_mgr: LongContextManager):
        """超长段落按句子切分"""
        # 单段超长，含多个句子
        text = "sentence one. sentence two. sentence three. sentence four. sentence five. sentence six."
        chunks = enabled_mgr.chunk(text, max_tokens=20)
        assert len(chunks) >= 2

    def test_chunk_respects_max_tokens(self, enabled_mgr: LongContextManager):
        """每块 token 数应不超过 max_tokens（句子边界允许略微超限）"""
        text = "a" * 1000  # 单句超长，强制字符切分
        chunks = enabled_mgr.chunk(text, max_tokens=50)
        # 强制字符切分后，每块应接近 max_tokens × 2.5 字符
        for chunk in chunks:
            # 允许 ±10% 误差
            assert LongContextManager.estimate_tokens(chunk) <= 60


# ============================================================================
# 4. merge 合并测试
# ============================================================================

class TestMerge:
    """merge 合并测试"""

    def test_empty_list_returns_empty(self):
        """空列表 → 空字符串"""
        assert LongContextManager.merge([]) == ""

    def test_single_chunk(self):
        """单块 → 原样返回"""
        assert LongContextManager.merge(["only one"]) == "only one"

    def test_multiple_chunks_joined_by_double_newline(self):
        """多块用 \\n\\n 连接"""
        merged = LongContextManager.merge(["a", "b", "c"])
        assert merged == "a\n\nb\n\nc"

    def test_merge_round_trip(self, enabled_mgr: LongContextManager):
        """chunk + merge 应近似还原原文"""
        original = "para one.\n\npara two.\n\npara three."
        chunks = enabled_mgr.chunk(original, max_tokens=1000)
        merged = LongContextManager.merge(chunks)
        assert merged == original


# ============================================================================
# 5. summarize 摘要测试
# ============================================================================

class TestSummarize:
    """summarize 摘要测试"""

    def test_empty_text_returns_empty(self, enabled_mgr: LongContextManager):
        """空文本 → 空字符串"""
        assert enabled_mgr.summarize("") == ""

    def test_short_text_returns_original(self, enabled_mgr: LongContextManager):
        """短文本 → 直接返回原文（不摘要不加标注）"""
        text = "hello"
        summary = enabled_mgr.summarize(text, max_tokens=100)
        assert summary == text
        assert "[summary]" not in summary

    def test_long_text_truncated(self, enabled_mgr: LongContextManager):
        """长文本 → 截断 + 省略号 + hash"""
        text = "a" * 1000  # 1000 字符
        summary = enabled_mgr.summarize(text, max_tokens=10)  # max 25 字符
        assert "[summary]" in summary
        assert "..." in summary
        assert "[hash=" in summary
        # 截断后的内容应远短于原文
        assert len(summary) < 100

    def test_hash_consistency(self, enabled_mgr: LongContextManager):
        """相同超长文本 → 相同 hash"""
        text = "consistent hash test " * 50  # 超长触发 hash 回退
        s1 = enabled_mgr.summarize(text, max_tokens=50)
        s2 = enabled_mgr.summarize(text, max_tokens=50)
        # 提取 hash 部分
        import re
        h1 = re.search(r"\[hash=([a-f0-9]+)\]", s1)
        h2 = re.search(r"\[hash=([a-f0-9]+)\]", s2)
        assert h1 is not None and h2 is not None
        assert h1.group(1) == h2.group(1)


# ============================================================================
# 6. FeatureFlags 加载测试
# ============================================================================

class TestFeatureFlags:
    """FeatureFlags 加载测试"""

    def test_loads_without_error(self, flags: FeatureFlags):
        """应能加载 feature_flags.yaml"""
        assert flags is not None

    def test_long_context_flag_exists(self, flags: FeatureFlags):
        """long_context flag 应存在"""
        # 默认配置中 long_context.enabled = false
        assert flags.long_context_enabled in (True, False)

    def test_squilla_router_enabled(self, flags: FeatureFlags):
        """squilla_router 默认启用"""
        assert flags.squilla_router_enabled is True

    def test_to_dict_returns_all_flags(self, flags: FeatureFlags):
        """to_dict 应包含所有 flag"""
        d = flags.to_dict()
        assert "long_context" in d
        assert "squilla_router" in d
        assert "langfuse" in d
        assert "kepa" in d
        assert "skill_auto_generate" in d

    def test_get_manager_singleton(self):
        """get_manager 应返回单例"""
        reset_manager()
        m1 = get_manager()
        m2 = get_manager()
        assert m1 is m2
        reset_manager()


# ============================================================================
# 7. status 方法测试
# ============================================================================

class TestStatus:
    """status 方法测试"""

    def test_status_returns_dict(self, disabled_mgr: LongContextManager):
        """status 应返回 dict"""
        status = disabled_mgr.status()
        assert isinstance(status, dict)
        assert "enabled" in status
        assert "max_tokens_per_chunk" in status
        assert "summary_max_tokens" in status

    def test_status_reflects_state(self, enabled_mgr: LongContextManager):
        """status 应反映当前状态"""
        status = enabled_mgr.status()
        assert status["enabled"] is True
        assert status["max_tokens_per_chunk"] == 100
        assert status["summary_max_tokens"] == 50

