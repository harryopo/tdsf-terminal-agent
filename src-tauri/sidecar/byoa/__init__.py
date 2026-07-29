"""
byoa/__init__.py — Bring Your Own Agent (BYOA) Harness（T-P4-02）
===================================================================

模块组成：
- harness:           BYOA Harness 主入口（统一适配外部 CLI Agent）
- adapters/base:     Adapter 抽象基类
- adapters/claude:   Claude CLI 适配器
- adapters/codex:    Codex CLI 适配器
- adapters/cursor:   Cursor CLI 适配器
- adapters/aider:    Aider CLI 适配器
- adapters/continue: Continue CLI 适配器

设计原则：
1. 所有 adapter 继承 BaseAdapter，统一接口：``run(prompt) -> str``
2. mock 模式可离线运行（不依赖真实 CLI 安装）
3. 通过 harness.list_adapters() 列出所有可用适配器
4. 通过 harness.invoke(name, prompt) 调用指定适配器

使用方式：
    from byoa import BYOAHarness
    harness = BYOAHarness(mock=True)
    result = harness.invoke("claude", "fix nginx config")
"""

from __future__ import annotations

from byoa.harness import BYOAHarness
from byoa.adapters.base import BaseAdapter
from byoa.adapters.claude import ClaudeAdapter
from byoa.adapters.codex import CodexAdapter
from byoa.adapters.cursor import CursorAdapter
from byoa.adapters.aider import AiderAdapter
from byoa.adapters.continue_adapter import ContinueAdapter

__all__ = [
    "BYOAHarness",
    "BaseAdapter",
    "ClaudeAdapter",
    "CodexAdapter",
    "CursorAdapter",
    "AiderAdapter",
    "ContinueAdapter",
    # 便捷函数
    "get_harness",
    "reset_harness",
]


# ============================================================================
# 模块级单例（懒加载）
# ============================================================================

_harness_instance: BYOAHarness | None = None


def get_harness(mock: bool = True, force_rebuild: bool = False) -> BYOAHarness:
    """获取 BYOA Harness 单例（懒加载）

    Args:
        mock: 是否启用 mock 模式（离线测试用）
        force_rebuild: 强制重建实例

    Returns:
        BYOAHarness 实例
    """
    global _harness_instance
    if _harness_instance is None or force_rebuild:
        _harness_instance = BYOAHarness(mock=mock)
    return _harness_instance


def reset_harness() -> None:
    """重置 Harness 单例"""
    global _harness_instance
    _harness_instance = None
