"""CDP DOM 健康检查 - 验证 Tauri WebView 渲染状态"""
from __future__ import annotations
import json, time, urllib.request
import websocket  # type: ignore[import-untyped]


def main() -> int:
    resp = urllib.request.urlopen("http://127.0.0.1:9222/json")
    pages = [t for t in json.loads(resp.read()) if t.get("type") == "page"]
    if not pages:
        print("[ERR] no page target")
        return 1
    ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=10)

    def call(method: str, params: dict | None = None, mid: int = 1) -> dict:
        payload = {"id": mid, "method": method}
        if params:
            payload["params"] = params
        ws.send(json.dumps(payload))
        deadline = time.time() + 10
        while time.time() < deadline:
            data = json.loads(ws.recv())
            if data.get("id") == mid:
                return data
        return {}

    # 1. root 元素 + body 内容
    expr1 = (
        "JSON.stringify({"
        "rootExists: !!document.getElementById('root'),"
        "rootChildren: document.getElementById('root')?.children?.length || 0,"
        "bodyChildren: document.body.children.length,"
        "bodyHTML: document.body.innerHTML.slice(0, 800)"
        "})"
    )
    r = call("Runtime.evaluate", {"expression": expr1, "returnByValue": True}, 1)
    print("[1] DOM ROOT:", r.get("result", {}).get("result", {}).get("value", ""))

    # 2. 元素计数
    expr2 = (
        "JSON.stringify({"
        "allDivs: document.querySelectorAll('div').length,"
        "allBtns: document.querySelectorAll('button').length,"
        "allInputs: document.querySelectorAll('input,textarea').length,"
        "htmlClass: document.documentElement.className,"
        "dataChrome: document.documentElement.dataset.chrome || ''"
        "})"
    )
    r = call("Runtime.evaluate", {"expression": expr2, "returnByValue": True}, 2)
    print("[2] DOM COUNTS:", r.get("result", {}).get("result", {}).get("value", ""))

    # 3. 控制台错误（最近）
    r = call("Runtime.enable", {}, 3)
    time.sleep(0.3)
    expr3 = (
        "(() => {"
        "  try {"
        "    const entries = performance.getEntriesByType('measure');"
        "    return JSON.stringify({measures: entries.length, lastMeasures: entries.slice(-3).map(e => e.name)});"
        "  } catch (e) { return 'err:' + e.message; }"
        "})()"
    )
    r = call("Runtime.evaluate", {"expression": expr3, "returnByValue": True}, 4)
    print("[3] PERFORMANCE:", r.get("result", {}).get("result", {}).get("value", ""))

    # 4. 查找 AI 面板触发按钮（Ctrl+I 快捷键或侧边栏按钮）
    expr4 = (
        "(() => {"
        "  const all = document.querySelectorAll('button, [role=\"button\"], [data-command]');"
        "  const items = Array.from(all).map(b => ({"
        "    text: (b.textContent || '').trim().slice(0, 40),"
        "    aria: b.getAttribute('aria-label') || '',"
        "    cls: b.className.slice(0, 60),"
        "    cmd: b.getAttribute('data-command') || ''"
        "  })).filter(x => x.text || x.aria || x.cmd);"
        "  return JSON.stringify(items.slice(0, 25));"
        "})()"
    )
    r = call("Runtime.evaluate", {"expression": expr4, "returnByValue": True}, 5)
    print("[4] BUTTONS:", r.get("result", {}).get("result", {}).get("value", ""))

    # 5. 找终端元素（xterm）
    expr5 = (
        "JSON.stringify({"
        "xtermRows: document.querySelectorAll('.xterm-rows').length,"
        "xtermScreen: document.querySelectorAll('.xterm-screen').length,"
        "terminals: document.querySelectorAll('[data-terminal], [class*=\"terminal\"]').length"
        "})"
    )
    r = call("Runtime.evaluate", {"expression": expr5, "returnByValue": True}, 6)
    print("[5] TERMINAL:", r.get("result", {}).get("result", {}).get("value", ""))

    ws.close()
    print("[done]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
