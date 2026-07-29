"""Tauri 桌面端端到端验证（通过原始 CDP WebSocket）。

解决 Playwright connect_over_cdp 对 shared_worker 崩溃的问题。
前置：pnpm tauri dev 已启动，--remote-debugging-port=9222。
"""
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
    targets = r.json()
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("未找到 page target")
    # 返回第一个可见页面
    return pages[0]


class CdpClient:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=15)
        self._msg_id = 0
        self._pending = {}
        # 启用必要 domain
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

    def screenshot(self, path: Path):
        resp = self.call("Page.captureScreenshot", {"format": "png"})
        data = resp["result"]["data"]
        path.write_bytes(base64.b64decode(data))

    def close(self):
        self.ws.close()


def click_element(cdp: CdpClient, selector: str, wait_ms: int = 800):
    """通过 selector 点击元素，返回是否成功。"""
    expr = f"""
        (() => {{
            const btn = document.querySelector({selector!r});
            if (btn) {{ btn.click(); return true; }}
            return false;
        }})()
    """
    clicked = cdp.evaluate(expr)
    if clicked:
        time.sleep(wait_ms / 1000)
    return clicked


def main():
    print(f"[1/6] 获取 CDP page target: {CDP_HTTP}/json/list")
    try:
        target = get_page_target()
    except Exception as e:
        print(f"  ✗ 失败: {e}")
        return 1
    print(f"  ✓ title={target['title']!r} url={target['url']!r}")
    print(f"  ✓ ws={target['webSocketDebuggerUrl']}")

    print("[2/6] 连接 WebSocket 并等待页面稳定")
    cdp = CdpClient(target["webSocketDebuggerUrl"])
    time.sleep(3)

    print("[3/6] 截图 + 基础 UI 验证")
    shot1 = OUT_DIR / "e2e-desktop-01-initial.png"
    cdp.screenshot(shot1)
    print(f"  ✓ 截图: {shot1.name}")

    title = cdp.evaluate("document.title")
    print(f"  ✓ document.title = {title!r}")

    # 检查关键 UI 元素
    checks = [
        ("TDSF 标题文本", "document.body.innerText.includes('TDSF')"),
        ("侧边栏", "!!document.querySelector(\"[data-testid='sidebar']\")"),
        ("状态栏", "!!document.querySelector(\"[data-testid='statusbar']\")"),
        ("终端或空状态", "!!document.querySelector(\"[data-testid='tdsf-ssh-terminal-pane']\") || !!document.querySelector(\"[data-testid='no-terminal-empty-state']\")"),
    ]
    for label, expr in checks:
        try:
            ok = cdp.evaluate(expr)
            print(f"  {'✓' if ok else '✗'} {label}: {ok}")
        except Exception as e:
            print(f"  ✗ {label}: {e}")

    print("[4/6] 点击 Settings 按钮并截图")
    try:
        clicked = click_element(cdp, "[data-testid='settings-button']")
        if clicked:
            shot2 = OUT_DIR / "e2e-desktop-02-settings.png"
            cdp.screenshot(shot2)
            print(f"  ✓ 截图: {shot2.name}")
        else:
            print("  ⚠ 未找到 Settings 按钮")
    except Exception as e:
        print(f"  ✗ Settings 点击失败: {e}")

    print("[5/6] 检查 Mock LLM 告警 pill")
    try:
        has_pill = cdp.evaluate("!!document.querySelector(\"[data-testid='mock-llm-warning']\")")
        if has_pill:
            text = cdp.evaluate("document.querySelector(\"[data-testid='mock-llm-warning']\").innerText")
            print(f"  ⚠ Mock LLM 告警可见: {text}")
        else:
            print("  ✓ 无 Mock LLM 告警（API Key 可能已配置）")
    except Exception as e:
        print(f"  ✗ 检查告警失败: {e}")

    print("[6/6] 验证 Skills 面板入口")
    try:
        has_skills = cdp.evaluate("!!document.querySelector(\"[data-testid='skills-panel']\") || !!document.querySelector(\"button[data-testid='sidebar-skills']\")")
        print(f"  {'✓' if has_skills else '✗'} Skills 面板入口: {has_skills}")
    except Exception as e:
        print(f"  ✗ Skills 面板检查失败: {e}")

    cdp.close()
    print("\n✅ 桌面端 CDP 端到端验证完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
