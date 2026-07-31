"""收集 CDP 控制台日志和异常"""
from __future__ import annotations
import json, time, urllib.request
import websocket  # type: ignore[import-untyped]


def main() -> int:
    resp = urllib.request.urlopen("http://127.0.0.1:9222/json")
    pages = [t for t in json.loads(resp.read()) if t.get("type") == "page"]
    ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=10)

    next_id = 0
    events: list[dict] = []

    def call(method: str, params: dict | None = None) -> dict:
        nonlocal next_id
        next_id += 1
        payload = {"id": next_id, "method": method}
        if params:
            payload["params"] = params
        ws.send(json.dumps(payload))
        deadline = time.time() + 5
        while time.time() < deadline:
            data = json.loads(ws.recv())
            if data.get("id") == next_id:
                return data
            if "method" in data:
                events.append(data)
        return {}

    # 启用 Runtime + Log
    call("Runtime.enable")
    call("Log.enable")
    time.sleep(2.5)  # 收集 2.5 秒的事件

    # 主动触发一个 evaluate 看是否有新错误
    call("Runtime.evaluate", {
        "expression": "(function(){ try { return 'ok-' + document.title; } catch(e) { return 'err:' + e.message; } })()",
        "returnByValue": True,
    })

    time.sleep(0.5)

    # 收集更多事件
    deadline = time.time() + 1
    while time.time() < deadline:
        try:
            ws.settimeout(0.3)
            data = json.loads(ws.recv())
            if "method" in data:
                events.append(data)
        except Exception:
            break

    # 分类输出
    console = [e for e in events if e.get("method") == "Runtime.consoleAPICalled"]
    exceptions = [e for e in events if e.get("method") == "Runtime.exceptionThrown"]
    log_entries = [e for e in events if e.get("method") == "Log.entryAdded"]

    print(f"=== Events: {len(events)} total | console: {len(console)} | exceptions: {len(exceptions)} | log: {len(log_entries)} ===\n")

    print("--- Console API ---")
    for e in console[-15:]:
        args = e.get("params", {}).get("args", [])
        text = " ".join(a.get("value", a.get("description", ""))[:200] for a in args)
        t = e.get("params", {}).get("type", "")
        print(f"  [{t}] {text[:300]}")

    print("\n--- Exceptions ---")
    for e in exceptions[-10:]:
        details = e.get("params", {}).get("exceptionDetails", {})
        text = details.get("text", "")
        exc = details.get("exception", {})
        if exc:
            text += " | " + (exc.get("description") or exc.get("value", ""))
        print(f"  {text[:400]}")

    print("\n--- Log entries ---")
    for e in log_entries[-10:]:
        entry = e.get("params", {}).get("entry", {})
        print(f"  [{entry.get('level', '')}] {entry.get('text', '')[:300]}")

    ws.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
