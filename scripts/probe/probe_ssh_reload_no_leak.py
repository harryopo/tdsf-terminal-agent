"""真机门禁 #117：整页重载一次，Rust 侧的 SSH 连接数不许涨、也不许留下没人认领的会话。

为什么必须真机：这条判据的两个输入（Rust 的会话注册表、webview 窗口 label）
都不在 happy-dom 里，静态断言只能钉接线、钉不了"真的没泄漏"。

跑法：`pnpm probe:ssh`（dev 实例必须已连上一台 SSH 服务器，否则没有可重载的连接）。
"""

from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cdp  # noqa: E402

# 与 outputs/cleanup_ssh_leaks_117.py 同一口径：被 tab / leaf / Space / 活动会话
# 引用的一律算"有人认领"，其余就是当前 UI 永远达不到的僵尸。
JS_PLAN = r"""(async () => {
  const bridge = await import('/src/lib/ssh-bridge.ts');
  const d = window.__TDSF_DBG__;
  const ssh = d.getSshStore().getState();
  const sp = d.getSpaces().getState();
  const referenced = new Set();
  for (const t of d.getTabs()) {
    if (t.sshSessionId) referenced.add(t.sshSessionId);
    for (const leaf of Object.values(t.paneTree?.leaves ?? {})) {
      if (leaf.sshSessionId) referenced.add(leaf.sshSessionId);
    }
  }
  for (const s of sp.spaces) if (s.env && s.env.sessionId) referenced.add(s.env.sessionId);
  if (ssh.activeSessionId) referenced.add(ssh.activeSessionId);
  const byUuid = new Map((ssh.sessions || []).map((s) => [s.id, s]));
  const keep = new Set();
  for (const uuid of referenced) {
    const info = byUuid.get(uuid);
    if (info && info.rustSessionId !== null) keep.add(info.rustSessionId);
  }
  const details = await bridge.sshSessionsDetail();
  return {
    live: details.map((d) => d.sessionId),
    keep: [...keep],
    owners: details.map((d) => [d.sessionId, d.ownerWindow]),
  };
})()"""


def plan(page) -> dict:
    return page.evaluate(JS_PLAN, await_promise=True)


def wait_stable(page_factory, rounds: int = 4, secs: float = 4.0) -> dict:
    """轮询到连接数连续 rounds 次不变，避免把"还在重连"读成结论。"""
    last: dict | None = None
    same = 0
    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(secs)
        try:
            cur = plan(page_factory())
        except Exception as e:  # noqa: BLE001 - 重载期间 target 会短暂消失
            print("  …等待页面回来:", str(e)[:70], flush=True)
            last, same = None, 0
            continue
        print("  读数", json.dumps(cur, ensure_ascii=False), flush=True)
        if last is not None and cur["live"] == last["live"]:
            same += 1
        else:
            same = 0
        last = cur
        if same >= rounds:
            return cur
    raise SystemExit("120 秒内连接数没稳定，判据无法成立 —— 去看 dev 日志")


def main() -> int:
    def connect():
        return cdp.connect(cdp.probe_port()[0])

    page = connect()
    before = plan(page)
    print("BEFORE", json.dumps(before, ensure_ascii=False), flush=True)
    if not before["live"]:
        raise SystemExit(
            "Rust 侧一条 SSH 会话都没有：先在一个服务器工作区里连上服务器再跑本探针，"
            "否则这条判据是空跑（假绿）。"
        )
    page.call("Page.enable")
    page.call("Page.reload", {"ignoreCache": False})
    page.close()

    after = wait_stable(connect)
    print("AFTER ", json.dumps(after, ensure_ascii=False), flush=True)

    orphans = [i for i in after["live"] if i not in set(after["keep"])]
    unowned = [sid for sid, owner in after["owners"] if owner is None]
    grew = len(after["live"]) > len(before["live"])
    ok = not orphans and not unowned and not grew

    print(
        "判据: 连接数 %d → %d %s | 无主会话 %s | 出身缺失 %s"
        % (
            len(before["live"]),
            len(after["live"]),
            "（涨了）" if grew else "（没涨）",
            orphans or "无",
            unowned or "无",
        ),
        flush=True,
    )
    print("PROBE_SSH " + ("PASS" if ok else "FAIL"), flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
