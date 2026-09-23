"""
tests/test_visible_terminal_budget_ordering.py — 可见终端的两端计时器必须有先后（#119）
==========================================================================================

实测现场（2026-09-23 rust.log）：一条进可见终端的命令被整页重载甩掉后 ——

    16:12:44 [vt-probe] rust-emit req=vt-5 ... timeout_s=30
    16:16:04 [vt-probe] rust-timeout  req=vt-5 ... waited_ms=200002 budget_ms=200000
    16:16:04 rust_bridge timeout: method=visible_terminal_execute timeout=200.0s
    16:16:04 rust_bridge orphan response: id=1000011

Rust 等到 200 秒整给了一个结构化的 `timed_out`，Python 也在 200 秒整自己炸了
⇒ Rust 那份带回原因的结果成了孤儿包，模型只看见 `ipc_invoke_exception`，
用户看到的是"卡很久然后说没执行"。

这不是运气问题，是两个常数值相等。修法：Python 的等待必须**严格大于** Rust 的总预算，
让 Rust 那份带原因的结果永远先到位。本文件把这条不等式钉住（两个常数分处两种语言，
没有任何编译器能发现它们被改成相等）。
"""
from __future__ import annotations

import re
from pathlib import Path

_SIDECAR_DIR = Path(__file__).resolve().parents[1]
_REPO_ROOT = _SIDECAR_DIR.parent.parent
_RUST_SIDECAR_RS = _REPO_ROOT / "src-tauri" / "src" / "modules" / "sidecar.rs"
_TOOLS_INIT = _SIDECAR_DIR / "strands_backend" / "tools" / "__init__.py"


def _rust_transport_grace_secs() -> float:
    """Rust 在 Python 的 timeout 之上额外宽限多少秒（等前端回执的预算）。"""
    text = _RUST_SIDECAR_RS.read_text(encoding="utf-8")
    match = re.search(
        r"VISIBLE_TERMINAL_TRANSPORT_GRACE_SECS:\s*u64\s*=\s*(\d+)", text
    )
    assert match, "sidecar.rs 里读不到 VISIBLE_TERMINAL_TRANSPORT_GRACE_SECS"
    return float(match.group(1))


def _python_ipc_overhead_secs() -> float:
    """Python 在同一命令的 timeout 之上加多少秒作为 ipc 等待。"""
    text = _TOOLS_INIT.read_text(encoding="utf-8")
    match = re.search(
        r"VISIBLE_TERMINAL_IPC_OVERHEAD_SECS\s*=\s*([0-9.]+)", text
    )
    assert match, "tools/__init__.py 里读不到 VISIBLE_TERMINAL_IPC_OVERHEAD_SECS"
    return float(match.group(1))


def test_python_waits_strictly_longer_than_rust_budget() -> None:
    """不等式方向：Python > Rust 宽限，否则 Rust 的结构化结果必然成孤儿包。"""
    rust = _rust_transport_grace_secs()
    python = _python_ipc_overhead_secs()
    assert python > rust, (
        f"Python ipc  overhead {python}s 必须大于 Rust 传输宽限 {rust}s，"
        "否则两边同秒掐表，Rust 带回原因的 timed_out 会被 Python 的超时异常顶掉"
    )


def test_visible_terminal_invoke_uses_the_constant_not_a_literal() -> None:
    """派发点必须引用常量：写死的 `+ 170.0` 是这次事故的直接形状。"""
    text = _TOOLS_INIT.read_text(encoding="utf-8")
    call = re.search(
        r'"visible_terminal_execute",(?P<body>[^\n]*\n[^\n]*\n[^\n]*)', text
    )
    assert call, "找不到 visible_terminal_execute 的 ipc_invoke 调用点"
    body = call.group("body")
    assert "VISIBLE_TERMINAL_IPC_OVERHEAD_SECS" in body, (
        f"派发点没有引用常量，改成了字面量：{body.strip()}"
    )
    assert not re.search(r"\+\s*[0-9]+\.[0-9]\s*\)", body), (
        f"派发点仍有硬编码秒数：{body.strip()}"
    )
