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
- knowledge.list:      {limit?, offset?} → {results, total, ...}
- knowledge.import_docs: {files, source?} → {imported, skipped, errors, rejected}
- knowledge.add_case:    {title, content, tags?} → {ok, id}
- knowledge.crawl:       {source, url?} → {added, entries, error?}
- knowledge.stats:       {} → {total_entries, embed_model_loaded}
- knowledge.list_files:  {source?} → {files: [{url, filename, title0,
                         chunks, total_chars, source}], total}
- knowledge.get_doc:     {url} → {ok, url, filename, source, title,
                         content, chunks, total_chars}
- knowledge.titles_zh:   {source?} → {titles: [{url, zh}], total}

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

from knowledge.rag import get_global_rag

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
    - knowledge.search:   检索知识库（P2-4 起默认走 RAG 混合检索引擎）
    - knowledge.add:      增加一条知识
    - knowledge.rebuild:  全量重建索引
    - knowledge.get:      按 ID 获取单条知识
    - knowledge.count:    返回知识库条目数
    - knowledge.import_docs:  文档导入（{name, content} 列表，fail-closed 仅 .md）
    - knowledge.add_case:     会话案例沉淀（决策库雏形）
    - knowledge.crawl:        在线爬取入库
    - knowledge.stats:        知识库统计
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
            # P2-4: hybrid 走统一 RAG 引擎（sqlite-vec + FTS5 + RRF）
            results = get_global_rag().hybrid_search(query, top_k=limit)

        return {
            "results": results,
            "total": len(results),
            "query": query,
            "method": method_lower,
        }

    def _add(entry: dict[str, Any]) -> dict[str, Any]:
        """增加一条知识到统一 RAG 引擎（rag.db）

        ⚠️ 必须与 list/get/search 同源（rag.db）。历史实现写旧 FTS5Index
        （knowledge.db）+ ChromaDB，与读路径割裂，导致 add 后前端不可见
        （2026-08-18 修复）。

        Args:
            entry: KnowledgeEntry 字典（id/source/title/content/url/tags）

        Returns:
            {ok: bool, id: str}
        """
        try:
            e: KnowledgeEntry = KnowledgeEntry.from_dict(entry)
            rag = get_global_rag()
            entry_id = rag.add(e)
            return {"ok": True, "id": entry_id}
        except Exception as e:
            logger.exception(f"knowledge.add failed: {e}")
            return {"ok": False, "error": str(e)}

    def _rebuild() -> dict[str, Any]:
        """全量重建索引（清空统一 RAG 引擎三表）

        ⚠️ 与 _add 同源（rag.db）——历史实现清的是旧 FTS5Index + ChromaDB，
        对 rag.db 无操作，rebuild 后前端列表毫无变化（2026-08-18 修复）。

        Returns:
            {ok: bool, count: int}
        """
        try:
            rag = get_global_rag()
            count = rag.rebuild()
            return {"ok": True, "count": count}
        except Exception as e:
            logger.exception(f"knowledge.rebuild failed: {e}")
            return {"ok": False, "error": str(e)}

    def _get(id: str) -> dict[str, Any]:
        """按 ID 获取单条知识

        ⚠️ 必须与 list/search 同源（rag.db）。历史实现读旧 FTS5Index 的
        knowledge.db（knowledge_entries 表），与列表/搜索（rag.db）割裂，
        导致列表有数据而详情永远为空（2026-08-15 修复）。

        Args:
            id: 条目 ID

        Returns:
            {ok: bool, entry: dict | null}
        """
        try:
            rag = get_global_rag()
            entry = rag.get(id)
            if entry is None:
                return {"ok": False, "error": f"entry not found: {id}"}
            return {"ok": True, "entry": entry}
        except Exception as e:
            logger.exception(f"knowledge.get failed: {e}")
            return {"ok": False, "error": str(e)}

    def _count() -> dict[str, Any]:
        """返回知识库条目总数（RAG entries 表，与 list/search/get 同源）"""
        try:
            rag = get_global_rag()
            return {"count": rag.count()}
        except Exception as e:
            logger.exception(f"knowledge.count failed: {e}")
            return {"count": 0, "error": str(e)}

    dispatcher.register("knowledge.search", _search)
    dispatcher.register("knowledge.add", _add)
    dispatcher.register("knowledge.rebuild", _rebuild)
    dispatcher.register("knowledge.get", _get)
    dispatcher.register("knowledge.count", _count)

    # P2-4: 浏览模式（打开即列出，不依赖搜索词）
    def _list(limit: int = 50, offset: int = 0) -> dict[str, Any]:
        """列出知识条目（按入库时间倒序，供浏览模式）"""
        from knowledge.rag import get_global_rag

        rag = get_global_rag()
        limit = max(1, min(int(limit), 100))
        offset = max(0, int(offset))
        rows = rag.list_entries(limit=limit, offset=offset)
        return {"results": rows, "total": rag.count(), "limit": limit, "offset": offset}

    dispatcher.register("knowledge.list", _list)

    # P2-4: 内容源管道
    def _import_docs(
        files: list[dict[str, str]],
        source: str = "imported-docs",
    ) -> dict[str, Any]:
        """文档导入：前端读好的 {name, content} 列表分块入库

        fail-closed：仅接受 .md（sources.import_docs 内校验，非 md 进
        rejected）。Web 安全模型下 file input 拿不到绝对路径，故传内容。
        """
        from knowledge.sources import import_docs

        if not isinstance(files, list) or not all(
            isinstance(f, dict) for f in files
        ):
            return {
                "imported": 0,
                "skipped": 0,
                "errors": 0,
                "rejected": [],
                "error": "files must be a list of {name, content} objects",
            }
        return import_docs(files, source)

    def _add_case(title: str, content: str, tags: list[str] | None = None) -> dict[str, Any]:
        """会话案例沉淀（决策库雏形）"""
        from knowledge.sources import add_case

        case_id = add_case(title=title, content=content, tags=tags or [])
        return {"ok": True, "id": case_id}

    def _crawl(source: str, url: str | None = None) -> dict[str, Any]:
        """在线爬取文档入库"""
        from knowledge.sources import crawl_and_index

        return crawl_and_index(source, url)

    def _stats() -> dict[str, Any]:
        """知识库统计（总数/embedding 状态）"""
        from knowledge.sources import knowledge_stats

        return knowledge_stats()

    # 文件级聚合视图（同文件分片段落聚合浏览，配合标题边界分块）
    def _list_files(source: str | None = None) -> dict[str, Any]:
        """按 url 聚合列出文档文件

        同一文件（同 url）的全部分块聚合为一条；url 为空的条目
        （corpus 卡片/会话沉淀）跳过。

        Args:
            source: 可选，按来源过滤（如 "builtin-docs"）；None/空 = 全部

        Returns:
            {files: [{url, filename, title0, chunks, total_chars, source}], total}
        """
        rag = get_global_rag()
        files = rag.list_files(source=(source or None))
        return {"files": files, "total": len(files)}

    def _get_doc(url: str) -> dict[str, Any]:
        """按 url 取完整文档（全部块按序号排序，content 以空行拼接）

        Args:
            url: 文档 url（必填，fail-closed）

        Returns:
            {ok: True, url, filename, source, title, content, chunks, total_chars}
            或 {ok: False, error}
        """
        if not url or not str(url).strip():
            return {"ok": False, "error": "url is required"}
        doc = get_global_rag().get_doc(str(url).strip())
        if doc is None:
            return {"ok": False, "error": f"document not found: {url}"}
        return {"ok": True, **doc}

    dispatcher.register("knowledge.import_docs", _import_docs)
    dispatcher.register("knowledge.add_case", _add_case)
    dispatcher.register("knowledge.crawl", _crawl)
    dispatcher.register("knowledge.stats", _stats)
    dispatcher.register("knowledge.list_files", _list_files)
    dispatcher.register("knowledge.get_doc", _get_doc)

    # 中文标题映射（前端知识浏览器：中文主行 + 英文原名副行）
    def _titles_zh(source: str | None = None) -> dict[str, Any]:
        """返回 url → 中文标题 映射（doc_titles_zh 表，gen_titles_zh.py 生成）

        Args:
            source: 可选，按来源过滤；None/空 = 全部

        Returns:
            {titles: [{url, zh}, ...], total}
        """
        titles = get_global_rag().titles_zh(source=(source or None))
        return {"titles": titles, "total": len(titles)}

    dispatcher.register("knowledge.titles_zh", _titles_zh)
    logger.info("knowledge.* methods registered (13 methods, RAG hybrid)")
