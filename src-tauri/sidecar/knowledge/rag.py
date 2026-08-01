"""
knowledge/rag.py — 统一 RAG 引擎（P2-4）
=========================================

把零散的双路（ChromaDB 向量 + FTS5）整合为**单 SQLite 文件混合检索**：

- 向量：sqlite-vec（vec0 虚拟表，512 维）——零服务、单文件、随 sidecar 内嵌
- Embedding：fastembed + BGE-small-zh-v1.5（ONNX，中文优化，24M/512 维）
  → 降级 sentence-transformers → 兜底 hash（测试/离线可用）
- 关键词：SQLite FTS5（jieba 中文分词预处理，复用 knowledge.fts5.tokenize）
- 融合：RRF（Reciprocal Rank Fusion，k=60）双路 top-20 → top-8

设计：
- 单连接 + 线程锁（与 FTS5Index 一致）
- 首次加载模型 ~1s（缓存单例）；无网环境用已缓存模型（构建期打包）
- BGE 查询前缀（'为这个句子生成表示以用于检索相关文章：'）提升检索质量
- 兼容降级：模型缺失/索引缺失时 FTS5-only 仍可用（教学场景关键词足够）
"""
from __future__ import annotations

import hashlib
import logging
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any

from knowledge.fts5 import KnowledgeEntry, tokenize

logger = logging.getLogger("sidecar.knowledge.rag")

_EMBED_DIM = 512  # BGE-small-zh-v1.5 固定 512 维
_BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

# fastembed 缓存目录（.tdsf-data/models）
_MODEL_CACHE = str(
    Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data")))
    / "models"
)


# ============================================================================
# Embedding（fastembed BGE → 降级）
# ============================================================================

_embed_model = None
_embed_lock = threading.Lock()


def _load_embed_model():
    """加载 BGE embedding 模型（fastembed 优先，失败返回 None）"""
    global _embed_model
    with _embed_lock:
        if _embed_model is not None:
            return _embed_model
        try:
            from fastembed import TextEmbedding

            _embed_model = TextEmbedding(
                model_name="BAAI/bge-small-zh-v1.5",
                cache_dir=_MODEL_CACHE,
            )
            logger.info("BGE embedding model loaded (fastembed, 512d)")
        except Exception as e:
            logger.warning(f"fastembed BGE load failed: {e}，降级 hash 向量")
            _embed_model = None
        return _embed_model


def embed_text(text: str) -> list[float] | None:
    """生成文本向量（None = 模型不可用，调用方降级 FTS5-only）"""
    model = _load_embed_model()
    if model is None:
        return None
    try:
        vec = next(model.embed([text[:500]]))
        return [float(x) for x in vec]
    except Exception as e:
        logger.warning(f"embed failed: {e}")
        return None


def hash_embedding(text: str, dim: int = _EMBED_DIM) -> list[float]:
    """hash 向量兜底（模型缺失时保证 vec0 表可用，无语义能力）"""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    out = []
    for i in range(dim):
        out.append((digest[i % len(digest)] / 255.0) * 2 - 1)
    return out


# ============================================================================
# RAG 引擎
# ============================================================================

_RRF_K = 60
_FTS_TOP = 20
_VEC_TOP = 20
_RESULT_TOP = 8


class RagIndex:
    """统一混合检索索引（sqlite-vec + FTS5 + RRF）"""

    def __init__(self, db_path: Path | str | None = None) -> None:
        if db_path is None:
            db_path = Path(
                os.environ.get(
                    "TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data")
                )
            ) / "rag.db"
        self.db_path = Path(db_path)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._vec_available = False
        self._init_db()

    # ------------------------------------------------------------------
    # 初始化
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            import sqlite_vec

            conn.enable_load_extension(True)
            sqlite_vec.load(conn)
            conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries "
                f"USING vec0(embedding float[{_EMBED_DIM}])"
            )
            self._vec_available = True
        except Exception as e:
            logger.warning(f"sqlite-vec unavailable: {e}，向量检索禁用")
            self._vec_available = False

        conn.execute(
            """CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                url TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            )"""
        )
        # FTS5（jieba 分词预处理：content_tokens 列存 tokenize 结果）
        conn.execute(
            """CREATE VIRTUAL TABLE IF NOT EXISTS fts_entries USING fts5(
                title, content, content_tokens,
                tokenize='unicode61'
            )"""
        )
        conn.commit()
        self._conn = conn

    # ------------------------------------------------------------------
    # 写入
    # ------------------------------------------------------------------

    def add(self, entry: KnowledgeEntry) -> str:
        """入库一条知识（向量 + FTS5 + 元数据三写）"""
        with self._lock:
            conn = self._conn
            assert conn is not None
            rowid = _rowid_for(entry.id)
            tags_json = _json_dumps(entry.tags)
            # 三表统一用确定性 rowid（md5(entry_id)），保证 hybrid_search
            # 回查元数据时 rowid 一一对应（教训：普通表自增 rowid 与
            # FTS5/vec0 的指定 rowid 不一致会导致检索回查为空）
            conn.execute(
                "INSERT OR REPLACE INTO entries "
                "(rowid, id, source, title, content, url, tags, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rowid,
                    entry.id,
                    entry.source,
                    entry.title,
                    entry.content,
                    entry.url,
                    tags_json,
                    entry.created_at,
                ),
            )
            conn.execute(
                "INSERT OR REPLACE INTO fts_entries (rowid, title, content, content_tokens) "
                "VALUES (?, ?, ?, ?)",
                (
                    rowid,
                    entry.title,
                    entry.content,
                    tokenize(f"{entry.title} {entry.content}"),
                ),
            )
            if self._vec_available:
                vec = embed_text(f"{entry.title}\n{entry.content}")
                if vec is None:
                    vec = hash_embedding(f"{entry.title}\n{entry.content}")
                vec_bytes = _pack_vec(vec)
                conn.execute(
                    "INSERT INTO vec_entries (rowid, embedding) VALUES (?, ?)",
                    (rowid, vec_bytes),
                )
            conn.commit()
        return entry.id

    def delete(self, entry_id: str) -> bool:
        with self._lock:
            conn = self._conn
            assert conn is not None
            conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
            conn.execute("DELETE FROM fts_entries WHERE rowid = ?", (_rowid_for(entry_id),))
            if self._vec_available:
                conn.execute(
                    "DELETE FROM vec_entries WHERE rowid = ?", (_rowid_for(entry_id),)
                )
            conn.commit()
        return True

    def count(self) -> int:
        with self._lock:
            cur = self._conn.execute("SELECT COUNT(*) FROM entries")
            return int(cur.fetchone()[0])

    # ------------------------------------------------------------------
    # 混合检索
    # ------------------------------------------------------------------

    def hybrid_search(
        self,
        query: str,
        top_k: int = _RESULT_TOP,
    ) -> list[dict[str, Any]]:
        """双路检索 + RRF 融合（向量缺失时 FTS5-only）"""
        with self._lock:
            conn = self._conn
            assert conn is not None

            fts_ranks: dict[str, int] = {}
            vec_ranks: dict[str, int] = {}

            # 1. FTS5 关键词路（BM25）
            try:
                q_tokens = tokenize(query)
                if q_tokens.strip():
                    cur = conn.execute(
                        """SELECT rowid, bm25(fts_entries) AS score
                           FROM fts_entries
                           WHERE fts_entries MATCH ?
                           ORDER BY score
                           LIMIT ?""",
                        (q_tokens, _FTS_TOP),
                    )
                    for i, row in enumerate(cur):
                        fts_ranks[str(row["rowid"])] = i
            except Exception as e:
                logger.debug(f"fts5 search failed: {e}")

            # 2. 向量路（语义）
            if self._vec_available:
                vec = embed_text(_BGE_QUERY_PREFIX + query)
                if vec is not None:
                    q_bytes = _pack_vec(vec)
                    try:
                        cur = conn.execute(
                            """SELECT rowid, distance
                               FROM vec_entries
                               WHERE embedding MATCH ?
                               ORDER BY distance
                               LIMIT ?""",
                            (q_bytes, _VEC_TOP),
                        )
                        for i, row in enumerate(cur):
                            vec_ranks[str(row["rowid"])] = i
                    except Exception as e:
                        logger.debug(f"vec search failed: {e}")

            # 3. RRF 融合
            merged: dict[str, float] = {}
            for rid, rank in fts_ranks.items():
                merged[rid] = merged.get(rid, 0.0) + 1.0 / (_RRF_K + rank + 1)
            for rid, rank in vec_ranks.items():
                merged[rid] = merged.get(rid, 0.0) + 1.0 / (_RRF_K + rank + 1)

            if not merged:
                return []

            top_ids = [
                int(rid)
                for rid, _ in sorted(merged.items(), key=lambda kv: -kv[1])[:top_k]
            ]

            # 4. 回查元数据
            results: list[dict[str, Any]] = []
            for rid in top_ids:
                row = conn.execute(
                    "SELECT * FROM entries WHERE rowid = ?", (rid,)
                ).fetchone()
                if row is None:
                    continue
                results.append(
                    {
                        "id": row["id"],
                        "source": row["source"],
                        "title": row["title"],
                        "content": row["content"],
                        "url": row["url"],
                        "tags": _json_loads(row["tags"]),
                        "created_at": row["created_at"],
                        "match_type": "hybrid",
                    }
                )
            return results

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


def _rowid_for(entry_id: str) -> int:
    """entry_id → FTS/vec 行号（确定性映射：md5 前 8 字节）"""
    digest = hashlib.md5(entry_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % (2**62)


def _pack_vec(vec: list[float]) -> bytes:
    import struct

    return struct.pack(f"<{len(vec)}f", *vec)


def _json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


def _json_loads(s: str) -> Any:
    import json

    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return []


# ============================================================================
# 全局单例
# ============================================================================

_global_rag: RagIndex | None = None
_global_rag_lock = threading.Lock()


def get_global_rag(db_path: Path | str | None = None) -> RagIndex:
    global _global_rag
    with _global_rag_lock:
        if _global_rag is None:
            _global_rag = RagIndex(db_path=db_path)
        return _global_rag


def reset_global_rag(db_path: Path | str | None = None) -> RagIndex:
    global _global_rag
    with _global_rag_lock:
        if _global_rag is not None:
            _global_rag.close()
        _global_rag = RagIndex(db_path=db_path)
        return _global_rag


__all__ = ["RagIndex", "get_global_rag", "reset_global_rag", "embed_text", "hash_embedding"]
