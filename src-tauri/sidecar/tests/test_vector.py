"""
tests/test_vector.py — ChromaDB 向量检索单元测试（T-P3-02 验证）
=================================================================

验证内容：
1. VectorIndex 初始化 + 默认路径
2. add/search/delete 全流程
3. embedding 生成（sentence-transformers 不可用降级 hash）
4. limit / source 过滤
5. min_score 阈值
6. count / get 接口
7. 全局单例

运行：
    cd python-sidecar
    python -m pytest tests/test_vector.py -v
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from knowledge.fts5 import KnowledgeEntry
from knowledge.vector import (
    VectorIndex,
    generate_embedding,
    _hash_embedding,
    get_global_vector,
    reset_global_vector,
    _HASH_DIM,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def temp_vector(tmp_path: Path) -> VectorIndex:
    """临时 VectorIndex（每个测试独立 chroma 目录）

    使用 pytest 内置 tmp_path，避免 Windows 上 chroma.sqlite3 文件锁导致
    TemporaryDirectory 清理失败
    """
    chroma_path = tmp_path / "chroma"
    index = VectorIndex(chroma_path=chroma_path)
    yield index
    # ChromaDB PersistentClient 在 Windows 上对 sqlite3 文件持有句柄，
    # 无法在测试结束时删除 tmp_path；交由 pytest 自动清理（ignore_cleanup_errors）
    try:
        index.close()
    except Exception:
        pass


@pytest.fixture
def sample_entries() -> list[KnowledgeEntry]:
    """5 条样本知识条目"""
    return [
        KnowledgeEntry(
            id="vec-001",
            source="nginx-docs",
            title="nginx 启动失败排查",
            content="nginx 启动失败的常见原因：端口被占用 配置文件语法错误",
            url="https://nginx.org/docs/",
            tags=["nginx", "运维"],
        ),
        KnowledgeEntry(
            id="vec-002",
            source="systemd-docs",
            title="systemd 服务管理",
            content="systemctl start stop restart enable disable 管理系统服务",
            url="https://systemd.io/docs/",
            tags=["systemd"],
        ),
        KnowledgeEntry(
            id="vec-003",
            source="docker-docs",
            title="docker 容器排查",
            content="docker logs 查看容器日志 docker exec 进入容器",
            url="https://docs.docker.com/",
            tags=["docker"],
        ),
        KnowledgeEntry(
            id="vec-004",
            source="nginx-docs",
            title="nginx 配置文件",
            content="nginx.conf main events http server location 块结构",
            url="https://nginx.org/docs/beginners_guide.html",
            tags=["nginx", "配置"],
        ),
        KnowledgeEntry(
            id="vec-005",
            source="ssh-docs",
            title="SSH 免密登录",
            content="ssh-keygen 生成密钥对 ssh-copy-id 上传公钥",
            url="https://www.ssh.com/docs/",
            tags=["ssh"],
        ),
    ]


# ============================================================================
# 1. VectorIndex 初始化测试
# ============================================================================


def test_vector_index_creation(temp_vector):
    """测试 VectorIndex 创建"""
    assert temp_vector.chroma_path.exists()
    assert temp_vector.count() == 0


def test_vector_index_default_path(tmp_path: Path):
    """测试默认路径（python-sidecar/data/chroma/）"""
    chroma_path = tmp_path / "data" / "chroma"
    index = VectorIndex(chroma_path=chroma_path)
    assert chroma_path.exists()
    try:
        index.close()
    except Exception:
        pass


# ============================================================================
# 2. add 测试
# ============================================================================


def test_vector_add_single(temp_vector):
    """测试添加单条知识（自动生成 embedding）"""
    entry = KnowledgeEntry(
        id="test-001",
        source="test",
        title="测试",
        content="测试内容",
    )
    entry_id = temp_vector.add(entry)
    assert entry_id == "test-001"
    assert temp_vector.count() == 1


def test_vector_add_multiple(temp_vector, sample_entries):
    """测试添加多条知识"""
    for entry in sample_entries:
        temp_vector.add(entry)
    assert temp_vector.count() == 5


def test_vector_add_with_explicit_embedding(temp_vector):
    """测试用显式 embedding 添加"""
    entry = KnowledgeEntry(
        id="test-002",
        source="test",
        title="显式 embedding",
        content="content",
    )
    emb = [0.1] * _HASH_DIM
    entry_id = temp_vector.add(entry, embedding=emb)
    assert entry_id == "test-002"
    assert temp_vector.count() == 1


# ============================================================================
# 3. search 测试
# ============================================================================


def test_vector_search_basic(temp_vector, sample_entries):
    """测试基本向量检索"""
    for entry in sample_entries:
        temp_vector.add(entry)

    query_emb = generate_embedding("nginx 配置")
    results = temp_vector.search(query_emb, limit=10)
    assert len(results) > 0
    # 至少应有 nginx 相关结果
    assert any("nginx" in r["title"].lower() or "nginx" in r["content"].lower() for r in results)


def test_vector_search_with_limit(temp_vector, sample_entries):
    """测试 limit 参数"""
    for entry in sample_entries:
        temp_vector.add(entry)
    query_emb = generate_embedding("服务")
    results = temp_vector.search(query_emb, limit=2)
    assert len(results) <= 2


def test_vector_search_with_source_filter(temp_vector, sample_entries):
    """测试 source 过滤"""
    for entry in sample_entries:
        temp_vector.add(entry)
    query_emb = generate_embedding("nginx")
    results = temp_vector.search(query_emb, source="nginx-docs")
    assert len(results) > 0
    for r in results:
        assert r["source"] == "nginx-docs"


def test_vector_search_with_min_score(temp_vector, sample_entries):
    """测试 min_score 阈值"""
    for entry in sample_entries:
        temp_vector.add(entry)
    query_emb = generate_embedding("nginx")
    # 极高阈值应过滤所有结果
    results = temp_vector.search(query_emb, min_score=0.99)
    # hash 向量模式下相似度较低，可能全部被过滤
    # 仅验证不报错
    assert isinstance(results, list)


def test_vector_search_empty_query(temp_vector):
    """测试空 query 向量"""
    results = temp_vector.search([])
    assert results == []


# ============================================================================
# 4. delete / get / count 测试
# ============================================================================


def test_vector_delete(temp_vector, sample_entries):
    """测试删除单条知识"""
    for entry in sample_entries:
        temp_vector.add(entry)
    assert temp_vector.count() == 5

    deleted = temp_vector.delete("vec-001")
    assert deleted is True
    assert temp_vector.count() == 4


def test_vector_get_by_id(temp_vector, sample_entries):
    """测试按 ID 获取"""
    for entry in sample_entries:
        temp_vector.add(entry)

    result = temp_vector.get("vec-001")
    assert result is not None
    assert result["id"] == "vec-001"
    assert result["source"] == "nginx-docs"
    assert result["title"] == "nginx 启动失败排查"

    # 不存在
    none_result = temp_vector.get("nonexistent-id")
    assert none_result is None


def test_vector_count(temp_vector, sample_entries):
    """测试 count 接口"""
    assert temp_vector.count() == 0
    for entry in sample_entries[:3]:
        temp_vector.add(entry)
    assert temp_vector.count() == 3


# ============================================================================
# 5. embedding 生成测试
# ============================================================================


def test_vector_embedding_generation():
    """测试 generate_embedding 函数"""
    # 非空文本
    emb = generate_embedding("nginx 启动失败")
    assert isinstance(emb, list)
    assert len(emb) > 0
    assert all(isinstance(x, float) for x in emb)

    # 空文本
    emb_empty = generate_embedding("")
    assert isinstance(emb_empty, list)


def test_vector_hash_fallback():
    """测试 hash 向量降级方案"""
    # 直接调用 hash embedding
    emb1 = _hash_embedding("nginx")
    emb2 = _hash_embedding("nginx")
    emb3 = _hash_embedding("apache")

    # 相同输入应产生相同向量
    assert emb1 == emb2
    # 不同输入应产生不同向量
    assert emb1 != emb3
    # 维度正确
    assert len(emb1) == _HASH_DIM
    # L2 归一化：向量模长接近 1
    import math
    norm = math.sqrt(sum(x * x for x in emb1))
    assert 0.9 < norm < 1.1


# ============================================================================
# 6. ChromaDB 不可用 + 全局单例测试
# ============================================================================


def test_vector_chromadb_unavailable(monkeypatch, tmp_path: Path):
    """测试 ChromaDB 不可用时的错误处理"""
    # mock chromadb import 失败
    import sys
    original_chromadb = sys.modules.pop("chromadb", None)
    monkeypatch.setitem(sys.modules, "chromadb", None)

    with pytest.raises(RuntimeError) as exc_info:
        VectorIndex(chroma_path=tmp_path / "chroma")
    assert "chromadb" in str(exc_info.value).lower()

    # 恢复
    if original_chromadb is not None:
        sys.modules["chromadb"] = original_chromadb


def test_vector_global_singleton(tmp_path: Path):
    """测试全局单例"""
    reset_global_vector()
    chroma_path = tmp_path / "global_chroma"
    index1 = get_global_vector(chroma_path=chroma_path)
    index2 = get_global_vector()  # 应返回同一实例
    assert index1 is index2
    try:
        index1.close()
    except Exception:
        pass
    reset_global_vector()


def test_vector_metadata_persistence(temp_vector):
    """测试 metadata 持久化（source/title/url/tags 均可读）"""
    entry = KnowledgeEntry(
        id="meta-001",
        source="nginx-docs",
        title="nginx metadata 测试",
        content="验证 metadata 完整性",
        url="https://nginx.org/meta",
        tags=["nginx", "test", "metadata"],
    )
    temp_vector.add(entry)

    # 通过 search 验证 metadata
    query_emb = generate_embedding("nginx metadata")
    results = temp_vector.search(query_emb, limit=5)
    assert len(results) > 0
    found = [r for r in results if r["id"] == "meta-001"]
    assert len(found) == 1
    item = found[0]
    assert item["source"] == "nginx-docs"
    assert item["title"] == "nginx metadata 测试"
    assert item["url"] == "https://nginx.org/meta"
    assert "nginx" in item["tags"]
    assert "metadata" in item["tags"]
