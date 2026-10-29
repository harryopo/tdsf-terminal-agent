"""Explicit knowledge provenance; legacy slim/full databases remain untouched."""

from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

from knowledge import rag as rag_module
from knowledge.fts5 import tokenize
from knowledge.rag import RagIndex, _escape_fts_query

_indexes: dict[tuple[str, str], RagIndex] = {}
_lock = threading.Lock()
logger = logging.getLogger("sidecar.knowledge.collections")
# Raw browsing is not an alternate route into private session/case records.
_REFERENCE_SQL = "(source = 'archwiki' OR (source LIKE '%-docs' AND source != 'imported-docs'))"


def get_library(library: str) -> RagIndex:
    if library == "slim":
        return rag_module.get_slim_rag()
    if library in {"full", "reference"}:
        return rag_module.get_global_rag()
    if library == "builtin":
        from knowledge.bundled import bundled_slim_db_path

        path = bundled_slim_db_path()
    elif library == "personal":
        path = Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data"))) / "rag_personal.db"
    else:
        raise ValueError("library must be 'slim', 'full', 'builtin', 'personal' or 'reference'")
    key = (library, str(path.resolve()))
    with _lock:
        if key not in _indexes:
            _indexes[key] = RagIndex(path, read_only=library == "builtin")
        return _indexes[key]


def _reference_allowed(source: str) -> bool:
    return source == "archwiki" or (source.endswith("-docs") and source != "imported-docs")


def list_documents(
    library: str, *, limit: int = 30, offset: int = 0, category: str | None = None,
) -> dict[str, Any]:
    """Page document identities in SQLite, never individual retrieval chunks."""
    rag = get_library(library)
    limit, offset = max(1, min(int(limit), 100)), max(0, int(offset))
    where = (
        f"WHERE {_REFERENCE_SQL} AND url NOT IN "
        f"(SELECT url FROM entries WHERE NOT {_REFERENCE_SQL} AND url != '')"
        if library == "reference" else ""
    )
    # Empty-URL notes remain separate; identical basenames/other versions do not merge.
    docs_sql = (
        "SELECT CASE WHEN url != '' THEN 'url:' || url ELSE 'entry:' || id END AS doc_key, "
        "MIN(id) AS id, url, MIN(source) AS source, COALESCE(MIN(category), '') AS category, "
        "MIN(title) AS title0, COUNT(*) AS chunks, SUM(LENGTH(content)) AS total_chars, "
        "MAX(LENGTH(content) = 12000) AS possibly_truncated "
        f"FROM entries {where} GROUP BY doc_key"
    )
    filter_sql = " WHERE category = ?" if category is not None else ""
    params: list[Any] = [category] if category is not None else []
    with rag._lock:
        conn = rag._conn
        assert conn is not None
        total = int(conn.execute(f"SELECT COUNT(*) FROM ({docs_sql}){filter_sql}", params).fetchone()[0])
        rows = conn.execute(
            f"SELECT * FROM ({docs_sql}){filter_sql} ORDER BY category, source, doc_key LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        groups = conn.execute(
            f"SELECT category, source, SUM(chunks) AS entries, COUNT(*) AS files "
            f"FROM ({docs_sql}) GROUP BY category, source ORDER BY category, source"
        ).fetchall()
        titles = {row["url"]: row for row in conn.execute("SELECT url, zh, summary_zh FROM doc_titles_zh")}
    documents = []
    for row in rows:
        doc = dict(row)
        doc.pop("doc_key")
        # Chunk suffixes are numeric, not lexical (10 must not precede 2).
        if doc["url"]:
            full_doc = get_document(str(doc["url"]), library)
            if full_doc:
                doc["title0"] = full_doc["title"]
                if full_doc.get("processing"):
                    doc["processing"] = full_doc["processing"]
        title = titles.get(doc["url"])
        doc.update(
            library=library, title_zh=str(title["zh"] or "") if title else "",
            summary_zh=str(title["summary_zh"] or "") if title else "",
            possibly_truncated=library == "reference" and bool(doc["possibly_truncated"]),
        )
        documents.append(doc)
    return {"documents": documents, "total": total, "groups": [dict(row) for row in groups], "limit": limit, "offset": offset}


def get_document(url: str, library: str) -> dict[str, Any] | None:
    rag = get_library(library)
    if library == "reference":
        with rag._lock:
            conn = rag._conn
            assert conn is not None
            sources = conn.execute("SELECT DISTINCT source FROM entries WHERE url = ?", (url,)).fetchall()
        if not sources or any(not _reference_allowed(str(row[0])) for row in sources):
            return None
    doc = rag.get_doc(url)
    if doc is not None:
        doc["library"] = library
        with rag._lock:
            conn = rag._conn
            assert conn is not None
            stats = conn.execute(
                "SELECT MAX(LENGTH(content) = 12000), SUM(CASE WHEN TRIM(COALESCE(content_zh, '')) != '' THEN 1 ELSE 0 END) "
                "FROM entries WHERE url = ?", (url,),
            ).fetchone()
            if library == "personal" and conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_provenance'").fetchone():
                provenance = conn.execute("SELECT processing FROM document_provenance WHERE url = ?", (url,)).fetchone()
                if provenance:
                    doc["processing"] = str(provenance[0])
        doc["possibly_truncated"] = library == "reference" and bool(stats[0])
        doc["translated_chunks"] = int(stats[1] or 0)
        doc["translation_complete"] = doc["translated_chunks"] == doc["chunks"]
    return doc


def search_collection(query: str, library: str, limit: int = 10) -> list[dict[str, Any]]:
    if library == "curated":
        return search_curated(query, limit)
    limit = max(1, min(int(limit), 100))
    rag = get_library(library)
    if library == "reference":
        # Raw references use keyword search. Filter in SQL BEFORE the candidate
        # limit; private memory must neither leak nor crowd out matching docs.
        tokens = _escape_fts_query(tokenize(query))
        if not tokens:
            return []
        with rag._lock:
            conn = rag._conn
            assert conn is not None
            ids = [row[0] for row in conn.execute(
                "SELECT entries.id FROM fts_entries JOIN entries ON entries.rowid = fts_entries.rowid "
                f"WHERE fts_entries MATCH ? AND {_REFERENCE_SQL} "
                f"AND url NOT IN (SELECT url FROM entries WHERE NOT {_REFERENCE_SQL} AND url != '') "
                "ORDER BY bm25(fts_entries), entries.id LIMIT ?", (tokens, limit),
            )]
        rows = [rag.get(entry_id) for entry_id in ids]
        return [{**row, "library": library, "match_type": "fts", "rrf_score": 1 / (61 + rank)} for rank, row in enumerate(rows) if row and _reference_allowed(str(row["source"]))]
    return [{**row, "library": library} for row in rag.hybrid_search(query, top_k=limit)]


def curated_candidates(
    query: str, limit: int, *, unavailable_libraries: list[str] | None = None,
) -> list[dict[str, Any]]:
    rows = []
    for library in ("personal", "slim", "builtin"):
        try:
            rows.extend(search_collection(query, library, limit))
        except (sqlite3.DatabaseError, OSError) as error:
            # Legacy callers still fail as before; opt-in callers must disclose
            # missing sources. Programming errors are never partial retrievals.
            if unavailable_libraries is None or isinstance(error, sqlite3.ProgrammingError):
                raise
            logger.warning("Knowledge source unavailable: %s (%s)", library, type(error).__name__)
            unavailable_libraries.append(library)
    return rows


def merge_curated(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """Reuse index ranks; merge only equal URL and body, never title/basename alone."""
    rows.sort(key=lambda row: float(row.get("rrf_score", 0)), reverse=True)
    seen: set[tuple[str, str]] = set()
    results = []
    for row in rows:
        digest = hashlib.sha256((row["content"] + "\0" + str(row.get("content_zh") or "")).encode()).hexdigest()
        identity = (str(row.get("url") or row.get("id") or digest), digest)
        if identity in seen:
            continue
        seen.add(identity)
        results.append(row)
        if len(results) >= limit:
            break
    return results


def search_curated(query: str, limit: int = 5) -> list[dict[str, Any]]:
    limit = max(1, min(int(limit), 100))
    return merge_curated(curated_candidates(query, limit), limit)
