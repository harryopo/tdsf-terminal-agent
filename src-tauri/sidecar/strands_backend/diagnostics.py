"""Local, bounded diagnostic snapshots. Never accepts an output path."""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any

from .tools._redact import redact_sensitive_text

MAX_EXPORT_BYTES = 2 * 1024 * 1024
_SECRET_KEY = re.compile(
    r"password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|"
    r"refresh[_-]?token|auth[_-]?token|private[_-]?key|"
    r"(?:pwd|id[_-]?token|token|authorization|cookie)$|"
    r"^(?:credential)$", re.I
)
_JSON_FIELD = re.compile(r'("(?:[^"\\]|\\.)*")\s*:\s*')
_QUOTED_SECRET = re.compile(
    r'''(["'](?:[^"']*(?:password|passwd|passphrase|secret|api[_-]?key|private[_-]?key|token)|authorization|cookie)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')''',
    re.I,
)


def _redact_json_fields(text: str) -> str:
    """Redact embedded JSON values using the standard decoder's boundaries."""
    decoder = json.JSONDecoder()
    parts: list[str] = []
    cursor = 0
    for match in _JSON_FIELD.finditer(text):
        if match.start() < cursor:
            continue
        try:
            key = json.loads(match.group(1))
        except ValueError:
            continue
        if not _SECRET_KEY.search(key):
            continue
        try:
            _, end = decoder.raw_decode(text, match.end())
        except (ValueError, RecursionError):
            end = len(text)
        parts.extend((text[cursor:match.end()], '"<REDACTED>"'))
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)


def sanitize_diagnostic(value: Any, _depth: int = 0) -> Any:
    """Redact structured credentials too, including JSON embedded in tool text."""
    if _depth > 20:
        return "<OMITTED:depth-limit>"
    if isinstance(value, dict):
        return {
            sanitize_diagnostic(str(k), _depth + 1): "<REDACTED>"
            if _SECRET_KEY.search(str(k)) else sanitize_diagnostic(v, _depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [sanitize_diagnostic(v, _depth + 1) for v in value]
    if not isinstance(value, str):
        return value
    if value.lstrip().startswith(("{", "[", '"')):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list, str)):
                return json.dumps(sanitize_diagnostic(parsed, _depth + 1), ensure_ascii=False)
        except (ValueError, RecursionError):
            pass
    value = _redact_json_fields(value)
    value = _QUOTED_SECRET.sub(lambda m: m[1] + '"<REDACTED>"', value)
    value = re.sub(
        r'''(?i)(\b(?:[\w-]*[_-])?(?:password|passwd|passphrase|token|secret|api[_-]?key|private[_-]?key)\s*(?:=|:|\s)\s*)("(?:\\.|[^"\\])*"|'(?:''|\\.|[^'\\])*'|[^\s;|&]+)''',
        lambda m: m[1] + "<REDACTED>", value,
    )
    value = re.sub(r"(?im)\b((?:Proxy-)?Authorization|(?:Set-)?Cookie)\s*:\s*[^\r\n]+",
                   lambda m: m[1] + ": <REDACTED>", value)
    value = re.sub(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
                   "<REDACTED:private-key>", value)
    value = re.sub(r"(\b[a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@",
                   r"\1<REDACTED:credentials>@", value, flags=re.I)
    return redact_sensitive_text(value)


def export_snapshot(session_id: str, snapshot: dict[str, Any]) -> dict[str, Any]:
    """Save an explicitly requested current-chat snapshot under the data directory."""
    if (not isinstance(session_id, str) or not session_id or not isinstance(snapshot, dict)
            or snapshot.get("session_id") != session_id
            or type(snapshot.get("schema_version")) is not int
            or snapshot.get("schema_version") != 1):
        raise ValueError("诊断快照会话或格式不匹配")
    raw = json.dumps(snapshot, ensure_ascii=False, allow_nan=False)
    if len(raw.encode("utf-8")) > MAX_EXPORT_BYTES:
        raise ValueError("诊断快照超过 2 MiB，请缩小记录范围")
    allowed = {"schema_version", "session_id", "exported_at", "app_version",
               "sources", "conversation", "limitations"}
    clean = sanitize_diagnostic({k: v for k, v in snapshot.items() if k in allowed})
    encoded = json.dumps(clean, ensure_ascii=False, indent=2, allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_EXPORT_BYTES:
        raise ValueError("诊断快照超过 2 MiB，请缩小记录范围")
    directory = Path(os.environ.get("TDSF_DATA_DIR", ".")).resolve() / "diagnostics"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"diagnostics-{uuid.uuid4().hex}.json"
    with path.open("x", encoding="utf-8") as handle:
        handle.write(encoded)
    return {"ok": True, "path": str(path)}
