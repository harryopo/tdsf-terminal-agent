"""purge_builtin.py — 清除知识库 builtin-* 个人语料残留（一次性运维脚本）"""
import sqlite3
import sys

sys.path.insert(0, ".")
from knowledge.rag import get_global_rag  # noqa: E402

rag = get_global_rag()
con = sqlite3.connect(str(rag.db_path))
ids = [
    r[0]
    for r in con.execute("SELECT id FROM entries WHERE source LIKE 'builtin%'")
]
con.close()
print(f"removing {len(ids)} builtin entries...")
for eid in ids:
    rag.delete(eid)
print("remaining total:", rag.count())
con2 = sqlite3.connect(str(rag.db_path))
for row in con2.execute(
    "SELECT source, count(*) FROM entries GROUP BY source ORDER BY 1"
):
    print(f"{row[0]:<18} {row[1]:>4} entries")
