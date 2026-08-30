"""purge_builtin.py — 清除知识库 builtin-* 个人语料残留（一次性运维脚本）"""
import os
import sqlite3
import sys
from pathlib import Path

# TDSF 2026-08-30 根因修复：与应用（main.py）读写同一个 rag.db（<项目根>/.tdsf-data）。
# RagIndex 实例化时才读 TDSF_DATA_DIR，先 set 再 import 即生效；强制 set 防环境缺失。
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))
from knowledge.rag import get_global_rag  # noqa: E402

rag = get_global_rag()
print("db:", rag.db_path)
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
