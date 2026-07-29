"""observability — Langfuse 可观测性集成（T-P5-07）

提供 OpenTelemetry 兼容的可观测性客户端，
支持离线模式缓存到本地 SQLite，避免丢失 trace 数据。

子模块：
- langfuse_client: LangfuseClient 核心实现
"""
from __future__ import annotations

from .langfuse_client import (
    LangfuseClient,
    SpanContext,
    TraceContext,
    get_client,
    reset_client_for_test,
)

__all__ = [
    "LangfuseClient",
    "SpanContext",
    "TraceContext",
    "get_client",
    "reset_client_for_test",
]
