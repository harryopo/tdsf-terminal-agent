"""Internal Agent RPC provenance; never a permission or liveness proof."""
from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any
from uuid import UUID


@dataclass(frozen=True)
class _AgentRequest:
    request_id: int
    active: threading.Event
    stream_id: str | None = None


_current_request: ContextVar[_AgentRequest | None] = ContextVar(
    "tdsf_agent_rpc_request", default=None
)


@contextmanager
def agent_request_scope(request_id: object, stream_id: object = None) -> Iterator[None]:
    """Bind a wire integer ID, masking unknown or unrelated dispatches."""
    request = None
    if type(request_id) is int and 0 <= request_id <= (1 << 63) - 1:
        canonical_stream_id = None
        if isinstance(stream_id, str) and len(stream_id) == 36:
            try:
                if str(UUID(stream_id)) == stream_id:
                    canonical_stream_id = stream_id
            except ValueError:
                pass
        active = threading.Event()
        active.set()
        request = _AgentRequest(request_id, active, canonical_stream_id)
    token = _current_request.set(request)
    try:
        yield
    finally:
        if request is not None:
            # Context copies share this flag: abandoned workers cannot retain
            # active provenance after the dispatch has returned.
            request.active.clear()
        _current_request.reset(token)


def current_agent_request_id() -> int | None:
    request = _current_request.get()
    if request is not None and request.active.is_set():
        return request.request_id
    return None


def with_agent_request_id(meta: dict[str, Any]) -> dict[str, Any]:
    """Copy metadata; only the current dispatch may supply this reserved ID."""
    result = dict(meta)
    result.pop("rpc_request_id", None)
    result.pop("rpc_stream_id", None)
    request = _current_request.get()
    if request is not None and request.active.is_set():
        result["rpc_request_id"] = request.request_id
        if request.stream_id is not None:
            result["rpc_stream_id"] = request.stream_id
    return result
