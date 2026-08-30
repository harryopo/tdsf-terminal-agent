#!/usr/bin/env python
"""
scripts/gen_titles_zh.py — 官方文档中文标题+摘要批量生成（TDSF 2026-08-30）
===========================================================================

用途：遍历 .tdsf-data/rag.db 官方源（*-docs + archwiki）**文件级**条目
（knowledge.list_files 的 url + title0），调项目现有 LLM 配置
（core.llm_config，环境变量 / .tdsf-data/llm_config.json）批量生成：
1. 简短中文标题 → doc_titles_zh.zh
2. 120 字中文内容摘要 → doc_titles_zh.summary_zh（C2 新增；**不是全文
   翻译**——781 页整页 LLM 翻译 token 成本巨大且质量不可控，官方技术
   文档保持英文原文，检索命中时 Agent 可现场解释；中文摘要供前端知识
   详情弹窗顶部摘要条快速预览）

写入 rag.db 表 doc_titles_zh(url, zh, summary_zh, created_at)。前端知识
浏览器显示「中文主行 + 英文原名副行」，详情弹窗显示中文摘要条
（RPC knowledge.titles_zh / knowledge.get_doc 读取）。

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/gen_titles_zh.py            # 全部官方源
    .venv/Scripts/python.exe scripts/gen_titles_zh.py --source nginx-docs
    .venv/Scripts/python.exe scripts/gen_titles_zh.py --force    # 重生成已有映射

增量说明：已有 zh 但缺 summary_zh 的 url 也会进入待处理清单（仅补摘要
时 LLM 被告知沿用已有标题）；--force 强制全部重生成。

LLM 不可用（未配置/调用失败）时优雅跳过：logger.warning，表留空或保留
旧值，前端自动回退英文原标题。

爬取链路不耦合 LLM：import_docs / knowledge.crawl 新增文件不自动生成，
下次手动重跑本脚本补齐（幂等 upsert）。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from pathlib import Path

# 与应用/rebuild_knowledge.py 读写同一个 rag.db（<项目根>/.tdsf-data）
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.gen_titles_zh")

_BATCH_SIZE = 20  # 每批文件数（prompt 体积与请求次数折中）
_CONTENT_HEAD_CHARS = 300  # 摘要生成用的正文开头截取长度

_PROMPT_TMPL = (
    "为以下 Linux 技术文档生成：1) 简短中文标题（10字内，技术术语可保留"
    "英文，如 systemd/cgroups 不翻译）；2) 120 字以内的中文内容摘要"
    "（概括文档讲了什么，不是逐句翻译）。\n"
    "如条目已提供 zh_title，可沿用原中文标题，仅生成摘要。\n"
    "只输出一个 JSON 对象，键为编号、值为 {{\"t\": \"中文标题\", "
    "\"s\": \"中文摘要\"}}，不要输出其他内容：\n"
    "{items}"
)

# LLM 回复中的 JSON 对象提取（容忍 ```json 围栏与前后杂文本）
_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def _official_files(rag, source_filter: str | None) -> list[dict]:
    """官方源文件级条目（url + title0）；--source 指定时仅该源"""
    files = rag.list_files(source=source_filter)
    if source_filter:
        return files
    return [
        f for f in files
        if str(f["source"]).endswith("-docs") or f["source"] == "archwiki"
    ]


def _parse_items(reply: str, n: int) -> dict[int, dict[str, str]]:
    """解析 LLM 回复为 {编号: {"t": 标题, "s": 摘要}}

    兼容两种值格式：字符串（旧格式，仅标题）与 {"t","s"} 对象。
    解析失败返回空（调用方跳过该批）。
    """
    m = _JSON_OBJ_RE.search(reply)
    if not m:
        return {}
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return {}
    out: dict[int, dict[str, str]] = {}
    if isinstance(data, dict):
        for k, v in data.items():
            try:
                idx = int(k)
            except (TypeError, ValueError):
                continue
            if not (0 <= idx < n):
                continue
            if isinstance(v, str) and v.strip():
                out[idx] = {"t": v.strip(), "s": ""}
            elif isinstance(v, dict):
                t = str(v.get("t", "")).strip()
                s = str(v.get("s", "")).strip()
                if t or s:
                    out[idx] = {"t": t, "s": s}
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="官方文档中文标题+摘要批量生成")
    parser.add_argument("--source", default=None, help="仅处理指定源（默认全部官方源）")
    parser.add_argument(
        "--force",
        action="store_true",
        help="重生成已有映射（默认跳过 zh 与 summary_zh 均已覆盖的 url）",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from core.llm_config import load_config, make_llm_call
    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    files = _official_files(rag, args.source)
    if not files:
        logger.warning("no official-source files found (先跑 rebuild_knowledge.py --crawl-all)")
        return 1

    # 待处理清单：无 zh、或 zh 已有但 summary_zh 缺失（仅补摘要）的 url
    existing = {t["url"]: t for t in rag.titles_zh()}
    todo: list[dict] = []
    if args.force:
        todo = list(files)
    else:
        for f in files:
            row = existing.get(str(f["url"]))
            if row is None or not str(row.get("summary_zh", "")).strip():
                todo.append(f)
    skipped = len(files) - len(todo)
    if skipped:
        logger.info(f"{skipped} files already covered (use --force to regenerate)")

    llm_call = make_llm_call(load_config())
    if llm_call is None:
        logger.warning(
            "LLM 不可用（未配置 API Key 或创建失败），跳过中文标题/摘要生成——"
            "前端将回退英文原标题。配置 .tdsf-data/llm_config.json 后重跑本脚本"
        )
        return 0
    if not todo:
        logger.info("nothing to generate (all covered)")
        return 0

    total = len(todo)
    done = 0
    failed_batches = 0
    for start in range(0, total, _BATCH_SIZE):
        batch = todo[start : start + _BATCH_SIZE]
        # 组装 prompt 条目：标题 + 已有中文标题（若有）+ 正文开头（摘要素材）
        items = {}
        for i, f in enumerate(batch):
            url = str(f["url"])
            head = ""
            doc = rag.get_doc(url)
            if doc is not None:
                head = str(doc.get("content", ""))[:_CONTENT_HEAD_CHARS]
            items[i] = {
                "title": str(f["title0"]),
                "zh_title": str(existing.get(url, {}).get("zh", "")),
                "content_head": head,
            }
        messages = [
            {
                "role": "system",
                "content": "你是技术文档翻译助手，只输出 JSON，不要解释。",
            },
            {"role": "user", "content": _PROMPT_TMPL.format(
                items=json.dumps(items, ensure_ascii=False))},
        ]
        try:
            reply = llm_call(messages)
        except Exception as e:
            logger.warning(f"batch {start} LLM call failed: {e}，跳过该批")
            failed_batches += 1
            continue
        parsed = _parse_items(str(reply), len(batch))
        mapping: dict[str, str] = {}
        summaries: dict[str, str] = {}
        for i, item in parsed.items():
            url = str(batch[i]["url"])
            # 未返回新标题时沿用已有中文标题（仅补摘要的场景）
            zh = item["t"] or str(existing.get(url, {}).get("zh", ""))
            if not zh:
                continue
            mapping[url] = zh
            if item["s"]:
                summaries[url] = item["s"]
        if not mapping:
            logger.warning(f"batch {start} 回复解析失败（非 JSON），跳过该批")
            failed_batches += 1
            continue
        n = rag.upsert_titles_zh(mapping, summaries)
        done += n
        logger.info(
            f"batch {start}~{start + len(batch) - 1}: {n}/{len(batch)} 写入"
            f"（含摘要 {len(summaries)} 条）"
        )
        if start + _BATCH_SIZE < total:
            time.sleep(0.5)  # 轻量限速，防 provider 429

    print(f"\n生成完成：{done}/{total} 条写入 doc_titles_zh"
          f"（失败批次 {failed_batches}）")
    print(f"db: {rag.db_path}")
    return 0 if done > 0 or failed_batches == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
