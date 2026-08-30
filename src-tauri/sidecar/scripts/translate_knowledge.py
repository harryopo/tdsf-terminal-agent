#!/usr/bin/env python
"""
scripts/translate_knowledge.py — 知识库 LLM 全量中文翻译（TDSF 2026-08-30）
============================================================================

用途：遍历 .tdsf-data/rag.db 全部官方条目（*-docs + archwiki，~620 条），
调项目现有 LLM 配置（core.llm_config，OpenAI 兼容）把英文正文逐条翻译为
简体中文，写入 entries.content_zh（原文 content 保留——RAG 检索双语）。

设计（用户钦定）：
- 译文进 FTS5：写入时同步更新 fts_entries.content_zh_tokens（jieba 分词，
  rag.update_content_zh 统一处理）——中文 query 直接命中译文
- **断点续跑**：content_zh IS NOT NULL 的条目直接跳过（脚本可中断重跑）
- **合批优化**：小条目（< _SMALL_ENTRY_CHARS 字符）按 3-5 条拼接翻译，
  用 ===序号=== 分隔符切回；大条目单独翻译（省请求次数与 token 开销）
- **校验**：译文长度 < 原文 30% 或 > 300% 视为失败，重试最多 2 次
- 进度打印（每 10 条）；条目间不 sleep（API 自身限速）
- 翻译规则（prompt 钦定）：保留代码块/命令/参数原文；保留 markdown 标题
  与列表结构；技术术语首次出现可括注英文（如 守护进程(daemon)）

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/translate_knowledge.py            # 全量
    .venv/Scripts/python.exe scripts/translate_knowledge.py --source nginx-docs
    .venv/Scripts/python.exe scripts/translate_knowledge.py --limit 20 # 冒烟

爬取链路不耦合 LLM：rebuild 重爬后重跑本脚本补译文（而非重爬）。
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

# 与应用/rebuild_knowledge.py 读写同一个 rag.db（<项目根>/.tdsf-data）
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.translate_knowledge")

# 小条目阈值（字符）：低于此值参与合批翻译
_SMALL_ENTRY_CHARS = 1500
# 合批最大条数（3-5 条拼接，防单请求超长）
_BATCH_MAX_ITEMS = 5
# 合批总字符上限（拼接正文上限，超出提前封批）
_BATCH_MAX_CHARS = 6000
# 长度校验边界：译文 <30% 或 >300% 原文视为失败
_LEN_MIN_RATIO = 0.3
_LEN_MAX_RATIO = 3.0
# 单条失败重试次数
_MAX_RETRIES = 2

# 合批分隔符：LLM 回复中按此切回单条译文（序号从 0 起）
_BATCH_SEP_TMPL = "\n===zh-sep-{idx}===\n"
_BATCH_SEP_RE = None  # 惰性编译（模块被单测导入时避免依赖 re 顺序）

_SYSTEM_PROMPT = (
    "你是专业的 Linux 技术文档翻译引擎。只输出译文正文，不要任何解释、"
    "前言或总结。"
)

_PROMPT_TMPL = (
    "将以下 Linux 技术文档翻译为简体中文。要求：\n"
    "1. 保留代码块/命令/参数原文不翻译；\n"
    "2. 保留 markdown 标题结构与列表；\n"
    "3. 技术术语首次出现可括注英文（如 守护进程(daemon)）；\n"
    "4. 输出译文正文，不要任何解释。\n\n"
    "{body}"
)

# 合批 prompt：多段用分隔符隔开，要求 LLM 在每段译文前原样输出分隔符
_BATCH_PROMPT_TMPL = (
    "将以下 {n} 段 Linux 技术文档分别翻译为简体中文。要求：\n"
    "1. 保留代码块/命令/参数原文不翻译；\n"
    "2. 保留 markdown 标题结构与列表；\n"
    "3. 技术术语首次出现可括注英文（如 守护进程(daemon)）；\n"
    "4. 每段译文之前必须原样输出一行分隔标记（如 ===zh-sep-0===），"
    "不要解释，不要合并段落，不要增删分隔标记。\n\n"
    "{body}"
)


def _is_length_ok(original: str, translated: str) -> bool:
    """译文长度校验：<30% 或 >300% 原文视为失败（空译文必失败）"""
    if not translated or not translated.strip():
        return False
    n_src, n_out = len(original.strip()), len(translated.strip())
    return _LEN_MIN_RATIO * n_src <= n_out <= _LEN_MAX_RATIO * n_src


def _split_batch_reply(reply: str, n: int) -> list[str]:
    """按 ===zh-sep-<idx>=== 分隔符把合批回复切回 n 段译文

    - 容忍 LLM 漏掉个别分隔符：缺失段返回 ""（调用方按失败重试）
    - 容忍分隔符前后多余空行/说明文字：仅取分隔符之间的正文
    - 段数多于 n 时截断（LLM 幻觉多输出的尾巴丢弃）
    """
    import re

    parts = re.split(r"===zh-sep-\d+===", reply)
    # split 首段是第一个分隔符之前的内容（无标记的杂音），丢弃
    segments = [p.strip() for p in parts[1:]]
    out: list[str] = []
    for i in range(n):
        out.append(segments[i] if i < len(segments) else "")
    return out


def build_batches(entries: list[dict]) -> list[list[int]]:
    """条目列表 → 合批方案（返回每批的条目下标）

    - 小条目（< _SMALL_ENTRY_CHARS）贪心装批：批内最多 _BATCH_MAX_ITEMS 条、
      总字符 ≤ _BATCH_MAX_CHARS
    - 大条目独占一批（单独翻译）
    """
    batches: list[list[int]] = []
    cur: list[int] = []
    cur_chars = 0
    for i, e in enumerate(entries):
        size = len(str(e.get("content", "")))
        if size >= _SMALL_ENTRY_CHARS:
            # 大条目：先封当前批，再独占一批
            if cur:
                batches.append(cur)
                cur, cur_chars = [], 0
            batches.append([i])
            continue
        if cur and (
            len(cur) >= _BATCH_MAX_ITEMS
            or cur_chars + size > _BATCH_MAX_CHARS
        ):
            batches.append(cur)
            cur, cur_chars = [], 0
        cur.append(i)
        cur_chars += size
    if cur:
        batches.append(cur)
    return batches


def _translate_single(llm_call, entry: dict) -> str | None:
    """单条翻译（含重试与长度校验）；最终失败返回 None"""
    content = str(entry.get("content", ""))
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": _PROMPT_TMPL.format(body=content)},
    ]
    for attempt in range(1 + _MAX_RETRIES):
        try:
            reply = str(llm_call(messages)).strip()
        except Exception as e:
            logger.warning(f"LLM call failed (attempt {attempt + 1}) "
                           f"id={entry.get('id')}: {e}")
            continue
        if _is_length_ok(content, reply):
            return reply
        logger.warning(
            f"length check failed (attempt {attempt + 1}) id={entry.get('id')}: "
            f"src={len(content)} out={len(reply)}"
        )
    return None


def _translate_batch(llm_call, entries: list[dict]) -> list[str | None]:
    """合批翻译（含重试与逐段长度校验）；失败段单独重试一次兜底"""
    n = len(entries)
    body = ""
    for i, e in enumerate(entries):
        body += _BATCH_SEP_TMPL.format(idx=i).strip()
        body += "\n" + str(e.get("content", "")) + "\n"
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": _BATCH_PROMPT_TMPL.format(n=n, body=body)},
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
            if seg and _is_length_ok(str(entries[i].get("content", "")), seg):
                results[i] = seg
        if all(results):
            return results
    # 合批仍缺的段：逐条单独翻译兜底（通常 ≤1-2 段）
    for i, r in enumerate(results):
        if not r:
            results[i] = _translate_single(llm_call, entries[i])
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知识库 LLM 全量中文翻译")
    parser.add_argument("--source", default=None, help="仅翻译指定源（默认全部官方源）")
    parser.add_argument("--limit", type=int, default=None, help="最多翻译 N 条（冒烟用）")
    parser.add_argument(
        "--force",
        action="store_true",
        help="重翻已有译文（默认 content_zh 非空即跳过——断点续跑）",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from core.llm_config import load_config, make_llm_call
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    entries = rag.official_entries()
    if args.source:
        entries = [e for e in entries if e["source"] == args.source]
    if not args.force:
        # 断点续跑：已有译文（content_zh 非空）跳过
        entries = [e for e in entries if not (e.get("content_zh") or "").strip()]
    if args.limit:
        entries = entries[: args.limit]
    if not entries:
        print("nothing to translate (all covered or no entries)")
        return 0

    llm_call = make_llm_call(load_config())
    if llm_call is None:
        logger.warning(
            "LLM 不可用（未配置 API Key 或创建失败），跳过翻译。"
            "配置 .tdsf-data/llm_config.json 后重跑本脚本"
        )
        return 0

    total = len(entries)
    print(f"待翻译 {total} 条（合批优化：小条目 ≤{_BATCH_MAX_ITEMS} 条/批）")
    done = 0
    failed: list[str] = []
    batches = build_batches(entries)
    for bi, batch_idx in enumerate(batches):
        batch_entries = [entries[i] for i in batch_idx]
        if len(batch_entries) == 1:
            out = _translate_single(llm_call, batch_entries[0])
            results = [out]
        else:
            results = _translate_batch(llm_call, batch_entries)
        for e, zh in zip(batch_entries, results):
            if zh:
                if rag.update_content_zh(str(e["id"]), zh):
                    done += 1
                else:
                    failed.append(str(e["id"]))
            else:
                failed.append(str(e["id"]))
        if (bi + 1) % 2 == 0 or bi == len(batches) - 1:
            print(
                f"progress: batch {bi + 1}/{len(batches)}, "
                f"translated {done}/{total}, failed {len(failed)}",
                flush=True,
            )

    print("\n=== 翻译完成 ===")
    print(f"成功 {done}/{total}，失败 {len(failed)}")
    if failed:
        print("失败条目 id（重跑本脚本自动补翻）：")
        for fid in failed[:50]:
            print(f"  {fid}")
    print(f"db: {rag.db_path}")
    return 0 if done > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
