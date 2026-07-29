"""
tests/test_handoff_manager.py — HandoffManager 单元测试（T-P4-08）
=====================================================================

验证内容：
1. estimate_tokens / estimate_messages_tokens
   - 空字符串 / 空列表
   - 中英文混合估算（4 字符 ≈ 1 token）
   - 多模态消息（content 为 list）
2. HandoffManager 初始化
   - 默认参数（max_tokens=32000, recent_n=10）
   - 自定义参数
   - 非法参数校验（max_tokens < 1000 / recent_n < 1）
3. compress - 无需压缩场景
   - 原始 token 数 ≤ max_tokens 时返回原始消息
   - compressed=False
4. compress - recent_n 策略
   - 保留最后 N 条消息
   - removed_count 正确
5. compress - summary 策略
   - 保留首 2 条 + 中间摘要 + 尾 N 条
   - 摘要消息为 system 角色
6. compress - key_tool_calls 策略
   - 保留 system / user 消息
   - 保留高 risky 工具调用（L3/L4）
   - 保留最后 N 条
7. 非法策略名抛 ValueError
8. 全局单例 get_global_manager / reset_for_test

运行：
    cd python-sidecar
    python -m pytest tests/test_handoff_manager.py -v
"""

from __future__ import annotations

import sys
from pathlib import Path

# 确保能 import handoff_manager 模块
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from handoff_manager import (
    DEFAULT_MAX_TOKENS,
    DEFAULT_RECENT_N,
    TOKEN_RATIO,
    HandoffManager,
    estimate_messages_tokens,
    estimate_tokens,
    get_global_manager,
    reset_for_test,
)


# ============================================================================
# 1. estimate_tokens / estimate_messages_tokens 单元测试
# ============================================================================

class TestEstimateTokens:
    """token 估算函数测试"""

    def test_empty_string_returns_zero(self) -> None:
        """空字符串返回 0"""
        assert estimate_tokens("") == 0

    def test_short_string_returns_at_least_1(self) -> None:
        """短字符串至少返回 1"""
        # "a" 长度 1，1 // 4 = 0，但 max(1, 0) = 1
        assert estimate_tokens("a") == 1

    def test_4_chars_returns_1(self) -> None:
        """4 字符 ≈ 1 token"""
        assert estimate_tokens("abcd") == 1

    def test_8_chars_returns_2(self) -> None:
        """8 字符 ≈ 2 tokens"""
        assert estimate_tokens("abcdefgh") == 2

    def test_chinese_text_uses_same_ratio(self) -> None:
        """中文同样按 4 字符 ≈ 1 token 估算"""
        # 12 个中文字符 ≈ 3 tokens
        text = "你好世界你好世界你好世界"
        assert len(text) == 12
        assert estimate_tokens(text) == 3

    def test_token_ratio_constant(self) -> None:
        """TOKEN_RATIO 常量为 4"""
        assert TOKEN_RATIO == 4


class TestEstimateMessagesTokens:
    """消息列表 token 估算测试"""

    def test_empty_list_returns_zero(self) -> None:
        """空消息列表返回 0"""
        assert estimate_messages_tokens([]) == 0

    def test_single_string_message(self) -> None:
        """单条字符串消息：content tokens + 4 metadata tokens"""
        # content "abcd" = 1 token, + 4 metadata = 5
        messages = [{"role": "user", "content": "abcd"}]
        assert estimate_messages_tokens(messages) == 5

    def test_multiple_messages_accumulate(self) -> None:
        """多条消息累加"""
        messages = [
            {"role": "system", "content": "abcd"},  # 1 + 4 = 5
            {"role": "user", "content": "abcdefgh"},  # 2 + 4 = 6
        ]
        assert estimate_messages_tokens(messages) == 11

    def test_multimodal_content_list(self) -> None:
        """多模态消息（content 为 list）"""
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "abcd"},  # 1
                    {"type": "text", "text": "efgh"},  # 1
                ],
            },  # 1 + 1 + 4 = 6
        ]
        assert estimate_messages_tokens(messages) == 6

    def test_missing_content_key(self) -> None:
        """缺少 content 字段时仅计 4 metadata tokens"""
        messages = [{"role": "user"}]
        assert estimate_messages_tokens(messages) == 4

    def test_non_string_content_fallback(self) -> None:
        """非字符串 / 非 list 的 content 不计入 content tokens"""
        # content 为 int，不计 content tokens，仅 4 metadata
        messages = [{"role": "user", "content": 12345}]  # type: ignore[dict-item]
        assert estimate_messages_tokens(messages) == 4


# ============================================================================
# 2. HandoffManager 初始化测试
# ============================================================================

class TestHandoffManagerInit:
    """HandoffManager 初始化测试"""

    def test_default_init(self) -> None:
        """默认参数初始化"""
        mgr = HandoffManager()
        assert mgr.max_tokens == DEFAULT_MAX_TOKENS == 32000
        assert mgr.recent_n == DEFAULT_RECENT_N == 10

    def test_custom_init(self) -> None:
        """自定义参数初始化"""
        mgr = HandoffManager(max_tokens=8000, recent_n=5)
        assert mgr.max_tokens == 8000
        assert mgr.recent_n == 5

    def test_max_tokens_too_small_raises(self) -> None:
        """max_tokens < 1000 抛 ValueError"""
        with pytest.raises(ValueError, match="max_tokens must be >= 1000"):
            HandoffManager(max_tokens=999)

    def test_recent_n_too_small_raises(self) -> None:
        """recent_n < 1 抛 ValueError"""
        with pytest.raises(ValueError, match="recent_n must be >= 1"):
            HandoffManager(recent_n=0)


# ============================================================================
# 3. compress - 无需压缩场景
# ============================================================================

class TestCompressNoOp:
    """compress 在未超限时不应压缩"""

    def test_short_messages_not_compressed(self) -> None:
        """短消息列表不触发压缩"""
        mgr = HandoffManager(max_tokens=32000)
        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello"},
        ]
        result = mgr.compress(messages, strategy="recent_n")
        assert result["compressed"] is False
        assert result["removed_count"] == 0
        assert result["original_tokens"] == result["tokens"]
        # 返回的消息是副本（不修改原列表）
        assert result["messages"] == messages
        assert result["messages"] is not messages  # 应为新列表

    def test_empty_messages_not_compressed(self) -> None:
        """空消息列表不触发压缩"""
        mgr = HandoffManager()
        result = mgr.compress([], strategy="recent_n")
        assert result["compressed"] is False
        assert result["tokens"] == 0
        assert result["messages"] == []

    def test_invalid_messages_type_raises(self) -> None:
        """messages 非 list 抛 ValueError"""
        mgr = HandoffManager()
        with pytest.raises(ValueError, match="messages must be list"):
            mgr.compress("not a list", strategy="recent_n")  # type: ignore[arg-type]

    def test_invalid_strategy_raises(self) -> None:
        """未知策略抛 ValueError"""
        mgr = HandoffManager()
        with pytest.raises(ValueError, match="strategy must be one of"):
            mgr.compress([], strategy="unknown_strategy")


# ============================================================================
# 4. compress - recent_n 策略
# ============================================================================

class TestCompressRecentN:
    """recent_n 策略测试"""

    def test_keeps_last_n_messages(self) -> None:
        """保留最后 N 条消息"""
        # max_tokens 最小值 1000，用 1000 + 大 content 触发压缩
        # 每条消息约 800 chars = 200 tokens，6 条 ≈ 1200 tokens > 1000
        mgr = HandoffManager(max_tokens=1000, recent_n=3)
        big_content = "x" * 800
        messages = [
            {"role": "user", "content": f"msg-{i}-{big_content}"}
            for i in range(6)
        ]
        result = mgr.compress(messages, strategy="recent_n")
        assert result["compressed"] is True
        assert len(result["messages"]) == 3
        # 应保留最后 3 条
        kept_contents = [m["content"] for m in result["messages"]]
        assert kept_contents == [messages[3]["content"], messages[4]["content"], messages[5]["content"]]
        assert result["removed_count"] == 3

    def test_recent_n_smaller_than_total_keeps_all(self) -> None:
        """消息数 ≤ recent_n 时保留全部（不进入压缩分支）"""
        # 由于 token 数 ≤ max_tokens，会先返回 no-op
        mgr = HandoffManager(max_tokens=32000, recent_n=10)
        messages = [{"role": "user", "content": "short"}] * 5
        result = mgr.compress(messages, strategy="recent_n")
        # 不触发压缩
        assert result["compressed"] is False
        assert len(result["messages"]) == 5


# ============================================================================
# 5. compress - summary 策略
# ============================================================================

class TestCompressSummary:
    """summary 策略测试"""

    def test_summary_keeps_head_and_tail(self) -> None:
        """summary 保留首 2 条 + 摘要 + 尾 N 条"""
        # max_tokens=1000 + 大 content 触发压缩
        mgr = HandoffManager(max_tokens=1000, recent_n=2)
        big_content = "y" * 800
        messages = [
            {"role": "system", "content": f"sys-{big_content}"},  # head[0]
            {"role": "user", "content": f"usr0-{big_content}"},  # head[1]
            {"role": "assistant", "content": f"asst1-{big_content}"},  # middle
            {"role": "assistant", "content": f"asst2-{big_content}"},  # middle
            {"role": "user", "content": f"usr3-{big_content}"},  # tail[0]
            {"role": "assistant", "content": f"asst4-{big_content}"},  # tail[1]
        ]
        result = mgr.compress(messages, strategy="summary")
        assert result["compressed"] is True
        kept = result["messages"]
        # 应为 head(2) + summary(1) + tail(2) = 5
        assert len(kept) == 5
        # 首 2 条
        assert kept[0] is messages[0] or kept[0] == messages[0]
        assert kept[1] is messages[1] or kept[1] == messages[1]
        # 摘要消息
        assert kept[2]["role"] == "system"
        assert "[summary]" in kept[2]["content"]
        # 尾 2 条
        assert kept[3] is messages[4] or kept[3] == messages[4]
        assert kept[4] is messages[5] or kept[4] == messages[5]

    def test_summary_message_count_below_threshold(self) -> None:
        """消息数 ≤ recent_n + 2 时 summary 不压缩"""
        # max_tokens=1000 + 大 content 触发压缩，但消息数 3 ≤ 10 + 2 = 12
        mgr = HandoffManager(max_tokens=1000, recent_n=10)
        # 每条 2000 chars = 500 tokens，3 条 = 1500 tokens > 1000
        messages = [
            {"role": "user", "content": "x" * 2000},
            {"role": "user", "content": "y" * 2000},
            {"role": "user", "content": "z" * 2000},
        ]
        result = mgr.compress(messages, strategy="summary")
        # 由于消息数不够 summary 切分，_compress_summary 返回原列表
        # 但 compressed=True（因为触发了压缩分支）
        assert result["compressed"] is True
        assert len(result["messages"]) == 3  # 原样返回


# ============================================================================
# 6. compress - key_tool_calls 策略
# ============================================================================

class TestCompressKeyToolCalls:
    """key_tool_calls 策略测试"""

    def test_keeps_system_user_messages(self) -> None:
        """key_tool_calls 保留 system / user 消息"""
        mgr = HandoffManager(max_tokens=1000, recent_n=2)
        big_content = "z" * 800
        messages = [
            {"role": "system", "content": f"sys-{big_content}"},  # head[0] 保留
            {"role": "user", "content": f"usr0-{big_content}"},  # head[1] 保留
            {"role": "user", "content": f"usr1-{big_content}"},  # 中间 user 保留
            {"role": "assistant", "content": f"asst2-{big_content}"},  # 中间 assistant 过滤
            {"role": "assistant", "content": f"asst3-{big_content}"},  # tail[0]
            {"role": "user", "content": f"usr4-{big_content}"},  # tail[1]
        ]
        result = mgr.compress(messages, strategy="key_tool_calls")
        assert result["compressed"] is True
        kept = result["messages"]
        # 应包含 head(2) + 中间 user(1) + tail(2) = 5（assistant 被过滤）
        kept_roles = [m["role"] for m in kept]
        # head + middle user + tail
        assert "system" in kept_roles  # head[0]
        assert kept_roles.count("user") >= 3  # head[1] + middle user + tail user
        # 中间的 assistant 不应保留
        # tail 是最后 2 条 messages[-2:]，应包含 asst3 + usr4
        assert kept[-1]["content"] == messages[5]["content"]
        assert kept[-2]["content"] == messages[4]["content"]

    def test_keeps_high_risk_tool_calls(self) -> None:
        """高风险（L3/L4）工具调用消息保留"""
        mgr = HandoffManager(max_tokens=1000, recent_n=2)
        big_content = "w" * 800
        messages = [
            {"role": "system", "content": f"sys-{big_content}"},
            {"role": "user", "content": f"usr0-{big_content}"},
            # 中间：低风险工具调用（应过滤）
            {"role": "assistant", "content": f"low-risk-{big_content}", "risk_level": "L1"},
            # 中间：高风险工具调用（应保留）
            {"role": "assistant", "content": f"high-risk-{big_content}", "risk_level": "L4"},
            # 中间：带 tool_calls 字段的 assistant 消息
            {
                "role": "assistant",
                "content": f"with-tool-calls-{big_content}",
                "tool_calls": [{"id": "tc-1", "risk_level": "L3"}],
            },
            # tail 2 条
            {"role": "user", "content": f"usr-tail1-{big_content}"},
            {"role": "assistant", "content": f"asst-tail2-{big_content}"},
        ]
        result = mgr.compress(messages, strategy="key_tool_calls")
        assert result["compressed"] is True
        kept = result["messages"]
        kept_contents = [m["content"] for m in kept]
        # L4 risk_level 消息应被保留
        assert any("high-risk" in c for c in kept_contents)
        # 带 tool_calls 且高风险的应被保留
        assert any("with-tool-calls" in c for c in kept_contents)
        # L1 低风险应被过滤
        assert not any("low-risk" in c for c in kept_contents)


# ============================================================================
# 7. 全局单例测试
# ============================================================================

class TestGlobalManager:
    """全局单例测试"""

    def test_get_global_manager_returns_singleton(self) -> None:
        """get_global_manager 返回单例"""
        reset_for_test()
        mgr1 = get_global_manager()
        mgr2 = get_global_manager()
        assert mgr1 is mgr2
        assert isinstance(mgr1, HandoffManager)

    def test_reset_for_test_clears_singleton(self) -> None:
        """reset_for_test 清空单例"""
        reset_for_test()
        mgr1 = get_global_manager()
        reset_for_test()
        mgr2 = get_global_manager()
        assert mgr1 is not mgr2


# ============================================================================
# 8. 集成场景测试
# ============================================================================

class TestIntegrationScenarios:
    """集成场景测试"""

    def test_full_32k_scenario_not_compressed(self) -> None:
        """32K token 限制下的常见对话不触发压缩"""
        mgr = HandoffManager(max_tokens=32000)
        # 模拟 20 轮对话，每轮约 200 字符 = 50 tokens
        messages: list[dict] = []
        for i in range(20):
            messages.append({"role": "user", "content": f"Question {i}: " + "x" * 200})
            messages.append({"role": "assistant", "content": f"Answer {i}: " + "y" * 200})
        # 总 token ≈ 40 * (50 + 4) ≈ 2160，远小于 32K
        result = mgr.compress(messages, strategy="recent_n")
        assert result["compressed"] is False
        assert result["original_tokens"] < 32000

    def test_compress_all_strategies_produce_valid_messages(self) -> None:
        """三种策略压缩后都应返回有效的消息列表"""
        mgr = HandoffManager(max_tokens=1000, recent_n=3)
        big_content = "x" * 800
        messages = [
            {"role": "system", "content": f"sys-{big_content}"},
            {"role": "user", "content": f"usr0-{big_content}"},
            {"role": "assistant", "content": f"asst1-{big_content}"},
            {"role": "assistant", "content": f"asst2-{big_content}"},
            {"role": "user", "content": f"usr3-{big_content}"},
            {"role": "assistant", "content": f"asst4-{big_content}"},
        ]
        for strategy in ("recent_n", "summary", "key_tool_calls"):
            result = mgr.compress(messages, strategy=strategy)
            assert result["compressed"] is True
            assert isinstance(result["messages"], list)
            assert len(result["messages"]) > 0
            assert result["tokens"] < result["original_tokens"]
