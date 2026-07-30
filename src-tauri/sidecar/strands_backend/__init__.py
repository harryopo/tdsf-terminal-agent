"""
strands_backend/__init__.py — Strands Agents 后端适配层包入口
===============================================================

职责：
- 导出 ``StrandsAgentAdapter``（适配层核心类），供 ``main.py`` 通过 feature flag 注入。
- 提供 ``configure_strands`` 便捷函数（与方案文档 §4.2 集成接入点对齐）。
- 提供包版本与可用性自检（``is_strands_available``）。

集成方式（main.py:332-358，本包不修改 main.py，仅给出推荐用法）：

    backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
    if backend == "strands":
        try:
            from strands_backend import StrandsAgentAdapter, configure_strands
            adapter = configure_strands(
                event_bus=event_bus.get_global_bus(),
                rust_bridge=None,  # P2 阶段注入真实 send_request
            )
            agents.set_backend(
                lambda agent_id, input, state: adapter.invoke(agent_id, input, state)
            )
        except Exception as se:
            logger.exception(f"failed to activate Strands backend, fallback: {se}")
            agents.configure_agents(
                event_bus=event_bus.get_global_bus(), llm_call=llm_call
            )
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.adapter import StrandsAgentAdapter, TdsfStrandsCallbackHandler
from strands_backend.tools import (
    DefaultRustBridge,
    RustBridge,
    RiskChecker,
    ToolContext,
    TOOL_DECORATOR_AVAILABLE,
    OPS_TOOL_NAMES,
    make_all_ops_tools,
)

logger = logging.getLogger("sidecar.strands_backend")

__version__ = "0.1.0"

# Strands 是否可用（运行时检测，供 main.py 决策）
try:
    from strands import Agent as _StrandsAgent  # type: ignore[import]
    from strands import tool as _strands_tool  # type: ignore[import]
    is_strands_available = True
except ImportError:
    is_strands_available = False


def configure_strands(
    event_bus: Any,
    rust_bridge: RustBridge | None = None,
    strands_model: Any = None,
    backend_enabled: bool = True,
    system_prompt: str | None = None,
    max_iterations: int = 10,
) -> StrandsAgentAdapter:
    """便捷构造函数：创建并返回 StrandsAgentAdapter 实例

    与方案文档 §4.2 集成接入点对齐：main.py 调用此函数注入 Strands 后端。

    Args:
        event_bus: EventBus 实例
        rust_bridge: RustBridge 实例（None 时用 DefaultRustBridge()，未配置 send_request）
        strands_model: Strands Model 对象（P0 阶段由 model_adapter.py 构造，None 时降级）
        backend_enabled: feature flag，False 时直接降级
        system_prompt: 系统提示词（None 时用默认）
        max_iterations: Strands Agent 最大迭代次数

    Returns:
        StrandsAgentAdapter 实例
    """
    adapter = StrandsAgentAdapter(
        event_bus=event_bus,
        rust_bridge=rust_bridge or DefaultRustBridge(),
        backend_enabled=backend_enabled,
        system_prompt=system_prompt,
        strands_model=strands_model,
        max_iterations=max_iterations,
    )
    logger.info(
        f"Strands backend configured: strands_available={is_strands_available}, "
        f"adapter={adapter.get_stats()}"
    )
    return adapter


__all__ = [
    # 适配层核心
    "StrandsAgentAdapter",
    "TdsfStrandsCallbackHandler",
    # 便捷函数
    "configure_strands",
    # 工具基础设施
    "DefaultRustBridge",
    "RustBridge",
    "RiskChecker",
    "ToolContext",
    "make_all_ops_tools",
    "OPS_TOOL_NAMES",
    "TOOL_DECORATOR_AVAILABLE",
    # 元信息
    "is_strands_available",
    "__version__",
]
