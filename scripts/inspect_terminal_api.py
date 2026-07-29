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

print("terminal globals:", eval_expr("Object.keys(window).filter(k=>/term|xterm|ssh/i.test(k)).join(',')"))
print("xterm screen text:", eval_expr("document.querySelector('.xterm-screen')?.innerText?.slice(0,200)"))
print("file tree exists:", eval_expr("!!document.querySelector('[data-testid=\"ssh-files\"]')"))

ws.close()
