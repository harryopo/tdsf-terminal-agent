"""
tools/ground.py — 知识接地 MCP tool（T-P1-07.3）
===================================================

实现方案书 4.3 节的知识接地（Grounding for Knowledge）：
- ChromaDB 向量检索（语义匹配）
- SQLite FTS5 关键词检索（精确匹配）
- 双路融合（向量 + 关键词）+ 去重 + 排序

spec 要求：
- 输入：query 字符串 + 检索参数
- 输出：``{"results": [...], "sources": [...]}``

实现要点：
1. **ChromaDB 不可用降级**：当 chromadb 包未安装或 embedding 模型不可用时，
   自动降级为纯 FTS5 关键词检索，保证可用性。
2. **FTS5 全文索引**：使用 SQLite FTS5 虚拟表，对知识库文档建立全文索引。
3. **双路检索融合**：向量检索 + 关键词检索结果合并去重，按 BM25 + 余弦相似度加权排序。
4. **来源标注**：每条检索结果标注来源类型（vector / keyword / both）。

输入格式（params）：
    {
        "query": "nginx 启动失败如何排查",
        "top_k": 5,                    # 可选，默认 5
        "method": "hybrid",            # 可选: "vector" / "keyword" / "hybrid"
        "collection": "tdsf_kb",       # 可选，默认 tdsf_kb
        "min_score": 0.3,              # 可选，最低相似度阈值
        "filter_metadata": {"type": "tutorial"}  # 可选，元数据过滤
    }

输出格式：
    {
        "results": [
            {
                "id": "doc-001",
                "content": "nginx 启动失败排查步骤：1. 检查配置文件...",
                "score": 0.85,
                "source_type": "both",  # "vector" / "keyword" / "both"
                "metadata": {
                    "title": "nginx 故障排查指南",
                    "type": "tutorial",
                    "source_file": "knowledge/courses/nginx.md"
                }
            }
        ],
        "sources": [
            {
                "type": "vector",
                "count": 5,
                "available": true
            },
            {
                "type": "keyword",
                "count": 3,
                "available": true
            }
        ],
        "total": 5,
        "query": "nginx 启动失败如何排查",
        "method": "hybrid"
    }

集成点：
- 被 graph/nodes.py 的 tool_call_node 调用（tool_name == "ground"）
- 被 Teach Agent 调用做 Linux 运维知识库检索
- 被 DecisionEngine 调用做历史案例检索
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger("sidecar.tools.ground")


# ============================================================================
# 常量定义
# ============================================================================

# 检索方法
_METHOD_VECTOR: str = "vector"
_METHOD_KEYWORD: str = "keyword"
_METHOD_HYBRID: str = "hybrid"
_SUPPORTED_METHODS: tuple[str, ...] = (_METHOD_VECTOR, _METHOD_KEYWORD, _METHOD_HYBRID)
_DEFAULT_METHOD: str = _METHOD_HYBRID

# 默认参数
_DEFAULT_TOP_K: int = 5
_DEFAULT_MIN_SCORE: float = 0.0
_DEFAULT_COLLECTION: str = "tdsf_kb"

# 默认数据目录（优先使用 TDSF_DATA_DIR 环境变量，避免 Tauri dev watcher 循环重启）
_DATA_DIR: Path = Path(os.environ.get("TDSF_DATA_DIR", str(Path(__file__).parent.parent / "data")))
_KB_DB_PATH: Path = _DATA_DIR / "kb.db"
_CHROMA_PATH: Path = _DATA_DIR / "chroma"

# FTS5 索引表 DDL（content + metadata + source_file）
_FTS5_DDL: str = """
CREATE VIRTUAL TABLE IF NOT EXISTS kb_documents USING fts5(
    doc_id UNINDEXED,
    content,
    title UNINDEXED,
    source_file UNINDEXED,
    metadata UNINDEXED,
    tokenize = 'unicode61'
);
"""


# ============================================================================
# 异常类型
# ============================================================================


class GroundToolError(Exception):
    """ground tool 基础异常"""


# ============================================================================
# 模块级单例
# ============================================================================

_kb_db: sqlite3.Connection | None = None
_kb_db_lock = threading.Lock()

_chroma_client: Any = None  # type: ignore[assignment]
_chroma_collection: Any = None  # type: ignore[assignment]
_chroma_lock = threading.Lock()
_chroma_unavailable_reason: str | None = None  # 不可用原因（用于诊断）


# ============================================================================
# FTS5 知识库初始化
# ============================================================================


def _get_kb_db(db_path: Path | None = None) -> sqlite3.Connection:
    """获取 SQLite KB 数据库连接（懒加载，线程安全）

    Args:
        db_path: 数据库路径（None 时使用默认路径）

    Returns:
        sqlite3.Connection（FTS5 索引已就绪）
    """
    global _kb_db

    if _kb_db is not None:
        return _kb_db

    with _kb_db_lock:
        # 双重检查
        if _kb_db is not None:
            return _kb_db

        path = db_path or _KB_DB_PATH
        path.parent.mkdir(parents=True, exist_ok=True)

        # SQLite 连接：允许多线程访问（FTS5 读取为主）
        conn = sqlite3.connect(
            str(path),
            check_same_thread=False,
            isolation_level=None,  # autocommit 模式
        )
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute(_FTS5_DDL)
        _kb_db = conn
        logger.info(f"KB SQLite FTS5 ready at {path}")

    return _kb_db


def reset_kb_db() -> None:
    """重置 KB 数据库连接 + 清空数据文件（用于测试隔离）

    行为：
    1. 关闭内存中的 sqlite3.Connection
    2. 删除持久化的 kb.db 文件（下次 _get_kb_db 会重建空表）

    注：本函数为测试专用，生产环境不应调用。
    """
    global _kb_db
    with _kb_db_lock:
        if _kb_db is not None:
            _kb_db.close()
            _kb_db = None
        # 删除持久化文件，确保下次 _get_kb_db 创建全新的空 FTS5 表
        try:
            if _KB_DB_PATH.exists():
                _KB_DB_PATH.unlink()
                # 同时清理 SQLite WAL/SHM 临时文件
                for suffix in ("-wal", "-shm"):
                    wal = _KB_DB_PATH.with_suffix(_KB_DB_PATH.suffix + suffix)
                    if wal.exists():
                        wal.unlink()
        except OSError as e:
            logger.warning(f"reset_kb_db: failed to remove kb.db: {e}")
    logger.info("reset_kb_db: closed KB SQLite connection and removed data file")


# ============================================================================
# ChromaDB 向量检索初始化
# ============================================================================


def _init_chroma(collection_name: str = _DEFAULT_COLLECTION) -> tuple[Any, str | None]:
    """初始化 ChromaDB 客户端和 collection

    Returns:
        (collection, unavailable_reason) 元组
        - collection: ChromaDB collection 对象（不可用时为 None）
        - unavailable_reason: 不可用原因（可用时为 None）
    """
    global _chroma_client, _chroma_collection, _chroma_unavailable_reason

    if _chroma_collection is not None:
        return _chroma_collection, None

    with _chroma_lock:
        if _chroma_collection is not None:
            return _chroma_collection, None

        try:
            # 延迟导入，避免 chromadb 未安装时整模块崩溃
            import chromadb
            from chromadb.config import Settings

            _CHROMA_PATH.mkdir(parents=True, exist_ok=True)

            # 使用 PersistentClient（本地持久化，无需服务器）
            _chroma_client = chromadb.PersistentClient(
                path=str(_CHROMA_PATH),
                settings=Settings(anonymized_telemetry=False, allow_reset=True),
            )

            # 获取或创建 collection（默认使用 chromadb 内置的 all-MiniLM-L6-v2）
            _chroma_collection = _chroma_client.get_or_create_collection(
                name=collection_name,
                metadata={"description": "TDSF Terminal Agent Knowledge Base"},
            )

            _chroma_unavailable_reason = None
            logger.info(
                f"ChromaDB ready at {_CHROMA_PATH}, collection={collection_name}"
            )
            return _chroma_collection, None

        except ImportError as e:
            reason = f"chromadb package not installed: {e}"
            logger.warning(f"ChromaDB unavailable: {reason}")
            _chroma_unavailable_reason = reason
            return None, reason
        except Exception as e:
            reason = f"chromadb init failed: {type(e).__name__}: {e}"
            logger.warning(f"ChromaDB unavailable: {reason}")
            _chroma_unavailable_reason = reason
            return None, reason


def reset_chroma() -> None:
    """重置 ChromaDB 客户端（用于测试或配置变更）"""
    global _chroma_client, _chroma_collection, _chroma_unavailable_reason
    with _chroma_lock:
        _chroma_client = None
        _chroma_collection = None
        _chroma_unavailable_reason = None
    logger.info("reset_chroma: cleared ChromaDB client")


def is_vector_available() -> bool:
    """检查 ChromaDB 向量检索是否可用"""
    collection, _ = _init_chroma()
    return collection is not None


# ============================================================================
# 文档入库接口
# ============================================================================


def add_documents(
    documents: list[dict[str, Any]],
    collection_name: str = _DEFAULT_COLLECTION,
) -> dict[str, Any]:
    """向知识库添加文档（同时入库 FTS5 和 ChromaDB）

    Args:
        documents: 文档列表，每项含：
            - content (str, 必填): 文档正文
            - title (str, 可选): 文档标题
            - source_file (str, 可选): 来源文件路径
            - metadata (dict, 可选): 元数据
            - doc_id (str, 可选): 文档 ID（不提供则自动生成）
        collection_name: ChromaDB collection 名称

    Returns:
        入库结果：
            - added_count (int): 成功入库数
            - vector_available (bool): 向量入库是否成功
            - errors (list[str]): 错误列表
    """
    if not isinstance(documents, list):
        raise ValueError(f"documents must be list, got {type(documents).__name__}")

    errors: list[str] = []
    added_count = 0

    # === FTS5 入库 ===
    conn = _get_kb_db()
    for doc in documents:
        content = doc.get("content", "")
        if not content:
            errors.append(f"document has no content: {doc}")
            continue

        doc_id = doc.get("doc_id") or str(uuid.uuid4())
        title = doc.get("title", "")
        source_file = doc.get("source_file", "")
        metadata_json = str(doc.get("metadata", {}))

        try:
            conn.execute(
                "INSERT INTO kb_documents "
                "(doc_id, content, title, source_file, metadata) "
                "VALUES (?, ?, ?, ?, ?);",
                (doc_id, content, title, source_file, metadata_json),
            )
            added_count += 1
        except sqlite3.Error as e:
            errors.append(f"FTS5 insert failed for doc_id={doc_id}: {e}")

    # === ChromaDB 入库 ===
    vector_available = False
    collection, reason = _init_chroma(collection_name)
    if collection is not None:
        try:
            # 收集所有有效文档
            ids: list[str] = []
            contents: list[str] = []
            metadatas: list[dict[str, Any]] = []
            for doc in documents:
                content = doc.get("content", "")
                if not content:
                    continue
                doc_id = doc.get("doc_id") or str(uuid.uuid4())
                ids.append(doc_id)
                contents.append(content)
                meta = doc.get("metadata", {})
                # ChromaDB metadata 必须 1D 平铺
                flat_meta: dict[str, Any] = {
                    "title": doc.get("title", ""),
                    "source_file": doc.get("source_file", ""),
                }
                if isinstance(meta, dict):
                    for k, v in meta.items():
                        if isinstance(v, (str, int, float, bool)):
                            flat_meta[k] = v
                metadatas.append(flat_meta)

            if ids:
                collection.upsert(ids=ids, documents=contents, metadatas=metadatas)
                vector_available = True
                logger.info(f"ChromaDB upserted {len(ids)} documents")
        except Exception as e:
            errors.append(f"ChromaDB upsert failed: {e}")
            logger.warning(f"ChromaDB upsert failed: {e}")
    else:
        errors.append(f"ChromaDB unavailable: {reason}")

    logger.info(
        f"add_documents: added={added_count}, vector_ok={vector_available}, "
        f"errors={len(errors)}"
    )

    return {
        "added_count": added_count,
        "vector_available": vector_available,
        "errors": errors,
    }


# ============================================================================
# 检索接口
# ============================================================================


def _search_keyword(
    query: str,
    top_k: int,
    min_score: float,
) -> list[dict[str, Any]]:
    """FTS5 关键词检索

    Args:
        query: 检索关键词
        top_k: 返回 top-K
        min_score: 最低相似度（FTS5 bm25 转换为 [0,1] 后过滤）

    Returns:
        检索结果列表（每项含 id / content / score / metadata / source_type）
    """
    conn = _get_kb_db()

    # FTS5 查询：按空格分词后用 OR 连接（对中英文混合友好）
    # 注：FTS5 unicode61 tokenizer 对中文按字符分词，对英文按空格分词。
    # 短语查询 "..." 要求 token 严格相邻，对中英文混合（如 "nginx 启动失败"）易失配；
    # 改为 OR 查询：每个 token 用双引号包裹（单 token 短语），用 OR 连接，
    # 任一 token 命中即返回，BM25 排序保证相关度。
    tokens = [t for t in query.split() if t]
    if not tokens:
        return []
    fts_query = " OR ".join(
        f'"{t.replace(chr(34), chr(34) * 2)}"' for t in tokens
    )

    try:
        cursor = conn.execute(
            "SELECT doc_id, content, title, source_file, metadata, "
            "bm25(kb_documents) AS rank "
            "FROM kb_documents "
            "WHERE kb_documents MATCH ? "
            "ORDER BY rank "
            "LIMIT ?;",
            (fts_query, top_k),
        )
        rows = cursor.fetchall()
    except sqlite3.OperationalError as e:
        logger.warning(f"FTS5 query failed: {e}")
        return []

    results: list[dict[str, Any]] = []
    for row in rows:
        doc_id, content, title, source_file, metadata_json, rank = row

        # bm25 返回的是负值（越小越相关），转换为 [0, 1] 的 score
        # 使用 sigmoid 函数：score = 1 / (1 + exp(rank))
        import math
        score = 1.0 / (1.0 + math.exp(rank)) if rank > -50 else 1.0
        score = round(max(0.0, min(1.0, score)), 4)

        if score < min_score:
            continue

        # 解析 metadata
        try:
            import json
            metadata = json.loads(metadata_json) if metadata_json else {}
        except (json.JSONDecodeError, ValueError):
            metadata = {}
        if title:
            metadata["title"] = title
        if source_file:
            metadata["source_file"] = source_file

        results.append({
            "id": doc_id,
            "content": content,
            "score": score,
            "source_type": "keyword",
            "metadata": metadata,
        })

    return results


def _search_vector(
    query: str,
    top_k: int,
    min_score: float,
    filter_metadata: dict[str, Any] | None = None,
    collection_name: str = _DEFAULT_COLLECTION,
) -> tuple[list[dict[str, Any]], str | None]:
    """ChromaDB 向量检索

    Args:
        query: 检索文本
        top_k: 返回 top-K
        min_score: 最低相似度（cosine distance 转换为 similarity）
        filter_metadata: 元数据过滤
        collection_name: collection 名称

    Returns:
        (results, unavailable_reason) 元组
        - results: 检索结果列表（不可用时为空列表）
        - unavailable_reason: 不可用原因（可用时为 None）
    """
    collection, reason = _init_chroma(collection_name)
    if collection is None:
        return [], reason

    try:
        # ChromaDB where 过滤
        where: dict[str, Any] | None = None
        if filter_metadata:
            where = {k: v for k, v in filter_metadata.items()
                     if isinstance(v, (str, int, float, bool))}

        query_result = collection.query(
            query_texts=[query],
            n_results=top_k,
            where=where,
        )
    except Exception as e:
        logger.warning(f"ChromaDB query failed: {e}")
        return [], f"query failed: {e}"

    results: list[dict[str, Any]] = []

    # 解析返回结果
    # 结构：{"ids": [[...]], "documents": [[...]], "metadatas": [[...]],
    #        "distances": [[...]]}
    if not query_result or not query_result.get("ids"):
        return results, None

    ids_list = query_result.get("ids", [[]])
    docs_list = query_result.get("documents", [[]])
    metas_list = query_result.get("metadatas", [[]])
    dists_list = query_result.get("distances", [[]])

    if not ids_list or not ids_list[0]:
        return results, None

    ids = ids_list[0]
    docs = docs_list[0] if docs_list else ["" for _ in ids]
    metas = metas_list[0] if metas_list else [{} for _ in ids]
    dists = dists_list[0] if dists_list else [0.0 for _ in ids]

    for i, doc_id in enumerate(ids):
        distance = float(dists[i]) if i < len(dists) else 1.0
        # cosine distance ∈ [0, 2]，转换为 similarity ∈ [0, 1]
        # similarity = 1 - distance / 2
        score = 1.0 - (distance / 2.0)
        score = round(max(0.0, min(1.0, score)), 4)

        if score < min_score:
            continue

        content = docs[i] if i < len(docs) else ""
        metadata = metas[i] if i < len(metas) and isinstance(metas[i], dict) else {}

        results.append({
            "id": doc_id,
            "content": content,
            "score": score,
            "source_type": "vector",
            "metadata": metadata,
        })

    return results, None


def _merge_results(
    vector_results: list[dict[str, Any]],
    keyword_results: list[dict[str, Any]],
    top_k: int,
) -> list[dict[str, Any]]:
    """融合向量 + 关键词检索结果（去重 + 加权排序）

    融合策略：
    1. 同一 doc_id 的结果合并，source_type 标记为 "both"
    2. score 取 max（向量相似度 vs 关键词 bm25）
    3. 按 score 降序排序
    4. 截断 top_k

    Args:
        vector_results: 向量检索结果
        keyword_results: 关键词检索结果
        top_k: 最终返回数

    Returns:
        融合后的结果列表
    """
    merged: dict[str, dict[str, Any]] = {}

    # 加入向量结果
    for r in vector_results:
        doc_id = r["id"]
        merged[doc_id] = {
            "id": doc_id,
            "content": r["content"],
            "score": r["score"],
            "source_type": "vector",
            "metadata": r["metadata"],
        }

    # 合并关键词结果
    for r in keyword_results:
        doc_id = r["id"]
        if doc_id in merged:
            # 已存在：合并为 both，取 max score
            merged[doc_id]["source_type"] = "both"
            merged[doc_id]["score"] = max(merged[doc_id]["score"], r["score"])
            # 补充 metadata
            for k, v in r["metadata"].items():
                if k not in merged[doc_id]["metadata"]:
                    merged[doc_id]["metadata"][k] = v
        else:
            merged[doc_id] = {
                "id": doc_id,
                "content": r["content"],
                "score": r["score"],
                "source_type": "keyword",
                "metadata": r["metadata"],
            }

    # 排序 + 截断
    sorted_results = sorted(
        merged.values(),
        key=lambda x: x["score"],
        reverse=True,
    )
    return sorted_results[:top_k]


# ============================================================================
# MCP tool 接口
# ============================================================================


def invoke_ground_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：知识接地检索（ChromaDB 向量 + SQLite FTS5 关键词）

    根据指定方法执行检索：
    - vector: 仅向量检索（语义匹配，需 ChromaDB 可用）
    - keyword: 仅关键词检索（FTS5 bm25 排序）
    - hybrid: 双路融合（默认，向量 + 关键词合并去重）

    Args:
        params: 工具参数字典，包含：
            - query (str, 必填): 检索查询
            - top_k (int, 可选): 返回数，默认 5
            - method (str, 可选): 检索方法，默认 "hybrid"
            - collection (str, 可选): ChromaDB collection，默认 "tdsf_kb"
            - min_score (float, 可选): 最低相似度阈值，默认 0.0
            - filter_metadata (dict, 可选): 元数据过滤

    Returns:
        检索结果字典：
            - results (list): 检索结果列表
            - sources (list): 各检索源的状态信息
            - total (int): 结果总数
            - query (str): 原始查询
            - method (str): 实际使用的检索方法

    Raises:
        ValueError: 必填参数缺失或类型错误
    """
    # === 参数校验 ===
    query = params.get("query", "")
    if not query:
        raise ValueError("query is required")
    if not isinstance(query, str):
        raise ValueError(f"query must be str, got {type(query).__name__}")

    top_k = int(params.get("top_k", _DEFAULT_TOP_K))
    if top_k <= 0:
        top_k = _DEFAULT_TOP_K

    method = params.get("method", _DEFAULT_METHOD)
    if method not in _SUPPORTED_METHODS:
        logger.warning(
            f"invoke_ground_tool: unsupported method '{method}', "
            f"fallback to {_DEFAULT_METHOD}"
        )
        method = _DEFAULT_METHOD

    collection_name = params.get("collection", _DEFAULT_COLLECTION)

    min_score = float(params.get("min_score", _DEFAULT_MIN_SCORE))
    if not 0.0 <= min_score <= 1.0:
        min_score = _DEFAULT_MIN_SCORE

    filter_metadata = params.get("filter_metadata")
    if filter_metadata is not None and not isinstance(filter_metadata, dict):
        raise ValueError(
            f"filter_metadata must be dict, got {type(filter_metadata).__name__}"
        )

    # === 执行检索 ===
    vector_results: list[dict[str, Any]] = []
    keyword_results: list[dict[str, Any]] = []
    vector_reason: str | None = None

    if method in (_METHOD_VECTOR, _METHOD_HYBRID):
        vector_results, vector_reason = _search_vector(
            query=query,
            top_k=top_k,
            min_score=min_score,
            filter_metadata=filter_metadata,
            collection_name=collection_name,
        )
        # 若向量不可用且 method=vector，降级为 keyword
        if not vector_results and vector_reason and method == _METHOD_VECTOR:
            logger.warning(
                f"vector unavailable, fallback to keyword: {vector_reason}"
            )
            method = _METHOD_KEYWORD  # 降级
            keyword_results = _search_keyword(query, top_k, min_score)

    if method in (_METHOD_KEYWORD, _METHOD_HYBRID):
        keyword_results = _search_keyword(query, top_k, min_score)

    # === 融合结果 ===
    if method == _METHOD_HYBRID:
        results = _merge_results(vector_results, keyword_results, top_k)
    elif method == _METHOD_VECTOR:
        results = vector_results[:top_k]
    else:  # keyword
        results = keyword_results[:top_k]

    # === 构建 sources 元信息 ===
    sources: list[dict[str, Any]] = [
        {
            "type": "vector",
            "count": len(vector_results),
            "available": vector_reason is None,
            "reason": vector_reason,
        },
        {
            "type": "keyword",
            "count": len(keyword_results),
            "available": True,
        },
    ]

    logger.info(
        f"invoke_ground_tool: query='{query[:40]}', method={method}, "
        f"vector={len(vector_results)}, keyword={len(keyword_results)}, "
        f"merged={len(results)}"
    )

    return {
        "results": results,
        "sources": sources,
        "total": len(results),
        "query": query,
        "method": method,
    }


# ============================================================================
# 工具元数据
# ============================================================================


TOOL_METADATA: dict[str, Any] = {
    "name": "ground",
    "description": (
        "知识接地检索：ChromaDB 向量检索（语义匹配）+ SQLite FTS5 关键词检索"
        "（精确匹配），支持 hybrid 双路融合。ChromaDB 不可用时自动降级为纯 FTS5。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "检索查询（必填）"},
            "top_k": {"type": "integer", "minimum": 1, "description": "返回数（默认 5）"},
            "method": {
                "type": "string",
                "enum": list(_SUPPORTED_METHODS),
                "description": "检索方法（默认 hybrid）",
            },
            "collection": {
                "type": "string",
                "description": "ChromaDB collection 名称（默认 tdsf_kb）",
            },
            "min_score": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
                "description": "最低相似度阈值（默认 0.0）",
            },
            "filter_metadata": {
                "type": "object",
                "description": "元数据过滤（可选）",
            },
        },
        "required": ["query"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "content": {"type": "string"},
                        "score": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                        "source_type": {
                            "type": "string",
                            "enum": ["vector", "keyword", "both"],
                        },
                        "metadata": {"type": "object"},
                    },
                },
            },
            "sources": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["vector", "keyword"]},
                        "count": {"type": "integer"},
                        "available": {"type": "boolean"},
                        "reason": {"type": ["string", "null"]},
                    },
                },
            },
            "total": {"type": "integer"},
            "query": {"type": "string"},
            "method": {"type": "string"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return TOOL_METADATA


# ============================================================================
# 集成到 LangGraph tool_call 节点
# ============================================================================


def register_to_graph_nodes() -> None:
    """将 ground tool 注册到 graph/nodes.py 的 tool_call_node

    使用方式（在 graph/nodes.py 中）：
        from tools.ground import invoke_ground_tool

        if tool_name == "ground":
            result = invoke_ground_tool(params)
    """
    logger.info("register_to_graph_nodes: ground tool ready for integration")
