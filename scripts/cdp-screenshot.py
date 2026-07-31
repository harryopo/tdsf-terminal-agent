"""
CDP 截图 + DOM 验证脚本
======================
通过 CDP 9222 连接 Tauri WebView2，截图并验证 P1-P4 修复的 UI 元素。

验证项：
1. 窗口可见 + 主壳渲染
2. AI 面板存在（Ctrl+I 触发或侧边栏）
3. 主题切换按钮存在（浅色/深色模式）
4. 翻译模块 CSS 变量已加载
5. Skill 调用工具渲染（需要 AI 对话触发，这里只验证 DOM 就绪）

用法：
    python scripts/cdp-screenshot.py
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
    """获取第一个 page 的 webSocketDebuggerUrl"""
    resp = urllib.request.urlopen("http://127.0.0.1:9222/json")
    targets = json.loads(resp.read().decode("utf-8"))
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("no page target found in CDP 9222")
    return pages[0]["webSocketDebuggerUrl"]


def send_cdp(ws: websocket.WebSocket, method: str, params: dict | None = None, msg_id: int = 1) -> dict:
    """发送 CDP 命令并等待响应"""
    payload = {"id": msg_id, "method": method}
    if params:
        payload["params"] = params
    ws.send(json.dumps(payload))
    # 等待响应（可能收到多个事件，找匹配 id 的）
    deadline = time.time() + 10
    while time.time() < deadline:
        raw = ws.recv()
        data = json.loads(raw)
        if data.get("id") == msg_id:
            return data
    raise TimeoutError(f"CDP method {method} timed out")


def main() -> int:
    out_dir = Path(".tdsf-data/cdp-shots")
    out_dir.mkdir(parents=True, exist_ok=True)

    ws_url = get_first_page_ws_url()
    print(f"[cdp] connecting to: {ws_url}")
    ws = websocket.create_connection(ws_url, timeout=10)
    print("[cdp] connected")

    msg_id = 0

    # 1. 截图（合成线程，不受主线程卡死影响）
    msg_id += 1
    r = send_cdp(ws, "Page.captureScreenshot", {"format": "png"}, msg_id)
    if "result" not in r:
        print(f"[cdp] screenshot failed: {r}")
        return 1
    img_data = base64.b64decode(r["result"]["data"])
    shot_path = out_dir / "p1-p4-verify.png"
    shot_path.write_bytes(img_data)
    print(f"[cdp] screenshot saved: {shot_path} ({len(img_data)} bytes)")

    # 2. 获取文档标题
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": "document.title",
        "returnByValue": True,
    }, msg_id)
    title = r.get("result", {}).get("result", {}).get("value", "")
    print(f"[cdp] document.title: {title}")

    # 3. 验证主壳渲染（#root 是否有子节点）
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": "document.getElementById('root')?.children?.length || 0",
        "returnByValue": True,
    }, msg_id)
    root_children = r.get("result", {}).get("result", {}).get("value", 0)
    print(f"[cdp] #root children count: {root_children}")
    if root_children == 0:
        print("[cdp] WARN: #root has no children, app may not be rendered")

    # 4. 验证 AI 面板相关元素
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": (
            "(() => {"
            "  const ai = document.querySelector('[data-tdsf-agent-panel], [data-ai-panel], [class*=\"agent\"], [class*=\"Agent\"], [class*=\"ai-chat\"], [class*=\"AiChat\"]');"
            "  return ai ? ai.className : 'not-found';"
            "})()"
        ),
        "returnByValue": True,
    }, msg_id)
    ai_panel = r.get("result", {}).get("result", {}).get("value", "not-found")
    print(f"[cdp] AI panel element: {ai_panel}")

    # 5. 验证主题切换按钮（浅色/深色模式）
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": (
            "(() => {"
            "  const btns = document.querySelectorAll('button, [role=\"button\"]');"
            "  const themeBtn = Array.from(btns).find(b => "
            "    /theme|主题|light|dark|浅色|深色|sun|moon/i.test(b.textContent || '') "
            "    || /theme|主题|light|dark|sun|moon/i.test(b.getAttribute('aria-label') || '')"
            "  );"
            "  return themeBtn ? themeBtn.outerHTML.slice(0, 200) : 'not-found';"
            "})()"
        ),
        "returnByValue": True,
    }, msg_id)
    theme_btn = r.get("result", {}).get("result", {}).get("value", "not-found")
    print(f"[cdp] theme button: {theme_btn[:120]}")

    # 6. 验证 CSS 变量（翻译模块深浅色适配）
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": (
            "(() => {"
            "  const styles = getComputedStyle(document.documentElement);"
            "  const warningBorder = styles.getPropertyValue('--warning-border').trim();"
            "  const warningBg = styles.getPropertyValue('--warning-bg').trim();"
            "  const warningFg = styles.getPropertyValue('--warning-fg').trim();"
            "  return JSON.stringify({warningBorder, warningBg, warningFg});"
            "})()"
        ),
        "returnByValue": True,
    }, msg_id)
    css_vars = r.get("result", {}).get("result", {}).get("value", "{}")
    print(f"[cdp] CSS vars (warning-*): {css_vars}")

    # 7. 验证当前主题模式（html class 或 data-theme）
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": (
            "(() => {"
            "  const html = document.documentElement;"
            "  return JSON.stringify({"
            "    class: html.className,"
            "    dataTheme: html.getAttribute('data-theme') || '',"
            "    colorScheme: getComputedStyle(html).colorScheme"
            "  });"
            "})()"
        ),
        "returnByValue": True,
    }, msg_id)
    theme_state = r.get("result", {}).get("result", {}).get("value", "{}")
    print(f"[cdp] theme state: {theme_state}")

    # 8. 列出所有 button 文本（前 20 个）
    msg_id += 1
    r = send_cdp(ws, "Runtime.evaluate", {
        "expression": (
            "(() => {"
            "  const btns = document.querySelectorAll('button');"
            "  return Array.from(btns).slice(0, 20).map(b => "
            "    (b.textContent || '').trim().slice(0, 30) || b.getAttribute('aria-label') || b.className.slice(0, 30)"
            "  ).join(' | ');"
            "})()"
        ),
        "returnByValue": True,
    }, msg_id)
    btn_texts = r.get("result", {}).get("result", {}).get("value", "")
    print(f"[cdp] buttons (first 20): {btn_texts[:300]}")

    ws.close()
    print("[cdp] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
