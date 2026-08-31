"""audit_fail.py — 定性 13 个失败章节的源内容"""
import hashlib
import re
import sqlite3
import sys

sys.stdout = open(r".tdsf-data\fail-out.txt", "w", encoding="utf-8")

FAIL_IDS = [
    "slim-a20b1c94-3", "slim-c3557f41-23", "slim-f6cac906-20",
    "slim-bb781115-17", "slim-c3557f41-18", "slim-c3557f41-7",
    "slim-c3557f41-8", "slim-c3557f41-10", "slim-a1ce7ef8-8",
    "slim-d3ad0244-0", "slim-79afa7ad-0", "slim-79afa7ad-7",
    "slim-f9c76ce1-10",
]

con = sqlite3.connect(r".tdsf-data\rag.db")
cur = con.cursor()

# 反查：slim-<md5(url)[:8]>-<章节序> 的 url 与章节内容
rows = cur.execute(
    "SELECT url, title, id, LENGTH(content), substr(content,1,150) "
    "FROM entries WHERE category != 'linux-philosophy'"
).fetchall()
# 章节聚合（同 distill 逻辑简化版）：url + title 段1
sections: dict[str, dict] = {}
ws = re.compile(r"\s+")
for url, title, eid, n, head in rows:
    parts = ws.sub(" ", title or "").strip().split(" · ")
    doc = parts[0]
    sec = parts[1] if len(parts) > 1 else ""
    key = f"slim-{hashlib.md5(url.encode()).hexdigest()[:8]}-{abs(hash((url, sec))) % 100000}"
    # 直接用章节序不对——distill 用稳定序号；改为按 url+sec 聚合展示
    skey = (url, sec)
    if skey not in sections:
        sections[skey] = {"doc": doc, "sec": sec, "chars": 0, "head": head}
    sections[skey]["chars"] += n

# 打印全部章节中字符数最大的、以及标题含可疑词的
print("=== 大章节（>4000 字）清单 ===")
for (url, sec), s in sorted(sections.items(), key=lambda kv: -kv[1]["chars"]):
    if s["chars"] > 4000:
        print(f"  {s['chars']:6d} | {s['doc'][:20]} · {s['sec'][:55]}")

print("\n=== 可疑脏章（PS/模板/沙箱/索引）===")
pat = re.compile(r"PS\)|PostScript|sandboxes|HOWTO \(|文档索引|Index", re.I)
for (url, sec), s in sections.items():
    if pat.search(s["sec"] or "") or pat.search(s["head"] or ""):
        print(f"  {s['chars']:6d} | {s['doc'][:20]} · {s['sec'][:55]}")

print("\n=== 失败 id 对应章节内容头 ===")
# 重建 distill 的稳定序：按 url 内 (url, sec) 首块序
seen_order: dict[str, dict[str, int]] = {}
for url, title, eid, n, head in rows:
    parts = ws.sub(" ", title or "").strip().split(" · ")
    sec = parts[1] if len(parts) > 1 else ""
    if url not in seen_order:
        seen_order[url] = {}
    if sec not in seen_order[url]:
        seen_order[url][sec] = len(seen_order[url])
for fid in FAIL_IDS:
    h = fid.split("-")[1]
    seq = int(fid.split("-")[2])
    match = [url for url in seen_order if hashlib.md5(url.encode()).hexdigest()[:8] == h]
    if not match:
        print(f"  {fid}: url 未找到")
        continue
    url = match[0]
    sec2seq = seen_order[url]
    sec = next((k for k, v in sec2seq.items() if v == seq), "?")
    skey = (url, sec)
    s = sections.get(skey)
    if s:
        print(f"  {fid} | {s['chars']:6d} 字 | {s['doc'][:16]} · {s['sec'][:50]}")
        print(f"        head: {s['head'][:100]!r}")
