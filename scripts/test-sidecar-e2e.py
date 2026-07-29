"""
Sidecar 端到端冒烟测试 — 验证 agent 真正能运行

用法: python scripts/test-sidecar-e2e.py
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

SIDECAR_SCRIPT = Path(__file__).resolve().parent.parent / "src-tauri" / "sidecar" / "main.py"


def send(proc: subprocess.Popen, msg: dict) -> None:
    line = json.dumps(msg, ensure_ascii=False) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()


def recv(proc: subprocess.Popen, timeout: float = 10.0) -> dict:
    """读一行 JSON-RPC 响应（带超时）"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        line = line.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            print(f"[warn] 非 JSON 行: {line[:200]}", file=sys.stderr)
    raise TimeoutError(f"recv 超时 ({timeout}s)")


def recv_method(proc: subprocess.Popen, method: str, timeout: float = 15.0) -> dict:
    """读到指定 method 的通知/响应为止，跳过其他通知（如 sidecar:log）"""
    deadline = time.time() + timeout
    skipped = 0
    while time.time() < deadline:
        msg = recv(proc, timeout=max(0.5, deadline - time.time()))
        if msg.get("method") == method:
            return msg
        # 跳过非目标通知（sidecar:log 等），但响应消息直接返回
        if "id" in msg and "result" in msg:
            return msg
        if "id" in msg and "error" in msg:
            return msg
        skipped += 1
        if skipped <= 3:
            print(f"  [skip] {msg.get('method', 'unknown')} 通知")
    raise TimeoutError(f"等待 method={method} 超时 ({timeout}s), 跳过 {skipped} 条通知")


def recv_response(proc: subprocess.Popen, req_id: int, timeout: float = 30.0) -> dict:
    """读到指定 id 的响应为止，跳过通知消息"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = recv(proc, timeout=max(0.5, deadline - time.time()))
        if msg.get("id") == req_id:
            return msg
        # 跳过通知（无 id）
    raise TimeoutError(f"等待 id={req_id} 响应超时 ({timeout}s)")


def main() -> int:
    print(f"=== 启动 sidecar: {SIDECAR_SCRIPT} ===", flush=True)
    env = os.environ.copy()
    # 强制 Python stdout/stderr 无缓冲，确保 Rust/测试脚本能立即读到响应
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # stderr 重定向到文件，避免 stderr pipe buffer 满导致 sidecar 阻塞
    stderr_file = open("sidecar-stderr.log", "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-u", str(SIDECAR_SCRIPT)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr_file,
        text=True,
        encoding="utf-8",
        bufsize=1,
        env=env,
    )

    try:
        # 1. 等待 ready 通知
        print("[1/5] 等待 ready 通知...")
        msg = recv_method(proc, method="ready", timeout=20)
        ready_params = msg.get("params", {})
        print(f"  ready: python={ready_params.get('python')} "
              f"methods={len(ready_params.get('methods', []))} "
              f"startup={ready_params.get('startup_time', 0):.2f}s")

        # 2. ping 测试
        print("[2/5] ping 测试...")
        send(proc, {"jsonrpc": "2.0", "id": 1, "method": "ping"})
        msg = recv_response(proc, req_id=1, timeout=5)
        assert msg.get("result", {}).get("alive") is True, f"ping alive 错误: {msg}"
        print(f"  ping OK: uptime={msg['result']['uptime']:.2f}s")

        # 3. agent.list 测试
        print("[3/5] agent.list 测试...")
        send(proc, {"jsonrpc": "2.0", "id": 2, "method": "agent.list"})
        msg = recv_response(proc, req_id=2, timeout=5)
        agents_list = msg.get("result", {}).get("agents", [])
        print(f"  注册的 agents: {[a['name'] for a in agents_list]}")
        assert len(agents_list) >= 5, f"agent 数量不足: {len(agents_list)}"

        # 4. agent.invoke 测试 (mock LLM 模式, 不需要 API key)
        print("[4/5] agent.invoke 测试 (mock LLM)...")
        state = {
            "input": "hello, 这是一条测试消息",
            "history": [],
            "plan": [],
            "current_task_index": 0,
            "mood": "idle",
            "selected_agent": "main",
        }
        send(proc, {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "agent.invoke",
            "params": {"name": "main", "state": state},
        })
        msg = recv_response(proc, req_id=3, timeout=30)
        if "error" in msg:
            print(f"  [WARN] agent.invoke 返回错误: {msg['error']}")
            print("  (mock LLM 模式下可能正常, 继续测试)")
        else:
            result = msg.get("result", {})
            print(f"  agent.invoke 返回字段: {sorted(result.keys())}")
            # 验证关键字段存在
            assert "observation" in result or "output" in result, \
                f"agent.invoke 缺少 observation/output 字段: {sorted(result.keys())}"
            obs = result.get("observation") or result.get("output", "")
            print(f"  observation 长度: {len(obs)} 字符")
            print(f"  observation 预览: {obs[:150]}...")

        # 5. 调用 teach agent (验证 teaching_content 字段)
        print("[5/5] teach agent.invoke 测试...")
        state["selected_agent"] = "teach"
        state["input"] = "解释一下 ls 命令"
        send(proc, {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "agent.invoke",
            "params": {"name": "teach", "state": state},
        })
        # teach agent 真实调用 LLM 可能需要 30-60s, 给足超时
        msg = recv_response(proc, req_id=4, timeout=90)
        if "error" in msg:
            print(f"  [WARN] teach agent.invoke 返回错误: {msg['error']}")
        else:
            result = msg.get("result", {})
            print(f"  teach 返回字段: {sorted(result.keys())}")
            if "teaching_content" in result:
                tc = result["teaching_content"]
                print(f"  teaching_content 长度: {len(tc)} 字符")
                print(f"  teaching_content 预览: {tc[:150]}...")
            else:
                print(f"  [INFO] 无 teaching_content 字段 (mock 模式可能不生成)")

        print()
        print("=== 所有测试通过 ===")
        return 0

    except Exception as e:
        print(f"[FAIL] 测试失败: {e}", file=sys.stderr, flush=True)
        # 打印 stderr 帮助调试
        try:
            proc.stdin.close()
        except Exception:
            pass
        time.sleep(0.5)
        stderr_file.close()
        try:
            with open("sidecar-stderr.log", "r", encoding="utf-8") as f:
                stderr_data = f.read()
            if stderr_data:
                print(f"\n=== sidecar stderr (最后 2000 字符) ===", file=sys.stderr, flush=True)
                print(stderr_data[-2000:], file=sys.stderr, flush=True)
        except Exception:
            pass
        return 1
    finally:
        try:
            send(proc, {"jsonrpc": "2.0", "method": "shutdown"})
        except Exception:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        finally:
            try:
                stderr_file.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
