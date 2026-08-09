"""decision_history 工具 — Strands 路径决策库检索（向量 + FTS5）

TDSF 魔改 (2026-08-09): 方案书 #10 决策库完善。
让 Sidecar agent 在排障前检索历史案例库，给出"之前遇到类似问题怎么解决的"参考。

数据源：RAG 引擎（sqlite-vec 向量 + FTS5 全文 + RRF 融合检索）。
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import ToolContext, tool

logger = logging.getLogger("sidecar.strands_backend.tools.decision_history")


def invoke_search_history(
    params: dict[str, Any],
    ctx: ToolContext,
) -> dict[str, Any]:
    """检索历史案例库

    Args:
        params:
            - query (str, 必填): 检索关键词（问题描述/命令/错误信息）
            - limit (int, 可选): 返回条数，默认 5
        ctx: ToolContext

    Returns:
        dict: {results: list, count: int}
    """
    query = str(params.get("query", "")).strip()
    if not query:
        return {"results": [], "count": 0}

    limit = int(params.get("limit", 5))
    limit = max(1, min(limit, 20))

    try:
        # 复用已有的 RAG 引擎
        import sys
        import os
        sidecar_root = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "sidecar")
        if sidecar_root not in sys.path:
            sys.path.insert(0, sidecar_root)

        from knowledge.rag import get_global_rag  # type: ignore[import-not-found]

        rag = get_global_rag()
        entries = rag.search(query, top_k=limit)

        results = []
        for entry in entries:
            results.append({
                "title": getattr(entry, "title", ""),
                "content": getattr(entry, "content", "")[:500],
                "tags": getattr(entry, "tags", []),
                "score": getattr(entry, "score", 0.0),
            })

        return {"results": results, "count": len(results)}
    except Exception as e:
        logger.warning(f"search_history failed: {e}")
        return {"results": [], "count": 0, "error": str(e)}


def make_decision_history_tool(ctx: ToolContext):
    """构建 search_history 工具"""

    @tool
    def search_history(
        query: str,
        limit: int = 5,
    ) -> dict:
        """检索历史排障案例库，找到与当前问题相似的历史案例。

        在开始排障前调用此工具，参考之前遇到类似问题时的解决方案。
        数据源包含自动沉淀的成功排障案例。

        Args:
            query (str): 检索关键词（问题描述、命令名、错误信息等）。
            limit (int): 返回条数，默认 5，上限 20。

        Returns:
            dict: {results: list[{title, content, tags, score}], count: int}
        """
        return invoke_search_history({"query": query, "limit": limit}, ctx)

    search_history.__name__ = "search_history"
    return search_history
