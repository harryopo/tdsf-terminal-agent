import json
import requests
import websocket
import time

CDP = "http://localhost:9222"
targets = requests.get(f"{CDP}/json/list", timeout=5).json()
page = [t for t in targets if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)


def send(method, params=None, _id=[0]):
    _id[0] += 1
    m = {"id": _id[0], "method": method}
    if params:
        m["params"] = params
    ws.send(json.dumps(m))
    return _id[0]


def eval_expr(expr):
    req = send(
        "Runtime.evaluate",
        {"expression": expr, "returnByValue": True, "awaitPromise": True},
    )
    deadline = time.time() + 5
    while time.time() < deadline:
        ws.settimeout(max(0.1, deadline - time.time()))
        try:
            raw = ws.recv()
        except websocket.WebSocketTimeoutException:
            continue
        data = json.loads(raw)
        if data.get("id") == req:
            return data
    return None


def click_by_text(text, wait=1.0):
    eval_expr(
        f"""
        (()=>{{
          const btns = Array.from(document.querySelectorAll('button'));
          const b = btns.find(x => x.innerText.trim() === {text!r});
          if (b) {{ b.click(); return true; }}
          return false;
        }})()
        """
    )
    time.sleep(wait)


send("Runtime.enable")
send("Log.enable")
send("Console.enable")
print("=== Click SSH tab ===")
click_by_text("SSH", wait=1.5)
print("=== Click Settings button ===")
eval_expr("document.querySelector(\"[data-testid='settings-button']\").click()")
time.sleep(2)

print("=== Console events ===")
# Flush remaining messages for 3s
deadline = time.time() + 3
while time.time() < deadline:
    ws.settimeout(max(0.1, deadline - time.time()))
    try:
        raw = ws.recv()
        data = json.loads(raw)
        if data.get("method") in (
            "Runtime.consoleAPICalled",
            "Log.entryAdded",
            "Console.messageAdded",
        ):
            print(json.dumps(data, ensure_ascii=False))
    except websocket.WebSocketTimeoutException:
        pass

ws.close()
