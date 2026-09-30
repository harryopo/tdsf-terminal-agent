#!/usr/bin/env python3
"""把随包知识库剪到**允许再分发**的来源范围内（离线一次性，#166 ⑥ 续）

为什么跑这个（2026-09-29）：随包分发前逐源核了一次许可，结论比原先假设的硬 ——
Redis 站点条款明文禁止 republish/redistribute、Pro Git 是 CC BY-NC-SA 3.0（SA 与 Apache-2.0
冲突）、Arch Wiki 是 GNU FDL 1.3+（衍生作品须同许可 + 附许可全文）、bash 手册 GFDL、
Gentoo wiki CC BY-SA，另有 ssh/iptables/systemd/dnf 四个源**找不到覆盖文档文字的许可授予**
（"没找到许可"＝未获授权，不是"可以随便用"）。名单与依据都在 `knowledge/bundled_scope.py`，
本脚本只按那份名单剪枝，判断不在这里再写一遍。

默认**演练**（写到临时文件、跑一致性校验、打印读数，不动随包 db）；
加 `--write` 才替换 `knowledge-bundled/rag_slim.db`（旧件先备份到 `--backup` 指定处）。

跑法（在 src-tauri/sidecar 下）：
  .venv/Scripts/python.exe -B scripts/prune_bundled_knowledge.py
  .venv/Scripts/python.exe -B scripts/prune_bundled_knowledge.py --write
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

SIDECAR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SIDECAR))

from knowledge.bundled_scope import (  # noqa: E402
    allowed_sources,
    prune_to_bundled_scope,
)

BUNDLE = SIDECAR / "knowledge-bundled" / "rag_slim.db"


def counts(db: Path) -> dict[str, int]:
    # with sqlite3.connect(...) 只管事务、**不会关连接** —— Windows 上没关的句柄
    # 会让后面的 unlink/move 报 WinError 32（本轮就撞在这）。所以要 closing。
    with closing(sqlite3.connect(f"file:{db}?mode=ro", uri=True)) as conn:
        return {
            str(r[0] or "<empty>"): int(r[1])
            for r in conn.execute(
                "SELECT source, COUNT(*) FROM entries GROUP BY source ORDER BY COUNT(*) DESC"
            )
        }


def optimize_and_vacuum(db: Path) -> None:
    """FTS5 删行后要 optimize 才回收倒排段，再 VACUUM 压文件。"""
    with closing(sqlite3.connect(db)) as conn:
        conn.execute("INSERT INTO fts_entries(fts_entries) VALUES('optimize')")
        conn.commit()
        conn.execute("VACUUM")
        conn.commit()


def consistency(db: Path) -> list[str]:
    """三表 rowid 必须一一对齐 —— 剪枝最容易留下的就是 FTS/向量孤儿行。"""
    problems: list[str] = []
    with closing(sqlite3.connect(f"file:{db}?mode=ro", uri=True)) as conn:
        entries = {int(r[0]) for r in conn.execute("SELECT rowid FROM entries")}
        fts = {int(r[0]) for r in conn.execute("SELECT rowid FROM fts_entries")}
        vec = {int(r[0]) for r in conn.execute("SELECT rowid FROM vec_entries_rowids")}
        for name, got in (("fts_entries", fts), ("vec_entries_rowids", vec)):
            orphans = got - entries
            missing = entries - got
            if orphans:
                problems.append(f"{name} 有 {len(orphans)} 条孤儿行（entries 里已删）")
            if missing:
                problems.append(f"{name} 少 {len(missing)} 条（entries 里有）")
        bad = conn.execute("PRAGMA integrity_check").fetchone()
        if str(bad[0]) != "ok":
            problems.append(f"integrity_check: {bad[0]}")
        leftover = [
            str(s)
            for (s,) in conn.execute("SELECT DISTINCT source FROM entries")
            if str(s) not in allowed_sources()
        ]
        if leftover:
            problems.append(f"仍含不可分发来源：{sorted(leftover)}")
        titles = conn.execute(
            "SELECT COUNT(*) FROM doc_titles_zh WHERE url NOT IN (SELECT url FROM entries)"
        ).fetchone()[0]
        if int(titles) > 0:
            problems.append(f"doc_titles_zh 有 {titles} 条无主标题")
        cache = conn.execute("SELECT COUNT(*) FROM embed_cache").fetchone()[0]
        if int(cache) > 0:
            problems.append(f"embed_cache 仍有 {cache} 条（随包件里应当清空）")
    return problems



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="真的替换随包 db（默认只演练）")
    ap.add_argument(
        "--backup",
        default=str(SIDECAR.parent.parent / "outputs" / "rag_slim-660-before-prune.db"),
        help="旧随包 db 的备份位置（--write 时才用）",
    )
    args = ap.parse_args()

    if not BUNDLE.exists():
        print(f"找不到随包 db：{BUNDLE}")
        return 1

    work = BUNDLE.with_suffix(".prune-work.db")
    shutil.copyfile(BUNDLE, work)
    before = counts(work)
    print("剪枝前：")
    for source, n in sorted(before.items(), key=lambda kv: -kv[1]):
        mark = "保留" if source in allowed_sources() else "剔除"
        print(f"  {source:<16}{n:>5}  {mark}")
    print(f"  合计 {sum(before.values())} 条 / {BUNDLE.stat().st_size:,} B")

    removed = prune_to_bundled_scope(work)
    optimize_and_vacuum(work)
    after = counts(work)
    problems = consistency(work)

    print("\n剪枝后：")
    for source, n in sorted(after.items(), key=lambda kv: -kv[1]):
        print(f"  {source:<16}{n:>5}")
    print(
        f"  合计 {sum(after.values())} 条（删 {sum(v for k, v in removed.items() if not k.startswith('<'))} 条）/ "
        f"{work.stat().st_size:,} B"
    )
    print(f"  派生表清理：{ {k: v for k, v in removed.items() if k.startswith('<')} }")
    for p in problems:
        print(f"  ⚠️ {p}")


    if problems:
        work.unlink(missing_ok=True)
        print("\n三表对齐或完整性校验没过 ⇒ 不写回，临时件已删")
        return 1

    if not args.write:
        work.unlink(missing_ok=True)
        print("\n演练完成（没动随包 db；确认无误后加 --write）")
        return 0

    backup = Path(args.backup)
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BUNDLE, backup)
    shutil.move(str(work), str(BUNDLE))
    print(f"\n已替换 {BUNDLE}（旧件备份在 {backup}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
