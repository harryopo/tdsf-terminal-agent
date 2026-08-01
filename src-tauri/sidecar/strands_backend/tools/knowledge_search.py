"""
strands_backend/tools/knowledge_search.py — 知识库检索工具（P2-4）
==================================================================

让 Strands agent 检索内置教学语料 / 导入文档 / 沉淀案例（RAG 混合检索）。

- 走统一 RAG 引擎（knowledge.rag.RagIndex.hybrid_search：FTS5 + sqlite-vec + RRF）
- 返回结构化结果（title/content/source/tags），LLM 据此回答/教学
- 知识库为空时返回 empty 状态（引导 agent 诚实说明）

工具签名：
    knowledge_search(query: str, limit: int = 5) -> dict
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import tool

logger = logging.getLogger("sidecar.strands_backend.tools.knowledge_search")


def invoke_knowledge_search_tool(params: dict[str, Any], ctx: Any = None) -> dict[str, Any]:
    """知识库检索核心实现

    Args:
        params: {query (str, 必填), limit (int, 默认 5)}
        ctx: ToolContext（当前未使用，保留签名一致性）

    Returns:
        {
            status: "success" | "empty" | "error",
            query, count, results: [{id, title, content, source, tags, url}]
        }
    """
    query = (params.get("query") or "").strip()
    if not query:
        return {"status": "error", "query": "", "message": "query 参数缺失"}
    try:
        limit = max(1, min(int(params.get("limit", 5)), 10))
    except (TypeError, ValueError):
        limit = 5

    try:
        from knowledge.rag import get_global_rag

        results = get_global_rag().hybrid_search(query, top_k=limit)
    except Exception as e:
        logger.exception(f"knowledge_search failed: query={query[:50]}, error={e}")
        return {
            "status": "error",
            "query": query,
            "message": f"知识库检索异常: {e}",
        }

    if not results:
        return {
            "status": "empty",
            "query": query,
            "count": 0,
            "results": [],
            "message": "知识库暂无相关内容（可建议用户导入文档或沉淀案例）",
        }

    # 压缩内容（工具结果给 LLM 用，每条保留前 400 字）
    for r in results:
        if len(r["content"]) > 400:
            r["content"] = r["content"][:400] + "…"
    return {
        "status": "success",
        "query": query,
        "count": len(results),
        "results": results,
    }


def make_knowledge_search_tool(ctx: Any):
    """构建知识库检索工具（带 ctx 闭包，Strands @tool 装饰）"""
    @tool
    def knowledge_search(query: str, limit: int = 5) -> dict:
        """检索内置 Linux 教学知识库（命令/概念/哲学/排障案例，RAG 混合检索）。

        用户询问 Linux 概念/命令用法/运维知识/历史案例时调用，返回最相关的
        知识条目（标题 + 正文 + 来源）。知识库为空时返回 empty 状态。

        Args:
            query (str): 检索主题，如 "systemctl 服务管理"、"nginx 502 排障"。
            limit (int): 返回条数上限，默认 5，最大 10。

        Returns:
            dict: 含 status / results 列表（每条含 title / content / source / tags）。
        """
        return invoke_knowledge_search_tool(
            params={"query": query, "limit": limit},
            ctx=ctx,
        )

    knowledge_search.__name__ = "knowledge_search"
    return knowledge_search


__all__ = ["invoke_knowledge_search_tool", "make_knowledge_search_tool"]
