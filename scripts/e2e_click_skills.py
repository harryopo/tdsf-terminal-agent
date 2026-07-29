import base64
import json
import time
from pathlib import Path

import requests
import websocket

CDP = "http://localhost:9222"
OUT = Path(__file__).resolve().parent.parent / "reports"
OUT.mkdir(exist_ok=True)


def main():
    targets = requests.get(f"{CDP}/json/list", timeout=5).json()
    page = [t for t in targets if t.get("type") == "page"][0]
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)
    msg_id = [0]

    def send(method, params=None):
        msg_id[0] += 1
        m = {"id": msg_id[0], "method": method}
        if params:
            m["params"] = params
        ws.send(json.dumps(m))
        return msg_id[0]

    def eval_expr(expr):
        req = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        deadline = time.time() + 5
        while time.time() < deadline:
            ws.settimeout(max(0.1, deadline - time.time()))
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            data = json.loads(raw)
            if data.get("id") == req:
                return data
        return None

    def screenshot(name):
        req = send("Page.captureScreenshot", {"format": "png"})
        deadline = time.time() + 5
        while time.time() < deadline:
            ws.settimeout(max(0.1, deadline - time.time()))
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            data = json.loads(raw)
            if data.get("id") == req:
                (OUT / name).write_bytes(base64.b64decode(data["result"]["data"]))
                print(f"  screenshot: {name}")
                return

    send("Runtime.enable")
    send("Page.enable")
    time.sleep(1)

    # Click Skills button
    print("[click Skills] 点击 Skills 按钮")
    res = eval_expr(
        """(()=>{
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find(x => x.innerText.trim() === 'Skills');
      if (b) { b.click(); return true; }
      return false;
    })()"""
    )
    clicked = res.get("result", {}).get("result", {}).get("value") if res else None
    print(f"  clicked: {clicked}")
    time.sleep(2)
    screenshot("e2e-desktop-03-skills.png")

    # Check skills panel content
    text_res = eval_expr(
        """(()=>{
      const sidebar = document.querySelector('[data-testid="sidebar"]');
      return sidebar ? sidebar.innerText.slice(0, 800) : 'no sidebar';
    })()"""
    )
    text = text_res.get("result", {}).get("result", {}).get("value") if text_res else ""
    print(f"  sidebar text preview:\n{text}\n")

    # Check skill cards
    card_count = eval_expr(
        """(()=>{
      return document.querySelectorAll('[data-testid="skill-card"]').length;
    })()"""
    )
    count = card_count.get("result", {}).get("result", {}).get("value") if card_count else 0
    print(f"  skill-card count: {count}")

    ws.close()
    print("[click Skills] 完成")


if __name__ == "__main__":
    main()
