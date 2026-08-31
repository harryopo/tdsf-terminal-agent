"""analyze_junk.py — 知识库章节垃圾模式统计（一次性诊断）"""
import re
import sqlite3

con = sqlite3.connect(r".tdsf-data\rag.db")
rows = con.execute(
    "SELECT title, source FROM entries WHERE source LIKE '%-docs' ORDER BY title"
).fetchall()
print("total chunks:", len(rows))

patterns = {
    "要点/Keywords": re.compile(r"要点|Keywords", re.I),
    "开发类": re.compile(r"Development|Release|Style Guide|Contribut|Developer", re.I),
    "vulnerab/安全报告": re.compile(r"vulnerab|Security Report", re.I),
    "版本/索引/FAQ": re.compile(r"^Apache 2\.\d 文档|FAQ|Index of|Master Index", re.I),
    "man 残渣标题": re.compile(r"^See also$|^EXAMPLES$|^SYNOPSIS$|^COPYRIGHT$", re.I),
}
for name, pat in patterns.items():
    hits = [r for r in rows if pat.search(r[0])]
    print(f"{name}: {len(hits)}")
    for r in hits[:12]:
        print(f"   - {r[1][:18]} | {r[0][:70]}")
    print()
