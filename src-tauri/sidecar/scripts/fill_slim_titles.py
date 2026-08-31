#!/usr/bin/env python
"""
scripts/fill_slim_titles.py — 精简库中文标题映射 + 占位块清理（幂等运维脚本）
==============================================================================

双库方案 TDSF 2026-08-31 配套：agent 检索（knowledge_search）与前端知识浏览器
主读精简库 rag_slim.db 后，slim 库需要自己的 doc_titles_zh 中文标题映射
（此前映射只填在全量库 rag.db，slim 库 titles_zh 为空 → 前端回退英文文件名）。

做两件事（均可安全重复执行）：

1. 中文标题映射（修 2）：
   - consolidated/<category>/<文档名>.md → 文档名已是中文，直接提取做 zh
     （如 "consolidated/services/Web 服务器（Nginx 与 Apache）.md" →
     "Web 服务器（Nginx 与 Apache）"）
   - 非 consolidated url（教学语料 slug，如 linux_philosophy.md）：
     优先查全量库 doc_titles_zh 同 url 映射 → 内置 SLUG_TITLES 常量
     （标题取自语料文档 H1 原文）→ 兜底 slug 下划线转空格
   - summary_zh：该 url 首块 content 前 100 字（slim 库无 frontmatter，
     content 即中文提炼正文）
   - 写入走 RagIndex.upsert_titles_zh（INSERT ON CONFLICT UPDATE，天然幂等）

2. 占位块清理（修 4）：删除 content 以「未提供正文内容，无法提炼」开头的块
   （distill LLM 失败的 fallback 产物，占位前缀后可能拼有残留笔记，属脏数据）。
   走 RagIndex.delete 保证 entries/fts_entries/vec_entries 三表联动删除。

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/fill_slim_titles.py
"""
from __future__ import annotations

import logging
import os
import re
import sys
from pathlib import Path

# 与 distill_knowledge.py / rebuild_knowledge.py 读写同一批 db（<项目根>/.tdsf-data）
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.fill_slim_titles")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

# 占位块前缀（distill_knowledge.py LLM 失败 fallback 写入的开头）
_PLACEHOLDER_PREFIX = "未提供正文内容，无法提炼"

# 非 consolidated slug 文档的中文标题（取自教学语料文档 H1 原文，
# 2026-08-31 探针确认；全量库 doc_titles_zh 无这些 url 的映射）
SLUG_TITLES: dict[str, str] = {
    "command_design.md": "Linux 命令设计——从英文词源理解命令",
    "command_etymology.md": "命令中英文对照与词源",
    "linux_directory_logic.md": "Linux 目录结构设计逻辑",
    "linux_philosophy.md": "Linux 设计哲学",
}

# summary_zh 截取长度（对齐全量库 gen_titles_zh.py 的中文摘要量级，
# slim 无独立摘要来源，用首块正文前 100 字）
_SUMMARY_CHARS = 100

# list_entries 单次拉取上限（slim 库 661 块，余量充足）
_MAX_ENTRIES = 2000

_WS_RE = re.compile(r"\s+")


def _doc_name_from_consolidated_url(url: str) -> str | None:
    """consolidated/<category>/<文档名>.md → 文档名；非 consolidated 返回 None"""
    parts = url.replace("\\", "/").split("/")
    if len(parts) >= 3 and parts[0] == "consolidated" and parts[-1]:
        return parts[-1].removesuffix(".md") or None
    return None


# 摘要清洗：markdown 语法符号剥离模式（用户实测反馈摘要以 ###/---/> 开头）
_MD_NOISE_RE = re.compile(
    r"```.*?```"          # 代码块整体删除（摘要里放命令堆无意义）
    r"|^#{1,6}\s*"        # 标题前缀 ##/###
    r"|^>\s?"             # 引用前缀
    r"|^[-*]\s"           # 列表符
    r"|^\|[-: |]+\|"      # 表格分隔行 |---|---|
    r"|\|"                # 表格竖线
    r"|`"                 # 行内代码反引号
    r"|\*\*?"             # 粗体/斜体星号
    r"|^\-{3,}\s*$",      # 分隔线 ---
    re.M,
)


def _clean_summary(text: str) -> str:
    """首块正文 → 单行纯文本摘要（跳过开头标题/引用行 + 剥 markdown + 截 100 字）

    实测教训：首块常以「## 30. 概述」「## sftp-server ...」等标题行开头，
    只剥符号会把"30. 概述"留作摘要开头——先跳过开头的标题/引用/分隔行，
    从首个叙述性正文行取摘要。
    """
    lines = text.splitlines()
    body: list[str] = []
    for line in lines:
        s = line.strip()
        if not s:
            continue
        # 开头的结构行（标题/引用/分隔/表格头）跳过，遇正文段落即停
        if not body and (
            re.match(r"^#{1,6}\s", s)
            or s.startswith(">")
            or re.match(r"^\|", s)
            or re.match(r"^-{3,}$", s)
            or s.startswith("<!--")
        ):
            continue
        body.append(s)
    text = "\n".join(body) if body else text
    text = _MD_NOISE_RE.sub(" ", text)
    return _WS_RE.sub(" ", text).strip()[:_SUMMARY_CHARS]


def fill_titles() -> int:
    """从 url / 全量库映射生成 slim 库 doc_titles_zh（幂等），返回写入条数"""
    from knowledge.rag import get_global_rag, get_slim_rag

    slim = get_slim_rag()
    full = get_global_rag()

    # 全部带 url 的文档（list_files 即 distinct url 聚合，公共方法免锁内查询）
    files = slim.list_files()
    if not files:
        logger.warning("slim 库无带 url 条目，跳过标题映射")
        return 0

    # 每个 url 的首块 content（list_entries 按 rowid 倒序 → 反转后首个即首块）
    first_block: dict[str, str] = {}
    for e in reversed(slim.list_entries(limit=_MAX_ENTRIES)):
        u = str(e.get("url") or "")
        if u and u not in first_block:
            first_block[u] = str(e.get("content") or "")

    # 全量库已有映射优先（url 完全一致时复用离线 LLM 产物）
    full_zh = {t["url"]: t["zh"] for t in full.titles_zh()}

    mapping: dict[str, str] = {}
    summaries: dict[str, str] = {}
    for f in sorted(files, key=lambda x: str(x["url"])):
        url = str(f["url"])
        zh = _doc_name_from_consolidated_url(url)
        if zh is None:
            zh = (
                full_zh.get(url)
                or SLUG_TITLES.get(str(f["filename"]))
                or str(f["filename"]).replace("_", " ")
            )
        mapping[url] = zh
        summaries[url] = _clean_summary(first_block.get(url, ""))

    n = slim.upsert_titles_zh(mapping, summaries)
    logger.info(f"标题映射写入 {n} 条（distinct url {len(files)} 个）")
    return n


def remove_placeholder_blocks() -> int:
    """删除 content 以占位前缀开头的块（三表联动，幂等），返回删除条数"""
    from knowledge.rag import get_slim_rag

    slim = get_slim_rag()
    ids = [
        str(e["id"])
        for e in slim.list_entries(limit=_MAX_ENTRIES)
        if str(e.get("content") or "").startswith(_PLACEHOLDER_PREFIX)
    ]
    if not ids:
        logger.info("无占位块（幂等：已清理或不存在）")
        return 0
    for eid in ids:
        slim.delete(eid)
    logger.info(f"占位块删除 {len(ids)} 条: {ids}")
    return len(ids)


def main() -> int:
    removed = remove_placeholder_blocks()
    filled = fill_titles()
    # 复核输出（走公共方法：count/list_files/titles_zh）
    from knowledge.rag import get_slim_rag

    slim = get_slim_rag()
    remaining = sum(
        1
        for e in slim.list_entries(limit=_MAX_ENTRIES)
        if str(e.get("content") or "").startswith(_PLACEHOLDER_PREFIX)
    )
    print(
        f"done: slim entries={slim.count()}, distinct_url={len(slim.list_files())}, "
        f"titles_zh={len(slim.titles_zh())}, placeholder remaining={remaining} "
        f"(removed {removed}, titles filled {filled})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
