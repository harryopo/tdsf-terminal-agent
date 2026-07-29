"""
knowledge/rpc.py — 知识库 JSON-RPC 方法注册（T-P3-08）
======================================================

职责：
- 向 JSON-RPC dispatcher 注册 knowledge.* 方法
- 整合 FTS5 + ChromaDB 双路检索
- 提供 knowledge.search / knowledge.add / knowledge.rebuild / knowledge.get

注册的方法：
- knowledge.search:    {query, limit?, method?} → {results, total}
- knowledge.add:       {entry: KnowledgeEntry} → {id}
- knowledge.rebuild:   {} → {ok, count}
- knowledge.get:       {id} → {entry | null}
- knowledge.count:     {} → {count}

method 参数支持：
- "fts5":    仅 FTS5 检索
- "vector":  仅向量检索
- "hybrid":  双路检索合并去重（默认）
"""

from __future__ import annotations

import logging
from typing import Any

from knowledge.fts5 import KnowledgeEntry, get_global_index
from knowledge.vector import generate_embedding, get_global_vector

logger = logging.getLogger("sidecar.knowledge.rpc")


# ============================================================================
# 检索方法实现
# ============================================================================


def _search_fts5(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """FTS5 关键词检索"""
    try:
        index = get_global_index()
        return index.search(query, limit=limit)
    except Exception as e:
        logger.warning(f"_search_fts5 failed: {e}")
        return []


def _search_vector(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """向量语义检索"""
    try:
        vec_index = get_global_vector()
        query_emb = generate_embedding(query)
        return vec_index.search(query_emb, limit=limit)
    except Exception as e:
        logger.warning(f"_search_vector failed: {e}")
        return []


def _search_hybrid(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """双路检索：FTS5 + Vector 合并去重

    合并策略：
    - FTS5 结果在前（关键词精确匹配优先）
    - Vector 结果在后（语义补充）
    - 同 ID 去重
    """
    fts_results = _search_fts5(query, limit=limit)
    vec_results = _search_vector(query, limit=limit)

    merged: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for r in fts_results:
        entry_id = r.get("id", "")
        if entry_id in seen_ids:
            continue
        seen_ids.add(entry_id)
        r["match_type"] = "fts5"
        merged.append(r)
    for r in vec_results:
        entry_id = r.get("id", "")
        if entry_id in seen_ids:
            continue
        seen_ids.add(entry_id)
        r["match_type"] = "vector"
        merged.append(r)

    return merged[:limit]


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """向 JSON-RPC dispatcher 注册 knowledge.* 方法

    注册的方法：
    - knowledge.search:   检索知识库
    - knowledge.add:      增加一条知识
    - knowledge.rebuild:  全量重建索引
    - knowledge.get:      按 ID 获取单条知识
    - knowledge.count:    返回知识库条目数
    """

    def _search(
        query: str,
        limit: int = 10,
        method: str = "hybrid",
    ) -> dict[str, Any]:
        """检索知识库

        Args:
            query: 查询字符串
            limit: 返回 top-K（默认 10）
            method: 检索方法（fts5 / vector / hybrid，默认 hybrid）

        Returns:
            {results: [...], total: int, query: str, method: str}
        """
        if not query or not query.strip():
            return {"results": [], "total": 0, "query": query, "method": method}

        method_lower = method.lower()
        if method_lower == "fts5":
            results = _search_fts5(query, limit=limit)
        elif method_lower == "vector":
            results = _search_vector(query, limit=limit)
        else:
            results = _search_hybrid(query, limit=limit)

        return {
            "results": results,
            "total": len(results),
            "query": query,
            "method": method_lower,
        }

    def _add(entry: dict[str, Any]) -> dict[str, Any]:
        """增加一条知识到 FTS5 + Vector 索引

        Args:
            entry: KnowledgeEntry 字典（id/source/title/content/url/tags）

        Returns:
            {ok: bool, id: str}
        """
        try:
            e: KnowledgeEntry = KnowledgeEntry.from_dict(entry)
            fts_index = get_global_index()
            entry_id = fts_index.add(e)

            # 同步加入向量索引
            try:
                vec_index = get_global_vector()
                vec_index.add(e)
            except Exception as ex:
                logger.warning(f"knowledge.add: 向量索引添加失败（不阻塞）: {ex}")

            return {"ok": True, "id": entry_id}
        except Exception as e:
            logger.exception(f"knowledge.add failed: {e}")
            return {"ok": False, "error": str(e)}

    def _rebuild() -> dict[str, Any]:
        """全量重建索引（清空所有数据）

        Returns:
            {ok: bool, count: int}
        """
        try:
            fts_index = get_global_index()
            count = fts_index.rebuild()

            # 同步重置向量索引
            try:
                vec_index = get_global_vector()
                vec_index.reset()
            except Exception as ex:
                logger.warning(f"knowledge.rebuild: 向量索引重置失败（不阻塞）: {ex}")

            return {"ok": True, "count": count}
        except Exception as e:
            logger.exception(f"knowledge.rebuild failed: {e}")
            return {"ok": False, "error": str(e)}

    def _get(id: str) -> dict[str, Any]:
        """按 ID 获取单条知识

        Args:
            id: 条目 ID

        Returns:
            {ok: bool, entry: dict | null}
        """
        try:
            fts_index = get_global_index()
            entry = fts_index.get(id)
            if entry is None:
                return {"ok": False, "error": f"entry not found: {id}"}
            return {"ok": True, "entry": entry}
        except Exception as e:
            logger.exception(f"knowledge.get failed: {e}")
            return {"ok": False, "error": str(e)}

    def _count() -> dict[str, Any]:
        """返回知识库条目总数（FTS5 索引）"""
        try:
            fts_index = get_global_index()
            return {"count": fts_index.count()}
        except Exception as e:
            logger.exception(f"knowledge.count failed: {e}")
            return {"count": 0, "error": str(e)}

    dispatcher.register("knowledge.search", _search)
    dispatcher.register("knowledge.add", _add)
    dispatcher.register("knowledge.rebuild", _rebuild)
    dispatcher.register("knowledge.get", _get)
    dispatcher.register("knowledge.count", _count)
    logger.info("knowledge.* methods registered (5 methods)")
