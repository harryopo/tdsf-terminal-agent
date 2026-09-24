#!/usr/bin/env python3
"""CDP 最小客户端：连 TDSF dev 实例的 WebView2 探针口。

前置：`pnpm tauri:dev`（探针端口取自 `src-tauri/tauri.dev.conf.json` 里那条
`--remote-debugging-port=`，本文件不另存一份数字）。
依赖 websocket-client，只在 sidecar 的 .venv 里装着，所以入口脚本是
`src-tauri/sidecar/.venv/Scripts/python.exe`（见 package.json 的 probe:ui）。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request
from pathlib import Path

import websocket

CDP_HOST = "127.0.0.1"

_DEV_CONF = Path(__file__).resolve().parents[2] / "src-tauri" / "tauri.dev.conf.json"


def _port_from_dev_conf() -> int:
    """探针端口必须跟着 dev 配置走，这里不留第二个数字。

    2026-09-24 撞到的现场：本机另一个 Electron 应用（D:\\ai\\zhixing-reader）
    也在 9222 上开了调试口，我们的 dev 窗绑不上 ⇒ 探针连上的是**别人的窗口**。
    端口写两处早晚漂移，所以主人只有一个：dev 配置。读不到就直说读不到，
    拿一个"以前能用"的默认值顶上去 = 又一次悄悄量错东西。
    """
    try:
        text = _DEV_CONF.read_text(encoding="utf-8")
    except OSError as e:
        raise SystemExit(f"读不到 dev 配置 {_DEV_CONF}：{e}") from e
    m = re.search(r"--remote-debugging-port=(\d+)", text)
    if not m:
        raise SystemExit(
            f"{_DEV_CONF.name} 里没有 --remote-debugging-port=<数字> —— "
            "探针口只在 dev 配置里开，端口也从那里读"
        )
    return int(m.group(1))


CDP_PORT = int(os.environ.get("TDSF_CDP_PORT") or _port_from_dev_conf())


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

    def click_text(self, text: str) -> dict:
        """按可见文字做**受信任**点击，返回实际点到的元素信息。

        为什么不用 `el.click()`：Radix Tabs / 自绘行等组件在 mousedown/pointerdown
        上挂激活逻辑，JS 合成一个 click 事件它们根本不理——历史上因此把正常 UI
        判成"点了没反应"。走 Input.dispatchMouseEvent 才生成浏览器认可的输入。
        """
        rect = self._rect_for(text)
        if not rect:
            raise RuntimeError(f"页面上找不到文字为 {text!r} 的可点元素")
        self.call(
            "Input.dispatchMouseEvent",
            {"type": "mouseMoved", "x": rect["x"], "y": rect["y"], "button": "none"},
        )
        self.call(
            "Input.dispatchMouseEvent",
            {"type": "mousePressed", "x": rect["x"], "y": rect["y"],
             "button": "left", "clickCount": 1},
        )
        self.call(
            "Input.dispatchMouseEvent",
            {"type": "mouseReleased", "x": rect["x"], "y": rect["y"],
             "button": "left", "clickCount": 1},
        )
        return rect

    def _rect_for(self, text: str) -> dict | None:
        js = """
          (({ text }) => {
            const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
            const els = [...document.querySelectorAll(
              'button,[role="button"],[role="tab"],a,label,[role="menuitem"]')];
            const el = els.find((e) => norm(e.textContent).includes(text)
              || norm(e.getAttribute('aria-label')).includes(text)
              || norm(e.getAttribute('title')).includes(text));
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2,
                     tag: el.tagName.toLowerCase(), w: r.width, h: r.height };
          })
        """
        return self.call(
            "Runtime.evaluate",
            {
                "expression": f"({js})( {json.dumps({'text': text})} )",
                "returnByValue": True,
            },
        ).get("result", {}).get("value")


def list_pages() -> list[dict]:
    url = f"http://{CDP_HOST}:{CDP_PORT}/json/list"
    with urllib.request.urlopen(url, timeout=5) as resp:
        targets = json.loads(resp.read().decode("utf-8"))
    return [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]


def connect(target: dict) -> CdpPage:
    return CdpPage(target["webSocketDebuggerUrl"])


#: dev 前端出处：读 tauri 基线配置里的 devUrl，这里同样不留第二个数字。
#: 探针只能量我们自己那个窗，"量的是谁"由这个 origin 说了算。
_TAURI_CONF = Path(__file__).resolve().parents[2] / "src-tauri" / "tauri.conf.json"


def _dev_origin() -> str:
    conf = _TAURI_CONF.read_text(encoding="utf-8")
    m = re.search(r'"devUrl"\s*:\s*"(http://[^"]+)"', conf)
    if not m:
        raise SystemExit(
            f"{_TAURI_CONF.name} 里读不到 build.devUrl —— "
            "探针需要它来认出自己的窗口"
        )
    return m.group(1).rstrip("/")


DEV_ORIGIN = _dev_origin()
#: localhost 与 127.0.0.1 是同一个 dev 前端的两种写法，都算我们自己的窗
DEV_ORIGINS = (DEV_ORIGIN, DEV_ORIGIN.replace("://127.0.0.1", "://localhost"))


def is_dev_page(target: dict) -> bool:
    """这个 page 是不是我们 dev 前端的（按出处判，不按标题判）。"""
    return (target.get("url") or "").startswith(DEV_ORIGINS)


def probe_port() -> list[dict]:
    """返回**我们那个 dev 窗**的 page 列表；端口不通或不是我们就报错。

    2026-09-24 实测踩到的坑：调试端口上挂着一个毫不相干的页面
    （本机另一个开发预览服务器，标题「知行读书」）——同一个端口被两个程序抢。
    老版本这里只筛 `type == "page"`，于是所有界面探针量的是别人的窗口，
    还照样报"0 违规"。一次"页面活着"的检查就此骗过了我。
    判据不能只是"连得上"，必须连"连的是谁"一起判。
    """
    try:
        pages = list_pages()
    except Exception as e:  # noqa: BLE001 - 统一换成可读提示
        raise SystemExit(
            f"连不上 CDP http://{CDP_HOST}:{CDP_PORT}/json/list：{e}\n"
            "先跑 pnpm tauri:dev（调试端口只在 dev 配置 tauri.dev.conf.json 里开放）"
        ) from e
    if not pages:
        raise SystemExit("CDP 端口在但没有 page target：dev 实例可能刚启动完还没建窗")
    ours = [p for p in pages if is_dev_page(p)]
    if not ours:
        others = ", ".join(
            sorted({(p.get("url") or "?")[:60] for p in pages})
        )
        raise SystemExit(
            f"CDP {CDP_PORT} 上没有任何页面指向 dev 前端（{DEV_ORIGINS[0]}）。\n"
            f"现在挂着的是：{others}\n"
            "两种可能：① dev 实例没在跑（先 pnpm tauri:dev）；"
            f"② {CDP_PORT} 被本机别的程序占了——那就改 tauri.dev.conf.json 里的"
            " --remote-debugging-port（探针跟着它，不必改这里），"
            "别拿别人的窗口量我们的界面。"
        )
    return ours
