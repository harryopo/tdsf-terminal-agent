#!/usr/bin/env python3
"""CDP 最小客户端：连 TDSF dev 实例的 WebView2 探针口。

前置：`pnpm tauri:dev`（dev 配置里带 --remote-debugging-port=9222）。
依赖 websocket-client，只在 sidecar 的 .venv 里装着，所以入口脚本是
`src-tauri/sidecar/.venv/Scripts/python.exe`（见 package.json 的 probe:ui）。
"""
from __future__ import annotations

import json
import time
import urllib.request

import websocket

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222


def _next_id(_counter=[0]) -> int:
    _counter[0] += 1
    return _counter[0]


class CdpPage:
    """一个 page target 的 CDP 会话（同一连接内按 id 匹配响应）。"""

    def __init__(self, ws_url: str) -> None:
        self._ws = websocket.create_connection(ws_url, timeout=20)
        self._pending: dict[int, str] = {}

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:  # noqa: BLE001 - 退出路径尽力而为
            pass

    def call(self, method: str, params: dict | None = None) -> dict:
        mid = _next_id()
        self._ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + 20
        while time.time() < deadline:
            msg = json.loads(self._ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method} 失败: {msg['error']}")
                return msg.get("result", {})
            # 事件消息（非本次请求）直接丢弃即可，我们不做订阅
        raise TimeoutError(f"等待 {method} 响应超时")

    def evaluate(self, expression: str, await_promise: bool = False):
        """执行 JS 并取 returnByValue 的结果；页面抛错时带上下文报错。"""
        result = self.call(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
        )
        exc = result.get("exceptionDetails")
        if exc:
            text = exc.get("exception", {}).get("description") or exc.get("text")
            raise RuntimeError(f"页面内执行抛错: {text}")
        return result.get("result", {}).get("value")

    def send_key(self, key: str, code: str, vk: int) -> None:
        """受信任的键盘事件（探针口注入走 Input 域，不是 JS 合成事件）。"""
        for typ, vk_state in (("keyDown", vk), ("keyUp", 0)):
            self.call(
                "Input.dispatchKeyEvent",
                {
                    "type": typ,
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": vk_state,
                    "nativeVirtualKeyCode": vk_state,
                },
            )


def list_pages() -> list[dict]:
    url = f"http://{CDP_HOST}:{CDP_PORT}/json/list"
    with urllib.request.urlopen(url, timeout=5) as resp:
        targets = json.loads(resp.read().decode("utf-8"))
    return [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]


def connect(target: dict) -> CdpPage:
    return CdpPage(target["webSocketDebuggerUrl"])


def probe_port() -> list[dict]:
    """返回可连的 page 列表；端口不通时抛带排查指引的错误。"""
    try:
        pages = list_pages()
    except Exception as e:  # noqa: BLE001 - 统一换成可读提示
        raise SystemExit(
            f"连不上 CDP http://{CDP_HOST}:{CDP_PORT}/json/list：{e}\n"
            "先跑 pnpm tauri:dev（调试端口只在 dev 配置 tauri.dev.conf.json 里开放）"
        ) from e
    if not pages:
        raise SystemExit("CDP 端口在但没有 page target：dev 实例可能刚启动完还没建窗")
    return pages
