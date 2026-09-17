"""T4.2 验证: PyInstaller 打包的 tdsf-sidecar.exe 独立运行 (JSON-RPC 冒烟)

验证点:
1. exe 启动 → ready 通知 (stdout 首行)
2. ping 请求 → 响应 {"alive": true}
3. status 请求 → 响应 (版本/python 信息)
4. 数据目录: %APPDATA%/tdsf-terminal-agent/.tdsf-data 被创建 (frozen 适配关键验证)
5. shutdown 优雅退出
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# onedir 产物: dist-sidecar/tdsf-sidecar/tdsf-sidecar.exe
_EXE_CANDIDATES = [
    Path(os.environ["TDSF_SIDECAR_EXE"])
    if os.environ.get("TDSF_SIDECAR_EXE")
    else Path("__missing__"),
    Path(__file__).parent / "tdsf-sidecar" / "tdsf-sidecar.exe",
    Path(__file__).parent / "dist-sidecar" / "tdsf-sidecar" / "tdsf-sidecar.exe",
    Path(__file__).parent / "dist-sidecar" / "tdsf-sidecar.exe",
]
EXE = next((p for p in _EXE_CANDIDATES if p.exists()), None)
assert EXE is not None, "sidecar exe missing (check tdsf-sidecar/tdsf-sidecar.exe)"
DATA_DIR = (
    Path(os.environ.get("APPDATA", str(Path(sys.executable).parent)))
    / "tdsf-terminal-agent"
    / ".tdsf-data"
)

p = subprocess.Popen(
    [str(EXE)],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    # stderr 必须消费否则 64KB 缓冲写满会阻塞整个进程 (dev 模式由 Rust 侧
    # stderr_reader_task 消费; 这里日志已落盘 .tdsf-data/sidecar.log, 丢弃无妨)
    stderr=subprocess.DEVNULL,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
)

def read_line(timeout: float = 60.0) -> str:
    """stdout 按行读 (带超时, 线程方式避免阻塞)"""
    import queue
    import threading
    q: queue.Queue = queue.Queue()

    def _read():
        line = p.stdout.readline()
        q.put(line)

    t = threading.Thread(target=_read, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"no stdout line within {timeout}s")
    line = q.get_nowait()
    if line == "":
        raise RuntimeError("stdout closed (exe crashed?)")
    return line.strip()

def send(method: str, params: dict | None = None, rid: int = 1) -> dict:
    req = {"jsonrpc": "2.0", "method": method, "id": rid}
    if params is not None:
        req["params"] = params
    p.stdin.write(json.dumps(req) + "\n")
    p.stdin.flush()
    # 跳过 ready 等 notification 行, 直到拿到带 id 的响应
    deadline = time.time() + 60
    while time.time() < deadline:
        line = read_line(5.0)
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            print(f"  [non-json] {line[:120]}")
            continue
        if msg.get("id") == rid:
            return msg
        print(f"  [notification] {msg.get('method')}")
    raise TimeoutError(f"no response for {method}")

try:
    # 1. ready 通知 (启动过程会先推 sidecar:log 通知, 需循环等待;
    #    onefile 每次启动解压 248MB, 首行可能 30-60s 才来)
    print("== 1. waiting ready ==")
    ready_deadline = time.time() + 180
    ready_line = ""
    while time.time() < ready_deadline:
        line = read_line(60.0)
        if "ready" in line:
            ready_line = line
            break
        print(f"  [pre-ready] {line[:100]}")
    print(f"  ready: {ready_line[:160]}")
    assert "ready" in ready_line, "no ready notification within 180s"

    # 2. ping
    print("== 2. ping ==")
    r = send("ping", rid=2)
    print(f"  ping resp: {json.dumps(r, ensure_ascii=False)[:160]}")
    assert r.get("result", {}).get("alive") is True, "ping not alive"

    # 3. status
    print("== 3. status ==")
    r = send("status", rid=3)
    res = r.get("result", {})
    print(f"  status resp: {json.dumps(r, ensure_ascii=False)[:200]}")
    assert "version" in res or "status" in res, "status missing fields"

    # 4. 数据目录 (frozen 适配: %APPDATA%/tdsf-terminal-agent/.tdsf-data/)
    print("== 4. data dir ==")
    assert DATA_DIR.is_dir(), f".tdsf-data not created at {DATA_DIR}"
    sidecar_log = DATA_DIR / "sidecar.log"
    print(f"  data dir: {DATA_DIR} (exists={DATA_DIR.is_dir()}, log={sidecar_log.exists()})")

    # 5. shutdown
    print("== 5. shutdown ==")
    try:
        r = send("shutdown", rid=4)
        print(f"  shutdown resp: {json.dumps(r, ensure_ascii=False)[:120]}")
    except Exception as e:
        print(f"  shutdown req failed (may already exit): {e}")
    p.wait(timeout=30)
    print(f"  exit code: {p.returncode}")
    print("ALL CHECKS PASSED")
except Exception as e:
    print(f"FAILED: {e}")
    sys.exit(1)
