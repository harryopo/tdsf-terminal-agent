"""验证 P1-P4 修复后的真实 UI 元素 - 用真实 selector"""
from __future__ import annotations
import json, time, urllib.request
import websocket  # type: ignore[import-untyped]


def main() -> int:
    resp = urllib.request.urlopen("http://127.0.0.1:9222/json")
    pages = [t for t in json.loads(resp.read()) if t.get("type") == "page"]
    ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=10)

    next_id = 0

    def call(method: str, params: dict | None = None) -> dict:
        nonlocal next_id
        next_id += 1
        payload = {"id": next_id, "method": method}
        if params:
            payload["params"] = params
        ws.send(json.dumps(payload))
        deadline = time.time() + 10
        while time.time() < deadline:
            data = json.loads(ws.recv())
            if data.get("id") == next_id:
                return data
        return {}

    def eval_js(expr: str) -> str:
        r = call("Runtime.evaluate", {
            "expression": expr,
            "returnByValue": True,
            "awaitPromise": True,
        })
        result = r.get("result", {}).get("result", {})
        if result.get("type") == "undefined":
            return ""
        return str(result.get("value", ""))

    # 1. 查找 reasoning 组件（@/components/ai-elements/reasoning）
    print("=== 1. Reasoning UI ===")
    r1 = eval_js("""
        (() => {
            // ai-elements/reasoning 通常渲染为 details/summary 或带 data-* 属性
            const sels = [
                'details[data-state]', '[data-state="open"]',
                '[class*="Reasoning"]', '[data-reasoning]',
                'summary', 'details',
            ];
            const out = [];
            for (const s of sels) {
                const els = document.querySelectorAll(s);
                if (els.length > 0) {
                    out.push(s + ': ' + els.length);
                    if (els.length <= 3) {
                        for (const e of Array.from(els).slice(0, 3)) {
                            const txt = (e.textContent || '').trim().slice(0, 100);
                            out.push('  -> tag=' + e.tagName + ' class=' + (e.className || '').slice(0, 80) + ' text=' + txt);
                        }
                    }
                }
            }
            return out.join('\\n') || 'no-reasoning-elements';
        })()
    """)
    print(r1)

    # 2. 查找 Tool 组件
    print("\n=== 2. Tool UI ===")
    r2 = eval_js("""
        (() => {
            const sels = [
                '[class*="Tool"]', '[data-tool]',
                '[class*="tool-call"]', '[class*="tool_use"]',
                'pre', 'code',
            ];
            const out = [];
            for (const s of sels) {
                const els = document.querySelectorAll(s);
                if (els.length > 0) {
                    out.push(s + ': ' + els.length);
                }
            }
            // 查找包含 tool/skill 关键字的元素
            const all = document.querySelectorAll('div, span, p');
            const toolTexts = [];
            for (const e of all) {
                const t = (e.textContent || '').trim();
                if (t.length > 5 && t.length < 200 && /skill_invoke|tool_call|linux-ops|executor/i.test(t)) {
                    toolTexts.push('tag=' + e.tagName + ' class=' + (e.className || '').slice(0, 60) + ' text=' + t.slice(0, 150));
                    if (toolTexts.length >= 8) break;
                }
            }
            return out.join(' | ') + '\\n--- tool texts ---\\n' + (toolTexts.join('\\n') || 'no-tool-texts');
        })()
    """)
    print(r2)

    # 3. AgentStatusPill
    print("\n=== 3. AgentStatusPill ===")
    r3 = eval_js("""
        (() => {
            const pills = document.querySelectorAll('[data-testid]');
            const out = [];
            for (const p of pills) {
                out.push('testid=' + p.getAttribute('data-testid') + ' tag=' + p.tagName + ' text=' + (p.textContent || '').trim().slice(0, 80));
            }
            return out.join('\\n') || 'no-testid';
        })()
    """)
    print(r3)

    # 4. AI 消息列表（找所有 message-bubble 或 message-role 类）
    print("\n=== 4. AI Messages ===")
    r4 = eval_js("""
        (() => {
            // 查找所有带 role 标记的消息容器
            const sels = [
                '[data-role]', '[class*="message"]', '[class*="Message"]',
                '[class*="bubble"]', '[class*="Bubble"]',
                '[class*="ChatMessage"]', '[class*="chat-message"]',
            ];
            const out = [];
            for (const s of sels) {
                const els = document.querySelectorAll(s);
                if (els.length > 0) {
                    out.push(s + ': ' + els.length);
                    if (els.length <= 5) {
                        for (const e of Array.from(els).slice(0, 5)) {
                            out.push('  -> ' + (e.textContent || '').trim().slice(0, 120));
                        }
                    }
                }
            }
            return out.join('\\n') || 'no-message-elements';
        })()
    """)
    print(r4)

    # 5. 查找主题切换按钮（实际是 Select trigger）
    print("\n=== 5. Theme Switcher ===")
    r5 = eval_js("""
        (() => {
            // 主题选择通常是 Select 组件
            const triggers = document.querySelectorAll('[role="combobox"], [role="listbox"], select, [class*="Select"]');
            const out = [];
            for (const t of triggers) {
                out.push('tag=' + t.tagName + ' role=' + (t.getAttribute('role') || '') + ' class=' + (t.className || '').slice(0, 80) + ' text=' + (t.textContent || '').trim().slice(0, 60));
            }
            return out.join('\\n') || 'no-select-found';
        })()
    """)
    print(r5)

    # 6. AI 面板中的所有 SVG 图标（看是否有 lightbulb/tools 等）
    print("\n=== 6. SVG icons in AI panel ===")
    r6 = eval_js("""
        (() => {
            const panel = document.querySelector('.tdsf-panel-in, [class*="tdsf-panel"]');
            if (!panel) return 'no-panel';
            const svgs = panel.querySelectorAll('svg');
            return 'svg_count=' + svgs.length;
        })()
    """)
    print(r6)

    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
