"""Paired UI events for synchronous reference tools, not SDK decorators."""
from __future__ import annotations

from functools import wraps
import logging
from typing import Any, Callable
from uuid import uuid4

from strands_backend.tools._redact import redact_sensitive_text

logger = logging.getLogger("sidecar.strands_backend.tools.tool_lifecycle")


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
        def wrapped(params: dict[str, Any], ctx: Any = None) -> dict[str, Any]:
            call_id = uuid4().hex
            event_bus = getattr(ctx, "event_bus", None)
            session_id = getattr(ctx, "session_id", "") or None
            source = f"{getattr(ctx, 'agent_name', 'main')}_agent.strands_tool.{tool_name}"
            event_params = _redact(params_summary(params) if params_summary else params)

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
