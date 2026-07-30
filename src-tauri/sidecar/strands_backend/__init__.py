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
                # strands_model 留空时自动调用 create_strands_model(load_config())
                # 与 LangGraph 路径共享同一份 LLMConfig（环境变量 / .tdsf-data/llm_config.json）
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
    llm_config: Any = None,
    backend_enabled: bool = True,
    system_prompt: str | None = None,
    max_iterations: int = 10,
) -> StrandsAgentAdapter:
    """便捷构造函数：创建并返回 StrandsAgentAdapter 实例

    与方案文档 §4.2 集成接入点对齐：main.py 调用此函数注入 Strands 后端。

    P0-C5 集成（2026-07-30）：``strands_model=None`` 时自动调用
    ``strands_backend.model_adapter.create_strands_model(llm_config)`` 注入 Strands Model，
    与 LangGraph 路径共享同一份 LLMConfig（环境变量 / .tdsf-data/llm_config.json）。
    这样 main.py 注入 Strands 后端时无需重复加载 LLM 配置，也避免双套配置导致行为分裂。

    Args:
        event_bus: EventBus 实例
        rust_bridge: RustBridge 实例（None 时用 DefaultRustBridge()，未配置 send_request）
        strands_model: Strands Model 对象。**None 时自动调用 create_strands_model(llm_config)**
                       （P0-C5 改动：之前 None 即降级，现在 None 自动注入）
        llm_config: LLMConfig 实例。仅当 ``strands_model=None`` 时使用，
                    传给 ``create_strands_model``。None 时由 ``create_strands_model``
                    内部调用 ``load_config()`` 自动加载（环境变量优先，配置文件回退）。
                    显式传入便于测试 / 运行时重新配置（如 agent.configure RPC 切换 LLM 后调用）。
        backend_enabled: feature flag，False 时直接降级
        system_prompt: 系统提示词（None 时用默认）
        max_iterations: Strands Agent 最大迭代次数

    Returns:
        StrandsAgentAdapter 实例（``strands_model`` 仍可能为 None，例如未配置 API Key 或
        Strands 未安装——此时 adapter.invoke 走降级路径，详见 adapter._check_degraded）
    """
    # P0-C5: strands_model=None 时自动注入（与 LangGraph 路径共享同一份 LLMConfig）
    if strands_model is None:
        # 延迟导入避免循环依赖（model_adapter 不导入本模块，但保持延迟导入是良好习惯）
        try:
            from strands_backend.model_adapter import create_strands_model
            strands_model = create_strands_model(llm_config)
            if strands_model is not None:
                logger.info(
                    "configure_strands: strands_model auto-injected via "
                    "create_strands_model(llm_config)"
                )
            else:
                logger.warning(
                    "configure_strands: create_strands_model returned None "
                    "(LLM not configured / Strands not installed / provider unsupported); "
                    "adapter will degrade on invoke"
                )
        except Exception as e:
            # 模型适配失败不应阻塞 sidecar 启动；adapter 走降级路径
            logger.exception(
                f"configure_strands: failed to auto-inject strands_model: {e}"
            )
            strands_model = None

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
