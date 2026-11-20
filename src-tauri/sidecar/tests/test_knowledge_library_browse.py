"""Regression coverage for library-aware knowledge browsing RPCs."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.fts5 import KnowledgeEntry
class FakeDispatcher:
    def __init__(self) -> None:
        self.methods: dict[str, object] = {}

    def register(self, name: str, fn) -> None:
        self.methods[name] = fn

    def dispatch(self, name: str, params: dict | None = None):
        fn = self.methods[name]
        return fn(**(params or {}))


@pytest.fixture
def dispatcher(tmp_path, monkeypatch) -> FakeDispatcher:
    import knowledge.rag as rag_mod
    from knowledge.rpc import register_methods

    monkeypatch.setattr(rag_mod, "_load_embed_model", lambda: None)
    rag_mod.reset_global_rag(db_path=str(tmp_path / "full.db"))
    rag_mod.reset_slim_rag(db_path=str(tmp_path / "slim.db"))
    dispatcher = FakeDispatcher()
    register_methods(dispatcher)
    yield dispatcher
    rag_mod.reset_global_rag(db_path=str(tmp_path / "after-full.db"))
    rag_mod.reset_slim_rag(db_path=str(tmp_path / "after-slim.db"))


def _entry(
    entry_id: str,
    *,
    source: str,
    category: str,
    content: str,
    url: str = "",
) -> KnowledgeEntry:
    return KnowledgeEntry(
        id=entry_id,
        source=source,
        title=f"title {entry_id}",
        content=content,
        url=url,
        category=category,
    )


def test_rpc_browsing_selects_library_and_preserves_each_default(dispatcher):
    from knowledge.rag import get_global_rag, get_slim_rag

    full = get_global_rag()
    slim = get_slim_rag()
    full.add(_entry("same-id", source="personal", category="mine", content="full body", url="kb://same"))
    slim.add(_entry("same-id", source="builtin", category="core", content="slim body", url="kb://same"))
    full.upsert_titles_zh({"kb://same": "全量标题"})
    slim.upsert_titles_zh({"kb://same": "精简标题"})

    assert dispatcher.dispatch("knowledge.list", {"library": "full"})["results"][0]["content"] == "full body"
    assert dispatcher.dispatch("knowledge.list", {"library": "slim"})["results"][0]["content"] == "slim body"
    assert dispatcher.dispatch("knowledge.list", {})["results"][0]["content"] == "full body"

    assert dispatcher.dispatch("knowledge.get", {"id": "same-id", "library": "slim"})["entry"]["content"] == "slim body"
    assert dispatcher.dispatch("knowledge.get", {"id": "same-id"})["entry"]["content"] == "full body"

    slim_file = dispatcher.dispatch("knowledge.list_files", {"library": "slim"})["files"]
    full_file = dispatcher.dispatch("knowledge.list_files", {"library": "full"})["files"]
    assert slim_file[0]["source"] == "builtin"
    assert full_file[0]["source"] == "personal"
    assert dispatcher.dispatch("knowledge.list_files", {})["files"][0]["source"] == "builtin"

    assert dispatcher.dispatch("knowledge.get_doc", {"url": "kb://same", "library": "full"})["content"] == "full body"
    assert dispatcher.dispatch("knowledge.get_doc", {"url": "kb://same"})["content"] == "slim body"
    assert dispatcher.dispatch("knowledge.titles_zh", {"library": "full"})["titles"][0]["zh"] == "全量标题"
    assert dispatcher.dispatch("knowledge.titles_zh", {})["titles"][0]["zh"] == "精简标题"


@pytest.mark.parametrize(
    ("method", "params"),
    [
        ("knowledge.list", {"library": "other"}),
        ("knowledge.get", {"id": "x", "library": "other"}),
        ("knowledge.list_files", {"library": "other"}),
        ("knowledge.get_doc", {"url": "kb://x", "library": "other"}),
        ("knowledge.titles_zh", {"library": "other"}),
    ],
)
def test_rpc_rejects_unknown_library(dispatcher, method, params):
    with pytest.raises(ValueError, match="library"):
        dispatcher.dispatch(method, params)


def test_list_groups_cover_all_entries_across_pages(dispatcher):
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    for i in range(56):
        category = "alpha" if i % 2 == 0 else "beta"
        source = "imported" if i % 3 == 0 else "case"
        url = f"kb://doc-{i}" if i < 40 else ""
        rag.add(_entry(f"entry-{i}", source=source, category=category, content=f"body {i}", url=url))

    first = dispatcher.dispatch("knowledge.list", {})
    second = dispatcher.dispatch("knowledge.list", {"offset": 50})

    assert len(first["results"]) == 50
    assert len(second["results"]) == 6
    assert first["total"] == 56
    groups = first["groups"]
    assert {(g["category"], g["source"]) for g in groups} == {
        ("alpha", "case"), ("alpha", "imported"), ("beta", "case"), ("beta", "imported")
    }
    assert sum(g["entries"] for g in groups) == 56
    assert sum(g["files"] for g in groups) == 40
    assert all(set(g) == {"category", "source", "entries", "files"} for g in groups)
