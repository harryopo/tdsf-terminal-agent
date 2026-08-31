#!/usr/bin/env python
"""
scripts/export_knowledge_md.py — 知识库导出本地 md 预览（TDSF 2026-08-30）
===========================================================================

用途：读 .tdsf-data/rag.db 官方条目（*-docs + archwiki + philosophy），按
**分类** 一级文件夹导出为本地 md 文件，供人工预览（用户钦定：「本质上
不就是 md 文件吗」）：

    <项目根>/knowledge-preview/<分类中文名>/<文件名>.md

- 分类 = 6+1 知识库分类（entries.category，category_for 映射），中文目录名：
  Linux哲学与命令对照 / 基础概念 / 命令与工具 / 系统管理 / 网络与远程 /
  安全加固 / 服务部署；category 为空归「其他」
- **TDSF 2026-08-31 知识库大整合新结构**：合并文档（url 以 consolidated/
  开头，7 分类 × ≤5 大文件）一级目录导出，文件名 = 合并中文文件名
  （url 最后段）；get_doc 按 url 聚合分块还原完整文档，整页内容与
  consolidate_knowledge.py 生成的合并文件一致（幂等校验）
- 同 url 多块时正文按序拼接（get_doc 语义）
- 文件名 slug 化消毒（Windows 非法字符替换为 _，保留中文；重名追加 -2/-3）
- 头部 frontmatter：source / url / title / category / zh_title / summary_zh
  （有则写）+ content_zh 全文译文（translate_knowledge.py 已翻译时）
- doc_titles_zh 的中文标题写进 frontmatter + 正文顶部「# 中文标题」
- 幂等：重跑覆盖（先清空导出目录再导出，条目减少不留陈旧文件）
- 导出后打印导出位置与每分类文件数统计
- **格式校验（TDSF 2026-08-30 根因修复）**：正文含 <!DOCTYPE/<html/<table
  等原始 HTML 标记 → 该条**拒绝导出**并告警（爬虫 HTML→MD 转换失效的信号，
  脏数据不进预览目录）

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


# 原始 HTML 标记（正文头部出现 = 爬虫 HTML→MD 转换失效，脏数据拒绝导出）。
# 只取"整页 HTML 未转换"的强信号（<table>/<html>/<!doctype/<body>），不含
# <div>/<span>——代码示例正文里合法出现的内联标签不误伤（TDSF 2026-08-30）
_RAW_HTML_RE = re.compile(
    r"<!doctype\s|<html[\s>]|<table[\s>]|<body[\s>]",
    re.IGNORECASE,
)


def has_raw_html(content: str) -> bool:
    """正文前 2000 字符含原始 HTML 标记 → True（导出校验，TDSF 2026-08-30）"""
    return bool(_RAW_HTML_RE.search(content[:2000]))


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


def export_all(
    out_dir: Path,
    source_filter: str | None,
    rag=None,
) -> dict[str, int]:
    """导出官方条目为 md 文件（<分类>/<文件名>.md 一级目录），返回 {分类: 文件数}

    Args:
        out_dir: 导出根目录
        source_filter: 可选，仅导出指定 source
        rag: 可选，RagIndex 实例（--slim 模式传精简库；None = 全量库）
    """
    if rag is None:
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
        logger.warning("no exportable files found（先跑 rebuild_from_consolidated.py）")
        return {}

    titles = {t["url"]: t for t in rag.titles_zh()}

    counts: dict[str, int] = {}
    rejected_raw_html = 0
    for f in official:
        source = str(f["source"])
        category = str(f.get("category", ""))
        url = str(f["url"])
        doc = rag.get_doc(url)
        if doc is None or not str(doc.get("content", "")).strip():
            continue
        content = str(doc.get("content", ""))
        # 格式校验：正文含原始 HTML 标记 = 转换器失效脏数据，拒绝导出并告警
        if has_raw_html(content):
            rejected_raw_html += 1
            logger.warning(
                f"REJECT export (raw HTML in content, crawler bug): "
                f"{source} {url} title={doc.get('title', '')!r}"
            )
            continue
        zh_row = titles.get(url, {})
        zh_title = str(zh_row.get("zh", "")).strip()
        summary = str(zh_row.get("summary_zh", "")).strip()
        content_zh = str(doc.get("content_zh", "") or "").strip()

        # 一级目录：<分类中文名>/<文件名>.md
        # 合并文档（url 以 consolidated/ 开头）文件名 = url 最后段（中文合并
        # 文件名）；philosophy 等回退 slug 化标题
        category_dir = out_dir / category_dir_name(category)
        category_dir.mkdir(parents=True, exist_ok=True)

        base = slugify_filename(
            str(doc.get("filename") or f.get("title0") or ""), f.get("filename", url)
        )
        if not base.lower().endswith(".md"):
            base += ".md"
        path = category_dir / base
        # 重名自动追加序号（同分类不同文档同文件名的场景）
        seq = 2
        while path.exists():
            stem, dot, ext = base.rpartition(".")
            path = category_dir / f"{stem}-{seq}{dot}{ext}"
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
        # 中文标题顶部行：合并文档正文已自带 `# 大标题`（与 zh_title 同文本）
        # 时不重复插入（TDSF 2026-08-31 大整合新结构）
        head = content.lstrip()
        if zh_title and not head.startswith(f"# {zh_title}"):
            lines.append(f"# {zh_title}")
            lines.append("")
        lines.append(content.rstrip())
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
        count_key = category_dir_name(category)
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
    parser.add_argument(
        "--slim",
        action="store_true",
        help=(
            "导出精简库 rag_slim.db（distill_knowledge.py 生成的 LLM 每章"
            "提炼版）到 knowledge-slim-preview/，供用户预览"
        ),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    rag = None
    if args.slim:
        from knowledge.rag import get_slim_rag

        rag = get_slim_rag()
    out_dir = (
        Path(args.out)
        if args.out
        else PROJECT_ROOT / (
            "knowledge-slim-preview" if args.slim else "knowledge-preview"
        )
    )

    # 幂等：默认先清空导出目录（条目减少后不留陈旧 md 文件）
    if out_dir.exists() and not args.keep_stale:
        import shutil

        shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    counts = export_all(out_dir, args.source, rag=rag)
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
