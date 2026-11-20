"""Privacy-minimal, revision-aware model usage normalization and SQLite ledger."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from collections.abc import Iterable
from dataclasses import asdict, dataclass, fields
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

_TOKEN_ALIASES = {
    "input_tokens": ("input_tokens", "inputTokens", "prompt_tokens"),
    "output_tokens": ("output_tokens", "outputTokens", "completion_tokens"),
    "total_tokens": ("total_tokens", "totalTokens"),
    "cached_input_tokens": (
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "prompt_cache_hit_tokens",
    ),
    "cache_creation_input_tokens": (
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
        "cache_write_input_tokens",
    ),
    "reasoning_tokens": ("reasoning_tokens", "reasoningTokens"),
}


def _usage_dict(usage: Any) -> dict[str, Any]:
    if isinstance(usage, dict):
        return usage
    if usage is not None and hasattr(usage, "__dict__"):
        return vars(usage)
    return {}


def _first(values: dict[str, Any], names: Iterable[str]) -> int | None:
    for name in names:
        value = values.get(name)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return None


def normalize_usage(usage: Any) -> dict[str, int | None]:
    """Normalize known aliases while preserving unknown as ``None``.

    Total is never inferred by adding reasoning/cache subsets to input/output.
    """
    values = _usage_dict(usage)
    result = {field: _first(values, aliases) for field, aliases in _TOKEN_ALIASES.items()}
    if result["cached_input_tokens"] is None:
        details = values.get("prompt_tokens_details")
        if isinstance(details, dict):
            result["cached_input_tokens"] = _first(details, ("cached_tokens",))
    if result["reasoning_tokens"] is None:
        details = values.get("completion_tokens_details")
        if isinstance(details, dict):
            result["reasoning_tokens"] = _first(details, ("reasoning_tokens",))
    return result


def extract_usage(response: Any) -> dict[str, Any]:
    """Extract response usage and identify aggregate versus physical-call precision."""
    if response is None:
        return {}
    metrics = getattr(response, "metrics", None)
    if isinstance(metrics, dict):
        normalized = normalize_usage(
            metrics.get("accumulated_usage", metrics)
        )
        normalized["_granularity"] = "invocation_aggregate"
        return normalized
    if metrics is not None:
        invocations = list(getattr(metrics, "agent_invocations", None) or [])
        latest_invocation = (
            invocations[-1] if invocations
            else getattr(metrics, "latest_agent_invocation", None)
        )
        # The SDK keeps previous calls on EventLoopMetrics. An event recorded
        # for one call receives only that call's invocation, including its cycles.
        aggregate = normalize_usage(
            getattr(latest_invocation, "usage", None)
            if latest_invocation is not None
            else getattr(metrics, "accumulated_usage", None)
        )
        if any(value is not None for value in aggregate.values()):
            aggregate["_granularity"] = "invocation_aggregate"
            invocation_id = getattr(latest_invocation, "id", None)
            aggregate["_covers_call_ids"] = (str(invocation_id),) if invocation_id else ()
            cycles = getattr(latest_invocation, "cycles", None) or []
            latest = normalize_usage(getattr(cycles[-1], "usage", None) if cycles else None)
            aggregate["last_input_tokens"] = latest["input_tokens"]
            aggregate["last_cached_input_tokens"] = latest["cached_input_tokens"]
            return aggregate
    usage = getattr(response, "usage", None)
    normalized = normalize_usage(usage)
    if any(value is not None for value in normalized.values()):
        normalized["_granularity"] = "model_call"
        normalized["last_input_tokens"] = normalized["input_tokens"]
        normalized["last_cached_input_tokens"] = normalized["cached_input_tokens"]
        return normalized
    return {}


@dataclass(frozen=True)
class UsageEvent:
    event_id: str
    call_id: str
    attempt_id: str
    revision: int
    update_mode: str
    granularity: str
    session_id: str
    turn_id: str
    provider: str
    requested_model: str
    resolved_model: str
    status: str
    completed_at: str
    started_at: str | None = None
    config_snapshot_id: str | None = None
    error_category: str | None = None
    covers_call_ids: tuple[str, ...] = ()
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    cached_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None
    reasoning_tokens: int | None = None

    def __post_init__(self) -> None:
        for field_name in ("event_id", "call_id", "attempt_id", "session_id", "turn_id"):
            if not str(getattr(self, field_name)).strip():
                raise ValueError(f"{field_name} 不能为空")
        if isinstance(self.revision, bool) or not isinstance(self.revision, int) or self.revision < 0:
            raise ValueError("revision 必须是非负整数")
        if self.update_mode not in {"cumulative", "delta"}:
            raise ValueError("update_mode 必须是 cumulative/delta")
        if self.granularity not in {"model_call", "invocation_aggregate"}:
            raise ValueError("granularity 必须是 model_call/invocation_aggregate")
        for field_name in _TOKEN_ALIASES:
            value = getattr(self, field_name)
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0
            ):
                raise ValueError(f"{field_name} 必须是非负整数或 null")

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["covers_call_ids"] = list(self.covers_call_ids)
        return result


_SENSITIVE_FIELDS = {
    "prompt", "response", "command", "tool_output", "api_key", "host", "hostname",
    "workspace", "error_message", "text",
}


def event_from_mapping(payload: dict[str, Any]) -> UsageEvent:
    forbidden = sorted(_SENSITIVE_FIELDS.intersection(payload))
    if forbidden:
        raise ValueError(f"usage 事件包含禁止字段: {', '.join(forbidden)}")
    allowed = {field.name for field in fields(UsageEvent)}
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise ValueError(f"usage 事件包含未知字段: {', '.join(unknown)}")
    values = dict(payload)
    if "covers_call_ids" in values:
        values["covers_call_ids"] = tuple(values["covers_call_ids"])
    return UsageEvent(**values)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_events (
    event_id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    update_mode TEXT NOT NULL,
    granularity TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    requested_model TEXT NOT NULL,
    resolved_model TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT NOT NULL,
    config_snapshot_id TEXT,
    error_category TEXT,
    covers_json TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    payload_json TEXT NOT NULL,
    UNIQUE(call_id, attempt_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_completed ON usage_events(completed_at);
CREATE TABLE IF NOT EXISTS session_usage_summary (
    session_id TEXT PRIMARY KEY,
    event_count INTEGER NOT NULL,
    reported_event_count INTEGER NOT NULL,
    unknown_usage_count INTEGER NOT NULL,
    cancelled_count INTEGER NOT NULL,
    failed_count INTEGER NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cached_input_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    updated_at TEXT NOT NULL
);
"""

_INSERT_COLUMNS = (
    "event_id", "call_id", "attempt_id", "revision", "update_mode", "granularity",
    "session_id", "turn_id", "provider", "requested_model", "resolved_model", "status",
    "started_at", "completed_at", "config_snapshot_id", "error_category", "covers_json",
    "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens",
    "cache_creation_input_tokens", "reasoning_tokens", "payload_json",
)


def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in row.keys()}


def _accepted_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        grouped.setdefault((row["call_id"], row["attempt_id"]), []).append(row)
    selected: list[dict[str, Any]] = []
    for versions in grouped.values():
        cumulative = [row for row in versions if row["update_mode"] == "cumulative"]
        if cumulative:
            selected.append(max(cumulative, key=lambda row: row["revision"]))
        else:
            selected.extend(row for row in versions if row["update_mode"] == "delta")
    covered = {
        call_id
        for row in selected
        if row["granularity"] == "invocation_aggregate"
        for call_id in json.loads(row["covers_json"])
    }
    return [
        row for row in selected
        if not (row["granularity"] == "model_call" and row["call_id"] in covered)
    ]


def _summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    accepted = _accepted_rows(rows)
    summary: dict[str, Any] = {
        "event_count": len(accepted),
        "reported_event_count": sum(
            1 for row in accepted if any(row[field_name] is not None for field_name in _TOKEN_ALIASES)
        ),
        "unknown_usage_count": sum(
            1 for row in accepted if all(row[field_name] is None for field_name in _TOKEN_ALIASES)
        ),
        "cancelled_count": sum(1 for row in accepted if row["status"] == "cancelled"),
        "failed_count": sum(
            1 for row in accepted if row["status"] in {"error", "degraded", "timeout"}
        ),
    }
    for field_name in _TOKEN_ALIASES:
        values = [row[field_name] for row in accepted if row[field_name] is not None]
        summary[field_name] = sum(values) if values else None
    return summary


def _public_event(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_id": row["event_id"],
        "call_id": row["call_id"],
        "attempt_id": row["attempt_id"],
        "revision": row["revision"],
        "update_mode": row["update_mode"],
        "granularity": row["granularity"],
        "session_id": row["session_id"],
        "turn_id": row["turn_id"],
        "provider": row["provider"],
        "requested_model": row["requested_model"],
        "resolved_model": row["resolved_model"],
        "status": row["status"],
        "started_at": row["started_at"],
        "completed_at": row["completed_at"],
        "config_snapshot_id": row["config_snapshot_id"],
        "error_category": row["error_category"],
        "covers_call_ids": json.loads(row["covers_json"]),
        **{field_name: row[field_name] for field_name in _TOKEN_ALIASES},
    }


class UsageStore:
    """SQLite ledger; duplicate detection, revision and summary share transactions."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(_SCHEMA)
            summary_columns = {
                row["name"]
                for row in connection.execute(
                    "PRAGMA table_info(session_usage_summary)"
                ).fetchall()
            }
            for column in (
                "reported_event_count",
                "unknown_usage_count",
                "cancelled_count",
                "failed_count",
            ):
                if column not in summary_columns:
                    connection.execute(
                        f"ALTER TABLE session_usage_summary ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0"
                    )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def _fingerprint(event: UsageEvent) -> str:
        return json.dumps(event.to_dict(), ensure_ascii=False, sort_keys=True)

    def record(self, event: UsageEvent) -> str:
        fingerprint = self._fingerprint(event)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT payload_json FROM usage_events WHERE event_id = ?", (event.event_id,)
            ).fetchone()
            if existing is not None:
                if existing["payload_json"] != fingerprint:
                    raise ValueError("event_id 重放内容不一致")
                return "duplicate"
            versions = connection.execute(
                "SELECT revision, update_mode FROM usage_events "
                "WHERE call_id = ? AND attempt_id = ? ORDER BY revision DESC",
                (event.call_id, event.attempt_id),
            ).fetchall()
            if versions:
                if versions[0]["update_mode"] != event.update_mode:
                    raise ValueError("同一 call/attempt 不能混用 cumulative 与 delta")
                if event.update_mode == "cumulative" and event.revision < versions[0]["revision"]:
                    return "stale"
                if any(event.revision == version["revision"] for version in versions):
                    raise ValueError("同一 call/attempt/revision 的事件身份不一致")
            if event.granularity == "model_call":
                aggregates = connection.execute(
                    "SELECT covers_json FROM usage_events "
                    "WHERE granularity = 'invocation_aggregate'"
                ).fetchall()
                if any(
                    event.call_id in json.loads(row["covers_json"]) for row in aggregates
                ):
                    return "covered"
            values = event.to_dict()
            values["covers_json"] = json.dumps(event.covers_call_ids)
            values["payload_json"] = fingerprint
            connection.execute(
                f"INSERT INTO usage_events ({', '.join(_INSERT_COLUMNS)}) "
                f"VALUES ({', '.join('?' for _ in _INSERT_COLUMNS)})",
                tuple(values[column] for column in _INSERT_COLUMNS),
            )
            self._refresh_session_summary(connection, event.session_id)
        return "recorded"

    def _refresh_session_summary(self, connection: sqlite3.Connection, session_id: str) -> None:
        rows = [
            _row_dict(row)
            for row in connection.execute(
                "SELECT * FROM usage_events WHERE session_id = ?", (session_id,)
            ).fetchall()
        ]
        summary = _summarize(rows)
        connection.execute(
            "INSERT OR REPLACE INTO session_usage_summary "
            "(session_id, event_count, reported_event_count, unknown_usage_count, "
            "cancelled_count, failed_count, input_tokens, output_tokens, total_tokens, "
            "cached_input_tokens, cache_creation_input_tokens, reasoning_tokens, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id,
                summary["event_count"],
                summary["reported_event_count"],
                summary["unknown_usage_count"],
                summary["cancelled_count"],
                summary["failed_count"],
                *(summary[field_name] for field_name in _TOKEN_ALIASES),
                datetime.now(UTC).isoformat(),
            ),
        )

    def query(
        self,
        *,
        session_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        days: int = 90,
    ) -> dict[str, Any]:
        clauses: list[str] = []
        parameters: list[Any] = []
        if session_id is not None:
            clauses.append("session_id = ?")
            parameters.append(session_id)
        if provider is not None:
            clauses.append("provider = ?")
            parameters.append(provider)
        if model is not None:
            clauses.append("(requested_model = ? OR resolved_model = ?)")
            parameters.extend((model, model))
        if days > 0:
            cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()
            clauses.append("completed_at >= ?")
            parameters.append(cutoff)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as connection:
            rows = [
                _row_dict(row)
                for row in connection.execute(
                    f"SELECT * FROM usage_events {where}", parameters
                ).fetchall()
            ]
        accepted = _accepted_rows(rows)
        accepted.sort(key=lambda row: row["event_id"])
        accepted.sort(key=lambda row: row["completed_at"], reverse=True)
        by_date: dict[str, list[dict[str, Any]]] = {}
        for row in accepted:
            by_date.setdefault(row["completed_at"][:10], []).append(row)
        trend = [
            {"date": date, **_summarize(group)}
            for date, group in sorted(by_date.items())
        ]
        return {
            "summary": _summarize(accepted),
            "events": [_public_event(row) for row in accepted],
            "trend": trend,
            "query": {
                "session_id": session_id,
                "provider": provider,
                "model": model,
                "days": days,
                "retention_policy": "no_automatic_deletion",
            },
        }


def _response_completed_at(response: Any) -> str | None:
    for name in ("completed_at", "created_at", "created"):
        value = getattr(response, name, None)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return datetime.fromtimestamp(value, UTC).isoformat()
    return None


def response_usage_event(
    response: Any,
    *,
    session_id: str,
    turn_id: str,
    status: str,
    config_snapshot: dict[str, Any] | None = None,
    call_id: str | None = None,
    attempt_id: str | None = None,
    revision: int | None = None,
    completed_at: str | None = None,
    started_at: str | None = None,
    covers_call_ids: tuple[str, ...] = (),
    record_empty: bool = False,
) -> UsageEvent | None:
    """Build a stable aggregate event from one Strands response, if usage exists."""
    tokens = extract_usage(response)
    if not tokens and not record_empty:
        return None
    snapshot = config_snapshot or {}
    metrics = getattr(response, "metrics", None)
    invocation = getattr(metrics, "latest_agent_invocation", None) if metrics is not None else None
    stable_call_id = str(
        call_id
        or getattr(response, "id", None)
        or getattr(invocation, "id", None)
        or f"invocation:{turn_id}"
    )
    stable_attempt_id = str(attempt_id or getattr(response, "attempt_id", None) or "0")
    stable_revision = int(revision or getattr(response, "revision", None) or 1)
    granularity = str(tokens.get("_granularity") or "invocation_aggregate")
    identity = f"{session_id}|{turn_id}|{stable_call_id}|{stable_attempt_id}|{stable_revision}|{granularity}"
    event_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    return UsageEvent(
        event_id=event_id,
        call_id=stable_call_id,
        attempt_id=stable_attempt_id,
        revision=stable_revision,
        update_mode="cumulative",
        granularity=granularity,
        session_id=session_id,
        turn_id=turn_id,
        provider=str(snapshot.get("provider") or "unknown"),
        requested_model=str(snapshot.get("requestedModel") or "unknown"),
        resolved_model=str(snapshot.get("resolvedModel") or "unknown"),
        status=status,
        started_at=started_at,
        completed_at=completed_at or _response_completed_at(response) or datetime.now(UTC).isoformat(),
        config_snapshot_id=snapshot.get("configSnapshotId"),
        covers_call_ids=covers_call_ids or tuple(tokens.get("_covers_call_ids", ())),
        **{field_name: tokens.get(field_name) for field_name in _TOKEN_ALIASES},
    )


_global_store: UsageStore | None = None
_global_path: Path | None = None


def get_global_usage_store() -> UsageStore:
    global _global_store, _global_path
    path = Path(os.environ.get("TDSF_DATA_DIR", ".")) / "usage.db"
    if _global_store is None or _global_path != path:
        _global_store = UsageStore(path)
        _global_path = path
    return _global_store


def reset_global_usage_store() -> None:
    global _global_store, _global_path
    _global_store = None
    _global_path = None


def record_response_usage(
    response: Any,
    *,
    session_id: str,
    turn_id: str,
    status: str,
    config_snapshot: dict[str, Any] | None = None,
    call_id: str | None = None,
    attempt_id: str | None = None,
    revision: int | None = None,
    completed_at: str | None = None,
    started_at: str | None = None,
    covers_call_ids: tuple[str, ...] = (),
    record_empty: bool = False,
) -> str:
    """Best-effort persistence; never retries a model call or a terminal command."""
    event = response_usage_event(
        response,
        session_id=session_id,
        turn_id=turn_id,
        status=status,
        config_snapshot=config_snapshot,
        call_id=call_id,
        attempt_id=attempt_id,
        revision=revision,
        completed_at=completed_at,
        started_at=started_at,
        covers_call_ids=covers_call_ids,
        record_empty=record_empty,
    )
    if event is None:
        return "no_usage"
    return get_global_usage_store().record(event)


def register_methods(dispatcher: Any) -> None:
    def _query(
        session_id: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        days: int = 90,
        sessionId: str | None = None,
    ) -> dict[str, Any]:
        return get_global_usage_store().query(
            session_id=session_id or sessionId,
            provider=provider,
            model=model,
            days=days,
        )

    dispatcher.register("usage.summary", _query)
    dispatcher.register("usage.events", _query)


__all__ = [
    "UsageEvent",
    "UsageStore",
    "event_from_mapping",
    "extract_usage",
    "get_global_usage_store",
    "normalize_usage",
    "record_response_usage",
    "register_methods",
    "reset_global_usage_store",
    "response_usage_event",
]
