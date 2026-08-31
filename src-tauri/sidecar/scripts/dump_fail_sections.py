"""dump_fail_sections.py — 导出 10 个失败章节原文供主 agent 直接提炼"""
import hashlib
import re
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

FAIL = [
    "slim-c3557f41-7", "slim-c3557f41-8", "slim-c3557f41-10",
    "slim-c3557f41-18", "slim-f6cac906-20", "slim-f9c76ce1-10",
    "slim-a20b1c94-3", "slim-bb781115-17", "slim-a1ce7ef8-8",
    "slim-d3ad0244-0", "slim-79afa7ad-0", "slim-79afa7ad-7",
]

con = sqlite3.connect(
    str(Path(__file__).resolve().parents[3] / ".tdsf-data" / "rag.db")
)
rows = con.execute(
    "SELECT url, title, content FROM entries WHERE category != 'linux-philosophy' "
    "ORDER BY url, id"
).fetchall()

ws = re.compile(r"\s+")
sections: dict[tuple, dict] = {}
order: dict[str, dict[str, int]] = {}
for url, title, content in rows:
    parts = ws.sub(" ", title or "").strip().split(" · ")
    sec = parts[1] if len(parts) > 1 else ""
    if url not in order:
        order[url] = {}
    if sec not in order[url]:
        order[url][sec] = len(order[url])
    k = (url, sec)
    if k not in sections:
        sections[k] = {"doc": parts[0], "sec": sec, "chunks": []}
    sections[k]["chunks"].append(content)

outdir = Path(".tdsf-data") / "fail-sections"
outdir.mkdir(exist_ok=True)
for fid in FAIL:
    h = fid.split("-")[1]
    seq = int(fid.split("-")[2])
    match = [u for u in order if hashlib.md5(u.encode()).hexdigest()[:8] == h]
    if not match:
        print(f"{fid}: url miss")
        continue
    url = match[0]
    sec = next((k for k, v in order[url].items() if v == seq), "?")
    s = sections.get((url, sec))
    if not s:
        print(f"{fid}: section miss")
        continue
    safe = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", f"{s['doc']}_{s['sec']}")[:60]
    p = outdir / f"{fid}__{safe}.md"
    p.write_text(
        f"<!-- id: {fid} | url: {url} | 章节: {s['sec']} -->\n\n"
        + "\n\n".join(s["chunks"]),
        encoding="utf-8",
    )
    total = sum(len(c) for c in s["chunks"])
    print(f"{fid} -> {p.name} ({total} 字)")
