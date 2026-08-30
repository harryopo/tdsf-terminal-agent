"""smoke_search.py — 语义检索冒烟验证（一次性运维脚本，可重复执行）"""
import os
import sys
from pathlib import Path

# TDSF 2026-08-30 根因修复：运维脚本必须与应用（main.py）读写同一个 rag.db。
# 应用 dev 数据目录 = <项目根>/.tdsf-data/；此前脚本落到 sidecar/data/rag.db
# （第二个库），purge/rebuild/crawl 全修在应用不读的库上。
# RagIndex 在**实例化时**读 TDSF_DATA_DIR（rag.py __init__），故此处设置先于
# get_global_rag() 即生效。强制 set（非 setdefault）：sidecar 进程环境可能没有。
# scripts→sidecar→src-tauri→项目根 = parents[3]，与 main.py L75 同一路径
os.environ["TDSF_DATA_DIR"] = str(Path(__file__).resolve().parents[3] / ".tdsf-data")

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))
from knowledge.rag import get_global_rag  # noqa: E402

QUERIES = [
    "服务启动失败怎么办",
    "怎么排查 nginx 502",
    "samba 共享目录 Windows 访问不了",
]

rag = get_global_rag()
print("db:", rag.db_path)
print("total:", rag.count())
for q in QUERIES:
    rs = rag.hybrid_search(q, top_k=5)
    print(f"--- {q}")
    for r in rs[:3]:
        sim = r.get("similarity", "-")
        print(f"  [{sim}] {r['title'][:44]}  ({r['source']})")
