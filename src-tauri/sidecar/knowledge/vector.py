"""
knowledge/vector.py — ChromaDB 向量检索（T-P3-02）
====================================================

职责：
- VectorIndex 类：基于 ChromaDB 的向量检索
- add(entry, embedding) / search(query_embedding, limit) / delete(id)
- sentence-transformers 不可用时降级为 hash 向量（保证测试可跑）

设计要点：
- ChromaDB PersistentClient（本地持久化，无需服务器）
- sentence-transformers all-MiniLM-L6-v2（384 维）生成本地 embedding
- 降级策略：sentence-transformers 不可用时使用 hash 向量（128 维，简单 hash 字符到向量）
- 数据路径：python-sidecar/data/chroma/

降级策略：
- sentence-transformers 不可用 → hash_embedding(text, dim=128)
- ChromaDB 不可用 → 抛 RuntimeError（chromadb 已在 requirements.txt，应该可用）
- 所有降级在测试中可跑

数据流：
    KnowledgeEntry + embedding → ChromaDB upsert
    query_embedding → ChromaDB query → cosine similarity → 排序返回
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any

from knowledge.fts5 import KnowledgeEntry

logger = logging.getLogger("sidecar.knowledge.vector")


# ============================================================================
# 常量定义
# ============================================================================

# 默认数据路径（dev: python-sidecar/data/chroma/; frozen: 数据目录下）
if getattr(sys, "frozen", False):
    _DEFAULT_CHROMA_PATH: Path = (
        Path(os.environ.get("TDSF_DATA_DIR", str(Path(sys.executable).resolve().parent / ".tdsf-data")))
        / "chroma"
    )
else:
    _DEFAULT_CHROMA_PATH: Path = Path(__file__).parent.parent / "data" / "chroma"

# 默认 collection 名称
_DEFAULT_COLLECTION: str = "tdsf_knowledge"

# hash 向量维度（降级模式）
_HASH_DIM: int = 128

# sentence-transformers 模型名
_ST_MODEL: str = "all-MiniLM-L6-v2"

# sentence-transformers 全局实例（懒加载）
_st_model: Any = None
_st_lock = threading.Lock()
_st_unavailable_reason: str | None = None


# ============================================================================
# Embedding 生成器
# ============================================================================


def _check_sentence_transformers() -> bool:
    """检查 sentence-transformers 是否可用（懒加载）"""
    global _st_model, _st_unavailable_reason
    if _st_model is not None:
        return True
    if _st_unavailable_reason is not None:
        return False
    with _st_lock:
        if _st_model is not None:
            return True
        if _st_unavailable_reason is not None:
            return False
        try:
            # 延迟导入，避免未安装时崩溃
            from sentence_transformers import SentenceTransformer  # type: ignore[import-untyped]
            _st_model = SentenceTransformer(_ST_MODEL)
            logger.info(f"sentence-transformers 已加载，model={_ST_MODEL}")
            return True
        except ImportError as e:
            _st_unavailable_reason = f"sentence-transformers 未安装: {e}"
            logger.warning(_st_unavailable_reason)
            return False
        except Exception as e:
            _st_unavailable_reason = f"sentence-transformers 初始化失败: {e}"
            logger.warning(_st_unavailable_reason)
            return False


def generate_embedding(text: str) -> list[float]:
    """生成文本的 embedding 向量

    优先使用 sentence-transformers all-MiniLM-L6-v2（384 维），
    不可用时降级为 hash 向量（128 维）。

    Args:
        text: 输入文本

    Returns:
        float 列表（384 维或 128 维）
    """
    if not text:
        # 空文本返回零向量（hash 降级模式）
        return [0.0] * _HASH_DIM

    if _check_sentence_transformers() and _st_model is not None:
        try:
            emb = _st_model.encode(text, convert_to_numpy=True)
            return [float(x) for x in emb.tolist()]
        except Exception as e:
            logger.warning(f"sentence-transformers 编码失败，降级 hash: {e}")

    # 降级：hash 向量
    return _hash_embedding(text, dim=_HASH_DIM)


def _hash_embedding(text: str, dim: int = _HASH_DIM) -> list[float]:
    """基于 hash 的简单 embedding（降级方案）

    策略：
    1. 用 SHA256 hash 文本，取前 dim 个字节的归一化值
    2. 再叠加每个字符的 char code 取模，增强区分度

    Args:
        text: 输入文本
        dim: 向量维度（默认 128）

    Returns:
        dim 维 float 列表，值域 [-1, 1]
    """
    vec = [0.0] * dim
    if not text:
        return vec

    # SHA256 hash → 32 字节
    h = hashlib.sha256(text.encode("utf-8")).digest()
    # 重复扩展到 dim 维
    for i in range(dim):
        byte_val = h[i % len(h)]
        # 字符级叠加（按位置加权和）
        char_factor = 0
        for j, ch in enumerate(text):
            char_factor += (ord(ch) + j) * (i + 1)
        # 归一化到 [-1, 1]
        vec[i] = ((byte_val + char_factor) % 200 - 100) / 100.0

    # L2 归一化（保证 cosine 相似度有效）
    norm = sum(x * x for x in vec) ** 0.5
    if norm > 0:
        vec = [x / norm for x in vec]
    return vec


# ============================================================================
# VectorIndex — 向量检索管理器
# ============================================================================


class VectorIndex:
    """ChromaDB 向量检索管理器

    线程安全：ChromaDB 内部线程安全，本类不额外加锁
    生命周期：长生命周期，通过 close() 显式释放

    用法：
        index = VectorIndex()                       # 使用默认路径
        emb = generate_embedding(entry.content)
        index.add(entry, emb)                       # 增加条目
        query_emb = generate_embedding("nginx")
        results = index.search(query_emb, limit=10) # 向量检索
        index.delete(entry.id)                      # 删除条目
    """

    def __init__(
        self,
        chroma_path: Path | str | None = None,
        collection_name: str = _DEFAULT_COLLECTION,
    ) -> None:
        """初始化 ChromaDB 向量索引

        Args:
            chroma_path: ChromaDB 数据目录。None 时使用默认路径
            collection_name: collection 名称（默认 tdsf_knowledge）
        """
        self.chroma_path: Path = Path(chroma_path) if chroma_path else _DEFAULT_CHROMA_PATH
        self.chroma_path.mkdir(parents=True, exist_ok=True)
        self.collection_name: str = collection_name

        # 初始化 ChromaDB
        try:
            import chromadb
            from chromadb.config import Settings
            self._client: Any = chromadb.PersistentClient(
                path=str(self.chroma_path),
                settings=Settings(anonymized_telemetry=False, allow_reset=True),
            )
            self._collection: Any = self._client.get_or_create_collection(
                name=collection_name,
                metadata={"description": "TDSF Terminal Agent Knowledge Base"},
            )
            logger.info(
                f"VectorIndex 初始化完成，path={self.chroma_path}, "
                f"collection={collection_name}"
            )
        except ImportError as e:
            raise RuntimeError(
                f"chromadb 未安装: {e}。请执行 pip install chromadb"
            ) from e

    # ========================================================================
    # 增删查接口
    # ========================================================================

    def add(
        self,
        entry: KnowledgeEntry,
        embedding: list[float] | None = None,
    ) -> str:
        """添加一条知识到向量索引

        Args:
            entry: 知识条目
            embedding: 预计算的 embedding 向量。None 时自动生成

        Returns:
            entry.id
        """
        if embedding is None:
            embedding = generate_embedding(entry.content or entry.title)

        # ChromaDB metadata 必须 1D 平铺（值类型为 str/int/float/bool）
        metadata: dict[str, Any] = {
            "source": entry.source,
            "title": entry.title,
            "url": entry.url,
            "created_at": entry.created_at,
            "tags": ",".join(entry.tags),  # list → str
        }

        self._collection.upsert(
            ids=[entry.id],
            embeddings=[embedding],
            documents=[entry.content or entry.title],
            metadatas=[metadata],
        )
        logger.debug(f"Vector add: id={entry.id}, title={entry.title[:40]}")
        return entry.id

    def search(
        self,
        query_embedding: list[float],
        limit: int = 10,
        source: str | None = None,
        min_score: float = 0.0,
    ) -> list[dict[str, Any]]:
        """向量检索

        Args:
            query_embedding: 查询向量
            limit: 返回 top-K
            source: 可选，按 source 过滤
            min_score: 最低相似度阈值（cosine similarity ∈ [0, 1]）

        Returns:
            检索结果列表，每项含 id/source/title/content/url/tags/created_at/score
        """
        if not query_embedding:
            return []

        # 构建 where 过滤
        where: dict[str, Any] | None = None
        if source:
            where = {"source": source}

        try:
            query_result = self._collection.query(
                query_embeddings=[query_embedding],
                n_results=limit,
                where=where,
            )
        except Exception as e:
            logger.warning(f"ChromaDB query 失败: {e}")
            return []

        # 解析结果
        # 结构: {"ids": [[...]], "documents": [[...]], "metadatas": [[...]], "distances": [[...]]}
        if not query_result or not query_result.get("ids"):
            return []

        ids_list = query_result.get("ids", [[]])
        docs_list = query_result.get("documents", [[]])
        metas_list = query_result.get("metadatas", [[]])
        dists_list = query_result.get("distances", [[]])

        if not ids_list or not ids_list[0]:
            return []

        ids = ids_list[0]
        docs = docs_list[0] if docs_list else ["" for _ in ids]
        metas = metas_list[0] if metas_list else [{} for _ in ids]
        dists = dists_list[0] if dists_list else [0.0 for _ in ids]

        results: list[dict[str, Any]] = []
        for i, entry_id in enumerate(ids):
            distance = float(dists[i]) if i < len(dists) else 1.0
            # cosine distance ∈ [0, 2]，转换为 similarity ∈ [0, 1]
            score = 1.0 - (distance / 2.0)
            score = round(max(0.0, min(1.0, score)), 4)

            if score < min_score:
                continue

            content = docs[i] if i < len(docs) else ""
            metadata = metas[i] if i < len(metas) and isinstance(metas[i], dict) else {}

            # 解析 tags 字符串
            tags_str = metadata.get("tags", "")
            tags = tags_str.split(",") if tags_str else []

            results.append({
                "id": entry_id,
                "source": metadata.get("source", ""),
                "title": metadata.get("title", ""),
                "content": content,
                "url": metadata.get("url", ""),
                "tags": tags,
                "created_at": metadata.get("created_at", ""),
                "score": score,
            })

        logger.debug(
            f"Vector search: results={len(results)}, "
            f"top_score={results[0]['score'] if results else 0:.3f}"
        )
        return results

    def delete(self, entry_id: str) -> bool:
        """删除指定 ID 的知识条目

        Args:
            entry_id: 条目 ID

        Returns:
            True 表示删除成功（ChromaDB 不返回影响行数，只要调用即视为成功）
        """
        try:
            self._collection.delete(ids=[entry_id])
            logger.debug(f"Vector delete: id={entry_id}")
            return True
        except Exception as e:
            logger.warning(f"Vector delete 失败: {e}")
            return False

    def count(self) -> int:
        """返回 collection 中的条目数"""
        try:
            return int(self._collection.count())
        except Exception as e:
            logger.warning(f"Vector count 失败: {e}")
            return 0

    def get(self, entry_id: str) -> dict[str, Any] | None:
        """按 ID 获取单条知识

        Args:
            entry_id: 条目 ID

        Returns:
            条目字典；不存在返回 None
        """
        try:
            result = self._collection.get(ids=[entry_id])
        except Exception as e:
            logger.warning(f"Vector get 失败: {e}")
            return None

        if not result or not result.get("ids"):
            return None

        ids = result.get("ids", [])
        docs = result.get("documents", [])
        metas = result.get("metadatas", [])

        if not ids:
            return None

        entry_id = ids[0]
        content = docs[0] if docs else ""
        metadata = metas[0] if metas and isinstance(metas[0], dict) else {}

        tags_str = metadata.get("tags", "")
        tags = tags_str.split(",") if tags_str else []

        return {
            "id": entry_id,
            "source": metadata.get("source", ""),
            "title": metadata.get("title", ""),
            "content": content,
            "url": metadata.get("url", ""),
            "tags": tags,
            "created_at": metadata.get("created_at", ""),
            "score": 1.0,
        }

    def reset(self) -> None:
        """清空 collection（仅供测试使用）"""
        try:
            self._client.delete_collection(self.collection_name)
            self._collection = self._client.get_or_create_collection(
                name=self.collection_name,
                metadata={"description": "TDSF Terminal Agent Knowledge Base"},
            )
            logger.info("Vector reset: collection 已清空重建")
        except Exception as e:
            logger.warning(f"Vector reset 失败: {e}")

    def close(self) -> None:
        """关闭客户端（通常仅在测试或 Sidecar 退出时调用）"""
        # ChromaDB PersistentClient 无需显式关闭
        logger.info("VectorIndex 客户端已释放")


# ============================================================================
# 模块级单例
# ============================================================================

_global_vector: VectorIndex | None = None
_global_vector_lock = threading.Lock()


def get_global_vector(chroma_path: Path | str | None = None) -> VectorIndex:
    """获取全局 VectorIndex 单例"""
    global _global_vector
    if _global_vector is not None:
        return _global_vector
    with _global_vector_lock:
        if _global_vector is not None:
            return _global_vector
        _global_vector = VectorIndex(chroma_path=chroma_path)
    return _global_vector


def reset_global_vector() -> None:
    """重置全局单例（仅供测试使用）"""
    global _global_vector
    with _global_vector_lock:
        if _global_vector is not None:
            try:
                _global_vector.close()
            except Exception as e:
                # 关闭向量库失败可接受（析构场景），不阻断置空
                logger.debug(f"vector global close failed: {e}")
        _global_vector = None
