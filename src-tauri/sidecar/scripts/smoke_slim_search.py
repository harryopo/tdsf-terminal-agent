#!/usr/bin/env python
"""
scripts/smoke_slim_search.py — 精简库检索冒烟 + 全量/精简对比（TDSF 2026-08-31）
================================================================================

对同一组 query 分别查全量库（rag.db）与精简库（rag_slim.db），并排打印
命中标题/来源/RRF 分数/相似度，供人工对比命中质量（精简库命中应更聚焦）。

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/smoke_slim_search.py
    .venv/Scripts/python.exe scripts/smoke_slim_search.py --query "如何开放端口"
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

# Windows 控制台 GBK 编码无法输出部分西文字符（法语音标等）→ 强制 UTF-8
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_QUERIES = [
    "nginx 反向代理配置",
    "如何用 iptables 开放端口",
    "ssh 免密登录配置",
    "systemd 服务开机自启",
    "docker 容器数据卷挂载",
    "git 撤销最后一次提交",
    "selinux 上下文修复",
]


def _show(rows, width_title: int = 58) -> None:
    if not rows:
        print("    （无命中）")
        return
    for i, r in enumerate(rows[:5], 1):
        sim = r.get("similarity", "")
        sim_s = f" sim={sim:.3f}" if isinstance(sim, float) else ""
        print(
            f"    {i}. [{r.get('match_type')}] {r['title'][:width_title]}"
            f"  rrf={r.get('rrf_score')}{sim_s}"
        )
        print(f"       {r['content'][:100].replace(chr(10), ' ')}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="精简库检索冒烟对比")
    parser.add_argument("--query", default=None, help="单条自定义 query")
    parser.add_argument("--top", type=int, default=5, help="每库展示 top-K")
    args = parser.parse_args(argv)

    from knowledge.rag import get_global_rag, get_slim_rag

    full = get_global_rag()
    slim = get_slim_rag()
    print(f"全量库: {full.db_path}  ({full.count()} 块)")
    print(f"精简库: {slim.db_path}  ({slim.count()} 块)")

    queries = [args.query] if args.query else DEFAULT_QUERIES
    for q in queries:
        print(f"\n{'=' * 78}\nQUERY: {q}\n{'=' * 78}")
        print("  -- 全量 rag.db --")
        _show(full.hybrid_search(q, top_k=args.top))
        print("  -- 精简 rag_slim.db --")
        _show(slim.hybrid_search(q, top_k=args.top))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
