"""
strands_backend/tools/knowledge_get_doc.py — 知识库整篇文档读取工具
====================================================================

与 knowledge_search 配套：检索命中后，按 url 读取该文档全部块按序拼接的
完整 markdown（知识浏览器「完整文档」同数据源）。

- 读精简库（rag_slim.db，中文提炼版）——双库方案 TDSF 2026-08-31，
  与 knowledge_search 同源（knowledge.rag.get_slim_rag().get_doc）
- fail-closed：url 缺失 → error；查无文档 → not_found
- 内容上限 30000 字符截断（防单篇超长文档撑爆 LLM 上下文）

工具签名：
    knowledge_get_doc(url: str) -> dict
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import tool

logger = logging.getLogger("sidecar.strands_backend.tools.knowledge_get_doc")

# 单篇返回给 LLM 的正文上限（字符）——超过截断并提示可用检索定位章节
_MAX_CONTENT_CHARS = 30000


def invoke_knowledge_get_doc_tool(params: dict[str, Any], ctx: Any = None) -> dict[str, Any]:
    """知识库整篇文档读取核心实现

    Args:
        params: {url (str, 必填)}
        ctx: ToolContext（当前未使用，保留签名一致性）

    Returns:
        {
            status: "success" | "not_found" | "error",
            url, title, category, content, chunks, truncated
        }
    """
    url = str(params.get("url") or "").strip()
    if not url:
        return {"status": "error", "url": "", "message": "url 参数缺失"}

    try:
        from knowledge.rag import get_slim_rag

        # TDSF 2026-08-31: 与 knowledge_search 同源读精简库（中文提炼版）
        doc = get_slim_rag().get_doc(url)
    except Exception as e:
        logger.exception(f"knowledge_get_doc failed: url={url[:80]}, error={e}")
        return {"status": "error", "url": url, "message": f"知识库读取异常: {e}"}

    if doc is None:
        return {
            "status": "not_found",
            "url": url,
            "message": "知识库中不存在该文档（url 需与检索结果返回的 url 完全一致）",
        }

    content = str(doc.get("content") or "")
    truncated = len(content) > _MAX_CONTENT_CHARS
    if truncated:
        content = content[:_MAX_CONTENT_CHARS] + "\n\n…（已截断，可用 knowledge_search 检索定位具体章节）"
    return {
        "status": "success",
        "url": url,
        "title": str(doc.get("title_zh") or doc.get("title") or ""),
        "category": str(doc.get("category") or ""),
        "content": content,
        "chunks": int(doc.get("chunks") or 0),
        "truncated": truncated,
    }


def make_knowledge_get_doc_tool(ctx: Any):
    """构建知识库整篇文档读取工具（带 ctx 闭包，Strands @tool 装饰）"""
    @tool
    def knowledge_get_doc(url: str) -> dict:
        """按 url 读取知识库完整文档（全部章节按序拼接的 markdown 全文）。

        先用 knowledge_search 检索，命中结果的 url 字段传给本工具读取
        该文档完整内容（适用于需要系统讲解某主题/引用完整配置示例时）。

        Args:
            url (str): 文档 url（必须与 knowledge_search 结果返回的 url
                完全一致，如 "consolidated/services/Web 服务器（Nginx 与 Apache）.md"）。

        Returns:
            dict: 含 status / url / title / category / content（完整
            markdown，超 30000 字符截断）/ chunks。
        """
        return invoke_knowledge_get_doc_tool(params={"url": url}, ctx=ctx)

    knowledge_get_doc.__name__ = "knowledge_get_doc"
    return knowledge_get_doc


__all__ = ["invoke_knowledge_get_doc_tool", "make_knowledge_get_doc_tool"]
