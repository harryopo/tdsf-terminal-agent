"""
端到端测试: 通过 stdin/stdout JSON-RPC 调用 Sidecar
模拟 Rust 端的 ipc_invoke 通信，验证真实运行时 API。
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SIDE_DIR = Path(__file__).resolve().parent


def call_sidecar(method: str, params: dict, timeout: float = 10.0) -> dict:
    """通过 stdin/stdout 调用一次 JSON-RPC"""
    req = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": int(time.time() * 1000) % 100000,
    }
    proc = subprocess.Popen(
        [sys.executable, str(SIDE_DIR / "main.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(SIDE_DIR),
        env={**os.environ, "TDSF_SIDECAR_LOG": "INFO"},
        text=True,
        bufsize=1,
    )
    try:
        # 写请求
        proc.stdin.write(json.dumps(req) + "\n")
        proc.stdin.flush()
        proc.stdin.close()
        # 读 ready 通知（直到收到 response 或 timeout）
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
                if "result" in msg and msg.get("id") == req["id"]:
                    return msg["result"]
                if "error" in msg and msg.get("id") == req["id"]:
                    return {"_error": msg["error"]}
            except json.JSONDecodeError:
                continue
        return {"_timeout": True}
    finally:
        try:
            proc.kill()
        except Exception:
            pass
        proc.wait(timeout=2)


def test(label: str, fn):
    print(f"\n--- {label} ---")
    try:
        result = fn()
        if result.get("_error"):
            print(f"  ✗ ERROR: {result['_error']}")
            return False
        if result.get("_timeout"):
            print(f"  ✗ TIMEOUT")
            return False
        # 截断长输出
        s = json.dumps(result, ensure_ascii=False, default=str)
        if len(s) > 400:
            s = s[:400] + "..."
        print(f"  ✓ {s}")
        return True
    except Exception as e:
        print(f"  ✗ EXCEPTION: {e}")
        return False


results = []

# 1. ping
def t1():
    return call_sidecar("ping", {}, timeout=8)
results.append(test("ping", t1))

# 2. status
def t2():
    return call_sidecar("status", {}, timeout=8)
results.append(test("status", t2))

# 3. agent.list
def t3():
    return call_sidecar("agent.list", {}, timeout=8)
results.append(test("agent.list", t3))

# 4. agent.info(coding)
def t4():
    return call_sidecar("agent.info", {"name": "coding"}, timeout=8)
results.append(test("agent.info(coding)", t4))

# 5. skill.list
def t5():
    return call_sidecar("skill.list", {"limit": 5}, timeout=8)
results.append(test("skill.list", t5))

# 6. risk.evaluate("rm -rf /tmp/test")
def t6():
    return call_sidecar("risk.evaluate", {"command": "rm -rf /tmp/test"}, timeout=8)
results.append(test("risk.evaluate(rm -rf)", t6))

# 7. risk.evaluate("ls -la")
def t7():
    return call_sidecar("risk.evaluate", {"command": "ls -la"}, timeout=8)
results.append(test("risk.evaluate(ls -la)", t7))

# 8. decision.list
def t8():
    return call_sidecar("decision.list", {"limit": 3}, timeout=8)
results.append(test("decision.list", t8))

# 9. event.list_types
def t9():
    return call_sidecar("event.list_types", {}, timeout=8)
results.append(test("event.list_types", t9))

# 10. fix_loop.stats
def t10():
    return call_sidecar("fix_loop.stats", {}, timeout=8)
results.append(test("fix_loop.stats", t10))

# 总结
print("\n" + "=" * 50)
print(f"结果: {sum(results)}/{len(results)} 通过")
if all(results):
    print("✓ 所有端到端测试通过")
else:
    print("✗ 部分测试失败")
    sys.exit(1)
