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
    batch = embed_batch([text])
    return batch[0] if batch else None


def embed_batch(texts: list[str]) -> list[list[float]] | None:
    """批量生成向量（None = 模型不可用）。单次 ONNX 前向，662 块 <10s"""
    model = _load_embed_model()
    if model is None:
        return None
    try:
        trimmed = [t[:2000] for t in texts]
        return [[float(x) for x in vec] for vec in model.embed(trimmed)]
    except Exception as e:
        logger.warning(f"embed_batch failed: {e}")
        return None


def _cosine(a: list[float], b: list[float]) -> float:
    """余弦相似度（rerank 精排用；零向量返回 0）"""
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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
                created_at TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT '',
                content_zh TEXT
            )"""
        )
        # FTS5（jieba 分词预处理：content_tokens 列存 tokenize 结果）
        # TDSF 2026-08-30: content_zh_tokens = 中文译文分词（translate_knowledge.py
        # 离线翻译后写入）——中文 query 可直接命中译文；旧表缺列时 DROP 重建
        # （正文仍在 entries，按行回填，无需重爬）。
        fts_cols = {
            str(r[1])
            for r in conn.execute("PRAGMA table_info(fts_entries)")
        }
        if fts_cols and "content_zh_tokens" not in fts_cols:
            logger.info("fts_entries 旧表缺 content_zh_tokens，重建 FTS（正文回填）")
            old_rows = conn.execute(
                "SELECT rowid, title, content, content_tokens FROM fts_entries"
            ).fetchall()
            conn.execute("DROP TABLE fts_entries")
            self._create_fts(conn)
            for r in old_rows:
                conn.execute(
                    "INSERT INTO fts_entries (rowid, title, content, "
                    "content_tokens, content_zh_tokens) VALUES (?, ?, ?, ?, ?)",
                    (r["rowid"], r["title"], r["content"], r["content_tokens"], ""),
                )
        else:
            self._create_fts(conn)
        # 嵌入缓存（content hash → 向量）：启动幂等索引先删后加时，同内容
        # 直接命中缓存免重算——662 块全量真嵌入一次仅数秒，重启重建零推理
        conn.execute(
            """CREATE TABLE IF NOT EXISTS embed_cache (
                content_hash TEXT PRIMARY KEY,
                embedding BLOB NOT NULL
            )"""
        )
        # 旧库迁移：已有 entries 表缺 category/content_zh 列时补列
        # （TDSF 2026-08-30 知识库 6+1 分类 + LLM 全量中文翻译；幂等探测）
        entry_cols = {
            str(r[1]) for r in conn.execute("PRAGMA table_info(entries)")
        }
        if "category" not in entry_cols:
            conn.execute(
                "ALTER TABLE entries ADD COLUMN category TEXT NOT NULL DEFAULT ''"
            )
        if "content_zh" not in entry_cols:
            conn.execute("ALTER TABLE entries ADD COLUMN content_zh TEXT")
        # 中文标题映射（url → zh + summary_zh）：官方文档英文标题的中文预览
        # 名与 120 字中文内容摘要，由 scripts/gen_titles_zh.py 离线 LLM 批量
        # 生成（TDSF 2026-08-30；summary_zh 为 C2 新增列，前端知识详情弹窗
        # 顶部显示中文摘要条）。派生数据、非检索内容——rag.rebuild() 不清
        # 此表（重爬后 url 不变仍可复用，新 url 缺映射时前端回退英文原标题）。
        conn.execute(
            """CREATE TABLE IF NOT EXISTS doc_titles_zh (
                url TEXT PRIMARY KEY,
                zh TEXT NOT NULL,
                summary_zh TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )"""
        )
        # 旧库迁移：已有表无 summary_zh 列时补列（幂等探测）
        zh_cols = {
            str(r[1]) for r in conn.execute("PRAGMA table_info(doc_titles_zh)")
        }
        if "summary_zh" not in zh_cols:
            conn.execute(
                "ALTER TABLE doc_titles_zh ADD COLUMN summary_zh "
                "TEXT NOT NULL DEFAULT ''"
            )
        conn.commit()
        self._conn = conn

    @staticmethod
    def _create_fts(conn: sqlite3.Connection) -> None:
        """创建 FTS5 虚拟表（content_zh_tokens 进索引：中文 query 命中译文）"""
        conn.execute(
            """CREATE VIRTUAL TABLE IF NOT EXISTS fts_entries USING fts5(
                title, content, content_tokens, content_zh_tokens,
                tokenize='unicode61'
            )"""
        )

    # ------------------------------------------------------------------
    # 写入
    # ------------------------------------------------------------------

    def add(
        self,
        entry: KnowledgeEntry,
        dedupe: bool = True,
        min_chars: int = 0,
    ) -> str:
        """入库一条知识（向量 + FTS5 + 元数据三写）

        Args:
            entry: 知识条目
            dedupe: 同 content 去重（排除自身——同 id 幂等覆盖合法）。
                    跳过时返回 ""（调用方不计数）。爬取/导入批量语料
                    建议开启；单条 case 沉淀默认开也无害（同 id 覆盖不受影响）。
            min_chars: 超短块过滤阈值，0 = 不过滤（默认）。批量爬取/导入
                       建议传 30（过滤解析残渣）；单条 case/测试传 0。

        Returns:
            入库成功返回 entry.id；被治理规则跳过返回 ""
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            # 内容治理 1：超短块过滤（仅批量语料显式启用，默认关）
            if min_chars and len(entry.content.strip()) < min_chars:
                logger.debug(f"add skipped (too short): {entry.title[:40]}")
                return ""
            # 内容治理 2：同 content 去重（排除自身——同 id 幂等覆盖合法）
            if dedupe:
                dup = conn.execute(
                    "SELECT id FROM entries WHERE content = ? AND id != ? LIMIT 1",
                    (entry.content, entry.id),
                ).fetchone()
                if dup is not None:
                    logger.debug(
                        f"add skipped (duplicate of {dup['id']}): {entry.title[:40]}"
                    )
                    return ""
            rowid = _rowid_for(entry.id)
            tags_json = _json_dumps(entry.tags)
            # 三表统一用确定性 rowid（md5(entry_id)），保证 hybrid_search
            # 回查元数据时 rowid 一一对应（教训：普通表自增 rowid 与
            # FTS5/vec0 的指定 rowid 不一致会导致检索回查为空）
            conn.execute(
                "INSERT OR REPLACE INTO entries "
                "(rowid, id, source, title, content, url, tags, created_at, "
                "category, content_zh) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    rowid,
                    entry.id,
                    entry.source,
                    entry.title,
                    entry.content,
                    entry.url,
                    tags_json,
                    entry.created_at,
                    entry.category,
                    entry.content_zh,
                ),
            )
            conn.execute(
                "INSERT OR REPLACE INTO fts_entries "
                "(rowid, title, content, content_tokens, content_zh_tokens) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    rowid,
                    entry.title,
                    entry.content,
                    tokenize(f"{entry.title} {entry.content}"),
                    # 译文进 FTS：中文 query 直接命中译文（空译文=空 token）
                    tokenize(entry.content_zh) if entry.content_zh else "",
                ),
            )
            if self._vec_available:
                # 嵌入缓存：同 content hash 直接复用向量（启动幂等重建零推理）
                chash = _content_hash(f"{entry.title}\n{entry.content}")
                cached = conn.execute(
                    "SELECT embedding FROM embed_cache WHERE content_hash = ?",
                    (chash,),
                ).fetchone()
                if cached is not None:
                    vec_bytes = cached["embedding"]
                else:
                    vec = embed_text(f"{entry.title}\n{entry.content}")
                    if vec is None:
                        vec = hash_embedding(f"{entry.title}\n{entry.content}")
                    vec_bytes = _pack_vec(vec)
                    conn.execute(
                        "INSERT OR REPLACE INTO embed_cache (content_hash, embedding) "
                        "VALUES (?, ?)",
                        (chash, vec_bytes),
                    )
                # vec0 虚拟表不支持 INSERT OR REPLACE（无 conflict 语义），
                # 幂等覆盖须 DELETE + INSERT（同 rowid 双写/重建安全）
                conn.execute(
                    "DELETE FROM vec_entries WHERE rowid = ?", (rowid,)
                )
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

    def count_official_sources(self) -> int:
        """官方文档源条目数（*-docs 后缀 + archwiki）

        启动自动初始化用：为 0 视为全新安装 → 触发后台全量爬取。
        """
        with self._lock:
            cur = self._conn.execute(
                "SELECT COUNT(*) FROM entries "
                "WHERE source LIKE '%-docs' OR source = 'archwiki'"
            )
            return int(cur.fetchone()[0])

    def rebuild(self) -> int:
        """全量清空索引（entries/fts_entries/vec_entries/embed_cache 四表）

        ⚠️ 必须与 add/list/search/get 使用同一 rag.db——历史实现清的是旧
        FTS5Index（knowledge.db）+ ChromaDB，与读路径（rag.db）割裂，导致
        rebuild 后前端列表毫无变化（2026-08-18 修复）。

        ⚠️ embed_cache 一并清空（2026-08-30 修复）：它是"content hash → 向量"
        的派生缓存。若保留，模型状态从"缺失(hash 兜底)"升级为"BGE 可用"后，
        重爬相同内容会命中旧 hash 向量缓存，向量质量永久无法升级（实测：迁移
        BGE 模型前爬的 apache-docs 50 条在重爬后仍是 hash 向量，语义检索失效）。
        全量重建本就应重算向量，清缓存代价仅是一次批量嵌入（784 块 <10s）。
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            conn.execute("DELETE FROM entries")
            conn.execute("DELETE FROM fts_entries")
            if self._vec_available:
                conn.execute("DELETE FROM vec_entries")
            conn.execute("DELETE FROM embed_cache")
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
            q_vec: list[float] | None = None
            if self._vec_available:
                prefix = _BGE_QUERY_PREFIX if _contains_chinese(query) else _BGE_QUERY_PREFIX_EN
                q_vec = embed_text(prefix + query)
                if q_vec is not None:
                    q_bytes = _pack_vec(q_vec)
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
                        "category": str(row["category"] or ""),
                        "content_zh": row["content_zh"],
                        "match_type": hit,
                        "rrf_score": round(m["score"], 4),
                    }
                )

            # 5. rerank 精排（向量语义可用时）：RRF 是排名融合，不知道候选与
            #    query 的真实相关度——用 BGE 对 top_k 候选批量算 query-doc 余弦
            #    相似度重排（bi-encoder 精排，毫秒级；真 cross-encoder 列为后续
            #    可选）。hash 降级模式下无语义，跳过。
            if q_vec is not None and results:
                try:
                    batch = embed_batch([r["content"] for r in results])
                    if batch is not None and len(batch) == len(results):
                        sims = [_cosine(q_vec, dv) for dv in batch]
                        for r, sim in zip(results, sims):
                            r["similarity"] = round(sim, 4)
                        results.sort(key=lambda r: -r["similarity"])
                        for r in results:
                            r["reranked"] = True
                except Exception as e:
                    logger.debug(f"rerank skipped: {e}")
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
                    "category": str(r["category"] or ""),
                    "content_zh": r["content_zh"],
                    "match_type": "list",
                }
                for r in rows
            ]

    def list_files(
        self,
        source: str | None = None,
        group: str | None = None,
    ) -> list[dict[str, Any]]:
        """按 url 聚合列出文档文件（文件级浏览视图）

        同一文件（同 url）的全部分片段落聚合为一条，便于"同文件的分片
        放一起"浏览；url 为空的条目（corpus 卡片/会话沉淀等）跳过。

        Args:
            source: 可选，按来源过滤（如 "builtin-docs"）；None = 全部
            group: 可选，按 category 过滤（如 "linux-philosophy"，前端
                   6+1 分组浏览用）；None = 全部

        Returns:
            [{url, filename, title0, chunks, total_chars, source, category}, ...]
            title0 为该文件第一个块的标题（按块序号排序）
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            sql = (
                "SELECT id, source, title, content, url, rowid, category "
                "FROM entries WHERE url != ''"
            )
            params: list[Any] = []
            if source:
                sql += " AND source = ?"
                params.append(source)
            if group:
                sql += " AND category = ?"
                params.append(group)
            sql += " ORDER BY url, rowid"
            rows = conn.execute(sql, params).fetchall()

        grouped: dict[str, list[sqlite3.Row]] = {}
        for r in rows:
            grouped.setdefault(str(r["url"]), []).append(r)

        files: list[dict[str, Any]] = []
        for url, group_rows in grouped.items():
            ordered = sorted(
                group_rows,
                key=lambda r: (_chunk_seq(str(r["id"])), int(r["rowid"])),
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
                    "category": str(first["category"] or ""),
                }
            )
        files.sort(key=lambda f: (str(f["source"]), str(f["filename"])))
        return files

    def get_doc(self, url: str) -> dict[str, Any] | None:
        """按 url 取完整文档（全部块按序号排序，content 以空行拼接）

        Args:
            url: 文档 url（与入库时的条目 url 完全一致）

        Returns:
            {url, filename, source, title, content, chunks, total_chars,
             title_zh, summary_zh}（title_zh/summary_zh 来自 doc_titles_zh，
             无映射为空串）；url 不存在返回 None
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            rows = conn.execute(
                "SELECT id, source, title, content, url, rowid, category, "
                "content_zh FROM entries WHERE url = ?",
                (url,),
            ).fetchall()
            zh_row = conn.execute(
                "SELECT zh, summary_zh FROM doc_titles_zh WHERE url = ?",
                (url,),
            ).fetchone()
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
            "category": str(first["category"] or ""),
            "content_zh": "\n\n".join(
                str(r["content_zh"]) for r in ordered if r["content_zh"]
            ),
            "title_zh": str(zh_row["zh"]) if zh_row and zh_row["zh"] else "",
            "summary_zh": (
                str(zh_row["summary_zh"]) if zh_row and zh_row["summary_zh"] else ""
            ),
        }

    def titles_zh(self, source: str | None = None) -> list[dict[str, Any]]:
        """读取中文标题映射（doc_titles_zh 表，前端知识浏览器预览用）

        Args:
            source: 可选，按来源过滤（与 entries.source 精确匹配）；
                    None/空 = 全部

        Returns:
            [{url, zh, summary_zh}, ...]（按 url 排序，稳定输出）
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            sql = "SELECT url, zh, summary_zh FROM doc_titles_zh"
            params: list[Any] = []
            if source:
                sql += " WHERE url IN (SELECT url FROM entries WHERE source = ?)"
                params.append(source)
            sql += " ORDER BY url"
            rows = conn.execute(sql, params).fetchall()
        return [
            {
                "url": str(r["url"]),
                "zh": str(r["zh"]),
                "summary_zh": str(r["summary_zh"] or ""),
            }
            for r in rows
        ]

    def upsert_titles_zh(
        self,
        mapping: dict[str, str],
        summaries: dict[str, str] | None = None,
    ) -> int:
        """批量写入/更新中文标题映射（gen_titles_zh.py 运维脚本用）

        Args:
            mapping: {url: 中文标题}；空 url 或空标题条目跳过
            summaries: 可选，{url: 120 字中文摘要}（C2，gen_titles_zh.py
                       生成；url 不在 mapping 中的条目忽略）

        Returns:
            实际写入条数
        """
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        summaries = summaries or {}
        n = 0
        with self._lock:
            conn = self._conn
            assert conn is not None
            for url, zh in mapping.items():
                url = str(url).strip()
                zh = str(zh).strip()
                if not url or not zh:
                    continue
                summary = str(summaries.get(url, "")).strip()
                conn.execute(
                    "INSERT INTO doc_titles_zh (url, zh, summary_zh, created_at) "
                    "VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(url) DO UPDATE SET zh = excluded.zh, "
                    "summary_zh = excluded.summary_zh, "
                    "created_at = excluded.created_at",
                    (url, zh, summary, now),
                )
                n += 1
            conn.commit()
        return n

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
            "category": str(row["category"] or ""),
            "content_zh": row["content_zh"],
            "score": 1.0,
            "match_type": "list",
        }

    def update_content_zh(self, entry_id: str, content_zh: str) -> bool:
        """写入单条中文译文（translate_knowledge.py 用）

        同步更新 entries.content_zh（RAG 检索双语正文）与
        fts_entries.content_zh_tokens（jieba 分词后进 FTS——中文 query
        直接命中译文）。entry_id 不存在返回 False。

        Returns:
            是否写入成功
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            cur = conn.execute(
                "UPDATE entries SET content_zh = ? WHERE id = ?",
                (content_zh, entry_id),
            )
            if cur.rowcount == 0:
                return False
            conn.execute(
                "UPDATE fts_entries SET content_zh_tokens = ? WHERE rowid = ?",
                (tokenize(content_zh), _rowid_for(entry_id)),
            )
            conn.commit()
        return True

    def official_entries(self) -> list[dict[str, Any]]:
        """官方文档源全部条目（*-docs 后缀 + archwiki；翻译/导出脚本用）

        Returns:
            [{id, source, title, content, url, category, content_zh}, ...]
            （按 source、id 排序，稳定输出）
        """
        with self._lock:
            conn = self._conn
            assert conn is not None
            rows = conn.execute(
                "SELECT id, source, title, content, url, category, content_zh "
                "FROM entries "
                "WHERE source LIKE '%-docs' OR source = 'archwiki' "
                "ORDER BY source, id"
            ).fetchall()
        return [
            {
                "id": str(r["id"]),
                "source": str(r["source"]),
                "title": str(r["title"]),
                "content": str(r["content"]),
                "url": str(r["url"]),
                "category": str(r["category"] or ""),
                "content_zh": r["content_zh"],
            }
            for r in rows
        ]

    def stats_by_category(self) -> list[dict[str, Any]]:
        """按 category 统计（块数/总字符数，重建脚本与前端统计用）"""
        with self._lock:
            conn = self._conn
            assert conn is not None
            rows = conn.execute(
                """SELECT category,
                          COUNT(*) AS chunks,
                          COUNT(DISTINCT CASE WHEN url != '' THEN url END) AS files,
                          SUM(LENGTH(content)) AS total_chars
                   FROM entries
                   GROUP BY category
                   ORDER BY category"""
            ).fetchall()
        return [
            {
                "category": str(r["category"] or ""),
                "files": int(r["files"]),
                "chunks": int(r["chunks"]),
                "total_chars": int(r["total_chars"] or 0),
            }
            for r in rows
        ]

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


# ============================================================================
# 精简库单例（双库方案 TDSF 2026-08-31：rag_slim.db 独立于全量 rag.db，
# LLM 每章提炼核心知识点（distill_knowledge.py 生成），检索同引擎）
# ============================================================================

_global_slim_rag: RagIndex | None = None


def _slim_db_path() -> Path:
    data_dir = Path(
        os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data"))
    )
    return data_dir / "rag_slim.db"


def get_slim_rag(db_path: Path | str | None = None) -> RagIndex:
    """精简知识库单例（默认 <TDSF_DATA_DIR>/rag_slim.db）

    与 get_global_rag（rag.db）同 schema 同引擎（sqlite-vec + FTS5 + RRF），
    仅 db 文件不同。db_path 参数对齐 get_global_rag（测试隔离用）。
    """
    global _global_slim_rag
    with _global_rag_lock:
        if _global_slim_rag is None:
            _global_slim_rag = RagIndex(db_path=db_path or _slim_db_path())
        return _global_slim_rag


def reset_slim_rag(db_path: Path | str | None = None) -> RagIndex:
    """重建精简库单例（测试/运维脚本用：换 db 后强制重开连接）"""
    global _global_slim_rag
    with _global_rag_lock:
        if _global_slim_rag is not None:
            _global_slim_rag.close()
        _global_slim_rag = RagIndex(db_path=db_path or _slim_db_path())
        return _global_slim_rag


__all__ = [
    "RagIndex",
    "get_global_rag",
    "reset_global_rag",
    "get_slim_rag",
    "reset_slim_rag",
    "embed_text",
    "hash_embedding",
]
