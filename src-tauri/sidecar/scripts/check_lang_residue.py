#!/usr/bin/env python
"""
scripts/check_lang_residue.py — 知识库语言残留扫描（TDSF 2026-08-30）
=====================================================================

用途：重爬后验证官方文档正文无非英文（西语等）残留。按任务约定扫描
entries 表 content/title 中的西班牙语高频特征词；命中 >0 时打印样本。

用法（在 src-tauri/sidecar 下）：
    .venv/Scripts/python.exe scripts/check_lang_residue.py
    .venv/Scripts/python.exe scripts/check_lang_residue.py --sample 5

退出码：0 = 零命中；1 = 有残留（CI/人工复检用）。
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

# 与应用/rebuild_knowledge.py 读写同一个 rag.db（<项目根>/.tdsf-data）
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

logger = logging.getLogger("sidecar.scripts.check_lang_residue")

# 西班牙语特征词（大小写不敏感；均为官方站西语版正文/标题高频词）
_ES_PATTERNS = [
    "%Documentaci%",   # Documentación / Documentaci
    "%NOMBRE%",        # man 页西语版「名称」节
    "%Descripci%",     # Descripción
    "%configuraci%",   # configuración
    "%introducci%",    # introducción（单独出现也常见于西语正文开头）
    "%SINOPSIS%",      # man 页西语版「概要」节
    "%UTILIZACI%",     # utilización
    "%servidor%",      # 西语「服务器」（docker/k8s 西语版高频）
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="知识库语言残留扫描")
    parser.add_argument("--sample", type=int, default=3, help="命中时打印样本条数")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    from knowledge.rag import get_global_rag

    rag = get_global_rag()
    conn = rag._conn  # noqa: SLF001  运维脚本直连只读扫描
    assert conn is not None

    where = " OR ".join(
        ["content LIKE ? OR title LIKE ?"] * len(_ES_PATTERNS)
    )
    params: list[str] = []
    for p in _ES_PATTERNS:
        params.extend([p, p])
    rows = conn.execute(
        f"SELECT id, source, title FROM entries WHERE {where}", params
    ).fetchall()

    total = conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
    official = conn.execute(
        "SELECT COUNT(*) FROM entries WHERE source LIKE '%-docs' OR source = 'archwiki'"
    ).fetchone()[0]
    print(f"entries total={total} official={official} residue_hits={len(rows)}")
    for r in rows[: args.sample]:
        print(f"  [{r['source']}] {r['id']}: {str(r['title'])[:80]}")
    if rows:
        sources = conn.execute(
            f"SELECT source, COUNT(*) FROM entries WHERE {where} GROUP BY source",
            params,
        ).fetchall()
        print("  by source:", [(s["source"], int(s[1])) for s in sources])
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
