"""
strands_backend/tests/conftest.py — 测试隔离
=========================================

P1-3 (2026-08-01): 审计链全局单例默认写 ~/.tdsf-data/audit-chain.jsonl，
测试中会污染真实用户文件。autouse fixture 把全局链重置到临时目录，
并在测试结束时恢复。
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_audit_chain(tmp_path):
    from strands_backend.audit_chain import reset_global_chain

    reset_global_chain(path=str(tmp_path / "audit-test.jsonl"))
    yield
    reset_global_chain()


@pytest.fixture(autouse=True)
def _isolate_knowledge(tmp_path):
    """T3/P2-4: 隔离知识库全局 rag（防测试污染真实 rag.db）"""
    from knowledge.rag import reset_global_rag

    reset_global_rag(db_path=str(tmp_path / "rag-test.db"))
    yield
    reset_global_rag()
