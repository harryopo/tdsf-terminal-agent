import json
import requests
import websocket
import time

CDP = "http://localhost:9222"
targets = requests.get(f"{CDP}/json/list", timeout=5).json()
page = [t for t in targets if t.get("type") == "page"][0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15)

_id = [0]
def send(method, params=None):
    _id[0] += 1
    m = {"id": _id[0], "method": method}
    if params:
        m["params"] = params
    ws.send(json.dumps(m))
    return _id[0]

def eval_expr(expr):
    req = send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
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

send("Runtime.enable")
time.sleep(1)

print("=== last boundary error ===")
err = eval_expr("window.__lastBoundaryError__")
print(err)

print("\n=== sidebar innerHTML (first 3000 chars) ===")
html = eval_expr("document.querySelector(\"[data-testid='sidebar']\").innerHTML.slice(0,3000)")
print(html)

print("\n=== body testids ===")
testids = eval_expr("Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]')).map(e=>e.dataset.testid))).join(',')")
print(testids)

ws.close()
