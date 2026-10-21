"""Regression coverage for the knowledge.stats embedding status snapshot."""

from __future__ import annotations

import pytest


@pytest.fixture
def knowledge_stats_rpc(tmp_path, monkeypatch):
    monkeypatch.setenv("TDSF_DATA_DIR", str(tmp_path / "data"))

    import main
    import knowledge.rag as rag_mod
    from knowledge.fts5 import KnowledgeEntry
    from knowledge.rpc import register_methods

    index = rag_mod.RagIndex(db_path=tmp_path / "rag.db")
    monkeypatch.setattr(rag_mod, "_global_rag", index)
    monkeypatch.setattr(rag_mod, "_load_embed_model", lambda: None)
    index.add(
        KnowledgeEntry(
            id="stats-entry",
            source="test",
            title="stats title",
            content="stats content",
        )
    )

    dispatcher = main.MethodDispatcher()
    register_methods(dispatcher)
    try:
        yield dispatcher, rag_mod
    finally:
        index.close()


@pytest.mark.parametrize("model", [None, object()], ids=["unloaded", "loaded"])
def test_stats_reads_loaded_state_without_loading(
    knowledge_stats_rpc, monkeypatch, model
):
    dispatcher, rag_mod = knowledge_stats_rpc
    calls = []
    monkeypatch.setattr(rag_mod, "_embed_model", model)

    def unexpected_loader():
        calls.append(True)
        raise AssertionError("knowledge.stats must not initialize the embedding model")

    monkeypatch.setattr(rag_mod, "_load_embed_model", unexpected_loader)

    result = dispatcher.dispatch("knowledge.stats", {})

    assert result == {"total_entries": 1, "embed_model_loaded": model is not None}
    assert calls == []
    assert rag_mod._embed_model is model


def test_stats_reports_live_model_state_on_each_call(knowledge_stats_rpc, monkeypatch):
    dispatcher, rag_mod = knowledge_stats_rpc
    calls = []

    def unexpected_loader():
        calls.append(True)
        raise AssertionError("knowledge.stats must not initialize the embedding model")

    monkeypatch.setattr(rag_mod, "_load_embed_model", unexpected_loader)
    snapshots = []
    for model in (None, object(), None):
        monkeypatch.setattr(rag_mod, "_embed_model", model)
        snapshots.append(dispatcher.dispatch("knowledge.stats", {}))
        assert rag_mod._embed_model is model

    assert snapshots == [
        {"total_entries": 1, "embed_model_loaded": False},
        {"total_entries": 1, "embed_model_loaded": True},
        {"total_entries": 1, "embed_model_loaded": False},
    ]
    assert calls == []
