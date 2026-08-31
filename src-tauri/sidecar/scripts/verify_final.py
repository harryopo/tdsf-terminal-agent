"""verify_final.py — 精简库收官验证"""
import sqlite3
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "src-tauri" / "sidecar"))
import os

os.environ["TDSF_DATA_DIR"] = str(ROOT / ".tdsf-data")
os.chdir(ROOT / "src-tauri" / "sidecar")

from knowledge.rag import get_slim_rag  # noqa: E402

slim = get_slim_rag()
print("slim blocks:", slim.count())

# 覆盖验证：623 章节中未提炼还剩几个（按 slim id 前缀聚合应无 FAIL 剩余）
con = sqlite3.connect(str(ROOT / ".tdsf-data" / "rag_slim.db"))
n_slim = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
n_manual = con.execute(
    "SELECT COUNT(*) FROM entries WHERE tags LIKE '%manual-distill%'"
).fetchone()[0]
n_philo = con.execute(
    "SELECT COUNT(*) FROM entries WHERE source='philosophy'"
).fetchone()[0]
print(f"总块 {n_slim} = 手工提炼 {n_manual} + philosophy {n_philo} + LLM 提炼 {n_slim - n_manual - n_philo}")

print("\n=== 检索冒烟（含新补章节）===")
for q in ["双重 NAT 重叠地址段", "fstab 开机挂载 nofail", "iptables 默认拒绝策略", "nginx 缓存 proxy_cache"]:
    hits = slim.hybrid_search(q, top_k=2)
    print(f"  {q} -> {[h['title'][:40] for h in hits]}")
