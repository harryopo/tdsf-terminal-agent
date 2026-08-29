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
from urllib.parse import urlparse

from knowledge.fts5 import KnowledgeEntry, tokenize

logger = logging.getLogger("sidecar.knowledge.rag")

_EMBED_DIM = 512  # BGE-small-zh-v1.5 固定 512 维
_BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
# 英文查询前缀（BGE 硬性要求：查询与文档用不同前缀，中英自动切换）
_BGE_QUERY_PREFIX_EN = "Represent this sentence for searching relevant passages: "

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


def _model_cached() -> bool:
    """BGE 模型是否已缓存（离线可用）

    检查 fastembed 缓存目录下是否存在模型文件。不存在时跳过加载
    ——否则每次加载尝试连接 HF 会阻塞 30s（启动/测试卡顿根源）。
    """
    try:
        model_dir = Path(_MODEL_CACHE) / "models--Qdrant--bge-small-zh-v1.5"
        if not model_dir.exists():
            return False
        # 实际 ONNX 文件存在才算缓存完整
        for p in model_dir.rglob("model_optimized.onnx"):
            if p.is_file() and p.stat().st_size > 1_000_000:
                return True
        return False
    except OSError:
        return False


def _load_embed_model():
    """加载 BGE embedding 模型（fastembed 优先，失败返回 None）

    离线优先：模型未缓存时直接返回 None（hash 兜底），不尝试联网下载
    ——否则每次加载 30s 网络超时。模型可通过 HF_ENDPOINT 镜像预下载到
    _MODEL_CACHE（见 docs/ROADMAP P2-4 说明）。
    """
    global _embed_model
    with _embed_lock:
        if _embed_model is not None:
            return _embed_model
        if not _model_cached():
            logger.info(
                "BGE 模型未缓存（离线降级 hash 向量）——"
                f"预下载到 {_MODEL_CACHE} 后启用语义检索"
            )
            _embed_model = None
            return None
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

    def delete_by_url(self, url: str, id_prefix: str | None = None) -> int:
        """按 url 删除全部条目（可选限定 id 前缀），返回删除条数

        用于文档重新分块入库前的旧块清理：同一 url 的旧分块尾部 id 序号
        可能超出新分块数（旧 ~400 字策略的残留块），仅 INSERT OR REPLACE
        覆盖不到，必须先显式删除再入新块。

        Args:
            url: 条目 url（本地文件路径或网页 URL）
            id_prefix: 可选，仅删除 id 以该前缀开头的条目（如 "doc-"），
                       避免误删同 url 下其他来源的条目

        Returns:
            删除的条目数
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            sql = "SELECT id FROM entries WHERE url = ?"
            params: list[Any] = [url]
            if id_prefix:
                sql += " AND id LIKE ?"
                params.append(f"{id_prefix}%")
            ids = [str(r["id"]) for r in conn.execute(sql, params).fetchall()]
            for eid in ids:
                rid = _rowid_for(eid)
                conn.execute("DELETE FROM entries WHERE id = ?", (eid,))
                conn.execute("DELETE FROM fts_entries WHERE rowid = ?", (rid,))
                if self._vec_available:
                    conn.execute(
                        "DELETE FROM vec_entries WHERE rowid = ?", (rid,)
                    )
            conn.commit()
        if ids:
            logger.debug(f"delete_by_url: removed {len(ids)} entries for {url[:60]}")
        return len(ids)

    def count(self) -> int:
        with self._lock:
            cur = self._conn.execute("SELECT COUNT(*) FROM entries")
            return int(cur.fetchone()[0])

    def rebuild(self) -> int:
        """全量清空索引（entries/fts_entries/vec_entries 三表，与 add 同源）

        ⚠️ 必须与 add/list/search/get 使用同一 rag.db——历史实现清的是旧
        FTS5Index（knowledge.db）+ ChromaDB，与读路径（rag.db）割裂，导致
        rebuild 后前端列表毫无变化（2026-08-18 修复）。
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            conn.execute("DELETE FROM entries")
            conn.execute("DELETE FROM fts_entries")
            if self._vec_available:
                conn.execute("DELETE FROM vec_entries")
            conn.commit()
        return self.count()

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
                        (_escape_fts_query(q_tokens), _FTS_TOP),
                    )
                    for i, row in enumerate(cur):
                        fts_ranks[str(row["rowid"])] = i
            except Exception as e:
                logger.debug(f"fts5 search failed: {e}")

            # 2. 向量路（语义）——BGE 查询前缀按中英文自动切换
            if self._vec_available:
                prefix = _BGE_QUERY_PREFIX if _contains_chinese(query) else _BGE_QUERY_PREFIX_EN
                vec = embed_text(prefix + query)
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

            # 3. RRF 融合（带来源标记：fts/vec/both）
            merged: dict[str, dict[str, float]] = {}
            for rid, rank in fts_ranks.items():
                merged.setdefault(rid, {"score": 0.0, "fts": 0.0, "vec": 0.0})[
                    "score"
                ] += 1.0 / (_RRF_K + rank + 1)
                merged[rid]["fts"] += 1.0 / (_RRF_K + rank + 1)
            for rid, rank in vec_ranks.items():
                merged.setdefault(rid, {"score": 0.0, "fts": 0.0, "vec": 0.0})[
                    "score"
                ] += 1.0 / (_RRF_K + rank + 1)
                merged[rid]["vec"] += 1.0 / (_RRF_K + rank + 1)

            if not merged:
                return []

            top_ids = [
                int(rid)
                for rid, _ in sorted(
                    merged.items(), key=lambda kv: -kv[1]["score"]
                )[:top_k]
            ]

            # 4. 回查元数据
            results: list[dict[str, Any]] = []
            for rid in top_ids:
                row = conn.execute(
                    "SELECT * FROM entries WHERE rowid = ?", (rid,)
                ).fetchone()
                if row is None:
                    continue
                m = merged[str(rid)]
                hit = "both" if m["fts"] > 0 and m["vec"] > 0 else ("fts" if m["fts"] > 0 else "vec")
                results.append(
                    {
                        "id": row["id"],
                        "source": row["source"],
                        "title": row["title"],
                        "content": row["content"],
                        "url": row["url"],
                        "tags": _json_loads(row["tags"]),
                        "created_at": row["created_at"],
                        "match_type": hit,
                        "rrf_score": round(m["score"], 4),
                    }
                )
            return results

    def list_entries(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        """列出条目（按入库时间倒序，浏览模式用）"""
        with self._lock:
            conn = self._conn
            assert conn is not None
            rows = conn.execute(
                "SELECT * FROM entries ORDER BY rowid DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return [
                {
                    "id": r["id"],
                    "source": r["source"],
                    "title": r["title"],
                    "content": r["content"],
                    "url": r["url"],
                    "tags": _json_loads(r["tags"]),
                    "created_at": r["created_at"],
                    "match_type": "list",
                }
                for r in rows
            ]

    def list_files(self, source: str | None = None) -> list[dict[str, Any]]:
        """按 url 聚合列出文档文件（文件级浏览视图）

        同一文件（同 url）的全部分片段落聚合为一条，便于"同文件的分片
        放一起"浏览；url 为空的条目（corpus 卡片/会话沉淀等）跳过。

        Args:
            source: 可选，按来源过滤（如 "builtin-docs"）；None = 全部

        Returns:
            [{url, filename, title0, chunks, total_chars, source}, ...]
            title0 为该文件第一个块的标题（按块序号排序）
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            sql = (
                "SELECT id, source, title, content, url, rowid "
                "FROM entries WHERE url != ''"
            )
            params: list[Any] = []
            if source:
                sql += " AND source = ?"
                params.append(source)
            sql += " ORDER BY url, rowid"
            rows = conn.execute(sql, params).fetchall()

        grouped: dict[str, list[sqlite3.Row]] = {}
        for r in rows:
            grouped.setdefault(str(r["url"]), []).append(r)

        files: list[dict[str, Any]] = []
        for url, group in grouped.items():
            ordered = sorted(
                group, key=lambda r: (_chunk_seq(str(r["id"])), int(r["rowid"]))
            )
            first = ordered[0]
            files.append(
                {
                    "url": url,
                    "filename": _filename_from_url(url),
                    "title0": str(first["title"]),
                    "chunks": len(ordered),
                    "total_chars": sum(len(str(r["content"])) for r in ordered),
                    "source": str(first["source"]),
                }
            )
        files.sort(key=lambda f: (str(f["source"]), str(f["filename"])))
        return files

    def get_doc(self, url: str) -> dict[str, Any] | None:
        """按 url 取完整文档（全部块按序号排序，content 以空行拼接）

        Args:
            url: 文档 url（与入库时的条目 url 完全一致）

        Returns:
            {url, filename, source, title, content, chunks, total_chars}；
            url 不存在返回 None
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            rows = conn.execute(
                "SELECT id, source, title, content, url, rowid "
                "FROM entries WHERE url = ?",
                (url,),
            ).fetchall()
        if not rows:
            return None
        ordered = sorted(
            rows, key=lambda r: (_chunk_seq(str(r["id"])), int(r["rowid"]))
        )
        first = ordered[0]
        return {
            "url": url,
            "filename": _filename_from_url(url),
            "source": str(first["source"]),
            "title": str(first["title"]),
            "content": "\n\n".join(str(r["content"]) for r in ordered),
            "chunks": len(ordered),
            "total_chars": sum(len(str(r["content"])) for r in ordered),
        }

    def stats_by_source(self) -> list[dict[str, Any]]:
        """按 source 统计（文件数/块数/总字符数，重建脚本与前端统计用）"""
        with self._lock:
            conn = self._conn
            assert conn is not None
            rows = conn.execute(
                """SELECT source,
                          COUNT(*) AS chunks,
                          COUNT(DISTINCT CASE WHEN url != '' THEN url END) AS files,
                          SUM(LENGTH(content)) AS total_chars
                   FROM entries
                   GROUP BY source
                   ORDER BY source"""
            ).fetchall()
        return [
            {
                "source": str(r["source"]),
                "files": int(r["files"]),
                "chunks": int(r["chunks"]),
                "total_chars": int(r["total_chars"] or 0),
            }
            for r in rows
        ]

    def get(self, entry_id: str) -> dict[str, Any] | None:
        """按 ID 取单条（详情弹窗用，与 list_entries 同源——必须与 list/search
        使用同一个 rag.db，否则列表与详情割裂（旧 FTS5Index 的 knowledge.db
        与此库不互通，曾导致列表有数据而详情永远为空））"""
        with self._lock:
            conn = self._conn
            assert conn is not None
            row = conn.execute(
                "SELECT * FROM entries WHERE id = ?", (entry_id,)
            ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "source": row["source"],
            "title": row["title"],
            "content": row["content"],
            "url": row["url"],
            "tags": _json_loads(row["tags"]),
            "created_at": row["created_at"],
            "score": 1.0,
            "match_type": "list",
        }

    def close(self) -> None:
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None


def _rowid_for(entry_id: str) -> int:
    """entry_id → FTS/vec 行号（确定性映射：md5 前 8 字节）"""
    digest = hashlib.md5(entry_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % (2**62)


def _chunk_seq(entry_id: str) -> int:
    """从条目 id 尾部提取块序号（"doc-<hash>-3" → 3；无尾部数字 → 0）

    分块 id 统一为 <前缀>-<hash>-<序号> 格式；corpus 卡片/案例等无序号
    条目恒为 0。用于 get_doc/list_files 的块排序（不能直接按 id 字符串排
    ——字符串序 "10" < "2" 会乱序）。
    """
    tail = entry_id.rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def _filename_from_url(url: str) -> str:
    """从 url 提取文件名（本地路径与 http URL 通用）"""
    if "://" in url:
        path = urlparse(url).path
    else:
        path = url.replace("\\", "/")
    name = path.rstrip("/").rsplit("/", 1)[-1]
    return name or url


def _pack_vec(vec: list[float]) -> bytes:
    import struct

    return struct.pack(f"<{len(vec)}f", *vec)


def _contains_chinese(text: str) -> bool:
    """检测是否含中文字符（BGE 查询前缀中英切换）"""
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def _escape_fts_query(tokens: str) -> str:
    """FTS5 查询转义（继承旧版 hybrid-search 的经验）

    按空白分词后，每个词用双引号包裹（短语化），过滤纯标点——
    防止 FTS5 语法（OR/NOT/AND/引号）注入误解析。
    """
    parts = []
    for tok in tokens.split():
        # 过滤纯标点/空词
        if not any(ch.isalnum() or "\u4e00" <= ch <= "\u9fff" for ch in tok):
            continue
        parts.append(f'"{tok}"')
    return " ".join(parts)


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
