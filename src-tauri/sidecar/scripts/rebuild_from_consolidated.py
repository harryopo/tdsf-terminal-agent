#!/usr/bin/env python
"""
scripts/rebuild_from_consolidated.py — 从合并 md 重建 rag.db（TDSF 2026-08-31）
================================================================================

知识库大整合第二步（db 才是 RAG 主体）：读 knowledge-preview/ 合并文件 →
按标题边界分块（复用 knowledge.sources._chunk_markdown）→ 入库。

设计（用户钦定）：
- 合并文件在**入库层**按标题边界分块——单条几十万字符超出嵌入（fastembed
  text[:2000] 截断）与检索粒度限制；块 title=`合并标题 · 章节标题`，块
  category/source 沿用 frontmatter，url=合并文件逻辑 id（frontmatter url），
  块 id=`consol-<hash>-<序号>` 保序 → RAG 检索命中块 → 前端 get_doc 按
  url 聚合显示完整合并文档
- 分块边界只落在 `## 序号. 来源章节`（consolidate_knowledge 已把来源内
  标题降级到 ####），块 title 语义 =「合并文件 · 来源章节」；超 ~1200 字
  的章节二次切分（同 title 多块，顺序保序）
- philosophy 4 篇（第 7 分类）不参与：全量重建后由 load_philosophy_docs
  幂等补齐（保持独立，jump 过「Linux哲学与命令对照」目录）
- doc_titles_zh 按合并文件重生成（zh=合并中文标题；summary_zh=frontmatter
  摘要，非 LLM 版——LLM 精修可后续跑 gen_titles_zh.py，后台待命不阻塞）
- 幂等：全量模式 rag.rebuild() 清空后重建；--file 单文件模式
  delete_by_url 后重入（重跑覆盖）

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/rebuild_from_consolidated.py
    .venv/Scripts/python.exe scripts/rebuild_from_consolidated.py --preview D:/preview
    .venv/Scripts/python.exe scripts/rebuild_from_consolidated.py --file "d:/.../Web 服务器（Nginx 与 Apache）.md"
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import uuid
from pathlib import Path

# 与应用读写同一个 rag.db（<项目根>/.tdsf-data）
PROJECT_ROOT = Path(__file__).resolve().parents[3]
os.environ["TDSF_DATA_DIR"] = str(PROJECT_ROOT / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.rebuild_from_consolidated")

# 分类中文目录 → category key（与 consolidate_knowledge.CATEGORY_DIR_NAMES 对齐）
DIR_TO_CATEGORY: dict[str, str] = {
    "Linux哲学与命令对照": "linux-philosophy",
    "基础概念": "basic-ops",
    "命令与工具": "cmd-tools",
    "系统管理": "sys-admin",
    "网络与远程": "net-remote",
    "安全加固": "security",
    "服务部署": "services",
}

# philosophy 保持独立（第 7 分类不读合并文件，由 load_philosophy_docs 负责）
PHILOSOPHY_DIR_NAME = "Linux哲学与命令对照"

_CONSOL_ID_PREFIX = "consol-"
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """解析合并文件 frontmatter（简单 key: value 行），返回 (meta, 正文)"""
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        if ": " in line:
            key, _, value = line.partition(": ")
            meta[key.strip()] = value.strip()
        elif line.strip().endswith(":"):
            meta[line.strip()[:-1]] = ""
    return meta, text[m.end():]


def load_consolidated_dir(
    preview_dir: Path,
    rag=None,
    reset: bool = False,
    single_file: Path | None = None,
) -> dict:
    """读合并 md → 分块入库

    Args:
        preview_dir: knowledge-preview 目录（下含 7 分类中文目录）
        rag: RagIndex 实例（默认全局单例；测试注入临时库）
        reset: True 时先 rag.rebuild() 全清 + load_philosophy_docs 幂等补齐
        single_file: 可选，仅重建该 md 文件（单文件幂等模式，不全清）

    Returns:
        {files, chunks, errors, titles_written}
    """
    from knowledge.sources import _chunk_markdown, load_philosophy_docs

    rag = rag or _get_rag()
    if reset:
        cleared = rag.rebuild()
        logger.info(f"rag.db cleared (entries removed: {cleared})")
        phil = load_philosophy_docs(rag)
        logger.info(
            f"philosophy corpus reloaded: {phil['files']} files, {phil['chunks']} chunks"
        )

    files_iter: list[Path] = []
    if single_file is not None:
        files_iter = [single_file]
    else:
        for dir_name in sorted(DIR_TO_CATEGORY):
            if dir_name == PHILOSOPHY_DIR_NAME:
                continue
            d = preview_dir / dir_name
            if d.is_dir():
                files_iter.extend(sorted(d.glob("*.md")))

    files = 0
    errors = 0
    total_chunks = 0
    titles: dict[str, str] = {}
    summaries: dict[str, str] = {}
    for md_path in files_iter:
        try:
            text = md_path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(text)
            url = (meta.get("url") or "").strip()
            title = (meta.get("zh_title") or meta.get("title") or "").strip()
            if not text.strip() or not url or not title:
                logger.warning(f"skip (missing frontmatter url/title): {md_path.name}")
                errors += 1
                continue
            # 目录名反查 category（frontmatter category 优先，缺省按目录）
            dir_category = DIR_TO_CATEGORY.get(md_path.parent.name, "")
            category = (meta.get("category") or dir_category).strip()
            source = (meta.get("source") or "").strip()
            # 幂等：同 url 旧块全删再入新块（分块数变化时清残留尾部块）
            rag.delete_by_url(url, id_prefix=_CONSOL_ID_PREFIX)
            chunks = _chunk_markdown(body)
            doc_hash = uuid.uuid5(uuid.NAMESPACE_URL, url)
            for i, (heading, chunk) in enumerate(chunks):
                # 导语段的一级标题即合并标题本身（heading == title），后缀去重
                block_title = (
                    title
                    if not heading or heading == title
                    else f"{title} · {heading}"
                )
                rag.add(
                    _make_entry(
                        id=f"{_CONSOL_ID_PREFIX}{doc_hash}-{i}",
                        source=source,
                        title=block_title,
                        content=chunk,
                        url=url,
                        category=category,
                        tags=["合并文档", f"file:{md_path.name}"],
                    )
                )
            files += 1
            total_chunks += len(chunks)
            titles[url] = title
            summaries[url] = meta.get("summary_zh", "")
            logger.info(
                f"indexed: {md_path.parent.name}/{md_path.name} ({len(chunks)} chunks)"
            )
        except Exception as e:
            errors += 1
            logger.warning(f"consolidated load failed {md_path.name}: {e}")

    # doc_titles_zh 按合并文件重生成（upsert，url=合并文件逻辑 id）
    titles_written = rag.upsert_titles_zh(titles, summaries) if titles else 0
    return {
        "files": files,
        "chunks": total_chunks,
        "errors": errors,
        "titles_written": titles_written,
    }


def _make_entry(**kwargs):
    """构造 KnowledgeEntry（独立小函数便于测试 patch）"""
    from knowledge.fts5 import KnowledgeEntry

    return KnowledgeEntry(**kwargs)


def _get_rag():
    from knowledge.rag import get_global_rag

    return get_global_rag()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="从合并 md 重建 rag.db")
    parser.add_argument(
        "--preview",
        default=None,
        help="合并文件目录（默认 <项目根>/knowledge-preview）",
    )
    parser.add_argument(
        "--file",
        default=None,
        help="仅重建指定 md 文件（单文件幂等模式，不全清）",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    preview_dir = (
        Path(args.preview) if args.preview else PROJECT_ROOT / "knowledge-preview"
    )
    if not preview_dir.is_dir():
        raise SystemExit(f"目录不存在：{preview_dir}（先跑 consolidate_knowledge.py）")
    single_file = Path(args.file) if args.file else None

    result = load_consolidated_dir(
        preview_dir, reset=single_file is None, single_file=single_file
    )

    # 统计（各 category 文件数/块数/字符数）
    rag = _get_rag()
    print("\n=== 合并知识库重建完成 ===")
    print(
        f"files={result['files']} chunks={result['chunks']} "
        f"errors={result['errors']} titles_zh={result['titles_written']}"
    )
    print("\n=== 知识库统计（按 category） ===")
    print(f"{'category':<20}{'files':>8}{'chunks':>8}{'chars':>12}")
    cat_rows = rag.stats_by_category()
    for r in cat_rows:
        print(
            f"{(r['category'] or '(未分类)'):<20}"
            f"{r['files']:>8}{r['chunks']:>8}{r['total_chars']:>12}"
        )
    print(f"{'TOTAL':<20}{rag.count():>8}")
    print(f"\ndb: {rag.db_path}")
    print("下一步：.venv/Scripts/python.exe scripts/export_knowledge_md.py（幂等校验导出）")
    return 0 if result["errors"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
