"""Strands-only Agent JSON-RPC facade.

The production Agent runtime lives in :mod:`strands_backend`.  This module keeps
the stable ``agent.invoke/list/info/configure`` wire contract while exposing a
single ``main`` Agent to callers.
"""

from __future__ import annotations

import hashlib
import logging
import threading
from collections.abc import Callable
from typing import Any

logger = logging.getLogger("sidecar.agent_facade")

BackendInvokeCallable = Callable[
    [str, str, dict[str, Any]], dict[str, Any]
]

AGENT_REGISTRY: dict[str, str] = {"main": "StrandsAgentAdapter"}

_global_backend: BackendInvokeCallable | None = None
_global_strands_adapter: Any = None
_configure_lock = threading.RLock()
_latest_client_generation = 0


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
    global _global_backend, _global_strands_adapter, _latest_client_generation
    _global_backend = None
    _global_strands_adapter = None
    _latest_client_generation = 0


def register_methods(dispatcher: Any) -> None:
    """Register the stable Agent JSON-RPC surface."""
    dispatcher.register("agent.invoke", _rpc_agent_invoke)
    dispatcher.register("agent.cancel", _rpc_agent_cancel)
    dispatcher.register("agent.set_mode", _rpc_agent_set_mode)
    dispatcher.register("agent.list", _rpc_agent_list)
    dispatcher.register("agent.info", _rpc_agent_info)
    dispatcher.register("agent.configure", configure)


def cancel_agent_session(session_id: str, reason: str = "") -> dict[str, Any]:
    """#69: 让用户按停止后这一会话真的停下来（前端 abort 只关了事件流）。"""
    if _global_strands_adapter is None:
        logger.warning(
            "agent.cancel: no strands adapter, session=%s (backend unavailable)",
            session_id,
        )
        return {
            "session_id": session_id,
            "cancelled": False,
            "reason": "Strands backend unavailable",
        }
    return _global_strands_adapter.request_cancel(session_id, reason)


def _rpc_agent_invoke(name: str, state: dict[str, Any]) -> dict[str, Any]:
    return invoke_agent(name, state)


def _rpc_agent_cancel(session_id: str, reason: str = "") -> dict[str, Any]:
    return cancel_agent_session(session_id, reason)


def _rpc_agent_set_mode(
    session_id: str, stream_id: str, mode: str, revision: int,
) -> dict[str, Any]:
    if _global_strands_adapter is None:
        return {"ok": False, "reason": "not_active"}
    return _global_strands_adapter.set_mode(session_id, stream_id, mode, revision)


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


def _configure_impl(
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create the model before publishing configuration and hot-reloading."""
    if not config:
        adapter = _global_strands_adapter
        return {
            "ok": True,
            "llm_call_set": _model_is_configured(),
            "turn_snapshot": getattr(adapter, "_model_turn_snapshot", None),
        }

    try:
        from core.llm_config import (
            LLMConfig,
            _get_config_path,
            load_config,
            save_config,
            set_runtime_config,
        )
        from strands_backend.model_adapter import create_strands_model
        from strands_backend.model_params import resolve_model_params

        llm_config = LLMConfig(
            provider=config.get("provider", "openai"),
            api_key=config.get("api_key", ""),
            base_url=config.get("base_url", ""),
            model=config.get("model", "gpt-4o-mini"),
            temperature=config.get("temperature", 0.1),
            max_tokens=config.get("max_tokens"),
            thinking=config.get("thinking", "provider_default"),
            reasoning_effort=config.get("reasoning_effort", "provider_default"),
        )
        if not llm_config.is_configured:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "LLM 配置失败：API Key 为空",
            }

        adapter = _global_strands_adapter
        if adapter is None:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "Strands 后端未激活，请重启 sidecar 后重试",
            }

        receipt = resolve_model_params(
            provider=llm_config.provider,
            model=llm_config.model,
            base_url=llm_config.base_url,
            temperature=llm_config.temperature,
            max_tokens=llm_config.max_tokens,
            thinking=llm_config.thinking,
            reasoning_effort=llm_config.reasoning_effort,
        )
        current_snapshot = getattr(adapter, "_model_turn_snapshot", None)
        current_generation = (
            int(current_snapshot.get("configGeneration", 0))
            if isinstance(current_snapshot, dict)
            else 0
        )
        new_model = create_strands_model(llm_config)
        if new_model is None:
            return {
                "ok": False,
                "llm_call_set": False,
                "message": "Strands 模型创建失败，请检查 API Key、模型和端点",
            }
        get_model_config = getattr(new_model, "get_config", None)
        resolved_config = get_model_config() if callable(get_model_config) else {}
        resolved_model = str(resolved_config.get("model_id") or llm_config.model)
        next_generation = current_generation + 1
        snapshot_id = hashlib.sha256(
            f"{next_generation}|{receipt['parameter_fingerprint']}|{resolved_model}".encode()
        ).hexdigest()[:24]
        turn_snapshot = {
            **receipt["turn_snapshot"],
            "configGeneration": next_generation,
            "configSnapshotId": snapshot_id,
            "resolvedModel": resolved_model,
        }

        # 模型构造通过后才发布配置；任何发布失败都恢复旧磁盘/模型/运行时。
        # key 仍只进进程内缓存（不落盘，#158-①）。
        config_path = _get_config_path()
        previous_disk = config_path.read_bytes() if config_path.exists() else None
        previous_config = load_config()
        previous_model = getattr(adapter, "strands_model", None)
        previous_snapshot = getattr(adapter, "_model_turn_snapshot", None)
        try:
            save_config(llm_config)
            adapter.update_model(new_model, turn_snapshot=turn_snapshot)
            set_runtime_config(llm_config)
        except Exception:
            try:
                if previous_disk is None:
                    if config_path.exists():
                        config_path.unlink()
                else:
                    config_path.write_bytes(previous_disk)
                adapter.update_model(previous_model, turn_snapshot=previous_snapshot)
                set_runtime_config(previous_config)
            except Exception as rollback_error:
                logger.error("LLM 配置回滚失败: %s", rollback_error)
            raise
        return {
            "ok": True,
            "llm_call_set": True,
            "message": f"LLM 配置已更新: {llm_config.provider}/{llm_config.model}",
            "requested": receipt["requested"],
            "effective": receipt["effective"],
            "applied": receipt["applied"],
            "sources": receipt["sources"],
            "warnings": receipt["warnings"],
            "capabilities": receipt["capabilities"],
            "turn_snapshot": turn_snapshot,
        }
    except Exception as error:
        logger.exception("Strands model hot-reload failed: %s", error)
        return {
            "ok": False,
            "llm_call_set": False,
            "message": f"LLM 配置异常: {error}",
        }


def configure(config: dict[str, Any] | None = None) -> dict[str, Any]:
    global _latest_client_generation
    with _configure_lock:
        client_generation = config.get("client_generation") if config else None
        if client_generation is not None:
            if (
                isinstance(client_generation, bool)
                or not isinstance(client_generation, int)
                or client_generation < 0
            ):
                return {
                    "ok": False,
                    "llm_call_set": False,
                    "reason_code": "invalid_client_generation",
                    "message": "client_generation 必须是非负整数",
                }
            if client_generation < _latest_client_generation:
                return {
                    "ok": False,
                    "llm_call_set": False,
                    "reason_code": "stale_config",
                    "message": "模型配置已更新，已拒绝过期配置发布",
                }
        result = _configure_impl(config)
        if result.get("ok") and client_generation is not None:
            _latest_client_generation = client_generation
        return result


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
