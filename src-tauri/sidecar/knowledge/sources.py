"""
knowledge/sources.py — 知识库内容源（P2-4，三路）
===================================================

1. **文档导入**：用户手动导入 .md（前端读文件内容后经 RPC
   knowledge.import_docs 传入，fail-closed 仅接受 .md）——内置教学语料
   （corpus/ 命令卡片、docs/ 教学文档、SKILL 技能包）属个人语料，不随
   应用分发，已于 2026-08-30 从默认索引剔除，改为用户手动导入
2. **会话案例沉淀**：排障案例/经验从会话写入（RPC knowledge.add_case），
   决策库雏形（链接 P2-4 长期规划）
3. **在线爬取**：crawlers 框架（nginx/generic），RPC knowledge.crawl 触发

设计：
- 所有入口统一转 KnowledgeEntry → RagIndex.add
- 幂等：文档重导入前按 url 删除同 url 旧块（分块数变化时
  INSERT OR REPLACE 清不掉残留尾部块）
- 分块：**标题边界优先**——按 markdown 1-3 级标题切章节段，段超 ~1200 字
  再按段落二次切分（保持顺序编号）；替代旧 ~400 字固定切块（一篇文档
  曾被碎成几十片，无标题语义）
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from knowledge.crawlers.clean import clean_markdown
from knowledge.fts5 import KnowledgeEntry
from knowledge.rag import get_global_rag

logger = logging.getLogger("sidecar.knowledge.sources")

_SECTION_MAX_CHARS = 1200  # 章节段二次切分阈值（字符）

# markdown 1-3 级标题行（4 级以下标题不作为段落边界，保持章内聚合）
_HEADING_RE = re.compile(r"^(#{1,3})\s+(.*)$")


# ============================================================================
# 1. 文档导入（分块；个人语料改为用户手动导入的唯一通道）
# ============================================================================

def import_docs(
    files: list[dict[str, str]],
    source: str = "imported-docs",
) -> dict[str, Any]:
    """导入 md 文档入库（fail-closed：仅接受 .md，其他一律拒绝）

    内置教学语料已剔除（个人语料不随应用分发），本函数是个人文档
    进入知识库的唯一通道。Web 安全模型下 file input 拿不到绝对路径，
    前端读文件内容后按 {name, content} 传入（与 composer 附件/主题
    导入同款文件选择机制）。

    Args:
        files: [{name: 文件名, content: 文件文本}]；name 用于 fail-closed
               后缀校验（仅 .md）与 url/title 生成，content 为 md 全文
        source: 来源标记（默认 imported-docs）

    Returns:
        {imported: 成功文件数, skipped: 空文件数, errors: 导入失败数,
         rejected: [{name, reason}]（非 .md / 内容缺失，fail-closed）}

    幂等：url = 文件名（不含路径），重导入同名文件自动清旧块再入新块
    （同名视为同一文档的新版本）。
    """
    rag = get_global_rag()
    imported = 0
    skipped = 0
    errors = 0
    rejected: list[dict[str, str]] = []
    for item in files:
        name = str(item.get("name", "")).strip()
        content = item.get("content") or ""
        # fail-closed：仅接受 .md（个人文档导入的唯一格式约定）
        if not name.lower().endswith(".md"):
            rejected.append({"name": name, "reason": f"仅支持 .md 文件: {name}"})
            logger.warning(f"doc import rejected (not .md): {name}")
            continue
        if not name:
            rejected.append({"name": name, "reason": "缺少文件名"})
            continue
        text = content.strip()
        if not text:
            skipped += 1
            continue
        try:
            url = name
            # 重导入旧块清理（同 url 全删再入新块，幂等）
            rag.delete_by_url(url, id_prefix="doc-")
            chunks = _chunk_markdown(text)
            doc_hash = uuid.uuid5(uuid.NAMESPACE_URL, url)
            for i, (heading, chunk) in enumerate(chunks):
                title = f"{name} · {heading}" if heading else name
                entry = KnowledgeEntry(
                    id=f"doc-{doc_hash}-{i}",
                    source=source,
                    title=title,
                    content=chunk,
                    url=url,
                    tags=["用户文档", f"file:{name}"],
                )
                rag.add(entry)
            imported += 1
            logger.info(f"doc imported: {name} ({len(chunks)} chunks)")
        except Exception as e:
            logger.warning(f"doc import failed {name}: {e}")
            errors += 1
    return {
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "rejected": rejected,
    }


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
    # 分块前清洗（TDSF 2026-08-30）：导入的 md 同样混入 emoji/导航残渣/
    # HTML 实体，统一走 clean_markdown（保留 # 标题与列表结构、保护代码块）
    text = clean_markdown(text)
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
    "import_docs",
    "add_case",
    "crawl_and_index",
    "knowledge_stats",
]
