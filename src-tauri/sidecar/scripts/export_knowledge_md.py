#!/usr/bin/env python
"""
scripts/export_knowledge_md.py — 知识库导出本地 md 预览（TDSF 2026-08-30）
===========================================================================

用途：读 .tdsf-data/rag.db 官方条目（*-docs + archwiki + philosophy），按
**分类/源** 两级文件夹导出为本地 md 文件，供人工预览（用户钦定：「本质上
不就是 md 文件吗」）：

    <项目根>/knowledge-preview/<分类中文名>/<源名>/<标题>.md

- 分类 = 6+1 知识库分类（entries.category，category_for 映射），中文目录名：
  Linux哲学与命令对照 / 基础概念 / 命令与工具 / 系统管理 / 网络与远程 /
  安全加固 / 服务部署；category 为空归「其他」
- 一条知识 = 一个 md 文件（整页合并条目）；同 url 多块时正文按序拼接
- 文件名 = 标题 slug 化（Windows 非法字符 <>:"/\\|?* 与控制符替换为 _，
  保留中文；截断 80 字符；空标题回退 url 文件名；重名自动追加 -2/-3）
- 头部 frontmatter：source / url / title / category / zh_title / summary_zh
  （有则写）+ content_zh 全文译文（translate_knowledge.py 已翻译时）
- doc_titles_zh 的中文标题写进 frontmatter + 正文顶部「# 中文标题」
- 幂等：重跑覆盖（先清空导出目录再导出，条目减少不留陈旧文件）
- 导出后打印导出位置与每分类/每源文件数统计

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/export_knowledge_md.py
    .venv/Scripts/python.exe scripts/export_knowledge_md.py --source archwiki
    .venv/Scripts/python.exe scripts/export_knowledge_md.py --out D:/preview
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sys
from pathlib import Path

# 与应用/rebuild_knowledge.py 读写同一个 rag.db（<项目根>/.tdsf-data）
PROJECT_ROOT = Path(__file__).resolve().parents[3]
os.environ["TDSF_DATA_DIR"] = str(PROJECT_ROOT / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.export_knowledge_md")

# Windows 保留文件名（不含扩展名部分命中即非法）
_WIN_RESERVED = frozenset({
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
})

# Windows 文件名非法字符 + 控制字符
_WIN_ILLEGAL_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

_FILENAME_MAX = 80  # 文件名截断长度（保留 .md 后缀余量）

# 6+1 分类 key → 中文目录名（与 knowledge.sources.category_for 对齐）
CATEGORY_DIR_NAMES: dict[str, str] = {
    "linux-philosophy": "Linux哲学与命令对照",
    "basic-ops": "基础概念",
    "cmd-tools": "命令与工具",
    "sys-admin": "系统管理",
    "net-remote": "网络与远程",
    "security": "安全加固",
    "services": "服务部署",
}


def category_dir_name(category: str) -> str:
    """category key → 中文目录名；空/未知归「其他」"""
    return CATEGORY_DIR_NAMES.get(category or "", "其他")


def slugify_filename(title: str, fallback: str) -> str:
    """标题 → Windows 安全文件名（保留中文；非法字符替换为 _）"""
    name = _WIN_ILLEGAL_RE.sub("_", title).strip(" .")
    if len(name.encode("utf-8")) > _FILENAME_MAX * 3 or len(name) > _FILENAME_MAX:
        name = name[:_FILENAME_MAX].rstrip(" .")
    if not name:
        name = _WIN_ILLEGAL_RE.sub("_", fallback).strip(" .")[:_FILENAME_MAX]
    if not name:
        name = hashlib.md5(fallback.encode("utf-8")).hexdigest()[:12]
    stem = name.split(".")[0].strip() or name
    if stem.upper() in _WIN_RESERVED:
        name = f"_{name}"
    return name


def export_all(out_dir: Path, source_filter: str | None) -> dict[str, int]:
    """导出官方条目为 md 文件（<分类>/<源>/<标题>.md），返回 {分类/源: 文件数}"""
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    files = rag.list_files(source=source_filter)
    # 官方源 + philosophy 教学语料（imported-docs/case 为个人语料不导出）
    official = [
        f for f in files
        if str(f["source"]).endswith("-docs")
        or f["source"] in ("archwiki", "philosophy")
    ]
    if not official:
        logger.warning("no exportable files found（先跑 rebuild_knowledge.py --crawl-all）")
        return {}

    titles = {t["url"]: t for t in rag.titles_zh()}

    counts: dict[str, int] = {}
    for f in official:
        source = str(f["source"])
        category = str(f.get("category", ""))
        url = str(f["url"])
        doc = rag.get_doc(url)
        if doc is None or not str(doc.get("content", "")).strip():
            continue
        zh_row = titles.get(url, {})
        zh_title = str(zh_row.get("zh", "")).strip()
        summary = str(zh_row.get("summary_zh", "")).strip()
        content_zh = str(doc.get("content_zh", "") or "").strip()

        # 两级目录：<分类中文名>/<源名>/
        source_dir = out_dir / category_dir_name(category) / source
        source_dir.mkdir(parents=True, exist_ok=True)

        base = slugify_filename(str(doc.get("title") or f.get("title0") or ""), f.get("filename", url))
        path = source_dir / f"{base}.md"
        # 重名自动追加序号（同源不同文档同标题的场景）
        seq = 2
        while path.exists():
            path = source_dir / f"{base}-{seq}.md"
            seq += 1

        lines: list[str] = [
            "---",
            f"source: {source}",
            f"category: {category or '其他'}",
            f"url: {url}",
            f"title: {str(doc.get('title', '')).strip()}",
        ]
        if zh_title:
            lines.append(f"zh_title: {zh_title}")
        if summary:
            lines.append(f"summary_zh: {summary}")
        lines.append("---")
        lines.append("")
        if zh_title:
            lines.append(f"# {zh_title}")
            lines.append("")
        lines.append(str(doc.get("content", "")).rstrip())
        lines.append("")
        # 中文译文（translate_knowledge.py 已翻译时导出——双语对照）
        if content_zh:
            lines.append("## 中文译文")
            lines.append("")
            lines.append(content_zh)
            lines.append("")
        lines.append("---")
        lines.append(f"来源：{url}")
        path.write_text("\n".join(lines), encoding="utf-8")
        count_key = f"{category_dir_name(category)}/{source}"
        counts[count_key] = counts.get(count_key, 0) + 1
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知识库导出本地 md 预览")
    parser.add_argument("--source", default=None, help="仅导出指定源（默认全部官方源）")
    parser.add_argument(
        "--out",
        default=None,
        help="导出目录（默认 <项目根>/knowledge-preview）",
    )
    parser.add_argument(
        "--keep-stale",
        action="store_true",
        help="保留目标目录中本次未导出的旧文件（默认清空各源目录，幂等）",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    out_dir = Path(args.out) if args.out else PROJECT_ROOT / "knowledge-preview"

    # 幂等：默认先清空导出目录（条目减少后不留陈旧 md 文件）
    if out_dir.exists() and not args.keep_stale:
        import shutil

        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    counts = export_all(out_dir, args.source)
    if not counts:
        return 1

    total = sum(counts.values())
    print("\n=== 知识库 md 导出完成 ===")
    print(f"{'source':<26}{'files':>8}")
    for source in sorted(counts):
        print(f"{source:<26}{counts[source]:>8}")
    print(f"{'TOTAL':<26}{total:>8}")
    print(f"\n导出位置：{out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
