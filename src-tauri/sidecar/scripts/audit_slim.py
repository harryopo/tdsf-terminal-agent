"""audit_slim.py — 精简版数据分析：章节粒度分布 + 内容类型判断"""
import re
import sqlite3
import sys

sys.stdout = open(r".tdsf-data\slim-out.txt", "w", encoding="utf-8")

con = sqlite3.connect(r".tdsf-data\rag.db")
cur = con.cursor()

print("=== 1. 章节粒度分布（合并文件一级章节 = title 不含 · # 的块）===")
# 一级章节块：title 不含子段后缀（· #N）
rows = cur.execute(
    "SELECT COUNT(*), SUM(LENGTH(content)) FROM entries "
    "WHERE category != 'linux-philosophy'"
).fetchone()
total_blocks, total_chars = rows
print(f"官方总块: {total_blocks}, 总字符: {total_chars} ({total_chars/10000:.0f}万)")

# 长度分布
rows = cur.execute(
    "SELECT CASE WHEN LENGTH(content)<300 THEN 'a.<300' "
    "WHEN LENGTH(content)<800 THEN 'b.300-800' "
    "WHEN LENGTH(content)<2000 THEN 'c.800-2000' "
    "ELSE 'd.>2000' END bucket, COUNT(*), SUM(LENGTH(content)) "
    "FROM entries WHERE category != 'linux-philosophy' GROUP BY 1"
).fetchall()
for b, n, c in rows:
    print(f"  {b:12s} {n:5d} 块  {c/10000:6.1f}万字")

print("\n=== 2. 一级章节数（每合并文件）===")
rows = cur.execute(
    "SELECT substr(title,1,instr(title,' · ')-1), COUNT(*) FROM entries "
    "WHERE category != 'linux-philosophy' AND instr(title,' · ')>0 "
    "GROUP BY 1 ORDER BY 2 DESC LIMIT 8"
).fetchall()
for t, n in rows:
    print(f"  {n:5d} 块 | {t[:50]}")
rows = cur.execute(
    "SELECT COUNT(*) FROM entries WHERE category != 'linux-philosophy' "
    "AND instr(title,' · ')=0"
).fetchone()
print(f"  导语块（无 · ）: {rows[0]}")

print("\n=== 3. 内容类型占比（启发式）===")
# 代码/命令密集 vs 叙述型
rows = cur.execute("SELECT title, content FROM entries WHERE category != 'linux-philosophy'").fetchall()
code_heavy = 0
table_only = 0
narrative = 0
example = []
for t, c in rows:
    n = len(c)
    fence_chars = sum(len(m) for m in re.findall(r"```.*?```", c, re.S))
    if fence_chars / max(n, 1) > 0.5:
        code_heavy += 1
    elif c.count("|") / max(n, 1) > 0.15:
        table_only += 1
        if len(example) < 5:
            example.append((t, c[:80]))
    else:
        narrative += 1
print(f"  代码密集(围栏>50%): {code_heavy}")
print(f"  表格密集(|>15%): {table_only}")
print(f"  叙述型: {narrative}")

print("\n=== 4. man 手册类章节抽样（页面源占比）===")
rows = cur.execute(
    "SELECT source, COUNT(*), SUM(LENGTH(content)) FROM entries "
    "WHERE category != 'linux-philosophy' GROUP BY source ORDER BY 3 DESC"
).fetchall()
for s, n, c in rows:
    print(f"  {s:20s} {n:5d} 块 {c/10000:6.1f}万字")

print("\n=== 5. 短块抽样（<300，是否低价值）===")
rows = cur.execute(
    "SELECT title, substr(content,1,60) FROM entries "
    "WHERE category != 'linux-philosophy' AND LENGTH(content)<300 LIMIT 10"
).fetchall()
for t, c in rows:
    print(f"  {t[:48]} | {c[:40]!r}")
