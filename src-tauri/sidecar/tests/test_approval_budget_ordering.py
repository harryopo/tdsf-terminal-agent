"""
tests/test_approval_budget_ordering.py — 审批窗口必须排在两道外层预算之前（#133）
================================================================================

实测现场（.tdsf-data/agent-logs/s-mufeww1j-g9aiur.jsonl，2026-09-24）：

    tool_call   18:07:25  ssh_command: systemd-detect-virt ...
    （静默 300.1 秒）
    tool_result 18:12:25  {"status": "needs_approval", ...}
    reasoning             "审批超时，按拒绝处理，未执行……用户5分钟没响应"

一次"用户还在想"被记成了"任务失败"。病根不是超时值太小，而是**三个常数分别住在
三种语言里，没人钉它们的先后**：审批窗口、Python 看门狗、Rust 单次 RPC 硬上限。
前端那一层（sidecar-adapter 的无活动计时）以前也正好是 300s，与审批窗口相等，
于是同秒到点。前端那一半已经改成"停在 needs_you 上时停表"（activityBudget.pause），
这里钉剩下两条仍然跨语言、编译器看不见的不等式。

口径与 #119 的 test_visible_terminal_budget_ordering.py 同源：
读两侧源码把不等式钉成用例，而不是在注释里写"记得对齐"。
"""
from __future__ import annotations

import re
from pathlib import Path

_SIDECAR_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _SIDECAR_DIR.parent.parent
_NEEDS_YOU = _SIDECAR_DIR / "needs_you.py"
_ADAPTER = _SIDECAR_DIR / "strands_backend" / "adapter.py"
_RUST_IPC = _REPO_ROOT / "src-tauri" / "src" / "modules" / "ipc.rs"


def _approval_timeout_secs() -> float:
    """needs_you 服务默认的审批窗口（用户多长时间不答按拒绝处理）。"""
    text = _NEEDS_YOU.read_text(encoding="utf-8")
    match = re.search(r"approval_timeout:\s*float\s*=\s*([0-9.]+)", text)
    assert match, "needs_you.py 里读不到 approval_timeout 默认值"
    return float(match.group(1))


def _watchdog_idle_secs() -> float:
    """Python 看门狗容忍的无回调空闲秒数。"""
    text = _ADAPTER.read_text(encoding="utf-8")
    match = re.search(r"INVOKE_WATCHDOG_IDLE_SECS\s*=\s*(\d+)", text)
    assert match, "adapter.py 里读不到 INVOKE_WATCHDOG_IDLE_SECS"
    return float(match.group(1))


def _rust_invoke_ceiling_secs() -> float:
    """Rust ipc_invoke 对 timeoutMs 的硬夹取上限（整轮 RPC 的总时长天花板）。"""
    text = _RUST_IPC.read_text(encoding="utf-8")
    match = re.search(r"ms\.clamp\(\s*([0-9_]+)\s*,\s*([0-9_]+)\s*\)", text)
    assert match, "ipc.rs 里读不到 timeoutMs 的 clamp 上下限"
    low = float(match.group(1).replace("_", "")) / 1000
    high = float(match.group(2).replace("_", "")) / 1000
    assert low < high, f"clamp 上下限反了：{low}s / {high}s"
    return high


def test_approval_window_ends_before_the_watchdog_would_abandon_it() -> None:
    """审批窗口 < 看门狗空闲阈值：否则等人回答会把整轮判成"模型挂了"。

    看门狗只数回调事件增量，needs_you 走 EventBus 不算事件（2026-09-24 读码
    确认）⇒ 用户思考的时间对它而言就是静默。两个数相等就是同秒对撞（#119 的
    那条教训在这里复发过一次）。
    """
    approval = _approval_timeout_secs()
    watchdog = _watchdog_idle_secs()
    assert approval < watchdog, (
        f"审批窗口 {approval}s 必须严格小于看门狗空闲阈值 {watchdog}s，"
        "否则用户还没答，看门狗先把整轮弃管"
    )


def test_approval_window_ends_before_the_rust_rpc_ceiling() -> None:
    """审批窗口 < Rust 单次 RPC 硬上限：否则用户还没答，RPC 先被掐了。

    被掐之后前端只会收到一句 `timeout`，而这句话的解释权在前端文案里——
    #133 之前它写的是「简化问题描述后重试」。
    """
    approval = _approval_timeout_secs()
    ceiling = _rust_invoke_ceiling_secs()
    assert approval < ceiling, (
        f"审批窗口 {approval}s 必须严格小于 Rust ipc_invoke 上限 {ceiling}s，"
        "否则 RPC 先炸，用户在审批卡上点什么都没人收"
    )


def test_frontend_no_activity_budget_pauses_while_awaiting_user() -> None:
    """前端那层必须"停在 needs_you 上就停表"——不许退回与审批窗口同秒对撞。

    只读源码钉接线：行为用例（sidecar-adapter.test.ts #133 那组）证明停表好用，
    这里证明**还在停**。删掉 pause 调用时行为用例会红，但没人拦住"有人把它
    当冗余代码删掉"这件事跨语言复发。
    """
    text = (
        _REPO_ROOT / "src" / "modules" / "ai" / "lib" / "sidecar-adapter.ts"
    ).read_text(encoding="utf-8")
    assert "budget.pause()" in text, (
        "sidecar-adapter.ts 里不再停表——审批挂起会重新变成"
        "「整轮 300 秒被判超时 + 叫用户简化问题描述」"
    )
    assert "subscribeAwaitingUser" in text, "等待事实的订阅接线被拆了"

