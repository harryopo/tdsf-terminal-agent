"""
CDP 发送 AI 消息 + 验证深度思考 UI + Skill 调用
================================================
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
    print(f"[cdp] connecting")
    ws = websocket.create_connection(ws_url, timeout=10)
    print("[cdp] connected")

    msg_id = 0

    # 1. 找到 AI 输入框并输入消息
    msg_id += 1
    input_result = eval_js(ws, """
        (async () => {
            const tas = document.querySelectorAll('textarea');
            let aiTa = null;
            for (const ta of tas) {
                if (ta.placeholder && ta.placeholder.includes('Ask TDSF')) {
                    aiTa = ta;
                    break;
                }
            }
            if (!aiTa) return 'no-ai-textarea';
            
            // 聚焦
            aiTa.focus();
            
            // 用 React 兼容方式设置值
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeSetter.call(aiTa, '请调用 linux-ops skill 帮我查看系统信息');
            aiTa.dispatchEvent(new Event('input', { bubbles: true }));
            aiTa.dispatchEvent(new Event('change', { bubbles: true }));
            
            await new Promise(r => setTimeout(r, 500));
            
            return 'value set: ' + aiTa.value;
        })()
    """, msg_id, timeout=15)
    print(f"[cdp] input: {input_result}")

    # 2. 截图输入后状态
    msg_id += 1
    screenshot(ws, out_dir / "06-message-typed.png", msg_id)

    # 3. 发送消息（Enter 或 Ctrl+Enter）
    msg_id += 1
    send_result = eval_js(ws, """
        (async () => {
            const tas = document.querySelectorAll('textarea');
            let aiTa = null;
            for (const ta of tas) {
                if (ta.placeholder && ta.placeholder.includes('Ask TDSF')) {
                    aiTa = ta;
                    break;
                }
            }
            if (!aiTa) return 'no-ai-textarea';
            
            // 查找发送按钮
            const allBtns = document.querySelectorAll('button');
            let sendBtn = null;
            for (const b of allBtns) {
                const aria = b.getAttribute('aria-label') || '';
                const text = (b.textContent || '').trim();
                if (/send|发送|submit|提交/i.test(aria + text)) {
                    sendBtn = b;
                    break;
                }
                // 也检查 SVG 图标
                const svg = b.querySelector('svg');
                if (svg && /send|paper-plane|arrow-up/i.test(svg.getAttribute('data-icon') || '')) {
                    sendBtn = b;
                    break;
                }
            }
            
            if (sendBtn) {
                sendBtn.click();
                return 'sent via button';
            }
            
            // 没有 send 按钮，按 Enter 发送
            aiTa.focus();
            aiTa.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter',
                bubbles: true, cancelable: true,
            }));
            aiTa.dispatchEvent(new KeyboardEvent('keypress', {
                key: 'Enter', code: 'Enter',
                bubbles: true, cancelable: true,
            }));
            aiTa.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter',
                bubbles: true, cancelable: true,
            }));
            return 'sent via enter key';
        })()
    """, msg_id, timeout=15)
    print(f"[cdp] send: {send_result}")

    # 4. 等待 AI 响应（深度思考 + 流式输出）
    print("[cdp] waiting 12s for AI response...")
    time.sleep(12)

    # 5. 截图 AI 响应
    msg_id += 1
    screenshot(ws, out_dir / "07-ai-response.png", msg_id)

    # 6. 验证深度思考 UI
    msg_id += 1
    reasoning_info = eval_js(ws, """
        (() => {
            const selectors = [
                '[class*="reasoning"]', '[class*="Reasoning"]',
                '[class*="thinking"]', '[class*="Thinking"]',
                '[data-reasoning]', '[data-thinking]',
                '[class*="depth-think"]', '[class*="DepthThink"]',
            ];
            const results = [];
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                    const el = els[0];
                    results.push(`${sel}: count=${els.length}, visible=${el.offsetParent !== null}, text="${(el.textContent || '').trim().slice(0, 120)}"`);
                }
            }
            return results.join(' | ') || 'no-reasoning-ui';
        })()
    """, msg_id)
    print(f"[cdp] reasoning UI: {reasoning_info}")

    # 7. 验证工具调用 UI
    msg_id += 1
    tool_info = eval_js(ws, """
        (() => {
            const selectors = [
                '[class*="RenderedTool"]', '[class*="rendered-tool"]',
                '[class*="tool-call"]', '[class*="ToolCall"]',
                '[data-tool-call]', '[class*="tool_use"]',
                '[class*="AgentStatusPill"]', '[class*="agent-status"]',
            ];
            const results = [];
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                    const el = els[0];
                    results.push(`${sel}: count=${els.length}, visible=${el.offsetParent !== null}, text="${(el.textContent || '').trim().slice(0, 150)}"`);
                }
            }
            return results.join(' | ') || 'no-tool-ui';
        })()
    """, msg_id)
    print(f"[cdp] tool call UI: {tool_info}")

    # 8. 验证 AI 消息内容
    msg_id += 1
    msg_info = eval_js(ws, """
        (() => {
            // 查找 AI 回复的消息
            const allText = document.body.innerText;
            const lines = allText.split('\\n').filter(l => l.trim().length > 10);
            return 'total_lines=' + lines.length + ', last_5_lines=' + lines.slice(-5).join(' | ').slice(0, 300);
        })()
    """, msg_id)
    print(f"[cdp] page text tail: {msg_info}")

    # 9. 检查 AI 面板内的所有元素
    msg_id += 1
    panel_content = eval_js(ws, """
        (() => {
            const panel = document.querySelector('.tdsf-panel-in, [class*="tdsf-panel"]');
            if (!panel) return 'no-panel';
            const children = panel.querySelectorAll('*');
            const classes = new Set();
            for (const c of children) {
                if (c.className && typeof c.className === 'string') {
                    c.className.split(' ').forEach(cl => {
                        if (cl.length > 3) classes.add(cl);
                    });
                }
            }
            return Array.from(classes).slice(0, 40).join(', ');
        })()
    """, msg_id)
    print(f"[cdp] panel classes: {panel_content[:400]}")

    ws.close()
    print("[cdp] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
