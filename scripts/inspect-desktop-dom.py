"""检查 Tauri 桌面端 DOM 结构。"""
import json
import sys
import time
from pathlib import Path

import requests
import websocket

CDP_HTTP = "http://localhost:9222"


def get_page_target():
    r = requests.get(f"{CDP_HTTP}/json/list", timeout=5)
    r.raise_for_status()
    targets = r.json()
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("未找到 page target")
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

    def recv_response(self, req_id: int, timeout: float = 10.0):
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

    def call(self, method: str, params=None, timeout: float = 10.0):
        req_id = self.send(method, params)
        return self.recv_response(req_id, timeout)

    def evaluate(self, expression: str, return_by_value: bool = True):
        resp = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": return_by_value,
            "awaitPromise": True,
        })
        if "error" in resp:
            raise RuntimeError(f"Runtime.evaluate error: {resp['error']}")
        result = resp.get("result", {}).get("result", {})
        if result.get("subtype") == "error":
            raise RuntimeError(f"JS error: {result.get('description')}")
        return result.get("value")

    def close(self):
        self.ws.close()


def main():
    target = get_page_target()
    print(f"title={target['title']!r} url={target['url']!r}")
    cdp = CdpClient(target["webSocketDebuggerUrl"])
    time.sleep(2)

    # 列出所有 data-testid
    testids = cdp.evaluate("""
        Array.from(document.querySelectorAll('[data-testid]'))
            .map(el => el.getAttribute('data-testid'))
    """)
    print(f"\n[data-testid] 列表 ({len(testids)} 个):")
    for tid in sorted(set(testids)):
        print(f"  - {tid}")

    # 检查终端区域
    terminal = cdp.evaluate("""
        (() => {
            const el = document.querySelector('.xterm-screen') ||
                       document.querySelector('.xterm') ||
                       document.querySelector('[class*="terminal"]');
            return el ? { tag: el.tagName, class: el.className.slice(0, 200), rect: el.getBoundingClientRect() } : null;
        })()
    """)
    print(f"\n终端区域: {terminal}")

    # 检查 Settings 按钮
    settings = cdp.evaluate("""
        (() => {
            const el = document.querySelector("[data-testid='settings-button']") ||
                       document.querySelector("button[title='Settings']");
            return el ? { tag: el.tagName, outerHTML: el.outerHTML.slice(0, 300) } : null;
        })()
    """)
    print(f"\nSettings 按钮: {settings}")

    # 检查 Skills 入口
    skills = cdp.evaluate("""
        (() => {
            const el = document.querySelector("button[data-testid='sidebar-skills']") ||
                       Array.from(document.querySelectorAll('button, a')).find(e => /skills/i.test(e.textContent || e.title));
            return el ? { tag: el.tagName, text: el.textContent?.slice(0, 50), title: el.title, outerHTML: el.outerHTML.slice(0, 300) } : null;
        })()
    """)
    print(f"\nSkills 入口: {skills}")

    cdp.close()


if __name__ == "__main__":
    main()
