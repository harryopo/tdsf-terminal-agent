"""
CDP 模拟 Ctrl+I 触发 AI 面板
=============================
"""
from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

import urllib.request
import websocket  # type: ignore[import-untyped]


def get_first_page_ws_url() -> str:
    resp = urllib.request.urlopen("http://127.0.0.1:9222/json")
    targets = json.loads(resp.read().decode("utf-8"))
    pages = [t for t in targets if t.get("type") == "page"]
    return pages[0]["webSocketDebuggerUrl"] if pages else ""


def send_cdp(ws: websocket.WebSocket, method: str, params: dict | None = None, msg_id: int = 1, timeout: float = 10) -> dict:
    payload = {"id": msg_id, "method": method}
    if params:
        payload["params"] = params
    ws.send(json.dumps(payload))
    deadline = time.time() + timeout
    while time.time() < deadline:
        raw = ws.recv()
        data = json.loads(raw)
        if data.get("id") == msg_id:
            return data
    raise TimeoutError(f"CDP method {method} timed out")


def eval_js(ws: websocket.WebSocket, expression: str, msg_id: int = 1, timeout: float = 10) -> str:
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": expression,
        "returnByValue": True,
        "awaitPromise": True,
    }, msg_id, timeout)
    result = r.get("result", {}).get("result", {})
    if result.get("type") == "undefined":
        return ""
    return str(result.get("value", ""))


def screenshot(ws: websocket.WebSocket, path: Path, msg_id: int) -> int:
    r = send_cdp(ws, "Page.captureScreenshot", {"format": "png"}, msg_id)
    if "result" not in r:
        return 1
    img_data = base64.b64decode(r["result"]["data"])
    path.write_bytes(img_data)
    print(f"[cdp] screenshot saved: {path} ({len(img_data)} bytes)")
    return 0


def main() -> int:
    out_dir = Path(".tdsf-data/cdp-shots")
    out_dir.mkdir(parents=True, exist_ok=True)

    ws_url = get_first_page_ws_url()
    print(f"[cdp] connecting to: {ws_url}")
    ws = websocket.create_connection(ws_url, timeout=10)
    print("[cdp] connected")

    msg_id = 0

    # 1. 用 JS dispatchEvent 触发 Ctrl+I（全局键盘事件）
    msg_id += 1
    trigger_result = eval_js(ws, """
        (() => {
            // 在 window 上 dispatch Ctrl+I keydown 事件
            const ev = new KeyboardEvent('keydown', {
                key: 'i',
                code: 'KeyI',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(ev);
            
            // 也尝试 keyup
            const evUp = new KeyboardEvent('keyup', {
                key: 'i',
                code: 'KeyI',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(evUp);
            
            return 'ctrl+i dispatched';
        })()
    """, msg_id)
    print(f"[cdp] {trigger_result}")

    time.sleep(2)

    # 2. 截图
    msg_id += 1
    screenshot(ws, out_dir / "05-after-ctrl-i.png", msg_id)

    # 3. 检查 AI 面板是否出现
    msg_id += 1
    panel_check = eval_js(ws, """
        (() => {
            // 查找 AI 面板相关元素
            const selectors = [
                '[class*="AiChat"]',
                '[class*="ai-chat"]',
                '[class*="AgentPanel"]',
                '[class*="agent-panel"]',
                '[class*="TdsfAgent"]',
                '[class*="tdsf-agent"]',
                '[class*="AiComposer"]',
                '[class*="ai-composer"]',
                '[class*="AiMini"]',
                '[class*="ai-mini"]',
                'textarea',
            ];
            const results = [];
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                    results.push(sel + ': ' + els.length + ' found');
                }
            }
            return results.join(' | ') || 'no-ai-panel-found';
        })()
    """, msg_id)
    print(f"[cdp] AI panel check: {panel_check}")

    # 4. 如果有 textarea，列出其属性
    msg_id += 1
    textarea_info = eval_js(ws, """
        (() => {
            const tas = document.querySelectorAll('textarea');
            return Array.from(tas).map((ta, i) => 
                `textarea[${i}]: placeholder="${ta.placeholder}", class="${ta.className.slice(0, 60)}", visible=${ta.offsetParent !== null}`
            ).join(' | ') || 'no-textarea';
        })()
    """, msg_id)
    print(f"[cdp] textareas: {textarea_info}")

    # 5. 查找所有可见的 dialog/panel/modal
    msg_id += 1
    panels_info = eval_js(ws, """
        (() => {
            const dialogs = document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="panel"], [class*="Panel"]');
            return Array.from(dialogs).slice(0, 10).map(d => 
                `tag=${d.tagName}, class="${d.className.slice(0, 60)}", visible=${d.offsetParent !== null}`
            ).join(' | ') || 'no-dialogs';
        })()
    """, msg_id)
    print(f"[cdp] panels/dialogs: {panels_info}")

    # 6. 列出所有按钮的详细信息
    msg_id += 1
    all_btns = eval_js(ws, """
        (() => {
            const btns = document.querySelectorAll('button');
            return Array.from(btns).slice(0, 30).map((b, i) => 
                `btn[${i}]: text="${(b.textContent || '').trim().slice(0, 20)}", aria="${b.getAttribute('aria-label') || ''}", class="${b.className.slice(0, 40)}"`
            ).join('\\n') || 'no-buttons';
        })()
    """, msg_id)
    print(f"[cdp] all buttons:\\n{all_btns}")

    ws.close()
    print("[cdp] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
