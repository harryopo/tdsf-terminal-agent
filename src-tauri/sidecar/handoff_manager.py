"""
handoff_manager.py — 32K 上下文压缩管理器（T-P4-08）
=======================================================

实现 32K token 限制的上下文压缩：
- 3 种压缩策略：
  - recent_n:       保留最近 N 轮对话（默认 10 轮）
  - summary:        摘要压缩（保留首尾 + 中间摘要）
  - key_tool_calls: 保留关键工具调用（按 risk_level 过滤）
- 估算 token 数（基于字符数 / 4 的粗略估算）
- 压缩后 token 数 ≤ 32K（默认）

使用方式：
    from handoff_manager import HandoffManager

    mgr = HandoffManager(max_tokens=32000)
    compressed = mgr.compress(messages, strategy="recent_n")
    print(compressed["tokens"], compressed["strategy"])
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.handoff")


# ============================================================================
# 常量
# ============================================================================

DEFAULT_MAX_TOKENS = 32000  # 32K token 限制
DEFAULT_RECENT_N = 10       # recent_n 策略默认保留轮数
TOKEN_RATIO = 4             # 粗略估算：4 字符 ≈ 1 token（中英文混合）


def estimate_tokens(text: str) -> int:
    """估算字符串的 token 数（粗略：4 字符 ≈ 1 token）

    Args:
        text: 输入字符串

    Returns:
        估算的 token 数
    """
    if not text:
        return 0
    return max(1, len(text) // TOKEN_RATIO)


def estimate_messages_tokens(messages: list[dict[str, Any]]) -> int:
    """估算消息列表的 token 数

    Args:
        messages: 消息列表（OpenAI Chat Completions 兼容格式）

    Returns:
        估算的总 token 数
    """
    total = 0
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            # 多模态消息（list of parts）
            for part in content:
                if isinstance(part, dict):
                    total += estimate_tokens(str(part.get("text", "")))
        # role + metadata 开销（粗略 +4 tokens）
        total += 4
    return total


class HandoffManager:
    """32K 上下文压缩管理器

    Args:
        max_tokens: 最大 token 数，默认 32000
        recent_n:   recent_n 策略保留轮数，默认 10
    """

    def __init__(
        self,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        recent_n: int = DEFAULT_RECENT_N,
    ) -> None:
        if max_tokens < 1000:
            raise ValueError(
                f"max_tokens must be >= 1000, got {max_tokens}"
            )
        if recent_n < 1:
            raise ValueError(f"recent_n must be >= 1, got {recent_n}")

        self.max_tokens = max_tokens
        self.recent_n = recent_n

    def compress(
        self,
        messages: list[dict[str, Any]],
        strategy: str = "recent_n",
    ) -> dict[str, Any]:
        """压缩消息列表

        Args:
            messages: 消息列表（OpenAI Chat Completions 兼容格式）
            strategy: 压缩策略（recent_n / summary / key_tool_calls）

        Returns:
            {
                "messages": list[dict],   # 压缩后的消息列表
                "tokens": int,            # 压缩后 token 数
                "original_tokens": int,   # 原始 token 数
                "strategy": str,          # 使用的策略
                "compressed": bool,       # 是否触发了压缩
                "removed_count": int,     # 移除的消息数
            }

        Raises:
            ValueError: 未知策略
        """
        if not isinstance(messages, list):
            raise ValueError(
                f"messages must be list, got {type(messages).__name__}"
            )

        valid_strategies = ("recent_n", "summary", "key_tool_calls")
        if strategy not in valid_strategies:
            raise ValueError(
                f"strategy must be one of {valid_strategies}, got '{strategy}'"
            )

        original_tokens = estimate_messages_tokens(messages)

        # 未超限，无需压缩
        if original_tokens <= self.max_tokens:
            return {
                "messages": list(messages),
                "tokens": original_tokens,
                "original_tokens": original_tokens,
                "strategy": strategy,
                "compressed": False,
                "removed_count": 0,
            }

        # 按策略压缩
        if strategy == "recent_n":
            compressed_msgs = self._compress_recent_n(messages)
        elif strategy == "summary":
            compressed_msgs = self._compress_summary(messages)
        else:  # key_tool_calls
            compressed_msgs = self._compress_key_tool_calls(messages)

        compressed_tokens = estimate_messages_tokens(compressed_msgs)

        logger.info(
            f"handoff.compress: strategy={strategy}, "
            f"original={original_tokens} tokens, "
            f"compressed={compressed_tokens} tokens, "
            f"removed={len(messages) - len(compressed_msgs)} msgs"
        )

        return {
            "messages": compressed_msgs,
            "tokens": compressed_tokens,
            "original_tokens": original_tokens,
            "strategy": strategy,
            "compressed": True,
            "removed_count": len(messages) - len(compressed_msgs),
        }

    def _compress_recent_n(
        self,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """recent_n 策略：保留最近 N 轮对话

        Args:
            messages: 消息列表

        Returns:
            压缩后的消息列表（保留最近 N 轮）
        """
        if len(messages) <= self.recent_n:
            return list(messages)
        # 保留最后 recent_n 条
        return list(messages[-self.recent_n:])

    def _compress_summary(
        self,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """summary 策略：保留首尾 + 中间摘要

        保留前 2 条（系统 + 首条用户消息）+ 最后 N 条 + 中间摘要

        Args:
            messages: 消息列表

        Returns:
            压缩后的消息列表
        """
        if len(messages) <= self.recent_n + 2:
            return list(messages)

        head = messages[:2]
        tail = messages[-self.recent_n:]
        middle = messages[2:-self.recent_n]

        # 构建中间摘要
        middle_summary_parts: list[str] = []
        for msg in middle:
            role = msg.get("role", "?")
            content = msg.get("content", "")
            if isinstance(content, str):
                # 截取前 100 字符
                snippet = content[:100].replace("\n", " ")
                middle_summary_parts.append(f"[{role}] {snippet}...")
            elif isinstance(content, list):
                middle_summary_parts.append(f"[{role}] (multimodal)")

        summary_text = (
            f"[summary] Compressed {len(middle)} messages:\n" +
            "\n".join(middle_summary_parts[:20])  # 最多保留 20 条摘要
        )
        summary_msg: dict[str, Any] = {
            "role": "system",
            "content": summary_text,
        }

        return head + [summary_msg] + tail

    def _compress_key_tool_calls(
        self,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """key_tool_calls 策略：保留关键工具调用（按 risk_level 过滤）

        保留：
        - 系统消息（role=system）
        - 用户消息（role=user）
        - 高风险工具调用（risk_level >= L3）
        - 最后 N 轮对话

        Args:
            messages: 消息列表

        Returns:
            压缩后的消息列表
        """
        if len(messages) <= self.recent_n + 2:
            return list(messages)

        result: list[dict[str, Any]] = []
        # 保留前 2 条
        result.extend(messages[:2])

        # 中间消息：仅保留关键工具调用
        middle = messages[2:-self.recent_n]
        for msg in middle:
            role = msg.get("role", "")
            # 保留系统消息和用户消息
            if role in ("system", "user"):
                result.append(msg)
                continue
            # 工具调用消息：检查 risk_level
            risk_level = msg.get("risk_level", "")
            if risk_level in ("L3", "L4"):
                result.append(msg)
                continue
            # assistant 消息带 tool_calls 字段
            tool_calls = msg.get("tool_calls", [])
            if tool_calls:
                # 检查工具调用是否高风险
                has_high_risk = any(
                    tc.get("risk_level") in ("L3", "L4")
                    for tc in tool_calls
                    if isinstance(tc, dict)
                )
                if has_high_risk:
                    result.append(msg)

        # 保留最后 N 条
        result.extend(messages[-self.recent_n:])

        # 去重（避免重复）
        seen_ids: set[int] = set()
        deduped: list[dict[str, Any]] = []
        for msg in result:
            msg_id = id(msg)
            if msg_id not in seen_ids:
                seen_ids.add(msg_id)
                deduped.append(msg)

        return deduped


# ============================================================================
# 模块级单例
# ============================================================================

_global_manager: HandoffManager | None = None


def get_global_manager() -> HandoffManager:
    """获取全局 HandoffManager 实例（懒加载）"""
    global _global_manager
    if _global_manager is None:
        _global_manager = HandoffManager()
    return _global_manager


def reset_for_test() -> None:
    """重置全局状态（测试用）"""
    global _global_manager
    _global_manager = None
