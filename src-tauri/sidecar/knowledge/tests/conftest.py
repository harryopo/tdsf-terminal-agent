"""
knowledge/tests/conftest.py — 知识库测试隔离（P2-4）
=====================================================

- 全局 RAG 指向临时库（防污染真实 .tdsf-data/rag.db）
- 跳过真实 BGE 模型加载（测试环境无网/不下载模型，hash 向量兜底，
  否则每次入库触发网络超时 30s+）
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_knowledge(tmp_path):
    from knowledge.rag import _load_embed_model, reset_global_rag

    # 1. 跳过真实 embedding 模型（测试用 hash 兜底）
    _load_embed_model.__defaults__ = None  # no-op guard
    import knowledge.rag as rag_mod

    original = rag_mod._load_embed_model
    rag_mod._load_embed_model = lambda: None
    # 2. 全局 RAG 指向临时库
    reset_global_rag(db_path=str(tmp_path / "rag-test.db"))
    yield
    rag_mod._load_embed_model = original
    reset_global_rag()
