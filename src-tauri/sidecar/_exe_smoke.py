"""T4.2 验证: PyInstaller 打包的 tdsf-sidecar.exe 独立运行 (JSON-RPC 冒烟)

验证点:
1. exe 启动 → ready 通知 (stdout 首行)
2. ping 请求 → 响应 {"alive": true}
3. status 请求 → 响应 (版本/python 信息)
4. 数据目录: %APPDATA%/tdsf-terminal-agent/.tdsf-data 被创建 (frozen 适配关键验证)
5. shutdown 优雅退出
6. 自报版本 (ready + sidecar.status) == sidecar_version.SIDECAR_VERSION —— #84:
   版本号此前在 main.py 里写死成 "1.0.0"，用户诊断里拿到的永远是假的那一个
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# 期望版本 = 被打包进去的同一份常量（脚本目录已在 sys.path[0]）
from sidecar_version import SIDECAR_VERSION as EXPECTED_VERSION

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
    # #84: 冻结包自报的版本必须是真的那个 —— 排查"用户装的是哪一版"就看这个数
    ready_version = json.loads(ready_line).get("params", {}).get("version")
    assert ready_version == EXPECTED_VERSION, (
        f"ready 自报版本 {ready_version!r} != 期望 {EXPECTED_VERSION!r}")
    print(f"  ready version: {ready_version}")

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
    status_version = res.get("version") or (res.get("status") or {}).get("version")
    assert status_version == EXPECTED_VERSION, (
        f"sidecar.status 自报版本 {status_version!r} != 期望 {EXPECTED_VERSION!r}")
    print(f"  status version: {status_version}")
    # #83 同类兜底：RPC 面也是运行时动态注册的（register_business_methods 里
    # 一条 import 失败会被 except 吞掉 → 整个模块的方法静默消失，#67 的白名单
    # 又会把"前端在调但没注册"变成 -32601）。冒烟不花 LLM 配额，这里必须看到
    # 完整方法面。阈值取 100（dev 真值 121），关键方法逐个点名。
    methods = res.get("methods") or []
    print(f"  methods registered: {len(methods)}")
    assert len(methods) >= 100, f"RPC 面不全：只有 {len(methods)} 个方法（期望 ≥100）"
    for critical in ("sidecar.health", "agent.invoke", "agent.list", "skill.list"):
        assert critical in methods, f"关键方法未注册: {critical}"

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
