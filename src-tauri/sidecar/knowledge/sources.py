"""
knowledge/sources.py — 知识库内容源（P2-4，四路）
===================================================

1. **内置教学语料**：corpus/*.json，首次启动自动索引（count==0 时）
2. **文档导入**：用户指定目录扫描 .md/.txt，分块入库（RPC knowledge.import_docs）
3. **会话案例沉淀**：排障案例/经验从会话写入（RPC knowledge.add_case），
   决策库雏形（链接 P2-4 长期规划）
4. **在线爬取**：crawlers 框架（nginx/generic），RPC knowledge.crawl 触发

设计：
- 所有入口统一转 KnowledgeEntry → RagIndex.add
- 幂等：内置语料按 id 去重（INSERT OR REPLACE）
- 分块：文档按 ~400 字切块（BGE 512 token 上限），标题保留
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import get_global_rag

logger = logging.getLogger("sidecar.knowledge.sources")

_CORPUS_DIR = Path(__file__).parent / "corpus"
_CHUNK_SIZE = 400  # 字符（约 200-300 token，BGE 512 上限内）
_CHUNK_OVERLAP = 50


# ============================================================================
# 1. 内置教学语料
# ============================================================================

def load_builtin_corpus() -> int:
    """首次启动自动索引内置语料（幂等，按 id 覆盖）

    Returns:
        本次入库条数
    """
    rag = get_global_rag()
    if rag.count() > 0:
        return 0  # 已有数据（可能包含用户导入），跳过避免重复索引
    added = 0
    if not _CORPUS_DIR.exists():
        return 0
    for f in sorted(_CORPUS_DIR.glob("*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                items = json.load(fh)
            for it in items:
                entry = KnowledgeEntry(
                    id=it.get("id") or f"corpus-{uuid.uuid4().hex[:12]}",
                    source=it.get("source", "builtin-corpus"),
                    title=it.get("title", ""),
                    content=it.get("content", ""),
                    url=it.get("url", ""),
                    tags=it.get("tags", []),
                )
                rag.add(entry)
                added += 1
            logger.info(f"builtin corpus indexed: {f.name} ({len(items)} entries)")
        except Exception as e:
            logger.warning(f"corpus load failed {f.name}: {e}")
    return added


# ============================================================================
# 2. 文档导入（分块）
# ============================================================================

def import_docs(directory: str, source: str = "imported-docs") -> dict[str, Any]:
    """扫描目录下的 .md/.txt 文件并分块入库

    Args:
        directory: 待扫描目录
        source: 来源标记（默认 imported-docs）

    Returns:
        {imported, skipped, errors}
    """
    root = Path(directory)
    if not root.is_dir():
        raise ValueError(f"目录不存在: {directory}")
    rag = get_global_rag()
    imported = 0
    errors = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in (".md", ".txt"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore").strip()
            if not text:
                continue
            chunks = _chunk_text(text)
            rel = path.relative_to(root).as_posix()
            for i, chunk in enumerate(chunks):
                entry = KnowledgeEntry(
                    id=f"doc-{uuid.uuid5(uuid.NAMESPACE_URL, str(path))}-{i}",
                    source=source,
                    title=f"{path.name}（第 {i + 1}/{len(chunks)} 节）" if len(chunks) > 1 else path.name,
                    content=chunk,
                    url=str(path),
                    tags=["用户文档"],
                )
                rag.add(entry)
            imported += 1
        except Exception as e:
            logger.warning(f"doc import failed {path}: {e}")
            errors += 1
    return {"imported": imported, "skipped": 0, "errors": errors}


def _chunk_text(text: str) -> list[str]:
    """按 ~400 字分块（保留 50 字重叠，避免切断语义）"""
    if len(text) <= _CHUNK_SIZE:
        return [text] if text.strip() else []
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + _CHUNK_SIZE, len(text))
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(text):
            break
        start = end - _CHUNK_OVERLAP
    return chunks


# ============================================================================
# 3. 会话案例沉淀（决策库雏形）
# ============================================================================

def add_case(
    title: str,
    content: str,
    tags: list[str] | None = None,
    source: str = "session-case",
) -> str:
    """把排障案例/经验写入知识库（决策库雏形）

    Args:
        title: 案例标题（如「502 排障：php-fpm socket 权限」）
        content: 案例正文（现象 → 根因 → 解法）
        tags: 标签（如 ["nginx", "排障"]）
        source: 来源标记

    Returns:
        条目 ID
    """
    entry = KnowledgeEntry(
        id=f"case-{uuid.uuid4().hex[:12]}",
        source=source,
        title=title,
        content=content,
        tags=tags or [],
    )
    get_global_rag().add(entry)
    logger.info(f"knowledge case added: {title}")
    return entry.id


# ============================================================================
# 4. 在线爬取（crawlers 框架）
# ============================================================================

def crawl_and_index(source_key: str, url: str | None = None) -> dict[str, Any]:
    """调用爬虫抓取文档并入库

    Args:
        source_key: 爬虫注册名（nginx / generic，见 knowledge/crawlers/registry.py）
        url: 抓取目标 URL（None 用爬虫默认）

    Returns:
        {added, entries, error?}
    """
    try:
        from knowledge.crawlers.registry import get_crawler

        crawler = get_crawler(source_key)
        items = crawler.fetch(url=url) if url else crawler.fetch()
        added = 0
        for it in items:
            entry = KnowledgeEntry(
                id=it.get("id") or f"crawl-{uuid.uuid4().hex[:12]}",
                source=it.get("source", f"crawl-{source_key}"),
                title=it.get("title", ""),
                content=it.get("content", ""),
                url=it.get("url", ""),
                tags=it.get("tags", []),
            )
            get_global_rag().add(entry)
            added += 1
        return {"added": added, "entries": len(items)}
    except Exception as e:
        logger.warning(f"crawl failed source={source_key}: {e}")
        return {"added": 0, "entries": 0, "error": str(e)}


# ============================================================================
# 统计
# ============================================================================

def knowledge_stats() -> dict[str, Any]:
    rag = get_global_rag()
    return {
        "total_entries": rag.count(),
        "embed_model_loaded": _embed_loaded(),
    }


def _embed_loaded() -> bool:
    try:
        from knowledge.rag import _load_embed_model

        return _load_embed_model() is not None
    except Exception:
        return False


__all__ = [
    "load_builtin_corpus",
    "import_docs",
    "add_case",
    "crawl_and_index",
    "knowledge_stats",
]
