#!/usr/bin/env python
"""
scripts/probe/probe_ipc_allowlist.py —— #67 方法白名单的真机门禁
================================================================

单测只能证明 `method_allowed()` 这个纯函数是对的；它证明不了三件更容易出事的事：

1. sidecar 的 `ready` 通知**真的**把 `methods` 发出来了（Rust 侧 `SidecarState.methods`
   非空）—— 没发出来的话白名单会 fail-closed 到只剩健康检查，**整个 AI 功能静默不可用**，
   而单元测试全绿。
2. 真实前端调用链（webview → `ipc_invoke` → Rust → sidecar）在闸门之后仍然通。
3. 未注册方法确实被 **Rust** 挡掉（而不是打到 Python 才报 method not found ——
   那才是这条纵深防御真正要防的那一层）。

判据（三条都要成立）：
  · 快照 methods 数量 > 50
  · `sidecar.health` 与 `skill.list`（真实 UI 在用的只读方法）调用成功
  · `probe.definitelyNotRegistered` 被拒，且 **dev 进程日志里出现
    `[ipc] rejected not-allowlisted`** —— 这条才是"挡在 Rust"的证据

跑法（先起 dev，别用 pnpm tauri:dev，它会跑 dev-seed-store 带上用户凭据）：
    npx tauri dev --config src-tauri/tauri.dev.conf.json > outputs/dev_run.log 2>&1 &
    src-tauri/sidecar/.venv/Scripts/python scripts/probe/probe_ipc_allowlist.py \
        --log outputs/dev_run.log
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cdp  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# vite dev 的模块缓存按 URL 记，固定查询串会拿到旧副本 —— 每次跑换一个
RUN = f"ipc-allowlist-probe-{int(time.time())}"

SNAPSHOT_JS = """
  (async () => {
    const b = await import('/src/lib/sidecar-bridge.ts?__RUN__');
    const snap = await b.getStatus();
    return JSON.stringify({
      status: snap.status,
      methods: (snap.methods || []).length,
      sample: (snap.methods || []).slice(0, 5),
    });
  })
""".strip()

CALLS_JS = """
  (async (methods) => {
    const b = await import('/src/lib/sidecar-bridge.ts?__RUN__');
    const out = {};
    for (const m of methods) {
      out[m] = await b.invokeRpc(m)
        .then(() => 'ok')
        .catch((e) => {
          const p = b.parseIPCError(e);
          return `rejected code=${p.code} type=${(p.data && p.data.type) || '?'}`;
        });
    }
    return JSON.stringify(out);
  })
""".strip()


def _js(template: str) -> str:
    """vite dev 的模块缓存按 URL 记 —— 每次跑换新的查询串，才拿得到改动后的副本。"""
    return template.replace("__RUN__", RUN)


def main() -> int:
    log_path = None
    args = sys.argv[1:]
    if args[:1] == ["--log"]:
        log_path = Path(args[1])

    pages = cdp.probe_port()
    if not pages:
        print("没连上 CDP 9222 —— dev 实例没起来，或连的不是 dev（identifier 冲突会让探针口开不了）")
        return 1
    page = cdp.connect([p for p in pages if "settings.html" not in p["url"]][0])
    if not page.evaluate("!!window.__TDSF_DBG__"):
        print("连的不是 dev 实例，停止")
        page.close()
        return 1

    snap = json.loads(page.evaluate(f"({_js(SNAPSHOT_JS)})()", True))
    print(f"sidecar status={snap['status']}  已见方法数={snap['methods']}  样例={snap['sample']}")
    if snap["methods"] < 50:
        print(
            f"FAIL：ready 快照里的方法数只有 {snap['methods']}。"
            "白名单会 fail-closed 到只剩健康检查 → AI 功能整体静默不可用。"
            "查 main.py 的 ready 载荷是否带 methods。"
        )
        page.close()
        return 1

    probed = ["sidecar.health", "skill.list", "probe.definitelyNotRegistered"]
    calls = json.loads(
        page.evaluate(
            f"({_js(CALLS_JS)})({json.dumps(probed, ensure_ascii=False)})", True
        )
    )
    for m in probed:
        print(f"  · {m:38s} → {calls[m]}")
    page.close()

    ok = True
    if calls["sidecar.health"] != "ok":
        print(f"FAIL：健康检查都被拒了（{calls['sidecar.health']}）—— 核心集或快照不对")
        ok = False
    if calls["skill.list"] != "ok":
        print("FAIL：真实 UI 在用的只读方法被拒 —— 白名单打断功能，不能放行面猜")
        ok = False
    if not calls["probe.definitelyNotRegistered"].startswith("rejected code=-32601"):
        print(f"FAIL：未注册方法没被拒（{calls['probe.definitelyNotRegistered']}）")
        ok = False

    if ok and log_path and log_path.exists():
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
        if "rejected not-allowlisted" not in tail:
            print(
                f"FAIL：Rust 没有留下拒绝痕迹（{log_path} 末尾 4000 字符里没有 "
                "`rejected not-allowlisted`）—— 那说明请求是打到 Python 才报 -32601 的，"
                "纵深防御那一层根本没生效"
            )
            ok = False
        else:
            print("  ✓ dev 日志里有 `[ipc] rejected not-allowlisted` ⇒ 确实挡在 Rust")
    elif ok and not log_path:
        print("  ! 未传 --log，只验了行为没验日志位置（挡在 Rust 还是挡在 Python 未证）")

    print("PASS：#67 白名单在真机链路上放行已注册、挡住未注册，且挡在 Rust" if ok else "FAIL：见上")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
