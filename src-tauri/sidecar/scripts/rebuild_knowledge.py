#!/usr/bin/env python
"""
scripts/rebuild_knowledge.py — 知识库重建运维脚本（一次性）
===========================================================

用途：
- 可选触发官方文档爬虫入库（--crawl <source> / --crawl-all）
- 打印各 source 统计（文件数/块数/总字符数）

注：内置教学语料已剔除（个人语料改为用户手动导入 knowledge.import_docs，
2026-08-30），本脚本不再重建内置索引。

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/rebuild_knowledge.py
    .venv/Scripts/python.exe scripts/rebuild_knowledge.py --no-clear
    .venv/Scripts/python.exe scripts/rebuild_knowledge.py --crawl nginx-docs
    .venv/Scripts/python.exe scripts/rebuild_knowledge.py --crawl-all --offline

⚠️ 默认清空 rag.db 全部条目（含会话沉淀案例）后全量重建；需保留现有
   条目请传 --no-clear（仅增量重建内置索引，docs/import 按文件替换旧块）。
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

# TDSF 2026-08-30 根因修复：与应用（main.py）读写同一个 rag.db（<项目根>/.tdsf-data）。
# 此前本脚本落到 sidecar/data/rag.db（第二个库），清库/重爬全修在应用不读的库上。
# RagIndex 实例化时才读 TDSF_DATA_DIR，先 set 再 import 即生效；强制 set 防环境缺失。
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.rebuild_knowledge")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知识库重建运维脚本")
    parser.add_argument(
        "--crawl",
        action="append",
        default=[],
        metavar="SOURCE",
        help="重建前先执行指定爬虫入库（可多次，如 --crawl nginx-docs）",
    )
    parser.add_argument(
        "--crawl-all",
        action="store_true",
        help="重建前执行全部 14 个官方文档爬虫入库",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="爬虫仅读本地缓存（离线重放，不联网）",
    )
    parser.add_argument(
        "--no-clear",
        action="store_true",
        help="保留现有条目（不清空 rag.db），仅增量重建内置索引",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from knowledge import sources
    from knowledge.rag import get_global_rag

    rag = get_global_rag()

    # 0) 可选：清空全量重建
    if not args.no_clear:
        cleared = rag.rebuild()
        logger.info(f"rag.db cleared (entries removed: {cleared})")

    # 1) 可选：官方文档爬取入库
    if args.crawl_all:
        from knowledge.crawlers.registry import list_crawlers

        crawl_targets = list_crawlers()
    else:
        crawl_targets = list(args.crawl)
    for name in crawl_targets:
        result = sources.crawl_and_index(name, offline=args.offline)
        if result.get("error"):
            logger.warning(f"crawl {name} failed: {result['error']}")
        else:
            logger.info(f"crawl {name}: added {result['added']} entries")

    # 2) 统计（各 source 文件数/块数/总字符数 + 各 category 分布）
    # 注：内置教学语料已剔除（个人语料改为用户手动导入，2026-08-30）；
    #     philosophy/（Linux 哲学与命令对照，第 7 分类）为随源码分发的
    #     教学语料，重建后由 load_philosophy_docs 幂等补齐
    rows = rag.stats_by_source()
    total_files = sum(r["files"] for r in rows)
    total_chunks = sum(r["chunks"] for r in rows)
    total_chars = sum(r["total_chars"] for r in rows)
    print("\n=== 知识库统计（按 source） ===")
    print(f"{'source':<26}{'files':>8}{'chunks':>8}{'chars':>12}")
    for r in rows:
        print(
            f"{r['source']:<26}{r['files']:>8}{r['chunks']:>8}{r['total_chars']:>12}"
        )
    print(f"{'TOTAL':<26}{total_files:>8}{total_chunks:>8}{total_chars:>12}")

    cat_rows = rag.stats_by_category()
    if cat_rows:
        from knowledge.sources import load_philosophy_docs

        # 重建后 philosophy 教学语料幂等补齐（随源码分发，不依赖爬虫）
        if not args.no_clear:
            phil = load_philosophy_docs(rag)
            logger.info(
                f"philosophy corpus reloaded: {phil['files']} files, "
                f"{phil['chunks']} chunks"
            )
            cat_rows = rag.stats_by_category()
        print("\n=== 知识库统计（按 category，6+1 分类） ===")
        print(f"{'category':<20}{'files':>8}{'chunks':>8}{'chars':>12}")
        for r in cat_rows:
            print(
                f"{r['category'] or '(未分类)':<20}"
                f"{r['files']:>8}{r['chunks']:>8}{r['total_chars']:>12}"
            )
    print(f"\ndb: {rag.db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
