"""
Tauri 行为模拟: 真实 spawn Python sidecar，验证 ready/ping/RPC 协议
模拟 src-tauri/src/modules/sidecar.rs 的启动握手流程
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

SIDE_DIR = Path(__file__).resolve().parent
PYTHON = sys.executable
SCRIPT = str(SIDE_DIR / "main.py")


async def simulate_tauri_sidecar():
    """模拟 Tauri sidecar.rs 的 spawn 流程"""
    print("=" * 60)
    print("Tauri 行为模拟: 真实 spawn Python sidecar")
    print("=" * 60)

    env = {
        **os.environ,
        "TDSF_SIDECAR_LOG": "INFO",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }

    proc = await asyncio.create_subprocess_exec(
        PYTHON, "-u", SCRIPT,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(SIDE_DIR),
        env=env,
    )
    print(f"[spawn] pid={proc.pid}")

    # 异步读取 stderr
    async def drain_stderr():
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            try:
                text = line.decode("utf-8", errors="replace").rstrip()
            except Exception:
                text = str(line)
            if text:
                print(f"[sidecar-stderr] {text}")

    stderr_task = asyncio.create_task(drain_stderr())

    # 1. 等待 ready 通知
    print("\n[step 1] 等待 sidecar ready 通知 (timeout=10s)...")
    ready_deadline = time.time() + 10
    ready_msg = None
    while time.time() < ready_deadline:
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=2.0)
        if not line:
            print("[FAIL] sidecar stdout 关闭")
            proc.kill()
            return False
        try:
            msg = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if msg.get("method") == "ready":
            ready_msg = msg
            break
    if not ready_msg:
        print("[FAIL] 10s 内未收到 ready 通知")
        proc.kill()
        return False
    print(f"[OK] 收到 ready 通知: keys={list(ready_msg.keys())}")
    if "params" in ready_msg:
        p = ready_msg["params"]
        if isinstance(p, dict):
            print(f"  python={p.get('python_version', '?')}, methods={len(p.get('methods', []))}")

    # 2. 发送 ping
    print("\n[step 2] 发送 ping 请求...")
    req = {"jsonrpc": "2.0", "method": "ping", "params": {}, "id": 1}
    proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
    await proc.stdin.drain()

    deadline = time.time() + 5
    while time.time() < deadline:
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=5.0)
        if not line:
            break
        try:
            msg = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if msg.get("id") == 1 and "result" in msg:
            print(f"[OK] ping 响应: {msg['result']}")
            break
    else:
        print("[FAIL] ping 无响应")
        proc.kill()
        return False

    # 3. 发送 status 请求
    print("\n[step 3] 发送 status 请求...")
    req = {"jsonrpc": "2.0", "method": "status", "params": {}, "id": 2}
    proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
    await proc.stdin.drain()

    deadline = time.time() + 5
    while time.time() < deadline:
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=5.0)
        if not line:
            break
        try:
            msg = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if msg.get("id") == 2 and "result" in msg:
            r = msg["result"]
            print(f"[OK] status: version={r.get('version')}, methods={len(r.get('methods', []))}")
            break
    else:
        print("[FAIL] status 无响应")
        proc.kill()
        return False

    # 4. 风险评估 RPC
    print("\n[step 4] 发送 risk.evaluate RPC...")
    req = {
        "jsonrpc": "2.0",
        "method": "risk.evaluate",
        "params": {"command": "rm -rf /"},
        "id": 3,
    }
    proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
    await proc.stdin.drain()

    deadline = time.time() + 5
    while time.time() < deadline:
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=5.0)
        if not line:
            break
        try:
            msg = json.loads(line.decode("utf-8"))
        except Exception:
            continue
        if msg.get("id") == 3:
            if "result" in msg:
                r = msg["result"]
                print(f"[OK] risk.evaluate: level={r.get('level')}, approval={r.get('require_approval')}")
            elif "error" in msg:
                print(f"[FAIL] error: {msg['error']}")
                proc.kill()
                return False
            break
    else:
        print("[FAIL] risk.evaluate 无响应")
        proc.kill()
        return False

    # 5. 优雅关闭（发送 shutdown）
    print("\n[step 5] 发送 shutdown 优雅退出...")
    try:
        req = {"jsonrpc": "2.0", "method": "shutdown", "params": {}, "id": 99}
        proc.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
        await proc.stdin.drain()
    except Exception:
        pass

    try:
        await asyncio.wait_for(proc.wait(), timeout=3.0)
        print(f"[OK] 进程正常退出 (exit_code={proc.returncode})")
    except asyncio.TimeoutError:
        print("[WARN] shutdown 3s 未退出，强制 kill")
        proc.kill()
        await proc.wait()

    stderr_task.cancel()
    try:
        await stderr_task
    except asyncio.CancelledError:
        pass

    print("\n" + "=" * 60)
    print("✓ Tauri 行为模拟测试全部通过")
    return True


if __name__ == "__main__":
    ok = asyncio.run(simulate_tauri_sidecar())
    sys.exit(0 if ok else 1)
