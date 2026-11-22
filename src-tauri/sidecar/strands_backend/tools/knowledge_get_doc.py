"""
strands_backend/tools/knowledge_get_doc.py — 知识库整篇文档读取工具
====================================================================

与 knowledge_search 配套：检索命中后，按 url 读取该文档全部块按序拼接的
完整 markdown（知识浏览器「完整文档」同数据源）。

- 旧 url 默认读精简库；本地引用绑定内置/个人来源，不抓取外部网页。
- fail-closed：url 缺失 → error；查无文档 → not_found
- 内容上限 30000 字符截断（防单篇超长文档撑爆 LLM 上下文）

工具签名：
    knowledge_get_doc(url: str) -> dict
"""
from __future__ import annotations

import logging
from typing import Any

from strands_backend.tools import tool
from strands_backend.tools.tool_lifecycle import tool_call_lifecycle

logger = logging.getLogger("sidecar.strands_backend.tools.knowledge_get_doc")

# 单篇返回给 LLM 的正文上限（字符）——超过截断并提示可用检索定位章节
_MAX_CONTENT_CHARS = 30000


@tool_call_lifecycle("knowledge_get_doc")
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
        result = {"status": "error", "url": "", "message": "url 参数缺失"}
        return result

    try:
        from knowledge.rag import get_slim_rag

        if url.startswith("tdsf-kb:"):
            from urllib.parse import unquote, urlsplit
            from knowledge.collections import get_document

            reference = urlsplit(url)
            if reference.scheme != "tdsf-kb" or reference.netloc not in {"builtin", "personal"} or reference.query or reference.fragment:
                raise ValueError("知识引用无效，请重新检索")
            doc = get_document(unquote(reference.path.removeprefix("/")), reference.netloc)
        else:
            doc = get_slim_rag().get_doc(url)
    except Exception as e:
        logger.exception(f"knowledge_get_doc failed: url={url[:80]}, error={e}")
        result = {"status": "error", "url": url, "message": f"知识库读取异常: {e}"}
        return result

    if doc is None:
        result = {
            "status": "not_found",
            "url": url,
            "message": "知识库中不存在该文档（url 需与检索结果返回的 url 完全一致）",
        }
        return result

    content = str(doc.get("content") or "")
    truncated = len(content) > _MAX_CONTENT_CHARS
    if truncated:
        content = content[:_MAX_CONTENT_CHARS] + "\n\n…（已截断，可用 knowledge_search 检索定位具体章节）"
    result = {
        "status": "success",
        "url": url,
        "title": str(doc.get("title_zh") or doc.get("title") or ""),
        "category": str(doc.get("category") or ""),
        "content": content,
        "chunks": int(doc.get("chunks") or 0),
        "truncated": truncated,
        "source_url": str(doc.get("url") or url),
    }
    return result


def make_knowledge_get_doc_tool(ctx: Any):
    """构建知识库整篇文档读取工具（带 ctx 闭包，Strands @tool 装饰）"""
    @tool(context="sdk_tool_context")
    def knowledge_get_doc(url: str, *, sdk_tool_context: Any = None) -> dict:
        """按 url 读取知识库完整文档（全部章节按序拼接的 markdown 全文）。

        先用 knowledge_search 检索，将命中结果的 url 字段原样传给本工具读取
        该文档完整内容（适用于需要系统讲解某主题/引用完整配置示例时）。

        Args:
            url (str): 文档 url（必须与 knowledge_search 结果返回的 url
                完全一致，如 "consolidated/services/Web 服务器（Nginx 与 Apache）.md"）。

        Returns:
            dict: 含 status / url / title / category / content（完整
            markdown，超 30000 字符截断）/ chunks。
        """
        result = invoke_knowledge_get_doc_tool(
            params={"url": url}, ctx=ctx, sdk_tool_context=sdk_tool_context,
        )
        if sdk_tool_context is None:
            return result
        # Keep business status/content inside a valid SDK content block.
        return {"status": "success", "content": [{"json": result}]}

    knowledge_get_doc.__name__ = "knowledge_get_doc"
    return knowledge_get_doc


__all__ = ["invoke_knowledge_get_doc_tool", "make_knowledge_get_doc_tool"]
