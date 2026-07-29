#!/usr/bin/env python3
"""等待终端 shell 输出后检查终端文本 + sshStore 状态"""
import json
import time
import urllib.request
import websocket

CDP_HOST = "localhost"
CDP_PORT = 9222


def get_page_target():
    url = f"http://{CDP_HOST}:{CDP_PORT}/json/list"
    with urllib.request.urlopen(url, timeout=5) as resp:
        targets = json.loads(resp.read().decode("utf-8"))
    pages = [t for t in targets if t.get("type") == "page"]
    return pages[0] if pages else None


def evaluate(ws_url: str, expression: str, await_promise: bool = True):
    ws = websocket.create_connection(ws_url, timeout=15)
    try:
        ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            }
        }))
        deadline = time.time() + 15
        while time.time() < deadline:
            raw = ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == 1:
                return msg
        raise TimeoutError("Timeout")
    finally:
        ws.close()


def main():
    target = get_page_target()
    if not target:
        print("[FAIL] 无 CDP target")
        return
    ws_url = target["webSocketDebuggerUrl"]

    # 等待 5 秒让 shell 输出提示符
    print("[INFO] 等待 5 秒让 shell 输出提示符...")
    time.sleep(5)

    # 检查终端文本 + sshStore 状态
    check_expr = """
    (() => {
        // 1. 终端文本 (多种方式获取)
        const term1 = document.querySelector('.xterm-viewport');
        const term1Text = term1 ? term1.textContent : '';
        const term2 = document.querySelector('.xterm-screen');
        const term2Text = term2 ? term2.textContent : '';
        const term3 = document.querySelector('.xterm-rows');
        const term3Text = term3 ? term3.textContent : '';

        // 2. 检查终端行数
        const termRows = document.querySelectorAll('.xterm-rows > div');
        const termRowCount = termRows.length;
        const termFirstRows = Array.from(termRows).slice(0, 5).map(r => r.textContent);

        // 3. 文件树内容
        const fileTree = document.querySelector('[data-testid="ssh-files"]');
        const fileTreeText = fileTree ? fileTree.innerText.slice(0, 300) : '';

        // 4. 会话标签
        const sessionTabs = Array.from(document.querySelectorAll('[role="button"][aria-label="断开连接"]'));

        return JSON.stringify({
            term1TextLen: term1Text.length,
            term1TextPreview: term1Text.slice(0, 300),
            term2TextLen: term2Text.length,
            term3TextLen: term3Text.length,
            term3TextPreview: term3Text.slice(0, 300),
            termRowCount,
            termFirstRows,
            fileTreeText,
            sessionTabCount: sessionTabs.length,
        }, null, 2);
    })()
    """

    try:
        resp = evaluate(ws_url, check_expr)
        result = resp.get("result", {}).get("result", {}).get("value")
        if not result:
            print(f"[FAIL] CDP 返回空: {json.dumps(resp, ensure_ascii=False)[:500]}")
            return
        data = json.loads(result)
    except Exception as e:
        print(f"[FAIL] CDP evaluate 失败: {e}")
        return

    print("\n=== 终端状态 ===")
    print(f"terminal-viewport 文本长度: {data['term1TextLen']}")
    print(f"terminal-viewport 文本预览: {data['term1TextPreview']!r}")
    print(f"terminal-screen 文本长度:   {data['term2TextLen']}")
    print(f"terminal-rows 文本长度:     {data['term3TextLen']}")
    print(f"terminal-rows 文本预览:     {data['term3TextPreview']!r}")
    print(f"terminal-rows 行数:         {data['termRowCount']}")
    print(f"terminal-rows 前 5 行:      {data['termFirstRows']}")

    print("\n=== 文件树 ===")
    print(data['fileTreeText'][:300] if data['fileTreeText'] else "(空)")

    print(f"\n=== 会话标签数: {data['sessionTabCount']} ===")

    # 综合判断
    print("\n=== 综合判断 ===")
    has_terminal_output = (
        data['term1TextLen'] > 5
        or data['term2TextLen'] > 5
        or data['term3TextLen'] > 5
        or data['termRowCount'] > 1
    )
    has_file_tree = len(data['fileTreeText']) > 10
    if has_terminal_output and has_file_tree:
        print("[PASS] SSH 已连接, 终端有输出, 文件树已渲染")
    elif has_file_tree and not has_terminal_output:
        print("[WARN] SSH 已连接 (文件树有内容), 但终端无输出 — 可能是 shell 未启动或数据订阅问题")
    elif has_terminal_output and not has_file_tree:
        print("[WARN] 终端有输出, 但文件树为空")
    else:
        print("[FAIL] 终端和文件树都为空")


if __name__ == "__main__":
    main()
