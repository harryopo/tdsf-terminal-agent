"""Paired UI events for synchronous reference tools, not SDK decorators."""
from __future__ import annotations

from functools import wraps
import logging
from typing import Any, Callable
from uuid import uuid4

from strands_backend.tools._redact import redact_sensitive_text

logger = logging.getLogger("sidecar.strands_backend.tools.tool_lifecycle")
_REFERENCE_CALLS = "_tdsf_reference_tool_calls"


def bind_tool_call_id(
    sdk_tool_context: Any,
    *,
    tool_name: str,
    tool_call_id: str,
    session_id: str | None,
    agent_name: str,
) -> None:
    """Associate a tool-owned card with its SDK invocation and frozen owner."""
    tool_use = getattr(sdk_tool_context, "tool_use", None)
    invocation_state = getattr(sdk_tool_context, "invocation_state", None)
    if not isinstance(tool_use, dict) or not isinstance(invocation_state, dict):
        return
    sdk_id = tool_use.get("toolUseId")
    if not isinstance(sdk_id, str) or not sdk_id.strip() or tool_use.get("name") != tool_name:
        return
    calls = invocation_state.setdefault(_REFERENCE_CALLS, {})
    if isinstance(calls, dict):
        calls[sdk_id] = (tool_name, session_id or None, agent_name, tool_call_id)


def take_reference_tool_call_id(
    tool_use: Any,
    invocation_state: Any,
    *,
    session_id: str,
    agent_name: str,
) -> str | None:
    """Consume only the card created for this SDK call and frozen owner."""
    if not isinstance(tool_use, dict) or not isinstance(invocation_state, dict):
        return None
    sdk_id = tool_use.get("toolUseId")
    if not isinstance(sdk_id, str) or not sdk_id.strip():
        return None
    calls = invocation_state.get(_REFERENCE_CALLS)
    if not isinstance(calls, dict):
        return None
    call = calls.get(sdk_id)
    if (
        not isinstance(call, tuple) or len(call) != 4
        or call[:3] != (tool_use.get("name"), session_id or None, agent_name)
        or not isinstance(call[3], str)
    ):
        return None
    del calls[sdk_id]
    if not calls:
        invocation_state.pop(_REFERENCE_CALLS, None)
    return call[3]


def _redact(value: Any) -> Any:
    if isinstance(value, str):
        return redact_sensitive_text(value)
    if isinstance(value, dict):
        return {key: _redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def tool_call_lifecycle(
    tool_name: str,
    *,
    params_summary: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    failed: Callable[[dict[str, Any]], bool] | None = None,
):
    """Give a core invocation one ID and close it without altering its result."""
    def decorate(invoke: Callable):
        @wraps(invoke)
        def wrapped(
            params: dict[str, Any], ctx: Any = None, *, sdk_tool_context: Any = None,
        ) -> dict[str, Any]:
            call_id = uuid4().hex
            event_bus = getattr(ctx, "event_bus", None)
            session_id = getattr(ctx, "session_id", "") or None
            agent_name = getattr(ctx, "agent_name", "main")
            source = f"{agent_name}_agent.strands_tool.{tool_name}"
            event_params = _redact(params_summary(params) if params_summary else params)
            bind_tool_call_id(
                sdk_tool_context, tool_name=tool_name, tool_call_id=call_id,
                session_id=session_id, agent_name=agent_name,
            )

            def emit(status: str, result: dict[str, Any] | None = None) -> None:
                if event_bus is None:
                    return
                try:
                    event_bus.emit_tool_call(
                        tool_name=tool_name,
                        tool_call_id=call_id,
                        params=event_params,
                        result=_redact(result),
                        status=status,
                        session_id=session_id,
                        source=source,
                    )
                except Exception as exc:  # UI delivery must not affect the tool
                    logger.debug("tool event failed: tool=%s status=%s error=%s", tool_name, status, exc)

            emit("started")
            try:
                result = invoke(params, ctx)
                status = "error" if failed and failed(result) else "completed"
            except Exception as exc:
                emit("error", {"status": "error", "message": str(exc)})
                raise
            emit(status, result)
            return result

        return wrapped

    return decorate
