#!/usr/bin/env python3
"""TDSF sidecar 死锁 mock（仅本地验证用，不打进安装包）。

用途：验证 sidecar「心跳超时 → 强杀 → 指数退避自动重启」链路：
1. 启动后立即发 ready 通知 → Rust 认为启动成功（status=Running）
2. 之后进程保持存活但不读 stdin、不响应任何 JSON-RPC → 模拟 Python 死锁
3. Rust health_check 30s 无 ping 响应 → 按 pid 强杀（kill_process）→
   child.wait() 返回 → 复用既有指数退避重启 → 5 轮（MAX_RETRY）后停止

运行方式（PowerShell，tauri dev 下验证）：
    $env:TDSF_SIDECAR_SCRIPT = "src-tauri/sidecar/mock_deadlock.py"
    pnpm tauri:dev
    # 验证完恢复：
    Remove-Item Env:TDSF_SIDECAR_SCRIPT

预期日志序列（tauri dev 控制台）：
    [setup] dev mode: TDSF_SIDECAR_SCRIPT override ...mock_deadlock.py
    [sidecar] script: ...mock_deadlock.py
    [sidecar] ready notification received
    （约 30s 后，重复 5 轮，退避 1/2/4/8/16s 递增）
    [sidecar:health] heartbeat lost (no response in ~30s)
    [sidecar:health] killed hung pid=xxxx success=true
    [sidecar] process exited ... 退避重启
    ...
    [sidecar] max retry reached (5), giving up
"""
import sys
import time


def main() -> None:
    # 1. 发 ready 通知（格式与 main.py 一致），让 Rust 进入 Running 状态
    sys.stdout.write('{"jsonrpc":"2.0","method":"ready"}\n')
    sys.stdout.flush()

    # 2. 模拟死锁：进程存活、不再读 stdin、不响应任何请求。
    #    用长 sleep（CPU 0%）而非空转死循环，避免验证期间 CPU 被吃满。
    time.sleep(3600)


if __name__ == "__main__":
    main()
