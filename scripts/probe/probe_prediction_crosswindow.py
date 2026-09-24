#!/usr/bin/env python3
"""真机行为门禁：设置窗点「清空预测历史」是否真的清掉了主窗的内存。

为什么需要它：预测历史活在主窗的 suggest-engine 单例里，而设置窗是独立 JS
context —— 单元测试跑在同一个 jsdom realm 里，永远发现不了"清错了对象"。
只有真机双窗口能测。读数走 __TDSF_DBG__.peekPredictionEngine()（app 自己那份
实例）；探针自己 import 引擎拿到的是副本，测了等于没测。

前置：dev 实例起着（绕过播种也行）：
    npx tauri dev --config src-tauri/tauri.dev.conf.json
    src-tauri/sidecar/.venv/Scripts/python.exe scripts/probe/probe_prediction_crosswindow.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cdp  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROBE_CMD = "__tdsf_probe_cmd__"
PEEK = "window.__TDSF_DBG__.peekPredictionEngine().then((x) => JSON.stringify(x))"


def is_main(t: dict) -> bool:
    u = t["url"]
    return "settings.html" not in u and u.rstrip("/").endswith("9300")


def main_page() -> cdp.CdpPage:
    return cdp.connect([x for x in cdp.probe_port() if is_main(x)][0])


def main() -> int:
    mp = main_page()
    if not mp.evaluate("!!(window.__TDSF_DBG__ && window.__TDSF_DBG__.peekPredictionEngine)"):
        print("主窗没有 __TDSF_DBG__：连的不是 dev 实例，停止（别用副本测）")
        mp.close()
        return 1

    mp.evaluate(f"window.__TDSF_DBG__.seedPredictionHistory('{PROBE_CMD}', 'windows')", True)
    seeded = mp.evaluate(PEEK, True)
    print("播种后主窗真身：", seeded)

    settings = [
        x
        for x in cdp.list_pages()
        if cdp.is_dev_page(x) and "settings.html" in x["url"]
    ]
    if not settings:
        mp.click_text("Settings")
        time.sleep(3)
        settings = [
            x
            for x in cdp.list_pages()
            if cdp.is_dev_page(x) and "settings.html" in x["url"]
        ]
    if not settings:
        print("设置窗没开出来")
        mp.close()
        return 1

    sp = cdp.connect(settings[0])
    sp.evaluate("location.href = '/settings.html?tab=prediction'")
    for _ in range(15):
        time.sleep(1)
        if sp.evaluate("document.body.innerText.includes('终端预测历史')"):
            break
    if not sp.evaluate("document.body.innerText.includes('终端预测历史')"):
        print("设置页切不到「终端预测」（深链或页签坏了）")
        sp.close()
        mp.close()
        return 1

    sp.click_text("清空预测历史")
    time.sleep(0.6)
    sp.click_text("再次点击确认")
    time.sleep(2.0)
    receipt = sp.evaluate(
        "(() => { const p = document.querySelector('[data-testid=prediction-clear-result]');"
        " return p ? p.textContent.trim() : null; })()"
    )
    print("设置页回执：", receipt)

    after = main_page().evaluate(PEEK, True)
    print("清空后主窗真身：", after)
    sp.close()

    ok = PROBE_CMD not in (after or "") and receipt is not None
    print("PASS" if ok else f"FAIL：主窗仍留着 {PROBE_CMD}，跨窗清空没生效")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
