"""Preview local knowledge snapshots; restore selected documents without replacing data."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any

from knowledge.collections import get_library
from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import _chunk_seq, _rowid_for

_previews: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()
_MAX_DB_BYTES = 128 * 1024 * 1024
_PREVIEW_SECONDS = 600
_PRIVATE_SOURCES = {"session-memory", "session-case", "auto-case"}
_FIELDS = ("id", "source", "title", "content", "url", "tags", "category", "content_zh")


def _readonly(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    conn.execute("PRAGMA trusted_schema=OFF")
    return conn


def _copy_snapshot(source: sqlite3.Connection, destination: sqlite3.Connection) -> None:
    started = time.monotonic()
    page_size = int(source.execute("PRAGMA page_size").fetchone()[0])
    def progress(_status: int, _remaining: int, total: int) -> None:
        if total * page_size > _MAX_DB_BYTES:
            raise ValueError("知识库过大，请先选择较小的整理库")
        if time.monotonic() - started > 15:
            raise TimeoutError("知识库快照超时，请稍后重新预览")
    source.backup(destination, pages=256, progress=progress, sleep=0.05)


def _backup(source: sqlite3.Connection, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # UUID names plus exclusive creation never replace an earlier backup.
    with path.open("xb"):
        pass
    with closing(sqlite3.connect(path)) as destination:
        _copy_snapshot(source, destination)


def _documents(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    table = conn.execute("SELECT type FROM sqlite_schema WHERE name = 'entries'").fetchone()
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(entries)")}
    if not table or table[0] != "table" or not {*_FIELDS, "created_at"}.issubset(columns):
        raise ValueError("这不是受支持的知识库文件")
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in conn.execute("SELECT id, source, title, content, url, tags, created_at, category, content_zh FROM entries"):
        item = dict(row)
        if any(not isinstance(item[key], str) for key in ("id", "source", "title", "content", "url", "tags", "created_at", "category")):
            raise ValueError("知识库条目格式不正确")
        if item["content_zh"] is not None and not isinstance(item["content_zh"], str):
            raise ValueError("知识库译文格式不正确")
        if not item["url"] or item["source"] in _PRIVATE_SOURCES or item["source"].startswith("case-"):
            continue
        tags = json.loads(item["tags"])
        if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
            raise ValueError("知识库标签格式不正确")
        groups.setdefault(item["url"], []).append(item)
    titles = {}
    if conn.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='doc_titles_zh'").fetchone():
        titles = {str(row["url"]): dict(row) for row in conn.execute("SELECT url, zh, summary_zh FROM doc_titles_zh")}
    documents = []
    for url, rows in sorted(groups.items()):
        rows.sort(key=lambda row: (_chunk_seq(row["id"]), row["id"]))
        title = titles.get(url, {})
        documents.append({"url": url, "entries": rows, "title_zh": str(title.get("zh") or ""), "summary_zh": str(title.get("summary_zh") or "")})
    return documents


def _digest(doc: dict[str, Any]) -> str:
    payload = [{key: row.get(key) or "" for key in _FIELDS} for row in sorted(doc["entries"], key=lambda row: row["id"])]
    # Tag order/JSON whitespace and creation timestamps are not document changes.
    for row in payload:
        row["tags"] = sorted(json.loads(row["tags"]))
    text = json.dumps([payload, doc["title_zh"], doc["summary_zh"]], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(text.encode()).hexdigest()


def _status(conn: sqlite3.Connection, doc: dict[str, Any]) -> str:
    rows = [dict(row) for row in conn.execute("SELECT * FROM entries WHERE url = ?", (doc["url"],))]
    title = conn.execute("SELECT zh, summary_zh FROM doc_titles_zh WHERE url = ?", (doc["url"],)).fetchone()
    if rows:
        existing = {"entries": rows, "title_zh": str(title[0] or "") if title else "", "summary_zh": str(title[1] or "") if title else ""}
        return "duplicate" if _digest(existing) == _digest(doc) else "conflict"
    if title and (str(title[0] or "") != doc["title_zh"] or str(title[1] or "") != doc["summary_zh"]):
        return "conflict"
    for row in doc["entries"]:
        if conn.execute("SELECT 1 FROM entries WHERE id = ? OR rowid = ?", (row["id"], _rowid_for(row["id"]))).fetchone():
            return "conflict"
    return "new"


def preview_recovery(source_path: str) -> dict[str, Any]:
    if source_path.replace("\\", "/").startswith("//"):
        raise ValueError("只支持本机知识库文件，不读取网络共享")
    path = Path(source_path)
    if not path.is_absolute():
        raise ValueError("请选择知识库文件的绝对路径")
    path = path.resolve(strict=True)
    if not path.is_file() or path.stat().st_size > _MAX_DB_BYTES:
        raise ValueError("请选择不超过128 MB的知识库文件")
    snapshot = sqlite3.connect(":memory:", check_same_thread=False)
    snapshot.row_factory = sqlite3.Row
    try:
        with closing(_readonly(path)) as source:
            _copy_snapshot(source, snapshot)
        documents = _documents(snapshot)
        target = get_library("personal")
        if path == target.db_path.resolve():
            raise ValueError("请选择旧知识库，不要选择当前个人知识库自身")
        builtin = get_library("builtin")
        with builtin._lock:
            assert builtin._conn is not None
            builtin_docs = {doc["url"]: _digest(doc) for doc in _documents(builtin._conn)}
        builtin_urls: set[str] = set()
        with target._lock:
            assert target._conn is not None
            preview_docs = []
            for doc in documents:
                body = "\n\n".join(str(row["content_zh"] or row["content"]) for row in doc["entries"])
                status = _status(target._conn, doc)
                if status == "new" and builtin_docs.get(doc["url"]) == _digest(doc):
                    status = "builtin"
                    builtin_urls.add(doc["url"])
                preview_docs.append({"url": doc["url"], "title": doc["title_zh"] or doc["entries"][0]["title"], "chunks": len(doc["entries"]), "status": status, "has_chinese": any("\u4e00" <= char <= "\u9fff" for char in body), "source_note": "旧整理资料，章节来源待核"})
        token = uuid.uuid4().hex
        with _lock:
            expired = [key for key, value in _previews.items() if time.monotonic() - value["created"] >= _PREVIEW_SECONDS]
            for key in expired:
                _previews.pop(key)["snapshot"].close()
            while len(_previews) >= 2:
                _previews.pop(next(iter(_previews)))["snapshot"].close()
            _previews[token] = {"created": time.monotonic(), "snapshot": snapshot, "documents": documents, "builtin_urls": builtin_urls, "target": str(target.db_path.resolve())}
        return {"token": token, "documents": preview_docs, "counts": {status: sum(doc["status"] == status for doc in preview_docs) for status in ("new", "duplicate", "conflict", "builtin")}}
    except Exception:
        snapshot.close()
        raise


def discard_recovery(token: str) -> None:
    with _lock:
        preview = _previews.pop(token, None)
    if preview:
        preview["snapshot"].close()


def insert_documents(documents: list[dict[str, Any]], *, snapshot: sqlite3.Connection | None = None) -> dict[str, Any]:
    """Backup before writing; check conflicts and write all selected chunks atomically."""
    target = get_library("personal")
    result: dict[str, Any] = {"imported": 0, "duplicate": 0, "conflicts": 0, "entries": 0, "backup_path": "", "source_backup_path": ""}
    with target._lock:
        conn = target._conn
        assert conn is not None
        conn.execute("BEGIN IMMEDIATE")
        try:
            additions = []
            pending_urls: set[str] = set()
            pending_ids: set[str] = set()
            for doc in documents:
                status = _status(conn, doc)
                ids = {row["id"] for row in doc["entries"]}
                if doc["url"] in pending_urls or ids & pending_ids:
                    status = "conflict"
                if status == "new":
                    additions.append(doc)
                    pending_urls.add(doc["url"])
                    pending_ids.update(ids)
                else:
                    result["duplicate" if status == "duplicate" else "conflicts"] += 1
            if additions:
                prefix = target.db_path.parent / "knowledge-backups" / uuid.uuid4().hex
                if snapshot is not None:
                    source_backup = prefix.with_name(prefix.name + "-source.db")
                    _backup(snapshot, source_backup)
                    result["source_backup_path"] = str(source_backup)
                backup = prefix.with_name(prefix.name + "-personal.db")
                # Independent reader sees the committed pre-write state while BEGIN
                # IMMEDIATE prevents another process from changing it before insertion.
                with closing(_readonly(target.db_path)) as before:
                    _backup(before, backup)
                result["backup_path"] = str(backup)
                conn.execute("CREATE TABLE IF NOT EXISTS document_provenance (url TEXT PRIMARY KEY, processing TEXT NOT NULL, content_hash TEXT NOT NULL)")
                for doc in additions:
                    for row in doc["entries"]:
                        item = dict(row)
                        item["tags"] = json.loads(item["tags"])
                        target._write_entry(KnowledgeEntry.from_dict(item))
                        result["entries"] += 1
                    first = doc["entries"][0]
                    if doc["title_zh"]:
                        conn.execute("INSERT OR IGNORE INTO doc_titles_zh(url, zh, summary_zh, created_at) VALUES (?, ?, ?, ?)", (doc["url"], doc["title_zh"], doc["summary_zh"], first["created_at"]))
                    conn.execute("INSERT INTO document_provenance(url, processing, content_hash) VALUES (?, ?, ?)", (doc["url"], "recovered" if snapshot is not None else "imported", _digest(doc)))
                    result["imported"] += 1
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return result


def apply_recovery(token: str, urls: list[str]) -> dict[str, Any]:
    with _lock:
        preview = _previews.pop(token, None)
    if preview is None:
        raise ValueError("预览不存在或已使用，请重新预览")
    try:
        if time.monotonic() - preview["created"] >= _PREVIEW_SECONDS:
            raise ValueError("预览已过期，请重新预览")
        if preview["target"] != str(get_library("personal").db_path.resolve()):
            raise ValueError("知识库位置已变化，请重新预览")
        if not isinstance(urls, list) or any(not isinstance(url, str) for url in urls):
            raise ValueError("请选择预览中的文档")
        selected = set(urls)
        available = {doc["url"] for doc in preview["documents"]}
        if not selected.issubset(available):
            raise ValueError("选择含有预览之外的文档，请重新预览")
        builtin_urls = preview["builtin_urls"] & selected
        result = insert_documents([doc for doc in preview["documents"] if doc["url"] in selected - builtin_urls], snapshot=preview["snapshot"])
        result["duplicate"] += len(builtin_urls)
        return result
    finally:
        preview["snapshot"].close()


def import_personal_docs(files: list[dict[str, Any]]) -> dict[str, Any]:
    """The new UI imports personal Markdown, never raw crawled/global knowledge."""
    from dataclasses import asdict
    from knowledge.sources import _chunk_markdown

    documents = []
    rejected = []
    skipped = 0
    for file in files:
        name, content = file.get("name"), file.get("content")
        if not isinstance(name, str) or not isinstance(content, str) or not name.lower().endswith((".md", ".markdown")):
            rejected.append(str(name or "未命名文件"))
            continue
        chunks = _chunk_markdown(content)
        if not chunks:
            skipped += 1
            continue
        rows = []
        for number, (heading, body) in enumerate(chunks):
            row = asdict(KnowledgeEntry(id=f"doc-{uuid.uuid5(uuid.NAMESPACE_URL, name)}-{number}", source="imported-docs", title=f"{Path(name).stem} · {heading}" if heading else Path(name).stem, content=body, url=name, tags=["用户文档", f"file:{name}"]))
            row["tags"] = json.dumps(row["tags"], ensure_ascii=False)
            rows.append(row)
        documents.append({"url": name, "entries": rows, "title_zh": "", "summary_zh": ""})
    result = insert_documents(documents)
    return {**result, "skipped": skipped + result["duplicate"], "errors": 0, "rejected": rejected}
