#!/usr/bin/env python3
"""
TDSF 真实桌面端状态检查脚本 (P1-C 收尾验证)

通过 CDP (Chrome DevTools Protocol) 连接 Tauri 桌面端 WebView2,
检查 SSH 自动连接 + 文件树 + 终端渲染状态。

使用:
    python scripts/check_real_desktop.py

前置:
    1. pnpm tauri dev 已启动
    2. WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 包含 --remote-debugging-port=9222
"""
import json
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

CDP_HOST = "localhost"
CDP_PORT = 9222


def get_page_target():
    """获取 CDP page target"""
    url = f"http://{CDP_HOST}:{CDP_PORT}/json/list"
    with urllib.request.urlopen(url, timeout=5) as resp:
        targets = json.loads(resp.read().decode("utf-8"))
    pages = [t for t in targets if t.get("type") == "page"]
    if not pages:
        raise RuntimeError("No page target found")
    return pages[0]


def evaluate(ws_url: str, expression: str, await_promise: bool = True) -> dict:
    """执行 JavaScript 表达式并返回结果"""
    ws = websocket.create_connection(ws_url, timeout=10)
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
        # 读取响应 (可能有多条消息, 找到 id=1 的)
        deadline = time.time() + 10
        while time.time() < deadline:
            raw = ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == 1:
                return msg
        raise TimeoutError("Timeout waiting for CDP response")
    finally:
        ws.close()


def main():
    print("=" * 60)
    print("TDSF 真实桌面端状态检查")
    print("=" * 60)

    # 1. 获取 CDP target
    try:
        target = get_page_target()
    except Exception as e:
        print(f"[FAIL] 无法连接 CDP: {e}")
        print("请确认 pnpm tauri dev 已启动且 --remote-debugging-port=9222 已设置")
        sys.exit(1)

    print(f"[OK] CDP target: title={target['title']!r} url={target['url']!r}")
    ws_url = target["webSocketDebuggerUrl"]

    # 2. 等待应用初始化 (自动登录需要几秒)
    print("\n[INFO] 等待 8 秒让 SSH 自动登录完成...")
    time.sleep(8)

    # 3. 检查 DOM 状态
    check_expr = """
    (() => {
        const text = document.body.innerText.slice(0, 1000);
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean);
        const hasSshNav = buttons.some(b => b === 'SSH' || b.includes('SSH'));
        const hasSshExplorer = !!document.querySelector('[data-testid="ssh-files"]');
        const hasTerminal = !!document.querySelector('.xterm-screen') || !!document.querySelector('[data-testid="ssh-terminal"]');
        const hasFileTree = !!document.querySelector('[data-testid="ssh-files"]');
        const hasEmptyState = text.includes('还没有 SSH 连接') || text.includes('No current directory');
        const hasSessionTabs = !!document.querySelector('[role="button"][aria-label="断开连接"]');
        // 检查终端是否有内容
        const terminalText = (() => {
            const term = document.querySelector('.xterm-viewport');
            return term ? term.textContent : '';
        })();
        // 检查文件树内容
        const fileTreeText = (() => {
            const tree = document.querySelector('[data-testid="ssh-files"]');
            return tree ? tree.innerText.slice(0, 500) : '';
        })();
        // 检查 toast 通知 (自动登录失败时会显示)
        const hasToastError = !!document.querySelector('[data-sonner-toast][data-type="error"]');
        const hasToastWarning = !!document.querySelector('[data-sonner-toast][data-type="warning"]');
        const toastText = (() => {
            const toasts = document.querySelectorAll('[data-sonner-toast]');
            return Array.from(toasts).map(t => t.textContent).join(' | ');
        })();
        return JSON.stringify({
            hasSshNav,
            hasSshExplorer,
            hasTerminal,
            hasFileTree,
            hasEmptyState,
            hasSessionTabs,
            hasToastError,
            hasToastWarning,
            toastText,
            terminalTextLen: terminalText.length,
            fileTreeText,
            textPreview: text.slice(0, 400),
            buttonsCount: buttons.length,
            buttonsSample: buttons.slice(0, 20)
        }, null, 2);
    })()
    """

    try:
        resp = evaluate(ws_url, check_expr)
        result = resp.get("result", {}).get("result", {}).get("value")
        if not result:
            print(f"[FAIL] CDP 返回空结果: {json.dumps(resp, ensure_ascii=False)}")
            sys.exit(1)
        data = json.loads(result)
    except Exception as e:
        print(f"[FAIL] CDP evaluate 失败: {e}")
        sys.exit(1)

    # 4. 打印检查结果
    print("\n" + "=" * 60)
    print("DOM 状态检查结果")
    print("=" * 60)
    print(f"SSH 导航按钮存在:        {'✓' if data['hasSshNav'] else '✗'}")
    print(f"SSH 资源管理器已挂载:    {'✓' if data['hasSshExplorer'] else '✗'}")
    print(f"终端组件已渲染:          {'✓' if data['hasTerminal'] else '✗'}")
    print(f"文件树组件已渲染:        {'✓' if data['hasFileTree'] else '✗'}")
    print(f"空状态页显示:            {'✓' if data['hasEmptyState'] else '✗'}")
    print(f"会话标签条存在:          {'✓' if data['hasSessionTabs'] else '✗'}")
    print(f"Toast 错误提示:          {'✓' if data['hasToastError'] else '✗'}")
    print(f"Toast 警告提示:          {'✓' if data['hasToastWarning'] else '✗'}")
    if data['toastText']:
        print(f"Toast 内容:              {data['toastText'][:200]}")
    print(f"终端文本长度:            {data['terminalTextLen']}")
    print(f"按钮总数:                {data['buttonsCount']}")

    print("\n--- 文件树内容 ---")
    print(data['fileTreeText'] if data['fileTreeText'] else "(空)")

    print("\n--- 页面文本预览 ---")
    print(data['textPreview'])

    print("\n--- 按钮样本 ---")
    print(data['buttonsSample'])

    # 5. 综合判断
    print("\n" + "=" * 60)
    print("综合判断")
    print("=" * 60)
    ssh_connected = (
        data['hasSshExplorer']
        and data['hasTerminal']
        and not data['hasEmptyState']
    )
    if ssh_connected:
        print("[PASS] SSH 已自动连接, 终端 + 文件树已渲染")
    elif data['hasEmptyState']:
        print("[FAIL] SSH 未自动连接, 显示空状态页")
    elif data['hasToastError'] or data['hasToastWarning']:
        print(f"[FAIL] SSH 自动连接失败, 有 toast 提示: {data['toastText'][:200]}")
    else:
        print("[WARN] 状态不明确, 需要人工检查")

    # 6. 如果 SSH 未连接, 尝试检查 ssh_credentials.json
    if not ssh_connected:
        print("\n[INFO] 检查 ssh_credentials.json 是否存在...")
        check_creds_expr = """
        (async () => {
            try {
                // 通过 invoke 调用 ssh_credentials_list 检查已保存的连接
                const { invoke } = await import('@tauri-apps/api/core');
                const list = await invoke('ssh_credentials_list');
                return JSON.stringify({ok: true, count: list.length, list: list});
            } catch (e) {
                return JSON.stringify({ok: false, error: e.message || String(e)});
            }
        })()
        """
        try:
            resp = evaluate(ws_url, check_creds_expr)
            creds_result = resp.get("result", {}).get("result", {}).get("value")
            if creds_result:
                creds = json.loads(creds_result)
                print(f"  ssh_credentials_list 调用: {'OK' if creds.get('ok') else 'FAILED'}")
                if creds.get('ok'):
                    print(f"  已保存连接数: {creds['count']}")
                    for p in creds.get('list', []):
                        print(f"    - {p.get('alias', '?')} | {p.get('user')}@{p.get('host')}:{p.get('port')}")
                else:
                    print(f"  错误: {creds.get('error')}")
        except Exception as e:
            print(f"  检查失败: {e}")


if __name__ == "__main__":
    main()
