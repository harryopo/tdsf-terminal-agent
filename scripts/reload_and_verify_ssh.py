#!/usr/bin/env python3
"""通过 CDP 重新加载页面并验证 SSH 自动登录"""
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
        raise TimeoutError("Timeout waiting for CDP response")
    finally:
        ws.close()


def reload_page(ws_url: str):
    """通过 CDP 重新加载页面"""
    ws = websocket.create_connection(ws_url, timeout=15)
    try:
        ws.send(json.dumps({
            "id": 1,
            "method": "Page.reload",
            "params": {"ignoreCache": True}
        }))
        deadline = time.time() + 10
        while time.time() < deadline:
            raw = ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == 1:
                return msg
        raise TimeoutError("Timeout waiting for Page.reload response")
    finally:
        ws.close()


def main():
    print("=" * 60)
    print("CDP 重新加载 + SSH 自动登录验证")
    print("=" * 60)

    target = get_page_target()
    if not target:
        print("[FAIL] 无 CDP page target")
        return
    print(f"[OK] CDP target: {target['title']!r}")
    ws_url = target["webSocketDebuggerUrl"]

    # 1. 重新加载页面 (忽略缓存, 确保拿到最新代码)
    print("\n[INFO] 重新加载页面 (ignoreCache=True)...")
    try:
        reload_page(ws_url)
        print("[OK] 页面已重新加载")
    except Exception as e:
        print(f"[WARN] Page.reload 失败 (可能不支持): {e}")

    # 2. 等待应用初始化 + SSH 自动登录 (loadSavedConnections + connectWithSaved)
    # SSH 连接需要: TOFU 主机验证 (首次) + 认证 + PTY 打开, 给足 15 秒
    print("\n[INFO] 等待 15 秒让应用初始化 + SSH 自动登录完成...")
    time.sleep(15)

    # 3. 检查 DOM 状态
    check_expr = """
    (() => {
        const text = document.body.innerText.slice(0, 1500);
        const buttons = Array.from(document.querySelectorAll('button')).map(b => b.innerText.trim()).filter(Boolean);
        const hasSshNav = buttons.some(b => b === 'SSH' || b.includes('SSH'));
        const hasSshExplorer = !!document.querySelector('[data-testid="ssh-files"]');
        const hasTerminal = !!document.querySelector('.xterm-screen') || !!document.querySelector('[data-testid="ssh-terminal"]');
        const hasFileTree = !!document.querySelector('[data-testid="ssh-files"]');
        const hasEmptyState = text.includes('还没有 SSH 连接') || text.includes('No current directory');
        const hasSessionTabs = !!document.querySelector('[role="button"][aria-label="断开连接"]');
        const terminalText = (() => {
            const term = document.querySelector('.xterm-viewport');
            return term ? term.textContent.slice(0, 300) : '';
        })();
        const fileTreeText = (() => {
            const tree = document.querySelector('[data-testid="ssh-files"]');
            return tree ? tree.innerText.slice(0, 500) : '';
        })();
        const hasToastError = !!document.querySelector('[data-sonner-toast][data-type="error"]');
        const hasToastWarning = !!document.querySelector('[data-sonner-toast][data-type="warning"]');
        const hasToastSuccess = !!document.querySelector('[data-sonner-toast][data-type="success"]');
        const toastText = (() => {
            const toasts = document.querySelectorAll('[data-sonner-toast]');
            return Array.from(toasts).map(t => t.textContent).join(' | ');
        })();
        // 检查 sidebarView: 通过侧栏标题判断当前视图
        const sidebarTitle = (() => {
            const el = document.querySelector('[class*="uppercase"][class*="tracking-wide"]');
            return el ? el.textContent.trim() : '';
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
            hasToastSuccess,
            toastText,
            terminalText,
            fileTreeText,
            sidebarTitle,
            textPreview: text.slice(0, 500),
            buttonsCount: buttons.length,
            buttonsSample: buttons.slice(0, 25)
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

    # 4. 打印检查结果
    print("\n" + "=" * 60)
    print("DOM 状态检查结果")
    print("=" * 60)
    print(f"当前侧栏视图:            {data['sidebarTitle'] or '(未知)'}")
    print(f"SSH 导航按钮存在:        {'✓' if data['hasSshNav'] else '✗'}")
    print(f"SSH 资源管理器已挂载:    {'✓' if data['hasSshExplorer'] else '✗'}")
    print(f"终端组件已渲染:          {'✓' if data['hasTerminal'] else '✗'}")
    print(f"文件树组件已渲染:        {'✓' if data['hasFileTree'] else '✗'}")
    print(f"空状态页显示:            {'✓' if data['hasEmptyState'] else '✗'}")
    print(f"会话标签条存在:          {'✓' if data['hasSessionTabs'] else '✗'}")
    print(f"Toast 错误:              {'✓' if data['hasToastError'] else '✗'}")
    print(f"Toast 警告:              {'✓' if data['hasToastWarning'] else '✗'}")
    print(f"Toast 成功:              {'✓' if data['hasToastSuccess'] else '✗'}")
    if data['toastText']:
        print(f"Toast 内容:              {data['toastText'][:300]}")
    print(f"终端文本:                {data['terminalText'][:200]!r}")
    print(f"按钮总数:                {data['buttonsCount']}")

    print("\n--- 文件树内容 ---")
    print(data['fileTreeText'] if data['fileTreeText'] else "(空)")

    print("\n--- 页面文本预览 (前 500 字符) ---")
    print(data['textPreview'])

    print("\n--- 按钮样本 ---")
    print(data['buttonsSample'])

    # 5. 综合判断
    print("\n" + "=" * 60)
    print("综合判断")
    print("=" * 60)
    # 关键指标: SSH session 是否已建立 (通过会话标签条或 SSH explorer 判断)
    ssh_connected = data['hasSessionTabs'] or (
        data['hasSshExplorer'] and data['hasTerminal'] and not data['hasEmptyState']
    )
    if ssh_connected:
        print("[PASS] SSH 已自动连接 (会话标签条存在 / SSH 资源管理器已挂载)")
    elif data['hasToastError'] or data['hasToastWarning']:
        print(f"[FAIL] SSH 自动连接失败, toast 提示: {data['toastText'][:300]}")
    elif data['hasEmptyState']:
        print("[FAIL] SSH 未自动连接, 显示空状态页")
    else:
        print("[WARN] 状态不明确, 需要人工检查")

    # 6. 如果 SSH 未连接, 切换到 SSH 视图再看一次
    if not ssh_connected:
        print("\n[INFO] 尝试切换到 SSH 视图...")
        switch_expr = """
        (() => {
            // 找到 SSH 导航按钮并点击
            const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'SSH');
            if (btn) { btn.click(); return true; }
            return false;
        })()
        """
        try:
            evaluate(ws_url, switch_expr, await_promise=False)
            print("[INFO] 已点击 SSH 按钮, 等待 5 秒...")
            time.sleep(5)
            # 重新检查
            resp2 = evaluate(ws_url, check_expr)
            result2 = resp2.get("result", {}).get("result", {}).get("value")
            if result2:
                data2 = json.loads(result2)
                print(f"\n切换后状态:")
                print(f"  SSH 资源管理器已挂载: {'✓' if data2['hasSshExplorer'] else '✗'}")
                print(f"  终端组件已渲染:       {'✓' if data2['hasTerminal'] else '✗'}")
                print(f"  会话标签条存在:       {'✓' if data2['hasSessionTabs'] else '✗'}")
                print(f"  空状态页显示:         {'✓' if data2['hasEmptyState'] else '✗'}")
                print(f"  Toast 错误:           {'✓' if data2['hasToastError'] else '✗'}")
                if data2['toastText']:
                    print(f"  Toast 内容:           {data2['toastText'][:300]}")
                print(f"\n  文件树内容: {data2['fileTreeText'][:300]!r}")
                print(f"  终端文本:   {data2['terminalText'][:200]!r}")
        except Exception as e:
            print(f"  切换失败: {e}")


if __name__ == "__main__":
    main()
