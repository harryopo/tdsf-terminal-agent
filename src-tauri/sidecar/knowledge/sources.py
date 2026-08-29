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
- 幂等：内置语料按 id 去重（INSERT OR REPLACE）；文档重索引前按 url
  删除同 url 旧块（分块数变化时 INSERT OR REPLACE 清不掉残留尾部块）
- 分块：**标题边界优先**——按 markdown 1-3 级标题切章节段，段超 ~1200 字
  再按段落二次切分（保持顺序编号）；替代旧 ~400 字固定切块（一篇文档
  曾被碎成几十片，无标题语义）
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import get_global_rag

logger = logging.getLogger("sidecar.knowledge.sources")

_CORPUS_DIR = Path(__file__).parent / "corpus"
_SKILLS_DIR = Path(__file__).parent.parent / "skills" / "builtin"
_SECTION_MAX_CHARS = 1200  # 章节段二次切分阈值（字符）

# markdown 1-3 级标题行（4 级以下标题不作为段落边界，保持章内聚合）
_HEADING_RE = re.compile(r"^(#{1,3})\s+(.*)$")


# ============================================================================
# 1. 内置教学语料
# ============================================================================

def load_builtin_corpus() -> int:
    """首次启动自动索引内置语料（幂等）

    - corpus/*.json：结构化语料（命令/概念/哲学/排障），已有数据时跳过
    - corpus/docs/*.md：精选教学文档（速查手册/备考资料），按文件分块
      幂等索引（id = md5(文件名-块号)，重复运行无害）

    Returns:
        本次入库条数
    """
    rag = get_global_rag()
    added = 0

    # 1. JSON 结构化语料（首次启动索引，已有数据跳过）
    if rag.count() == 0 and _CORPUS_DIR.exists():
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

    # 2. docs/*.md 精选教学文档（始终幂等索引，标题边界分块）
    docs_dir = _CORPUS_DIR / "docs"
    if docs_dir.exists():
        for f in sorted(docs_dir.glob("*.md")):
            try:
                text = f.read_text(encoding="utf-8", errors="ignore").strip()
                if not text:
                    continue
                # 旧块清理：同 url 旧块全删再入新块（分块数可能变少，仅
                # INSERT OR REPLACE 会残留旧策略的尾部块）
                rag.delete_by_url(str(f), id_prefix="doc-")
                chunks = _chunk_markdown(text)
                doc_hash = uuid.uuid5(uuid.NAMESPACE_URL, str(f))
                for i, (heading, chunk) in enumerate(chunks):
                    title = f"{f.stem} · {heading}" if heading else f.stem
                    entry = KnowledgeEntry(
                        id=f"doc-{doc_hash}-{i}",
                        source="builtin-docs",
                        title=title,
                        content=chunk,
                        url=str(f),
                        tags=["教学文档", f"file:{f.name}"],
                    )
                    rag.add(entry)
                added += len(chunks)
                logger.info(f"builtin doc indexed: {f.name} ({len(chunks)} chunks)")
            except Exception as e:
                logger.warning(f"doc load failed {f.name}: {e}")

    # 3. skills/builtin/*/SKILL.md 技能包入库（source=builtin-skills）
    #    skill_invoke 是主动调用通道，RAG 是被动检索通道——把技能正文也
    #    索引进知识库，用户问相关问题时能检索到（如 samba/SELinux 排障）
    skills_dir = _SKILLS_DIR
    if skills_dir.exists():
        for f in sorted(skills_dir.glob("*/SKILL.md")):
            try:
                text = f.read_text(encoding="utf-8", errors="ignore").strip()
                if not text:
                    continue
                rag.delete_by_url(str(f), id_prefix="skill-doc-")
                chunks = _chunk_markdown(text)
                doc_hash = uuid.uuid5(uuid.NAMESPACE_URL, str(f))
                for i, (heading, chunk) in enumerate(chunks):
                    title = f"{f.parent.name} · {heading}" if heading else f.parent.name
                    entry = KnowledgeEntry(
                        id=f"skill-doc-{doc_hash}-{i}",
                        source="builtin-skills",
                        title=title,
                        content=chunk,
                        url=str(f),
                        tags=["技能包", f"file:{f.parent.name}"],
                    )
                    rag.add(entry)
                added += len(chunks)
                logger.info(
                    f"builtin skill indexed: {f.parent.name} ({len(chunks)} chunks)"
                )
            except Exception as e:
                logger.warning(f"skill load failed {f.parent.name}: {e}")

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
            # 重导入旧块清理（同 url 全删再入新块，幂等）
            rag.delete_by_url(str(path), id_prefix="doc-")
            chunks = _chunk_markdown(text)
            doc_hash = uuid.uuid5(uuid.NAMESPACE_URL, str(path))
            for i, (heading, chunk) in enumerate(chunks):
                title = f"{path.name} · {heading}" if heading else path.name
                entry = KnowledgeEntry(
                    id=f"doc-{doc_hash}-{i}",
                    source=source,
                    title=title,
                    content=chunk,
                    url=str(path),
                    tags=["用户文档", f"file:{path.name}"],
                )
                rag.add(entry)
            imported += 1
        except Exception as e:
            logger.warning(f"doc import failed {path}: {e}")
            errors += 1
    return {"imported": imported, "skipped": 0, "errors": errors}


def _chunk_markdown(text: str) -> list[tuple[str, str]]:
    """标题边界优先分块（替代旧 ~400 字固定切块）

    策略：
    1. 按 1-3 级 markdown 标题行（``^#{1,3} ``）切章节段，每段 = 标题 +
       正文直到下一个 1-3 级标题；文件开头无标题的内容作为导语段
       （标题 ""）。更深的嵌套标题（如 h2 段内的 h3）不再细分——保证
       同一章节的分片段落聚合在一起、每块 title 带章节语义。
    2. 段落超过 ~1200 字时按空行段落二次切分（贪心装填，保持顺序）。

    Returns:
        [(节标题, 块文本), ...]；节标题为 "" 表示无标题段
    """
    sections: list[tuple[str, list[str]]] = []
    cur_title = ""
    cur_lines: list[str] = []
    in_fence = False
    fence_marker = ""
    for line in text.splitlines():
        stripped = line.lstrip()
        # 代码围栏（``` / ~~~）内的 # 是注释不是标题，跳过标题识别
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = stripped[:3]
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
            cur_lines.append(line)
            continue
        if not in_fence:
            m = _HEADING_RE.match(line)
            if m:
                if cur_lines:
                    sections.append((cur_title, cur_lines))
                cur_title = m.group(2).strip()
                cur_lines = [line]
                continue
        cur_lines.append(line)
    if cur_lines:
        sections.append((cur_title, cur_lines))

    chunks: list[tuple[str, str]] = []
    for title, lines in sections:
        body = "\n".join(lines).strip()
        if not body:
            continue
        if len(body) <= _SECTION_MAX_CHARS:
            chunks.append((title, body))
        else:
            for part in _split_long_section(body):
                chunks.append((title, part))
    return chunks


def _split_long_section(body: str) -> list[str]:
    """超长章节按空行段落贪心切分（每块 ≤ ~1200 字，保持顺序）

    单段自身超限时整段独立成块（不硬切行，保住表格/代码块完整性；
    向量入库侧已有 text[:500] 截断，FTS5 全文仍覆盖整块）。
    """
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    parts: list[str] = []
    buf: list[str] = []
    buf_len = 0
    for para in paragraphs:
        if buf and buf_len + len(para) + 2 > _SECTION_MAX_CHARS:
            parts.append("\n\n".join(buf))
            buf, buf_len = [], 0
        buf.append(para)
        buf_len += len(para) + 2
    if buf:
        parts.append("\n\n".join(buf))
    return parts


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

def crawl_and_index(
    source_key: str,
    url: str | None = None,
    offline: bool = False,
) -> dict[str, Any]:
    """调用爬虫抓取文档并入库

    Args:
        source_key: 爬虫注册名（nginx / generic，见 knowledge/crawlers/registry.py）
        url: 抓取目标 URL（爬虫基类 fetch 不支持单次 URL 覆盖，传入时
             显式拒绝 fail-closed——历史实现此分支会 TypeError 被吞成 error）
        offline: True 时爬虫仅读本地缓存（离线重放，不联网）

    Returns:
        {added, entries, error?}
    """
    try:
        from knowledge.crawlers.registry import get_crawler

        crawler = get_crawler(source_key)
        if crawler is None:
            return {"added": 0, "entries": 0, "error": f"unknown crawler: {source_key}"}
        if url:
            return {"added": 0, "entries": 0, "error": f"url override not supported: {url}"}
        # 新版爬虫接口（BFS 多页）：fetch 返回 CrawlerResult（entries 为
        # KnowledgeEntry 列表，success/error 标记整体成败），不再是 dict 列表
        result = crawler.fetch(offline=offline)
        if not result.success:
            return {
                "added": 0,
                "entries": 0,
                "error": result.error or f"crawl failed: {source_key}",
            }
        added = 0
        for entry in result.entries:
            get_global_rag().add(
                KnowledgeEntry(
                    id=entry.id or f"crawl-{uuid.uuid4().hex[:12]}",
                    source=entry.source or f"{source_key}-docs",
                    title=entry.title,
                    content=entry.content,
                    url=entry.url,
                    tags=entry.tags,
                )
            )
            added += 1
        return {"added": added, "entries": len(result.entries)}
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
