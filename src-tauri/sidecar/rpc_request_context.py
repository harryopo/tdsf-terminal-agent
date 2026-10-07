"""Internal Agent RPC provenance; never a permission or liveness proof."""
from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class _AgentRequest:
    request_id: int
    active: threading.Event


_current_request: ContextVar[_AgentRequest | None] = ContextVar(
    "tdsf_agent_rpc_request", default=None
)


@contextmanager
def agent_request_scope(request_id: object) -> Iterator[None]:
    """Bind a wire integer ID, masking unknown or unrelated dispatches."""
    request = None
    if type(request_id) is int and 0 <= request_id <= (1 << 63) - 1:
        active = threading.Event()
        active.set()
        request = _AgentRequest(request_id, active)
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
    request_id = current_agent_request_id()
    if request_id is not None:
        result["rpc_request_id"] = request_id
    return result
