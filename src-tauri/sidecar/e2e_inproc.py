"""
端到端测试 (in-process): 直接 import sidecar 模块并调用 handler
避开 subprocess 启动开销，更快暴露逻辑问题。
"""
import sys
from pathlib import Path

SIDE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SIDE_DIR))

# 触发数据目录初始化
import os
_TDSF_DATA_DIR = SIDE_DIR.parent.parent / ".tdsf-data"
_TDSF_DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("TDSF_DATA_DIR", str(_TDSF_DATA_DIR))

from main import MethodDispatcher, register_business_methods, send_notification  # noqa: E402

dispatcher = MethodDispatcher()
register_business_methods(dispatcher)


def call(method: str, params: dict | None = None, timeout: float = 8.0):
    """直接同步调用 handler"""
    import time
    start = time.time()
    try:
        result = dispatcher.dispatch(
            method=method,
            params=params or {},
        )
        elapsed = (time.time() - start) * 1000
        return {"ok": True, "elapsed_ms": round(elapsed, 1), "result": result}
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        return {"ok": False, "elapsed_ms": round(elapsed, 1), "error": str(e)}


def show(label: str, resp: dict, key: str | None = None, limit: int = 200):
    """展示结果"""
    print(f"\n--- {label}  [{resp['elapsed_ms']}ms] ---")
    if not resp["ok"]:
        print(f"  ✗ {resp['error']}")
        return
    r = resp["result"]
    if key and isinstance(r, dict):
        r = r.get(key, r)
    s = str(r)
    if len(s) > limit:
        s = s[:limit] + "..."
    print(f"  ✓ {s}")


print("=" * 60)
print(f"已注册方法总数: {len(dispatcher.list_methods())}")
print("=" * 60)

# 1. ping
show("ping", call("ping", {}))

# 2. status
show("status", call("status", {}))

# 3. agent.list
show("agent.list", call("agent.list", {}))

# 4. agent.info
show("agent.info(coding)", call("agent.info", {"name": "coding"}))

# 5. skill.list (limit 5)
show("skill.list(limit=5)", call("skill.list", {"limit": 5}))

# 6. skill.get
show("skill.get(linux-ops)", call("skill.get", {"name": "linux-ops"}))

# 7. risk.evaluate
show("risk.evaluate(rm -rf /tmp/test)", call("risk.evaluate", {"command": "rm -rf /tmp/test"}))
show("risk.evaluate(ls -la)", call("risk.evaluate", {"command": "ls -la"}))
show("risk.evaluate(sudo apt update)", call("risk.evaluate", {"command": "sudo apt update"}))

# 8. event.list_types
show("event.list_types", call("event.list_types", {}))

# 9. fix_loop.stats
show("fix_loop.stats", call("fix_loop.stats", {}))

# 10. decision.list
show("decision.list(limit=3)", call("decision.list", {"limit": 3}))

# 11. tdsf.status
show("tdsf.status", call("tdsf.status", {}))

# 12. confidence.score
show("confidence.score", call("confidence.score", {"text": "根据 Linux man page（man 7 signal），SIGTERM 是默认终止信号。"}))

# 13. long_context.status
show("long_context.status", call("long_context.status", {}))

# 14. squilla.list_tiers
show("squilla.list_tiers", call("squilla.list_tiers", {}))

# 15. agent.configure (查询当前状态，不传 config)
show("agent.configure (status query)", call("agent.configure", {}))

print("\n" + "=" * 60)
print("✓ 端到端 in-process 验证完成")
