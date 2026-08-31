#!/usr/bin/env python
"""
scripts/distill_knowledge.py — 知识库「精兵简政」：LLM 每章提炼核心知识点
============================================================================

用途（用户钦定双库方案 2026-08-31）：读 .tdsf-data/rag.db 官方条目
（*-docs + archwiki，3969 块），**按合并文档章节聚合**（同 title 前缀的
多块拼成完整章节），逐章调项目现有 LLM 配置（core.llm_config，OpenAI
兼容）提炼为简体中文核心知识点，写入独立精简库 .tdsf-data/rag_slim.db
（同 schema，全量 rag.db 保留不动）。

实测数据（探针 2026-08-31）：3969 块聚合为 623 章节（键 = url + title 段1
normalize——title 存在文档名双空格脏数据变体，normalize 后正确合并），
总 417 万字；目标精简至 ~30 万字（±50%）。

设计（沿用 translate_knowledge.py 的合批/断点模式）：
- **章节聚合**：块按 (url, chunk_seq) 排序 → 章节键 = (url, normalize(title
  段1))；title 段数 <2 的文档导语块归 "" 键（title 取文档名）
- **大章节切片**：章节 > _SLICE_CHARS 字符时按段落边界切片，每片独立
  提炼后拼接（单次调用吃不下 10 万字大章）
- **合批**：小章节（< _SMALL_SECTION_CHARS 字符）3-5 章拼接提炼，
  ===slim-sep-N=== 分隔符切回；大章节单独
- **校验**：片 ≥500 字时输出 >40% 片长视为失败（没精简到位）；片 <500
  字时输出 >片长视为失败（照抄）；空/异常重试最多 _MAX_RETRIES 次
- **断点续跑**：写入前查 rag_slim.db 同 id 是否已有 → 跳过（可中断重跑）
- **philosophy 直拷**：4 篇中文精华原样复制进精简库（id 不变，tags 加 slim）
- **嵌入**：写入走 RagIndex.add 同一管线（BGE 向量 + FTS5 + vec 三写）
- id 规则：slim-<md5(url)[:8]>-<章节序>（url 内按章节首块序稳定编号）；
  title = 章节标题；url = 合并文件 url（前端聚合兼容）；tags 加 "slim"

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/distill_knowledge.py             # 全量
    .venv/Scripts/python.exe scripts/distill_knowledge.py --limit 10  # 冒烟
    .venv/Scripts/python.exe scripts/distill_knowledge.py --dry-run   # 只看聚合统计
    .venv/Scripts/python.exe scripts/distill_knowledge.py --force     # 忽略断点重跑
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sys
import time
from collections import OrderedDict
from pathlib import Path

# 与应用/rebuild_knowledge.py 读写同一批 db（<项目根>/.tdsf-data）
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.distill_knowledge")

# ---- 聚合参数 ---------------------------------------------------------------

_WS_RE = re.compile(r"\s+")
# 章节标题提取：title = 文档名 · 章节标题[ · 内容片段][ · #序]，取段 1
_TITLE_SEP = " · "

# ---- 合批 / 校验参数 --------------------------------------------------------

# 小章节阈值（字符）：低于此值参与合批提炼
_SMALL_SECTION_CHARS = 400
# 合批最大章数（3-5 章拼接）
_BATCH_MAX_ITEMS = 5
# 合批总字符上限（拼接正文上限，超出提前封批）
_BATCH_MAX_CHARS = 6000
# 大章节切片阈值（单次 LLM 调用输入上限）
_SLICE_CHARS = 8000
# 超短章节跳过阈值（字符）：碎片不值得 LLM 调用，且极易诱发幻觉扩写
_MIN_SECTION_CHARS = 200
# 单片失败重试次数
_MAX_RETRIES = 2

# 合批分隔符：LLM 回复中按此切回单章提炼（序号从 0 起）
_BATCH_SEP_TMPL = "\n===slim-sep-{idx}===\n"

_SYSTEM_PROMPT = (
    "你是 Linux 技术教学编辑。只输出提炼后的正文，不要任何解释、"
    "前言或总结。"
)

# 动态字数上限（三轮实测校准 2026-08-31，教训固化）：
# ① 固定"25%/上限600字"prompt → 模型对长章节无视 600 上限输出 1765 字；
# ② prompt 锚提到 800 → 锚定效应反涨（输出 1640-2061 ≈ 等量翻译）；
# ③ 校验硬上限 700 → 密集大章节被误杀（src=7563 输出 798 仍被拒）。
# 结论：模型（deepseek-v4-flash）对"提炼 25%"执行弱，一次调用压不到位
# ——采用「prompt 低锚 600 + 校验 min(40%源, 850) + 超限级联压缩」三级链。
_MAX_OUT_CHARS = 600  # 单片 prompt 输出上限（任务书钦定）
# 校验绝对上限 950（实测 2026-08-31：850 会把级联收敛到 902-940 的高价值
# 密集章节（如 Limine 引导、压缩比已到 12%）在"差几十字"处误杀——
# 绝对上限只负责防失控，40% 比率线才负责删减质量；两者取小）
_VERIFY_ABS = 950
_SLIM_RATIO = 0.4  # 任务书钦定：输出 >40% 源长 = 没精简到位


def _max_out_chars(source: str) -> int:
    """按原文长度算单片 prompt 锚：25% 原文，下限 120、上限 600"""
    return min(_MAX_OUT_CHARS, max(120, len(source) // 4))


def _verify_limit(source: str) -> int:
    """单片校验上限：min(40% 源长, 950)——任务书 40% 钦定为主，
    950 绝对上限封顶（密集长章节靠级联压缩收敛）"""
    return min(int(_SLIM_RATIO * len(source)), _VERIFY_ABS)


# 级联压缩 prompt：初稿超限时二次删减（中文→中文，模型执行度远高于
# 英文一次提炼到位；实测 src=6543 → 初稿 1273-2061 → 级联后可入 900 内）
_COMPRESS_PROMPT_TMPL = (
    "以下是一份技术文档的中文要点初稿（约 {n} 字），超出了 {max_chars} 字"
    "的篇幅上限。请将它压缩到不超过 {max_chars} 字：\n"
    "1. 删除次要命令、重复示例、边缘配置与冗余解释；\n"
    "2. 保留最高频的核心命令/参数/重要配置/易错点，"
    "命令与代码原样保留；\n"
    "3. 用紧凑的 markdown 要点列表；\n"
    "4. 只输出压缩后的正文。\n\n"
    "{body}"
)

# --recompress 二次压缩参数（任务书钦定 prompt 的 600 字上限在首轮未被执行
# 到位——模型对密集章节输出 850-950 字；对 slim 库超限块统一补压缩）
_RECOMPRESS_THRESHOLD = 650  # 超过此长度的精简块参与二次压缩
_RECOMPRESS_MIN = 200  # 压缩下限：低于此长度 = 删过头，保留原稿


def _is_recompress_ok(old: str, new: str) -> bool:
    """二次压缩校验：非空且 ≤650 字（不查 40% 比率——中文→中文压缩
    语义不同于英文提炼；下限 _RECOMPRESS_MIN 防删光）"""
    if not new or not new.strip():
        return False
    return _RECOMPRESS_MIN <= len(new.strip()) <= _RECOMPRESS_THRESHOLD


_PROMPT_TMPL = (
    "将以下英文技术文档章节提炼为简体中文核心知识点。要求：\n"
    "1. 只保留核心概念/关键命令/关键参数/重要配置/易错点，"
    "删除冗余叙述、重复示例、边缘情况；\n"
    "2. 命令/代码/参数原文保留；\n"
    "3. 用紧凑的 markdown：要点列表+关键代码块；\n"
    "4. 输出不超过 {max_chars} 字，宁缺毋滥，可以更短；\n"
    "5. 只输出正文。\n\n"
    "{body}"
)

# 合批 prompt：多章用分隔符隔开，要求 LLM 在每章提炼前原样输出分隔符
_BATCH_PROMPT_TMPL = (
    "将以下 {n} 段英文技术文档章节分别提炼为简体中文核心知识点。要求：\n"
    "1. 只保留核心概念/关键命令/关键参数/重要配置/易错点，"
    "删除冗余叙述、重复示例、边缘情况；\n"
    "2. 命令/代码/参数原文保留；\n"
    "3. 用紧凑的 markdown：要点列表+关键代码块；\n"
    "4. 每段输出不超过 {max_chars} 字，宁缺毋滥，可以更短；\n"
    "5. 每段提炼之前必须原样输出一行分隔标记（如 ===slim-sep-0===），"
    "不要解释，不要合并段落，不要增删分隔标记。\n\n"
    "{body}"
)


# ============================================================================
# 章节聚合
# ============================================================================


def normalize_title_seg(seg: str) -> str:
    """标题段 normalize：折叠连续空白为单空格并去首尾
    （title 存在文档名/标题双空格脏数据变体，normalize 后同章节正确合并）"""
    return _WS_RE.sub(" ", seg or "").strip()


def _chunk_seq(entry_id: str) -> int:
    """条目 id 尾部块序号（"consol-<hash>-3" → 3；无尾部数字 → 0）"""
    tail = entry_id.rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else 0


def aggregate_sections(entries: list[dict]) -> list[dict]:
    """官方块列表 → 章节列表（保持文档内顺序）

    聚合键 = (url, normalize(title 段1))；title 段数 <2 的文档导语块归
    "" 键（章节标题用文档名）。同键多块按 chunk_seq 顺序拼接 content。

    Returns:
        [{id_prefix_doc(url), section_idx, title, content, url, source,
          category, tags, chunks, first_seq}, ...]
        按文档 url 排序、文档内按章节首次出现顺序排列
    """
    by_doc: dict[str, list[dict]] = OrderedDict()
    for e in sorted(entries, key=lambda x: (str(x["url"]), _chunk_seq(str(x["id"])))):
        by_doc.setdefault(str(e["url"]), []).append(e)

    sections: list[dict] = []
    for url in sorted(by_doc):
        doc_name = ""
        groups: "OrderedDict[str, dict]" = OrderedDict()
        for e in by_doc[url]:
            title = str(e.get("title", ""))
            parts = title.split(_TITLE_SEP)
            if doc_name == "" and parts:
                doc_name = normalize_title_seg(parts[0])
            if len(parts) >= 2:
                key = normalize_title_seg(parts[1])
            else:
                key = ""  # 文档导语块
            g = groups.get(key)
            if g is None:
                groups[key] = {
                    "key": key,
                    "title": key or doc_name,
                    "content": str(e.get("content", "")),
                    "url": url,
                    "source": str(e.get("source", "")),
                    "category": str(e.get("category", "") or ""),
                    "tags": list(e.get("tags", []) or []),
                    "chunks": 1,
                    "first_seq": _chunk_seq(str(e["id"])),
                }
            else:
                g["content"] += "\n\n" + str(e.get("content", ""))
                g["chunks"] += 1
        for idx, g in enumerate(groups.values()):
            g["section_idx"] = idx
            sections.append(g)
    return sections


def slim_entry_id(url: str, section_idx: int) -> str:
    """章节 → 精简库条目 id（slim-<md5(url)[:8]>-<章节序>，稳定幂等）"""
    return f"slim-{hashlib.md5(url.encode('utf-8')).hexdigest()[:8]}-{section_idx}"


# ============================================================================
# 切片 / 校验 / 合批
# ============================================================================


def slice_content(content: str, max_chars: int = _SLICE_CHARS) -> list[str]:
    """超长章节按段落边界切片（每片 ≤max_chars；超长单段硬切）"""
    if len(content) <= max_chars:
        return [content]
    pieces: list[str] = []
    for para in content.split("\n\n"):
        while len(para) > max_chars:
            pieces.append(para[:max_chars])
            para = para[max_chars:]
        pieces.append(para)
    slices: list[str] = []
    cur = ""
    for p in pieces:
        if cur and len(cur) + len(p) + 2 > max_chars:
            slices.append(cur)
            cur = p
        else:
            cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        slices.append(cur)
    return slices


def _is_distill_ok(source: str, distilled: str) -> bool:
    """提炼结果校验（两轮实测校准 2026-08-31）：
    - 空输出必失败
    - 输出 > _verify_limit(源) = 没精简到位/失控（失败）
    - 输出 >0.9×源长 = 照抄/扩写（中文 0.9×英文长度意味着远超原文
      信息量；同时覆盖短片幻觉扩写：src=123 → 上限 110 字）
    """
    if not distilled or not distilled.strip():
        return False
    n_src, n_out = len(source.strip()), len(distilled.strip())
    return n_out <= min(_verify_limit(source), 0.9 * n_src)


def _split_batch_reply(reply: str, n: int) -> list[str]:
    """按 ===slim-sep-<idx>=== 分隔符把合批回复切回 n 段提炼

    - 容忍 LLM 漏掉个别分隔符：缺失段返回 ""（调用方按失败重试）
    - 首个分隔符之前的杂音文字丢弃；多出的段截断
    """
    parts = re.split(r"===slim-sep-\d+===", reply)
    segments = [p.strip() for p in parts[1:]]
    return [segments[i] if i < len(segments) else "" for i in range(n)]


def build_batches(sections: list[dict]) -> list[list[int]]:
    """章节列表 → 合批方案（返回每批的章节下标）

    - 小章节（< _SMALL_SECTION_CHARS）贪心装批：批内最多 _BATCH_MAX_ITEMS
      章、总字符 ≤ _BATCH_MAX_CHARS
    - 大章节独占一批（切片后逐片提炼）
    """
    batches: list[list[int]] = []
    cur: list[int] = []
    cur_chars = 0
    for i, s in enumerate(sections):
        size = len(s["content"])
        if size >= _SMALL_SECTION_CHARS:
            if cur:
                batches.append(cur)
                cur, cur_chars = [], 0
            batches.append([i])
            continue
        if cur and (
            len(cur) >= _BATCH_MAX_ITEMS or cur_chars + size > _BATCH_MAX_CHARS
        ):
            batches.append(cur)
            cur, cur_chars = [], 0
        cur.append(i)
        cur_chars += size
    if cur:
        batches.append(cur)
    return batches


# ============================================================================
# LLM 提炼
# ============================================================================


def _distill_single(llm_call, source: str) -> str | None:
    """单片提炼（重试 + 超限级联压缩）；最终失败返回 None

    三级链（三轮实测教训）：原 prompt 提炼 → 合格即返；超限（非空）→
    级联压缩初稿（中文→中文删减，执行度高）→ 合格即返；仍超限 →
    下一轮原 prompt 重试（共 1 + _MAX_RETRIES 轮）。空输出/异常 →
    直接原 prompt 重试。
    """
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _PROMPT_TMPL.format(
                max_chars=_max_out_chars(source), body=source
            ),
        },
    ]
    for attempt in range(1 + _MAX_RETRIES):
        try:
            reply = str(llm_call(messages)).strip()
        except Exception as e:
            logger.warning(f"LLM call failed (attempt {attempt + 1}): {e}")
            continue
        if not reply:
            logger.warning(f"empty reply (attempt {attempt + 1})")
            continue
        if _is_distill_ok(source, reply):
            return reply
        logger.warning(
            f"distill over limit (attempt {attempt + 1}): "
            f"src={len(source)} out={len(reply)}，尝试级联压缩"
        )
        # 级联压缩：中文初稿 → 二次删减（比英文一次提炼到位更可控）
        compress_messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _COMPRESS_PROMPT_TMPL.format(
                    n=len(reply),
                    max_chars=_max_out_chars(source),
                    body=reply,
                ),
            },
        ]
        try:
            compressed = str(llm_call(compress_messages)).strip()
        except Exception as e:
            logger.warning(f"compress call failed (attempt {attempt + 1}): {e}")
            continue
        if compressed and _is_distill_ok(source, compressed):
            return compressed
        logger.warning(
            f"cascade compress still over limit (attempt {attempt + 1}): "
            f"src={len(source)} out={len(compressed)}"
        )
    return None


def _distill_batch(llm_call, sources: list[str]) -> list[str | None]:
    """合批提炼（含重试与逐段校验）；失败段单独重试兜底"""
    n = len(sources)
    body = ""
    for i, src in enumerate(sources):
        body += _BATCH_SEP_TMPL.format(idx=i).strip()
        body += "\n" + src + "\n"
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": _BATCH_PROMPT_TMPL.format(
                n=n,
                # 合批均为小章节，取批内最大单段上限（下限 120 生效）
                max_chars=max(_max_out_chars(s) for s in sources),
                body=body,
            ),
        },
    ]
    results: list[str | None] = [""] * n
    for attempt in range(1 + _MAX_RETRIES):
        try:
            reply = str(llm_call(messages))
        except Exception as e:
            logger.warning(f"batch LLM call failed (attempt {attempt + 1}): {e}")
            continue
        segs = _split_batch_reply(reply, n)
        for i, seg in enumerate(segs):
            if results[i]:
                continue  # 前一轮已成功的段不覆盖
            if seg and _is_distill_ok(sources[i], seg):
                results[i] = seg
        if all(results):
            return results
    # 合批仍缺的段：逐段单独提炼兜底（通常 ≤1-2 段）
    for i, r in enumerate(results):
        if not r:
            results[i] = _distill_single(llm_call, sources[i])
    return results


def distill_section(llm_call, section: dict) -> str | None:
    """单章节提炼：大章节切片逐片提炼后拼接；任一片失败返回 None"""
    slices = slice_content(section["content"])
    if len(slices) == 1:
        return _distill_single(llm_call, slices[0])
    outs: list[str] = []
    for j, piece in enumerate(slices):
        out = _distill_single(llm_call, piece)
        if out is None:
            logger.warning(
                f"slice {j + 1}/{len(slices)} failed: "
                f"{section['title'][:50]}"
            )
            return None
        outs.append(out)
    return "\n\n".join(outs)


# ============================================================================
# philosophy 直拷
# ============================================================================


def copy_philosophy(slim_rag) -> int:
    """philosophy 4 篇中文精华原样复制进精简库（id 不变，tags 加 slim）；
    同 id 已存在时跳过（幂等）。返回本次新复制条数。"""
    from knowledge.rag import get_global_rag
    from knowledge.fts5 import KnowledgeEntry

    rows = get_global_rag().official_entries()  # 仅 *-docs/archwiki，不含 philosophy
    # philosophy 不在 official_entries 里，直接查
    rag = get_global_rag()
    with rag._lock:
        rows = rag._conn.execute(
            "SELECT id, source, title, content, url, tags, created_at, "
            "category, content_zh FROM entries WHERE source = 'philosophy'"
        ).fetchall()
    existing = {
        str(r["id"])
        for r in slim_rag._conn.execute("SELECT id FROM entries").fetchall()
    }
    import json as _json

    copied = 0
    for r in rows:
        eid = str(r["id"])
        if eid in existing:
            continue
        tags = _json.loads(r["tags"]) if r["tags"] else []
        if "slim" not in tags:
            tags = tags + ["slim"]
        slim_rag.add(
            KnowledgeEntry(
                id=eid,
                source=str(r["source"]),
                title=str(r["title"]),
                content=str(r["content"]),
                url=str(r["url"]),
                tags=tags,
                created_at=str(r["created_at"]),
                category=str(r["category"] or ""),
                content_zh=r["content_zh"],
            ),
            dedupe=False,
        )
        copied += 1
    return copied


def filter_sections(
    sections: list[dict], existing_ids: set[str], force: bool = False
) -> list[dict]:
    """断点续跑过滤：为章节填 slim_id，已有同 id 且非 force 的跳过。

    Returns:
        待提炼章节列表（每项已带 slim_id 字段）
    """
    todo: list[dict] = []
    for s in sections:
        s["slim_id"] = slim_entry_id(s["url"], s["section_idx"])
        if not force and s["slim_id"] in existing_ids:
            continue
        todo.append(s)
    return todo


def recompress_oversize(
    slim_rag, llm_call, workers: int = 1, threshold: int = _RECOMPRESS_THRESHOLD
) -> tuple[int, int]:
    """二次压缩：slim 库中超阈值（默认 >650 字）的官方块统一压到 ≤600 字

    背景：首轮提炼的校验线 min(40%源, 950) 放行了 850-950 字的密集章节
    （模型对"600 字上限"执行不到位）——本函数用级联压缩 prompt 补一轮
    中文→中文删减，使全库贴近任务书钦定的 600 字上限。

    失败（超限未收敛/删光/API 错）保留原稿并计数，幂等可重跑。

    Returns:
        (压缩成功数, 保留原稿数)
    """
    import threading
    from concurrent.futures import ThreadPoolExecutor, as_completed

    with slim_rag._lock:
        rows = slim_rag._conn.execute(
            "SELECT id, source, title, content, url, tags, created_at, "
            "category, content_zh FROM entries "
            "WHERE source != 'philosophy' AND LENGTH(content) > ?",
            (threshold,),
        ).fetchall()

    import json as _json

    def _one(r) -> tuple[bool, str]:
        old = str(r["content"])
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _COMPRESS_PROMPT_TMPL.format(
                    n=len(old), max_chars=_MAX_OUT_CHARS, body=old
                ),
            },
        ]
        for _ in range(1 + _MAX_RETRIES):
            try:
                new = str(llm_call(messages)).strip()
            except Exception as e:
                logger.warning(f"recompress call failed id={r['id']}: {e}")
                continue
            if _is_recompress_ok(old, new):
                from knowledge.fts5 import KnowledgeEntry

                tags = _json.loads(r["tags"]) if r["tags"] else []
                slim_rag.add(
                    KnowledgeEntry(
                        id=str(r["id"]),
                        source=str(r["source"]),
                        title=str(r["title"]),
                        content=new,
                        url=str(r["url"]),
                        tags=tags,
                        created_at=str(r["created_at"]),
                        category=str(r["category"] or ""),
                        content_zh=r["content_zh"],
                    ),
                    dedupe=False,
                )
                return True, str(r["id"])
            logger.warning(
                f"recompress check failed id={r['id']}: "
                f"old={len(old)} new={len(new)}"
            )
        return False, str(r["id"])

    ok = 0
    kept = 0
    if workers <= 1:
        for r in rows:
            success, _ = _one(r)
            ok += 1 if success else 0
            kept += 0 if success else 1
            if (ok + kept) % 20 == 0:
                print(f"recompress progress: {ok + kept}/{len(rows)}", flush=True)
    else:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(_one, r) for r in rows]
            for i, fut in enumerate(as_completed(futs), 1):
                success, _ = fut.result()
                ok += 1 if success else 0
                kept += 0 if success else 1
                if i % 20 == 0 or i == len(rows):
                    print(f"recompress progress: {i}/{len(rows)}", flush=True)
    return ok, kept


# ============================================================================
# 主流程
# ============================================================================


def _process_batch(
    llm_call, slim_rag, batch_sections: list[dict]
) -> tuple[int, int, list[str]]:
    """处理一个批（单章或合批）：提炼 + 写库。返回 (成功数, 输出字符, 失败id)"""
    from knowledge.fts5 import KnowledgeEntry

    done = 0
    out_chars = 0
    failed: list[str] = []
    if len(batch_sections) == 1:
        sec = batch_sections[0]
        out = distill_section(llm_call, sec)
        results = [(sec, out)]
    else:
        outs = _distill_batch(llm_call, [s["content"] for s in batch_sections])
        results = list(zip(batch_sections, outs))
    for sec, out in results:
        if out:
            slim_rag.add(
                KnowledgeEntry(
                    id=sec["slim_id"],
                    source=sec["source"],
                    title=sec["title"],
                    content=out,
                    url=sec["url"],
                    tags=sorted(set(sec["tags"]) | {"slim"}),
                    category=sec["category"],
                ),
                dedupe=False,
            )
            done += 1
            out_chars += len(out)
        else:
            failed.append(sec["slim_id"])
    return done, out_chars, failed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知识库 LLM 每章提炼精简版")
    parser.add_argument("--source", default=None, help="仅提炼指定源（默认全部官方源）")
    parser.add_argument("--limit", type=int, default=None, help="最多提炼 N 章（冒烟用）")
    parser.add_argument(
        "--force", action="store_true", help="忽略断点已有结果重跑（默认跳过）"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="只打印聚合统计，不调 LLM 不写库"
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="并发批数（默认 1 串行；LLM 调用并发、写库由 RagIndex 线程锁串行化）",
    )
    parser.add_argument(
        "--recompress",
        action="store_true",
        help=(
            "二次压缩模式：对 slim 库中 >650 字的官方块统一压到 ≤600 字"
            "（跳过提炼主流程）"
        ),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from knowledge.rag import get_global_rag, get_slim_rag

    rag = get_global_rag()
    entries = rag.official_entries()
    if args.source:
        entries = [e for e in entries if e["source"] == args.source]

    sections = aggregate_sections(entries)
    total_chars = sum(len(s["content"]) for s in sections)
    print(
        f"聚合完成：{len(entries)} 块 → {len(sections)} 章节，"
        f"共 {total_chars} 字符"
    )
    by_src: dict[str, int] = {}
    for s in sections:
        by_src[s["source"]] = by_src.get(s["source"], 0) + 1
    for src in sorted(by_src):
        print(f"  {src:<20} {by_src[src]:>4} 章节")
    if args.dry_run:
        return 0

    # --recompress：对 slim 库超限块二次压缩（跳过提炼主流程）
    if args.recompress:
        slim_rag = get_slim_rag()
        from core.llm_config import load_config, make_llm_call

        llm_call = make_llm_call(load_config())
        if llm_call is None:
            logger.warning("LLM 不可用（未配置 API Key），跳过二次压缩")
            return 0
        with slim_rag._lock:
            n_over = int(
                slim_rag._conn.execute(
                    "SELECT COUNT(*) FROM entries WHERE source != 'philosophy' "
                    "AND LENGTH(content) > ?",
                    (_RECOMPRESS_THRESHOLD,),
                ).fetchone()[0]
            )
        print(
            f"二次压缩：{n_over} 块超 {_RECOMPRESS_THRESHOLD} 字，"
            f"目标 ≤{_MAX_OUT_CHARS} 字（workers={max(1, int(args.workers))}）"
        )
        ok, kept = recompress_oversize(
            slim_rag, llm_call, workers=max(1, int(args.workers))
        )
        with slim_rag._lock:
            slim_count = int(
                slim_rag._conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
            )
            slim_chars = int(
                slim_rag._conn.execute(
                    "SELECT COALESCE(SUM(LENGTH(content)), 0) FROM entries"
                ).fetchone()[0]
            )
        print(
            f"\n=== 二次压缩完成 ===\n压缩 {ok}，保留原稿 {kept}\n"
            f"精简库现状：{slim_count} 块，{slim_chars} 字符"
            f"（全量 4177878 字符，压缩比 {slim_chars / 4177878 * 100:.1f}%）"
        )
        return 0

    # 断点续跑：精简库已有同 id → 跳过
    slim_rag = get_slim_rag()
    with slim_rag._lock:
        existing = {
            str(r["id"])
            for r in slim_rag._conn.execute("SELECT id FROM entries").fetchall()
        }
    todo = filter_sections(sections, existing, force=args.force)
    # 超短章节跳过：碎片不值得 LLM 调用（实测：src=123 字符的碎片诱发
    # 幻觉扩写，3 次重试全败——宁缺毋滥直接跳过）
    skipped_short = [s for s in todo if len(s["content"]) < _MIN_SECTION_CHARS]
    todo = [s for s in todo if len(s["content"]) >= _MIN_SECTION_CHARS]
    if skipped_short:
        print(
            f"跳过超短章节 {len(skipped_short)} 个"
            f"（< {_MIN_SECTION_CHARS} 字符，碎片不值得提炼）"
        )
    if args.limit:
        todo = todo[: args.limit]
    print(f"待提炼 {len(todo)}/{len(sections)} 章节（断点跳过 "
          f"{len(sections) - len(todo)}）")

    # philosophy 直拷（幂等，不计入章节进度）
    phi = copy_philosophy(slim_rag)
    print(f"philosophy 直拷：新增 {phi} 条")

    if not todo:
        print("nothing to distill (all covered or no entries)")
        return 0

    from core.llm_config import load_config, make_llm_call

    llm_call = make_llm_call(load_config())
    if llm_call is None:
        logger.warning(
            "LLM 不可用（未配置 API Key 或创建失败），跳过提炼。"
            "配置 .tdsf-data/llm_config.json 后重跑本脚本"
        )
        return 0

    total = len(todo)
    workers = max(1, int(args.workers))
    print(f"开始提炼（workers={workers}；合批：小章节 ≤{_BATCH_MAX_ITEMS} 章/批；"
          f"大章节 >{_SLICE_CHARS} 字符切片）")
    done = 0
    out_chars = 0
    failed: list[str] = []
    t0 = time.time()
    batches = build_batches(todo)
    n_batches = len(batches)
    batch_args = [[todo[i] for i in b] for b in batches]

    def _report(finished: int) -> None:
        elapsed = time.time() - t0
        rate = done / elapsed if elapsed > 0 else 0.0
        eta = (total - done) / rate if rate > 0 else 0.0
        print(
            f"progress: batch {finished}/{n_batches}, "
            f"sections {done}/{total}, failed {len(failed)}, "
            f"rate {rate:.2f} 章/s, elapsed {elapsed / 60:.1f}min, "
            f"ETA {eta / 60:.1f}min",
            flush=True,
        )

    if workers == 1:
        for bi, batch_sections in enumerate(batch_args):
            d, oc, f = _process_batch(llm_call, slim_rag, batch_sections)
            done += d
            out_chars += oc
            failed.extend(f)
            if (bi + 1) % 10 == 0 or bi == n_batches - 1:
                _report(bi + 1)
    else:
        # 并发：LLM 调用为瓶颈，批级并发（写库由 RagIndex._lock 串行化）。
        # 实测教训 2026-08-31：密集章节重试+级联链使串行速率 ~1.8min/章，
        # 全量需 16h——并发 6-8 路是唯一可行提速手段（API flash 档限速宽松）。
        import threading
        from concurrent.futures import ThreadPoolExecutor, as_completed

        lock = threading.Lock()
        finished = 0

        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_process_batch, llm_call, slim_rag, bs)
                       for bs in batch_args]
            for fut in as_completed(futures):
                d, oc, f = fut.result()
                with lock:
                    done += d
                    out_chars += oc
                    failed.extend(f)
                    finished += 1
                    if finished % 10 == 0 or finished == n_batches:
                        _report(finished)

    # 终局统计
    slim_count = slim_rag.count()
    with slim_rag._lock:
        slim_chars = int(
            slim_rag._conn.execute(
                "SELECT COALESCE(SUM(LENGTH(content)), 0) FROM entries"
            ).fetchone()[0]
        )
    print("\n=== 提炼完成 ===")
    print(f"本次成功 {done}/{total}，失败 {len(failed)}")
    print(
        f"精简库现状：{slim_count} 块，{slim_chars} 字符"
        f"（全量 {total_chars} 字符，压缩比 "
        f"{slim_chars / total_chars * 100:.1f}%）"
    )
    if failed:
        print("失败章节 id（重跑本脚本自动补提）：")
        for fid in failed[:50]:
            print(f"  {fid}")
        if len(failed) > 50:
            print(f"  ...（共 {len(failed)} 个）")
    print(f"db: {slim_rag.db_path}")
    return 0 if done > 0 else (1 if todo else 0)


if __name__ == "__main__":
    raise SystemExit(main())
