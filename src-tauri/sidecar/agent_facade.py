"""Strands-only Agent JSON-RPC facade.

The production Agent runtime lives in :mod:`strands_backend`.  This module keeps
the stable ``agent.invoke/list/info/configure`` wire contract while exposing a
single ``main`` Agent to callers.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

logger = logging.getLogger("sidecar.agent_facade")

BackendInvokeCallable = Callable[
    [str, str, dict[str, Any]], dict[str, Any]
]

AGENT_REGISTRY: dict[str, str] = {"main": "StrandsAgentAdapter"}

_global_backend: BackendInvokeCallable | None = None
_global_strands_adapter: Any = None


def _require_known_agent(name: str) -> None:
    if name not in AGENT_REGISTRY:
        raise KeyError(
            f"unknown agent: {name!r}, available: {list(AGENT_REGISTRY)}"
        )


def set_backend(backend: BackendInvokeCallable) -> None:
    """Install the active Strands invocation entrypoint."""
    global _global_backend
    if not callable(backend):
        raise TypeError(
            f"set_backend expects callable, got {type(backend).__name__}"
        )
    _global_backend = backend
    logger.info(
        "Strands backend set: %s",
        getattr(backend, "__name__", type(backend).__name__),
    )


def set_backend_unavailable(reason: str) -> None:
    """Install a fail-closed entrypoint while keeping diagnostics online."""
    message = str(reason or "Strands backend unavailable")

    def _raise_unavailable(
        agent_id: str,
        input: str,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        del agent_id, input, state
        raise RuntimeError(message)

    set_backend(_raise_unavailable)
    set_strands_adapter(None)
    logger.error("agent backend unavailable (fail-closed): %s", message)


def set_strands_adapter(adapter: Any) -> None:
    """Keep the active adapter reference for metadata and model hot reload."""
    global _global_strands_adapter
    _global_strands_adapter = adapter
    logger.info(
        "Strands adapter reference set: type=%s",
        type(adapter).__name__ if adapter is not None else "None",
    )


def get_strands_adapter() -> Any:
    return _global_strands_adapter


def list_agents() -> list[str]:
    """Return the single public Agent entrypoint."""
    return list(AGENT_REGISTRY)


def invoke_agent(name: str, state: dict[str, Any]) -> dict[str, Any]:
    """Invoke Strands or fail closed when startup did not activate it."""
    _require_known_agent(name)
    if _global_backend is None:
        raise RuntimeError("Strands backend is not configured")
    return _global_backend(
        agent_id=name,
        input=state.get("input", ""),
        state=state,
    )


def reset_for_test() -> None:
    """Reset facade state for isolated tests."""
    global _global_backend, _global_strands_adapter
    _global_backend = None
    _global_strands_adapter = None


def register_methods(dispatcher: Any) -> None:
    """Register the stable Agent JSON-RPC surface."""
    dispatcher.register("agent.invoke", _rpc_agent_invoke)
    dispatcher.register("agent.list", _rpc_agent_list)
    dispatcher.register("agent.info", _rpc_agent_info)
    dispatcher.register("agent.configure", configure)


def _rpc_agent_invoke(name: str, state: dict[str, Any]) -> dict[str, Any]:
    return invoke_agent(name, state)


def _rpc_agent_list() -> dict[str, Any]:
    configured = list_agents() if _global_strands_adapter is not None else []
    return {
        "agents": [
            {"name": name, "class": class_name}
            for name, class_name in AGENT_REGISTRY.items()
        ],
        "configured": configured,
    }


def _rpc_agent_info(name: str) -> dict[str, Any]:
    _require_known_agent(name)
    adapter = _global_strands_adapter
    try:
        from strands_backend.tools import OPS_TOOL_NAMES

        tools = list(OPS_TOOL_NAMES)
    except Exception as error:
        logger.warning("failed to load Strands tool metadata: %s", error)
        tools = []
    return {
        "name": name,
        "role": "Linux operations agent",
        "description": "Strands main Agent for Linux operations and teaching",
        "tools": tools,
        "system_prompt": getattr(adapter, "system_prompt", ""),
    }


def _model_is_configured() -> bool:
    adapter = _global_strands_adapter
    if adapter is None:
        return False
    try:
        return bool(adapter.get_stats().get("model_available", False))
    except Exception:
        return False


def configure(
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist configuration and hot-reload only the active Strands model."""
    if not config:
        return {"ok": True, "llm_call_set": _model_is_configured()}

    try:
        from core.llm_config import LLMConfig, save_config
        from strands_backend.model_adapter import create_strands_model

        llm_config = LLMConfig(
            provider=config.get("provider", "openai"),
            api_key=config.get("api_key", ""),
            base_url=config.get("base_url", ""),
            model=config.get("model", "gpt-4o-mini"),
            temperature=config.get("temperature", 0.7),
            max_tokens=config.get("max_tokens", 2048),
        )
        if not llm_config.is_configured:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "LLM 配置失败：API Key 为空",
            }

        save_config(llm_config)
        adapter = _global_strands_adapter
        if adapter is None:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "Strands 后端未激活，请重启 sidecar 后重试",
            }

        new_model = create_strands_model(llm_config)
        if new_model is None:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "Strands 模型创建失败，请检查 API Key、模型和端点",
            }

        adapter.update_model(new_model)
        return {
            "ok": True,
            "llm_call_set": True,
            "message": f"LLM 配置已更新: {llm_config.provider}/{llm_config.model}",
        }
    except Exception as error:
        logger.exception("Strands model hot-reload failed: %s", error)
        return {
            "ok": False,
            "llm_call_set": False,
            "message": f"LLM 配置异常: {error}",
        }


__all__ = [
    "AGENT_REGISTRY",
    "BackendInvokeCallable",
    "configure",
    "get_strands_adapter",
    "invoke_agent",
    "list_agents",
    "register_methods",
    "reset_for_test",
    "set_backend",
    "set_backend_unavailable",
    "set_strands_adapter",
]
