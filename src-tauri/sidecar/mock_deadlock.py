"""mock_deadlock.py — TDSF_SIDECAR_SCRIPT 诊断 mock 脚本（dev 专用，勿删）
==========================================================================

用途：模拟「心跳死锁」故障——进程存活、CPU 0%、但不读 stdin、不响应 ping。
用于验证 Rust 侧 sidecar 健康检查 / 看门狗 / 僵尸进程检测逻辑。

⚠️ 使用注意：TDSF_SIDECAR_SCRIPT 必须设置为**绝对路径**
（Rust 进程 cwd 是 src-tauri/，相对路径会拼接错位 fallback 到 main.py）：
    $env:TDSF_SIDECAR_SCRIPT = "D:\\ai\\linux教学一体\\tdsf-terminal-agent-clone\\src-tauri\\sidecar\\mock_deadlock.py"

行为：发 ready 通知 → time.sleep(3600) 死锁。
"""
from __future__ import annotations

import json
import sys
import time


def main() -> None:
    # 模拟真实 sidecar 的 ready 握手：向 stdout 发一行 ready 通知
    ready = json.dumps({"type": "notify", "method": "ready", "params": {}})
    sys.stdout.write(ready + "\n")
    sys.stdout.flush()
    # 死锁：长时间睡眠（进程存活但不响应任何 stdin 请求）
    time.sleep(3600)


if __name__ == "__main__":
    main()
