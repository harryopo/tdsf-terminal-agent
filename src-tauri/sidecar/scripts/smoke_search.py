"""smoke_search.py — 语义检索冒烟验证（一次性运维脚本，可重复执行）"""
import sys

sys.path.insert(0, ".")
from knowledge.rag import get_global_rag  # noqa: E402

QUERIES = [
    "服务启动失败怎么办",
    "怎么排查 nginx 502",
    "samba 共享目录 Windows 访问不了",
]

rag = get_global_rag()
print("total:", rag.count())
for q in QUERIES:
    rs = rag.hybrid_search(q, top_k=5)
    print(f"--- {q}")
    for r in rs[:3]:
        sim = r.get("similarity", "-")
        print(f"  [{sim}] {r['title'][:44]}  ({r['source']})")
