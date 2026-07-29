"""
byoa/adapters/__init__.py — BYOA Adapter 注册表（T-P4-02）
============================================================

5 个 adapter 实现：
- base:              Adapter 抽象基类
- claude:            Claude CLI 适配器
- codex:             Codex CLI 适配器
- cursor:            Cursor CLI 适配器
- aider:             Aider CLI 适配器
- continue_adapter:  Continue CLI 适配器（避免覆盖 Python 关键字 continue）
"""

from __future__ import annotations

from byoa.adapters.base import BaseAdapter
from byoa.adapters.claude import ClaudeAdapter
from byoa.adapters.codex import CodexAdapter
from byoa.adapters.cursor import CursorAdapter
from byoa.adapters.aider import AiderAdapter
from byoa.adapters.continue_adapter import ContinueAdapter

__all__ = [
    "BaseAdapter",
    "ClaudeAdapter",
    "CodexAdapter",
    "CursorAdapter",
    "AiderAdapter",
    "ContinueAdapter",
    # 注册表
    "ADAPTER_REGISTRY",
]


# adapter name → class（供 harness 使用）
ADAPTER_REGISTRY: dict[str, type[BaseAdapter]] = {
    "claude": ClaudeAdapter,
    "codex": CodexAdapter,
    "cursor": CursorAdapter,
    "aider": AiderAdapter,
    "continue": ContinueAdapter,
}
