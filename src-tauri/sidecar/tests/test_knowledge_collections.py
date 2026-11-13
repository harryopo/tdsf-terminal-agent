"""Knowledge views preserve storage provenance without migrating user databases."""

from __future__ import annotations

import hashlib
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import RagIndex


def entry(entry_id, *, url="guide.md", source="bash-docs", content="服务管理 systemctl", title="服务管理", category="sys-admin"):
    return KnowledgeEntry(id=entry_id, url=url, source=source, content=content, title=title, category=category)


@pytest.fixture
def libraries(tmp_path, monkeypatch):
    import knowledge.bundled as bundled
    import knowledge.rag as rag

    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "user"))
    monkeypatch.setattr(rag, "_load_embed_model", lambda: None)
    bundle_path = tmp_path / "bundle.db"
    bundle = RagIndex(bundle_path)
    bundle.add(entry("bundle-0", content="内置参考 systemctl"))
    bundle.close()
    monkeypatch.setattr(bundled, "bundled_slim_db_path", lambda: bundle_path)
    full = rag.reset_global_rag(tmp_path / "user" / "rag.db")
    slim = rag.reset_slim_rag(tmp_path / "user" / "rag_slim.db")
    from knowledge import collections

    monkeypatch.setattr(collections, "_indexes", {})
    yield collections, full, slim, bundle_path
    for index in collections._indexes.values():
        index.close()
    full.close()
    slim.close()
    rag._global_rag = None
    rag._global_slim_rag = None


def test_readonly_index_does_not_migrate_or_write(tmp_path, monkeypatch):
    import knowledge.rag as rag

    monkeypatch.setattr(rag, "_load_embed_model", lambda: None)
    path = tmp_path / "bundle.db"
    index = RagIndex(path)
    index.add(entry("bundle-0"))
    index.close()
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    readonly = RagIndex(path, read_only=True)
    try:
        assert readonly.count() == 1
        assert readonly.hybrid_search("systemctl")[0]["id"] == "bundle-0"
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            readonly.add(entry("never-written", content="unique new content"))
    finally:
        readonly.close()
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    missing = tmp_path / "not-created" / "missing.db"
    with pytest.raises(sqlite3.OperationalError):
        RagIndex(missing, read_only=True)
    assert not missing.parent.exists()


def test_empty_legacy_slim_does_not_hide_builtin(libraries):
    collections, full, slim, bundle = libraries
    full.add(entry("raw-0", content="Raw cache systemctl"))
    assert slim.count() == 0
    assert collections.get_library("builtin").count() == 1
    assert collections.get_library("personal").count() == 0
    assert collections.get_library("reference") is full
    assert collections.get_library("full") is full
    assert collections.get_library("slim") is slim
    assert collections.get_library("builtin").db_path == bundle


def test_document_pagination_is_by_identity_not_chunk_or_basename(libraries):
    collections, _, _, _ = libraries
    personal = collections.get_library("personal")
    personal.add(entry("a-0", url="v1/index.html", title="服务 · 开始"))
    personal.add(entry("a-1", url="v1/index.html", title="服务 · 验证", content="验证服务"))
    personal.add(entry("b-0", url="v2/index.html", title="第二版", content="另一版本"))
    personal.upsert_titles_zh({"v1/index.html": "服务管理精华"}, {"v1/index.html": "已有中文摘要"})
    page = collections.list_documents("personal", limit=1, offset=0)
    assert page["total"] == 2
    assert len(page["documents"]) == 1
    first = page["documents"][0]
    assert first["url"] == "v1/index.html"
    assert first["title_zh"] == "服务管理精华"
    assert first["summary_zh"] == "已有中文摘要"
    assert first["chunks"] == 2
    assert first["library"] == "personal"
    assert sum(group["files"] for group in page["groups"]) == 2
    next_page = collections.list_documents("personal", limit=1, offset=1)
    assert next_page["documents"][0]["url"] == "v2/index.html"
    assert collections.list_documents("personal", offset=2)["documents"] == []
    assert collections.list_documents("personal", category="services")["total"] == 0


def test_raw_reference_never_exposes_private_memory(libraries):
    collections, full, _, _ = libraries
    full.add(entry("raw-0", content="raw systemctl"))
    full.add(entry("private-0", source="session-memory", url="memory://private", content="private systemctl"))
    page = collections.list_documents("reference")
    assert page["total"] == 1
    assert page["documents"][0]["id"] == "raw-0"
    assert collections.get_document("memory://private", "reference") is None
    assert collections.search_collection("systemctl", "reference", 10)[0]["id"] == "raw-0"
    assert all(row["id"] != "private-0" for row in collections.search_collection("systemctl", "reference", 10))


def test_curated_search_keeps_origin_and_same_named_versions(libraries):
    collections, full, slim, _ = libraries
    personal = collections.get_library("personal")
    personal.add(entry("same-0", content="个人精华 systemctl", url="v2/guide.md"))
    slim.add(entry("same-0", content="旧中文 systemctl", url="v1/guide.md"))
    full.add(entry("secret", source="session-memory", content="secret systemctl"))
    rows = collections.search_curated("systemctl", 10)
    assert {row["library"] for row in rows} == {"builtin", "personal", "slim"}
    assert {row["url"] for row in rows} == {"guide.md", "v1/guide.md", "v2/guide.md"}
    assert not any(row["id"] == "secret" for row in rows)
    for row in rows:
        assert row["content"] in collections.get_document(row["url"], row["library"])["content"]


def test_rpc_new_views_and_legacy_defaults_are_separate(libraries):
    _, full, slim, _ = libraries
    from knowledge.rpc import register_methods

    class Dispatcher:
        def __init__(self):
            self.methods = {}

        def register(self, name, fn):
            self.methods[name] = fn

    full.add(entry("legacy-full", content="Full systemctl"))
    slim.add(entry("legacy-slim", content="Slim systemctl"))
    dispatcher = Dispatcher()
    register_methods(dispatcher)
    call = dispatcher.methods
    assert call["knowledge.list"]()["results"][0]["id"] == "legacy-full"
    assert call["knowledge.get_doc"]("guide.md")["content"] == "Slim systemctl"
    assert call["knowledge.search"]("systemctl")["results"][0]["id"] == "legacy-slim"
    assert call["knowledge.documents"](library="builtin")["documents"][0]["id"] == "bundle-0"
    assert call["knowledge.search"]("systemctl", library="builtin")["results"][0]["id"] == "bundle-0"
    assert call["knowledge.get_doc"]("guide.md", library="builtin")["content"] == "内置参考 systemctl"
    assert call["knowledge.get"]("bundle-0", library="builtin")["entry"]["content"] == "内置参考 systemctl"


def test_agent_reference_binds_same_url_to_personal_library_without_new_schema(libraries):
    collections, _, slim, _ = libraries
    from strands.tools.registry import ToolRegistry
    from strands_backend.tools.knowledge_search import make_knowledge_search_tool
    from strands_backend.tools.knowledge_get_doc import make_knowledge_get_doc_tool

    personal = collections.get_library("personal")
    personal.add(entry("personal-0", content="个人独有测试词", url="same.md"))
    slim.add(entry("legacy-0", content="别的旧版本", url="same.md"))
    search = make_knowledge_search_tool(None)
    read = make_knowledge_get_doc_tool(None)
    registry = ToolRegistry()
    registry.process_tools([search, read])
    assert set(registry.registry["knowledge_search"].tool_spec["inputSchema"]["json"]["properties"]) == {"query", "limit"}
    assert set(registry.registry["knowledge_get_doc"].tool_spec["inputSchema"]["json"]["properties"]) == {"url"}
    result = search(query="个人独有测试词")
    hit = result["results"][0]
    assert hit["library"] == "personal" and hit["source_url"] == "same.md"
    assert hit["url"].startswith("tdsf-kb://personal/")
    doc = read(url=hit["url"])
    assert doc["content"] == "个人独有测试词"
    assert doc["url"] == hit["url"]
    assert doc["source_url"] == "same.md"


def test_private_hits_cannot_exhaust_reference_candidates(libraries):
    collections, full, _, _ = libraries
    full.add(entry("raw-0", title="Reference guide", content="context " * 100 + "needle"))
    for number in range(20):
        full.add(entry(f"private-{number}", source="session-memory", title="needle", content=f"needle {number}", url=f"memory://{number}"), dedupe=False)
    unfiltered = full.hybrid_search("needle", top_k=40)
    assert len(unfiltered) == 20
    assert all(row["source"] == "session-memory" for row in unfiltered)
    rows = collections.search_collection("needle", "reference", 5)
    assert [row["id"] for row in rows] == ["raw-0"]


def unavailable_library(monkeypatch, collections, path, library):
    original = collections.get_library

    def get_library(name):
        if library is None or name == library:
            return RagIndex(path, read_only=True)
        return original(name)

    monkeypatch.setattr(collections, "get_library", get_library)


@pytest.mark.parametrize("library", ["personal", "slim", "builtin"])
def test_degradation_one_library_failure_retains_healthy_hits(libraries, monkeypatch, tmp_path, library):
    collections, _, slim, _ = libraries
    collections.get_library("personal").add(entry("personal-0", content="个人 systemctl", url="personal.md"))
    slim.add(entry("slim-0", content="已有中文 systemctl", url="slim.md"))
    unavailable_library(monkeypatch, collections, tmp_path / "unavailable.db", library)
    from strands_backend.tools.knowledge_search import make_knowledge_search_tool
    from strands_backend.tools.knowledge_get_doc import make_knowledge_get_doc_tool

    result = make_knowledge_search_tool(None)(query="systemctl")
    assert result["status"] == "success"
    assert result["partial"] is True
    assert result["unavailable_libraries"] == [library]
    assert "不完整" in result["message"]
    assert {hit["library"] for hit in result["results"]} == {"personal", "slim", "builtin"} - {library}
    read = make_knowledge_get_doc_tool(None)
    for hit in result["results"]:
        doc = read(url=hit["url"])
        assert doc["status"] == "success"
        assert hit["content"] in doc["content"]
    assert not (tmp_path / "unavailable.db").exists()


def test_degradation_unavailable_library_without_hits_is_not_empty(libraries, monkeypatch, tmp_path):
    collections, _, _, _ = libraries
    unavailable_library(monkeypatch, collections, tmp_path / "unavailable.db", "builtin")
    from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

    result = invoke_knowledge_search_tool({"query": "no-matching-document"})
    assert result["status"] == "error"
    assert result["unavailable_libraries"] == ["builtin"]
    assert "检索未完成" in result["message"]
    assert "暂无相关内容" not in result["message"]


def test_degradation_all_libraries_unavailable_stays_error(libraries, monkeypatch, tmp_path):
    collections, _, _, _ = libraries
    unavailable_library(monkeypatch, collections, tmp_path / "unavailable.db", None)
    from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

    result = invoke_knowledge_search_tool({"query": "systemctl"})
    assert result["status"] == "error"
    assert result["unavailable_libraries"] == ["personal", "slim", "builtin"]
    assert "检索未完成" in result["message"]


def test_degradation_default_collection_call_still_raises(libraries, monkeypatch, tmp_path):
    collections, _, _, _ = libraries
    unavailable_library(monkeypatch, collections, tmp_path / "unavailable.db", "builtin")
    with pytest.raises(sqlite3.OperationalError):
        collections.search_curated("systemctl")


@pytest.mark.parametrize("failure", [RuntimeError, sqlite3.ProgrammingError, sqlite3.InterfaceError])
def test_degradation_nonstorage_bug_remains_error(libraries, monkeypatch, failure):
    collections, _, _, _ = libraries

    def fail(*_args, **_kwargs):
        raise failure("unexpected knowledge implementation failure")

    monkeypatch.setattr(collections, "search_collection", fail)
    from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

    result = invoke_knowledge_search_tool({"query": "systemctl"})
    assert result["status"] == "error"
    assert not result.get("partial")
    assert not result.get("unavailable_libraries")
    assert "unexpected knowledge implementation failure" in result["message"]


def test_degradation_healthy_empty_remains_empty(libraries):
    from strands_backend.tools.knowledge_search import invoke_knowledge_search_tool

    result = invoke_knowledge_search_tool({"query": "no-matching-document"})
    assert result["status"] == "empty"
    assert not result.get("partial")
    assert not result.get("unavailable_libraries")


@pytest.mark.parametrize("library", ["personal", "reference", "builtin"])
def test_listing_avoids_materializing_bodies(libraries, library):
    collections, _, _, bundle_path = libraries
    writer = RagIndex(bundle_path) if library == "builtin" else collections.get_library(library)
    bodies = {}
    translations = {}
    for sequence in (10, 2):
        bodies[sequence] = f"chapter-{sequence} " * 4000
        translations[sequence] = f"已有译文{sequence} " * 4000
        item = entry(f"listing-{sequence}", url="a-guide.md", title=f"章节 {sequence}", content=bodies[sequence])
        item.content_zh = translations[sequence]
        writer.add(item, dedupe=False)
    writer.upsert_titles_zh({"a-guide.md": "已有中文标题"}, {"a-guide.md": "已有中文摘要"})
    if library == "builtin":
        writer.close()
    index = collections.get_library(library)
    conn = index._conn
    original_factory = conn.row_factory
    body_characters = 0

    def measured_row(cursor, values):
        nonlocal body_characters
        body_characters += sum(
            len(value) for column, value in zip(cursor.description, values)
            if column[0] in {"content", "content_zh"} and isinstance(value, str)
        )
        return original_factory(cursor, values)

    conn.row_factory = measured_row
    try:
        page = collections.list_documents(library, limit=1)
        listing_characters = body_characters
        document = collections.get_document("a-guide.md", library)
        # A real full read must exercise the same meter; a broken meter cannot pass.
        assert body_characters - listing_characters == sum(map(len, bodies.values())) + sum(map(len, translations.values()))
        assert document["content"] == "\n\n".join(bodies[number] for number in (2, 10))
        assert document["content_zh"] == "\n\n".join(translations[number] for number in (2, 10))
    finally:
        conn.row_factory = original_factory
    row = page["documents"][0]
    assert row["url"] == "a-guide.md"
    assert row["title0"] == document["title"] == "章节 2"
    assert row["title_zh"] == "已有中文标题"
    assert row["summary_zh"] == "已有中文摘要"
    assert row["chunks"] == 2
    assert row["total_chars"] == sum(map(len, bodies.values()))
    assert row["library"] == library
    assert "content" not in row and "content_zh" not in row
    print(f"listing_body_characters[{library}]={listing_characters}")
    assert listing_characters == 0


def test_listing_title_ties_use_the_existing_rowid_order(libraries):
    collections, _, _, _ = libraries
    index = collections.get_library("personal")
    for identity, title in (("same-0", "同序号甲"), ("no-suffix", "同序号乙")):
        index.add(entry(identity, title=title, content=identity), dedupe=False)
    expected = index._conn.execute("SELECT title FROM entries WHERE url = ? ORDER BY rowid LIMIT 1", ("guide.md",)).fetchone()[0]
    assert collections.get_document("guide.md", "personal")["title"] == expected
    assert collections.list_documents("personal")["documents"][0]["title0"] == expected


@pytest.mark.parametrize("processing", ["imported", "recovered"])
def test_listing_preserves_personal_processing_metadata(libraries, processing):
    collections, _, _, _ = libraries
    index = collections.get_library("personal")
    index.add(entry("processing-0"))
    index._conn.execute("CREATE TABLE document_provenance (url TEXT PRIMARY KEY, processing TEXT NOT NULL, content_hash TEXT NOT NULL)")
    index._conn.execute("INSERT INTO document_provenance VALUES (?, ?, ?)", ("guide.md", processing, "temporary-fixture"))
    index._conn.commit()
    assert collections.list_documents("personal")["documents"][0]["processing"] == processing
    assert collections.get_document("guide.md", "personal")["processing"] == processing


def test_listing_empty_url_notes_remain_separate(libraries):
    collections, _, _, _ = libraries
    index = collections.get_library("personal")
    index.add(entry("note-a", url="", source="user-note", title="笔记甲", content="甲"))
    index.add(entry("note-b", url="", source="user-note", title="笔记乙", content="乙"))
    page = collections.list_documents("personal", limit=1)
    next_page = collections.list_documents("personal", limit=1, offset=1)
    assert page["total"] == next_page["total"] == 2
    assert {page["documents"][0]["id"], next_page["documents"][0]["id"]} == {"note-a", "note-b"}
    assert {page["documents"][0]["title0"], next_page["documents"][0]["title0"]} == {"笔记甲", "笔记乙"}


def test_listing_reference_still_excludes_mixed_private_documents(libraries):
    collections, full, _, _ = libraries
    full.add(entry("public-0", url="mixed.md", title="公开章节", content="公开内容"))
    full.add(entry("private-1", url="mixed.md", source="session-memory", title="私人章节", content="私人内容"))
    full.add(entry("allowed-0", url="allowed.md", title="可见文档", content="可见内容"))
    page = collections.list_documents("reference")
    assert page["total"] == 1
    assert [row["url"] for row in page["documents"]] == ["allowed.md"]
    assert page["documents"][0]["title0"] == "可见文档"
    assert collections.get_document("mixed.md", "reference") is None
