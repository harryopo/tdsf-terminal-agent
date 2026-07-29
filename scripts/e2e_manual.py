"""Manual interactive CDP helper for end-to-end verification."""
import base64
import json
import sys
import time
from pathlib import Path

import requests
import websocket

CDP_HTTP = "http://localhost:9222"
OUT_DIR = Path(__file__).resolve().parent.parent / "reports"
OUT_DIR.mkdir(exist_ok=True)


def get_page_target():
    r = requests.get(f"{CDP_HTTP}/json/list", timeout=5)
    r.raise_for_status()
    pages = [t for t in r.json() if t.get("type") == "page"]
    return pages[0]


class CdpClient:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=15)
        self._msg_id = 0
        self.send("Runtime.enable")
        self.send("Page.enable")

    def send(self, method: str, params=None):
        self._msg_id += 1
        msg = {"id": self._msg_id, "method": method}
        if params:
            msg["params"] = params
        self.ws.send(json.dumps(msg))
        return self._msg_id

    def call(self, method: str, params=None, timeout: float = 10.0):
        req_id = self.send(method, params)
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(0.1, deadline - time.time()))
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            data = json.loads(raw)
            if data.get("id") == req_id:
                return data
        raise TimeoutError(f"未收到 id={req_id} 的响应")

    def evaluate(self, expression: str, return_by_value: bool = True):
        resp = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": return_by_value,
                "awaitPromise": True,
            },
        )
        if "error" in resp:
            raise RuntimeError(f"Runtime.evaluate error: {resp['error']}")
        result = resp.get("result", {}).get("result", {})
        if result.get("subtype") == "error":
            raise RuntimeError(f"JS error: {result.get('description')}")
        return result.get("value")

    def screenshot(self, path: Path):
        resp = self.call("Page.captureScreenshot", {"format": "png"})
        data = resp["result"]["data"]
        path.write_bytes(base64.b64decode(data))

    def click(self, selector: str, wait_ms: int = 800):
        expr = f"""
        (() => {{
            const el = document.querySelector({selector!r});
            if (el) {{ el.click(); return true; }}
            return false;
        }})()
        """
        clicked = self.evaluate(expr)
        if clicked:
            time.sleep(wait_ms / 1000)
        return clicked

    def close(self):
        self.ws.close()


def main():
    target = get_page_target()
    print(f"title={target['title']!r} url={target['url']!r}")
    cdp = CdpClient(target["webSocketDebuggerUrl"])
    time.sleep(2)

    def snap(name: str):
        p = OUT_DIR / name
        cdp.screenshot(p)
        print(f"  screenshot: {p.name}")

    def body():
        return cdp.evaluate("document.body.innerText")

    def testids():
        return cdp.evaluate(
            "Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.getAttribute('data-testid'))"
        )

    print("\n[initial]")
    snap("e2e-01-initial.png")
    print("testids:", testids()[:30])

    print("\n[click settings-button]")
    ok = cdp.click("[data-testid='settings-button']", wait_ms=1200)
    print("clicked:", ok)
    snap("e2e-02-settings.png")
    print("body snippet:", body()[:400])
    print("testids:", testids()[:50])

    print("\n[press Escape to close settings/command palette if open]")
    cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape"})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Escape", "code": "Escape"})
    time.sleep(0.5)
    snap("e2e-03-after-escape.png")

    print("\n[click Skills tab]")
    # Skills tab button text 'Skills' at bottom sidebar
    ok = cdp.evaluate("""
    (()=>{
      const btns = Array.from(document.querySelectorAll('button'));
      const sk = btns.find(b => b.innerText.trim() === 'Skills');
      if (sk) { sk.click(); return true; }
      return false;
    })()
    """)
    print("clicked skills:", ok)
    time.sleep(1)
    snap("e2e-04-skills.png")
    print("body snippet:", body()[:600])
    print("testids:", testids()[:50])

    print("\n[click SSH tab]")
    ok = cdp.evaluate("""
    (()=>{
      const btns = Array.from(document.querySelectorAll('button'));
      const ssh = btns.find(b => b.innerText.trim() === 'SSH');
      if (ssh) { ssh.click(); return true; }
      return false;
    })()
    """)
    print("clicked ssh:", ok)
    time.sleep(1)
    snap("e2e-05-ssh-tab.png")
    print("body snippet:", body()[:400])
    print("testids:", testids()[:50])

    cdp.close()
    print("\nDone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
